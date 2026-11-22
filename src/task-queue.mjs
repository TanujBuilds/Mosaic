import { access } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { IdleSleepAssertion } from './harness/overnight-lifecycle.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { Journal, atomicJson } from './project/journal.mjs';
import { digest, Pause } from './project/contracts.mjs';
import { runProject, summarize } from './project/runner.mjs';
import { prepareResume } from './project/service.mjs';
import { ProjectFrontier, ProjectLocal } from './project/providers.mjs';
import { FakeProjectFrontier, FakeProjectLocal } from './project/fake.mjs';

export const QUEUE_ID = '00000000-0000-4000-8000-000000000001';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
const retryable = new Set(['failed', 'paused', 'blocked', 'needs_review']);
function rootPath(root) {
  if (typeof root !== 'string' || !root.trim()) throw new Error('root must be a directory path');
  return path.resolve(root);
}
function identifiers(jobId, hash) {
  if (!uuid.test(jobId ?? '')) throw new Error('Invalid job ID');
  if (!sha.test(hash ?? '')) throw new Error('Invalid approval hash');
}
function integer(value, name, min = 1, max = 1000) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
}
function journalFor(root) { return new Journal(path.join(rootPath(root), 'task-queue'), QUEUE_ID); }
function stateOf(journal) { return journal.events.findLast(e => e.data.state)?.data.state; }
function requireState(journal) {
  const state = stateOf(journal);
  if (!state) throw new Error('Queue is not initialized; run init first');
  return state;
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid worker PID; inspect queue ownership');
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}
async function save(journal, type, state, detail = {}) {
  state.updatedAt = new Date().toISOString();
  await journal.append(type, { ...detail, state });
}
// Reuse the coordinator's serialized dead-owner recovery. Contention never permits
// deleting a live/unknown owner's lock, even when a transaction takes a long time.
async function transaction(root, action) {
  const journal = journalFor(root);
  const until = Date.now() + 5000;
  let release;
  while (!release) {
    try { release = await journal.lock(); }
    catch (error) { if (error.code !== 'locked' || Date.now() >= until) throw error; await delay(10); }
  }
  try { return await action(journal); } finally { await release(); }
}
function view(state, journal) {
  const active = state.worker?.active;
  const workerAlive = active && alive(state.worker.pid);
  return {
    id: QUEUE_ID, initialized: true, mode: state.mode, limits: state.limits,
    status: active ? (workerAlive ? 'running' : 'interrupted') : state.stopped ? 'stopped' : state.lastOutcome ?? 'idle',
    stopped: state.stopped, deadline: state.deadline ?? null,
    jobsUsed: state.jobsUsed, reviewsUsed: state.reviewsUsed,
    jobsRemaining: Math.max(0, state.limits.maxJobs - state.jobsUsed),
    reviewsRemaining: Math.max(0, state.limits.maxReviews - state.reviewsUsed),
    worker: workerAlive ? state.worker : null, lastWorker: state.worker ?? null,
    items: [...state.items].sort((a, b) => b.priority - a.priority || a.sequence - b.sequence),
    reason: state.reason ?? null, updatedAt: state.updatedAt, eventSequence: journal.events.length,
    eventFile: journal.file, report: path.join(journal.dir, 'report.json'),
  };
}
export async function queueStatus({ root } = {}) {
  const journal = await journalFor(root).load(), state = stateOf(journal);
  if (!state) return { id: QUEUE_ID, initialized: false, items: [], status: 'uninitialized' };
  const result = view(state, journal);
  await atomicJson(result.report, result);
  return result;
}
export async function initQueue({ root, mode = 'live', hours = 8, maxJobs = 10, maxReviews = 8 } = {}) {
  if (!['live', 'fake'].includes(mode)) throw new Error('mode must be live or fake');
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) throw new Error('hours must be greater than 0 and no more than 24');
  integer(maxJobs, 'maxJobs'); integer(maxReviews, 'maxReviews');
  await transaction(root, async journal => {
    if (stateOf(journal)) return;
    await save(journal, 'queue.initialized', {
      mode, limits: { hours, maxJobs, maxReviews }, items: [], stopped: false,
      jobsUsed: 0, reviewsUsed: 0, createdAt: new Date().toISOString(),
    });
  });
  return queueStatus({ root });
}
async function project(root, jobId) {
  const journal = await new Journal(rootPath(root), jobId).load();
  const manifest = journal.last('project.created');
  if (!manifest) throw new Error('Project job not found');
  return { journal, manifest, status: summarize(journal) };
}
function bind(journal, hash, mode) {
  const manifest = journal.last('project.created');
  if (!manifest || digest(manifest) !== hash || journal.last('project.approved')?.hash !== hash) throw new Pause('Queued approval hash no longer matches the current approved plan', 'approval');
  if (manifest.mode !== mode) throw new Pause('Job mode does not match queue mode', 'approval');
}
async function manualStop(journal) {
  try { await access(path.join(journal.dir, 'stop.request')); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function fresh(journal) {
  if (journal.events.some(e => ['run.started', 'run.finished', 'budget.started', 'workspace.created', 'resume.requested'].includes(e.type)) || await manualStop(journal)) {
    throw new Pause('Only fresh approved jobs may be added; use the existing job recovery workflow for historical or stopped jobs', 'eligibility');
  }
}
function find(state, jobId) {
  const item = state.items.find(i => i.jobId === jobId);
  if (!item) throw new Error('Queued item not found');
  return item;
}
export async function enqueue({ root, jobId, hash, priority = 0 } = {}) {
  root = rootPath(root); identifiers(jobId, hash); integer(priority, 'priority', -1_000_000, 1_000_000);
  return transaction(root, async journal => {
    const state = requireState(journal), existing = state.items.find(i => i.jobId === jobId);
    if (existing) {
      if (existing.hash !== hash) throw new Error('Queued hash differs; existing item cannot be silently rebound');
      return { ...existing, duplicate: true };
    }
    const job = await project(root, jobId); bind(job.journal, hash, state.mode); await fresh(job.journal);
    const item = { jobId, hash, priority, sequence: state.items.length + 1, status: 'queued', outcome: null,
      retries: 0, hasRun: false, attempts: 0, createdAt: new Date().toISOString() };
    state.items.push(item); await save(journal, 'queue.enqueued', state, { jobId }); return item;
  });
}
export async function cancelItem({ root, jobId } = {}) {
  return transaction(root, async journal => {
    const state = requireState(journal), item = find(state, jobId);
    if (item.status !== 'queued') throw new Error('Only pending items can be cancelled');
    item.status = item.outcome = 'cancelled'; item.reason = 'Cancelled by user';
    await save(journal, 'queue.cancelled', state, { jobId }); return item;
  });
}
export async function retryItem({ root, jobId, hash } = {}) {
  root = rootPath(root); identifiers(jobId, hash);
  return transaction(root, async journal => {
    const state = requireState(journal), item = find(state, jobId);
    if (!retryable.has(item.status) || item.retries >= 1) throw new Error('Only a failed or stopped item may be retried, at most once');
    if (hash !== item.hash) throw new Error('Retry hash must match the original queued approval');
    const job = await project(root, jobId); bind(job.journal, hash, state.mode);
    const deadline = job.status.deadline;
    if (deadline && Date.now() >= deadline) throw new Error('Job deadline expired; explicit coordinator recovery is required');
    // This is an explicit user operation. The coordinator clears only its stop flag;
    // no attempt, review, plan, or time extension is supplied.
    await prepareResume(job.journal);
    item.retries++; item.status = 'queued'; item.outcome = null; item.reason = null; item.recovery = false;
    await save(journal, 'queue.retried', state, { jobId }); return item;
  });
}
export async function stopQueue({ root } = {}) {
  await transaction(root, async journal => {
    const state = requireState(journal); state.stopped = true;
    await save(journal, 'queue.stop.requested', state);
  });
  return queueStatus({ root });
}
function exhaustion(state) {
  if (state.stopped) return 'Queue stopped';
  if (state.deadline && Date.now() >= Date.parse(state.deadline)) return 'Queue time budget exhausted';
  if (state.reviewsUsed >= state.limits.maxReviews) return 'Queue review-call budget exhausted';
  return null;
}
async function defaultRunJob({ root, job, mode, signal, reserveReview, permitWork }) {
  const journal = await new Journal(root, job.jobId).load(), fake = mode === 'fake';
  const frontier = fake ? new FakeProjectFrontier() : new ProjectFrontier({ model: process.env.FRONTIER_MODEL_ID });
  let local;
  return runProject(journal, {
    expectedHash: job.hash, signal, frontier,
    authorizeRun: async locked => {
      bind(locked, job.hash, mode);
      if (!job.hasPreviouslyRun) await fresh(locked);
      else {
        if (await manualStop(locked)) throw new Pause('Job was manually stopped; explicit retry is required', 'stopped');
        const last = locked.events.findLast(e => ['run.started', 'run.finished'].includes(e.type));
        const resumed = locked.events.findLast(e => e.type === 'resume.requested');
        if (last?.type === 'run.finished' && last.data.status !== 'accepted' && !(resumed?.sequence > last.sequence)) throw new Pause('Stopped or failed job requires an explicit retry', 'stopped');
      }
    },
    beforeReview: async () => {
      const reservation = await reserveReview();
      if (!reservation.ok) throw new Pause(reservation.reason, 'needs_review');
    },
    local: { reply: async (input, s) => {
      await permitWork();
      local ??= fake ? new FakeProjectLocal() : new ProjectLocal({ baseUrl: process.env.DEEPSEEK_BASE_URL, model: process.env.DEEPSEEK_MODEL_ID });
      return local.reply(input, s);
    } },
  });
}
export async function runQueue({ root, signal, once = false, pollMs = 1000, runJob = defaultRunJob, workerToken = randomUUID(), keepAwake = true } = {}) {
  root = rootPath(root); integer(pollMs, 'pollMs', 1, 60000);
  if (!uuid.test(workerToken)) throw new Error('Invalid worker token');
  const controller = new AbortController(), cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
  let timer, poll, awake, pollTask = null, dispatched = 0, reason = 'Queue drained', owned = false;
  try {
    const started = await transaction(root, async journal => {
      const state = requireState(journal);
      if (state.worker?.active && alive(state.worker.pid)) throw new Pause('Another queue worker owns the lease', 'locked');
      // A dead worker's finished project is reconciled without executing it again.
      for (const item of state.items.filter(i => i.status === 'running')) {
        const job = await project(root, item.jobId);
        const last = job.journal.events.findLast(e => ['run.started', 'run.finished'].includes(e.type));
        if (last?.type === 'run.finished' && last.sequence > (item.projectSequence ?? 0)) {
          item.status = item.outcome = last.data.status; item.reason = last.data.reason;
        } else if (state.stopped || await manualStop(job.journal)) {
          item.status = item.outcome = 'paused'; item.reason = 'Stopped before worker recovery; explicit retry required';
        } else { item.status = 'queued'; item.recovery = true; }
      }
      state.stopped = false;
      state.deadline ??= new Date(Date.now() + state.limits.hours * 3600_000).toISOString();
      state.worker = { pid: process.pid, token: workerToken, active: true, startedAt: new Date().toISOString() };
      state.reason = null; await save(journal, 'queue.worker.started', state, { token: workerToken, pid: process.pid });
      return state;
    });
    owned = true;
    timer = setTimeout(cancel, Math.max(1, Date.parse(started.deadline) - Date.now()));
    poll = setInterval(() => {
      if (pollTask) return;
      pollTask = (async () => {
        try {
          const journal = await journalFor(root).load(), state = requireState(journal);
          if (state.stopped || state.worker?.token !== workerToken) cancel();
        } catch { cancel(); }
      })().finally(() => { pollTask = null; });
    }, Math.min(pollMs, 200));
    if (keepAwake) {
      awake = new IdleSleepAssertion();
      awake.sync(true, Date.parse(started.deadline));
    }
    while (!controller.signal.aborted) {
      const claim = await transaction(root, async journal => {
        const state = requireState(journal);
        if (state.worker?.token !== workerToken) throw new Pause('Worker ownership changed', 'locked');
        const blocked = exhaustion(state); if (blocked) return { done: blocked };
        const pending = state.items.filter(i => i.status === 'queued').sort((a, b) => Number(b.recovery) - Number(a.recovery) || b.priority - a.priority || a.sequence - b.sequence);
        const item = pending.find(i => i.hasRun || state.jobsUsed < state.limits.maxJobs);
        if (!item) return pending.length ? { done: 'Queue distinct-job budget exhausted' } : { empty: true };
        try {
          const job = await project(root, item.jobId); bind(job.journal, item.hash, state.mode);
          item.projectSequence = job.journal.events.length;
          if (!item.hasRun) await fresh(job.journal);
          if (item.recovery && await manualStop(job.journal)) throw new Error('Job manually stopped; retry explicitly');
        } catch (error) {
          item.status = item.outcome = 'invalidated'; item.reason = error.message;
          await save(journal, 'queue.invalidated', state, { jobId: item.jobId }); return { skipped: true };
        }
        const hasPreviouslyRun = item.hasRun;
        if (!item.hasRun) { item.hasRun = true; state.jobsUsed++; }
        item.status = 'running'; item.workerToken = workerToken; item.attempts++; item.recovery = false;
        await save(journal, 'queue.claimed', state, { jobId: item.jobId });
        return { job: { ...item, hasPreviouslyRun }, mode: state.mode };
      });
      if (claim.done) { reason = claim.done; break; }
      if (claim.skipped) continue;
      if (claim.empty) {
        if (once) break;
        await delay(pollMs, undefined, { signal: controller.signal }).catch(() => {}); continue;
      }
      const job = claim.job; dispatched++;
      const permit = async (reserve = false) => transaction(root, async journal => {
        const state = requireState(journal), item = find(state, job.jobId);
        const denied = controller.signal.aborted ? 'Queue interrupted' : exhaustion(state);
        if (state.worker?.token !== workerToken || item.status !== 'running' || item.workerToken !== workerToken) throw new Pause('Worker no longer owns this item', 'locked');
        if (denied) return { ok: false, reason: denied };
        if (reserve) { state.reviewsUsed++; await save(journal, 'queue.review.reserved', state, { jobId: job.jobId }); }
        return { ok: true };
      });
      let result;
      try {
        result = await runJob({ root, job, mode: claim.mode, signal: controller.signal,
          reserveReview: () => permit(true), permitWork: async () => { const p = await permit(); if (!p.ok) throw new Pause(p.reason, 'needs_review'); } });
      } catch (error) { result = { status: controller.signal.aborted ? 'paused' : 'failed', reason: error.message }; }
      await transaction(root, async journal => {
        const state = requireState(journal), item = find(state, job.jobId);
        if (state.worker?.token !== workerToken) throw new Pause('Worker ownership changed', 'locked');
        item.status = item.outcome = ['accepted', ...retryable].includes(result?.status) ? result.status : 'failed';
        item.reason = result?.reason ?? null; item.report = result?.report ?? null;
        await save(journal, 'queue.item.finished', state, { jobId: item.jobId });
      });
    }
    if (controller.signal.aborted) reason = 'Queue interrupted, stopped, or time budget exhausted';
  } finally {
    clearTimeout(timer); clearInterval(poll); await pollTask; awake?.close(); signal?.removeEventListener('abort', cancel);
    if (owned) await transaction(root, async journal => {
      const state = requireState(journal);
      if (state.worker?.token !== workerToken) return;
      state.worker.active = false; state.worker.finishedAt = new Date().toISOString();
      state.reason = reason; state.lastOutcome = controller.signal.aborted ? 'paused' : reason === 'Queue drained' ? 'drained' : 'budget_exhausted';
      await save(journal, 'queue.worker.finished', state, { token: workerToken });
    });
  }
  return { ...await queueStatus({ root }), dispatched };
}
