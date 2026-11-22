import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { IdleSleepAssertion } from '../harness/overnight-lifecycle.mjs';
import { digest, validateReply, stageAssignment, Pause, AttemptError } from './contracts.mjs';
import { Workspace } from './workspace.mjs';
import { CheckRunner } from './sandbox.mjs';
import { transient, providerFailure } from './providers.mjs';

const REVIEW_CONTEXT_BYTES = 64 * 1024;
const CHECK_TAIL = 8 * 1024;
const DIFF_LIMIT = 256 * 1024;

function compactFiles(files, limit) {
  let bytes = 0, truncated = false;
  const out = [];
  for (const file of files) {
    const size = Buffer.byteLength(file.content ?? '');
    if (bytes + size > limit) { truncated = true; out.push({ path: file.path, hash: file.hash, content: null }); continue; }
    bytes += size; out.push(file);
  }
  return { files: out, truncated };
}

// A durable intent charges interrupted calls too. Completion records retain the
// same callId, so usage and stage caps count each attempt exactly once. Legacy
// journals containing only completion records remain readable.
function frontierCalls(journal) {
  const starts = journal.events.filter(event => event.type === 'frontier.call.started');
  const completed = journal.events.filter(event => event.type === 'frontier.call');
  const byId = new Map(completed.filter(event => event.data.callId).map(event => [event.data.callId, event]));
  const startedIds = new Set(starts.map(event => event.data.callId));
  return [...starts.map(event => byId.get(event.data.callId) ?? event),
    ...completed.filter(event => !event.data.callId || !startedIds.has(event.data.callId))]
    .sort((a, b) => a.sequence - b.sequence);
}

export function summarize(journal) {
  const manifest = journal.last('project.created');
  if (!manifest) throw new Error('Not a project job');
  const last = journal.events.findLast(event => ['run.started', 'run.finished'].includes(event.type));
  const limits = { ...manifest.limits, reviewRounds: manifest.limits.reviewRounds ?? 2, attempts: journal.last('attempts.extended')?.attempts ?? manifest.limits.attempts };
  const stages = manifest.plan.stages.map(stage => {
    const accepted = journal.events.findLast(event => event.type === 'stage.accepted' && event.data.stageId === stage.id)?.data;
    const attempts = journal.events.filter(event => event.type === 'attempt.started' && event.data.stageId === stage.id);
    const reviews = frontierCalls(journal).filter(event => event.data.kind === 'review' && event.data.stageId === stage.id);
    const latest = journal.events.findLast(event => event.type === 'attempt.finished' && event.data.stageId === stage.id)?.data;
    return { id: stage.id, objective: stage.objective, status: accepted ? 'accepted' : attempts.length ? 'unfinished' : 'pending',
      localAttempts: attempts.length, codexReviews: reviews.length,
      checkpoint: accepted?.commit ?? null, lastFeedback: latest?.feedback ?? null,
      checks: latest?.checks ?? [], unverified: latest?.unverified ?? [] };
  });
  return {
    jobId: journal.id, mode: manifest.mode, status: journal.last('project.approved')?.hash !== digest(manifest) ? 'awaiting_approval' : last?.type === 'run.started' ? 'running' : last?.data.status ?? 'approved',
    reason: last?.data.reason ?? null, planHash: digest(manifest), planVersion: manifest.planVersion,
    branch: `orchestrator/${journal.id}`, worktree: path.join(journal.dir, 'worktree'),
    deadline: journal.last('budget.extended')?.deadline ?? journal.last('budget.started')?.deadline ?? null,
    budgetStartedAt: journal.events.find(event => event.type === 'budget.started')?.at ?? null,
    reportedLocalTokens: journal.events.filter(event => event.type === 'operation.completed')
      .reduce((total, event) => total + (Number(event.data.value?.usage?.total_tokens) || 0), 0),
    codexCalls: frontierCalls(journal).length,
    codexCallMs: frontierCalls(journal).reduce((total, event) => total + (Number(event.data.durationMs) || 0), 0),
    limits, stages, eventFile: journal.file, report: path.join(journal.dir, 'report.md'),
  };
}
export async function writeReport(journal) {
  const report = summarize(journal);
  const lines = [
    `# Overnight job ${report.jobId}`, '', `Status: **${report.status}**`, `Provider mode: **${report.mode}**`, '',
    report.reason ? `Reason: ${report.reason}` : '',
    `Branch: ${report.branch}`, `Worktree: ${report.worktree}`, `Events: ${report.eventFile}`, '',
    `Deadline: ${report.deadline ? new Date(report.deadline).toISOString() : 'not started'}`,
    `Reported local tokens: ${report.reportedLocalTokens} (only when the provider supplies usage; Codex CLI usage is not estimated)`,
    `Codex calls (planning, guidance, and review): ${report.codexCalls} in ${report.codexCallMs} ms`, '',
    '| Stage | Status | DeepSeek attempts | Codex reviews | Checkpoint |',
    '| --- | --- | ---: | ---: | --- |',
    ...report.stages.map(stage => `| ${stage.id} | ${stage.status} | ${stage.localAttempts} | ${stage.codexReviews} | ${stage.checkpoint ?? '—'} |`),
    '', '## Latest review limits',
    ...(report.stages.findLast(stage => stage.lastFeedback)?.unverified.length
      ? report.stages.findLast(stage => stage.lastFeedback).unverified.map(item => `- ${item}`)
      : ['- None recorded by the latest review.']),
    '',
    ...report.stages.flatMap(stage => [`## ${stage.id}`, stage.objective, stage.lastFeedback ?? '',
      ...stage.checks.map(check => `- ${check.id}: ${check.passed ? 'passed' : 'failed'}`),
      ...stage.unverified.map(item => `- At this stage review, unverified: ${item}`), '']),
  ];
  await writeFile(report.report, lines.join('\n'), { mode: 0o600 });
  return report;
}

export async function runProject(journal, {
  frontier, local, workspace, checks, signal, expectedHash, authorizeRun, beforeReview, now = Date.now,
  sleep = (ms, signal) => delay(ms, undefined, { signal }), keepAwake = true,
} = {}) {
  const release = await journal.lock();
  let timer, stopPoll, awake;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  let stopReason;
  try {
    const manifest = journal.last('project.created');
    if (!manifest || journal.last('project.approved')?.hash !== digest(manifest)) throw new Pause('Approve the exact plan and permissions before running', 'approval');
    if (expectedHash !== undefined && digest(manifest) !== expectedHash) throw new Pause('Queued approval hash changed before the project lock was acquired', 'approval');
    await authorizeRun?.(journal);
    if (journal.last('run.finished')?.status === 'accepted') return await writeReport(journal);
    workspace ??= new Workspace(manifest, journal);
    checks ??= new CheckRunner(workspace);
    const firstBudget = journal.last('budget.started');
    if (!firstBudget) await journal.append('budget.started', { deadline: now() + manifest.limits.hours * 3600_000 });
    const deadline = journal.last('budget.extended')?.deadline ?? journal.last('budget.started').deadline;
    const guard = () => {
      if (now() >= deadline) throw new Pause('Eight-hour/job time budget exhausted; extend it explicitly to continue', 'budget');
      if (controller.signal.aborted) throw new Pause(stopReason ?? 'Stopped by user; progress is saved', 'stopped');
    };
    guard();
    try { await access(path.join(journal.dir, 'stop.request')); throw new Pause('Stopped by user; use resume to continue', 'stopped'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    timer = setTimeout(() => { stopReason = 'Job time budget exhausted'; cancel(); }, Math.min(deadline - now(), 2_147_483_647));
    stopPoll = setInterval(async () => {
      try { await access(path.join(journal.dir, 'stop.request')); stopReason = 'Stopped by user'; cancel(); } catch {}
    }, 500);
    await journal.append('run.started');
    if (keepAwake) {
      awake = new IdleSleepAssertion();
      awake.sync(true, deadline);
    }
    await workspace.initialize();
    await workspace.recover();
    guard();
    await journal.append('sandbox.verified', await checks.verify(controller.signal));

    const provider = async (key, action, input) => journal.memo(key, async () => {
      const resumeSequence = journal.events.findLast(event => event.type === 'resume.requested')?.sequence ?? 0;
      let outageStart = journal.events.findLast(event => event.type === 'provider.waiting' && event.data.key === key && event.sequence > resumeSequence)?.data.outageStart;
      let failures = 0;
      while (true) {
        guard();
        if (outageStart !== undefined && now() - outageStart >= manifest.limits.reconnectMs) throw new Pause('Provider reconnection window exhausted; resume after reconnecting', 'connection');
        const callStarted = now();
        const remaining = outageStart === undefined ? manifest.limits.reconnectMs : manifest.limits.reconnectMs - (now() - outageStart);
        const callSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, remaining))]);
        try { return await action(callSignal); }
        catch (error) {
          guard();
          if (outageStart !== undefined && now() - outageStart >= manifest.limits.reconnectMs) throw new Pause('Provider reconnection window exhausted; resume after reconnecting', 'connection');
          if (error instanceof AttemptError || error instanceof Pause) throw error;
          if (!transient(error)) throw providerFailure(error);
          outageStart ??= callStarted;
          if (now() - outageStart >= manifest.limits.reconnectMs) throw new Pause('Provider unavailable for 30 minutes; resume after reconnecting', 'connection');
          const waitMs = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5), manifest.limits.reconnectMs - (now() - outageStart), deadline - now());
          await journal.append('provider.waiting', { key, reason: error.message, waitMs, outageStart });
          await sleep(waitMs, controller.signal);
        }
      }
    }, input);

    const attemptsLimit = journal.last('attempts.extended')?.attempts ?? manifest.limits.attempts;
    const reviewRounds = manifest.limits.reviewRounds ?? 2; // jobs created before review-only mode lack this field
    for (const stage of manifest.plan.stages) {
      if (journal.events.some(event => event.type === 'stage.accepted' && event.data.stageId === stage.id)) continue;
      guard();
      await workspace.assertSnapshot();
      const guidance = journal.events.findLast(event => event.type === 'stage.guidance' && event.data.stageId === stage.id)?.data.guidance;

      let accepted = false;
      for (let number = 1; number <= attemptsLimit; number++) {
        const key = `${stage.id}/local-${number}`;
        const operationKey = `v${manifest.planVersion}/${key}`;
        const prior = journal.events.find(event => event.type === 'attempt.finished' && event.data.key === key);
        if (prior) {
          if (prior.data.accepted) { accepted = true; break; }
          continue;
        }
        guard();
        const started = journal.events.some(event => event.type === 'attempt.started' && event.data.key === key);
        if (!started) await journal.append('attempt.started', { key, stageId: stage.id, number, role: 'local' });
        const failures = journal.events.filter(event => event.type === 'attempt.finished' && event.data.stageId === stage.id).map(event => event.data);
        let reply, checkResults = [], review = null, reviewRound = 0;
        const assignmentWithHistory = stageAssignment({ stage, plan: manifest.plan,
          acceptedStages: summarize(journal).stages.filter(item => item.status === 'accepted'), priorAttempts: failures, guidance });
        try {
          const context = [];
          for (let exchange = 0; exchange <= manifest.limits.contextRequests; exchange++) {
            const request = { stage, assignment: assignmentWithHistory, permissions: manifest.permissions, inventory: await workspace.inventory(), priorAttempts: failures,
              context, note: stage.kind === 'verification'
                ? 'Only one edit submission per attempt. If no source edit is warranted, submit_changes with edits:[]. The coordinator runs approved checks after each attempt; checks must pass before review. Do not ask for generated artifacts or approval to review them.'
                : 'Only one edit submission per attempt; use read_files to obtain current base hashes.' };
            const output = await provider(`${operationKey}/response-${exchange}`, s => local.reply(request, s), request);
            if (output?.protocolError) throw new AttemptError(output.protocolError);
            if (stage.kind === 'verification' && output?.reply?.type === 'needs_approval' &&
                Array.isArray(output.reply.paths) && output.reply.paths.length > 0 &&
                output.reply.paths.every(file => /^\.overnight-output\/[a-zA-Z0-9_.-]+\.png$/.test(file)) &&
                Array.isArray(output.reply.edits) && output.reply.edits.length === 0) {
              throw new AttemptError('The coordinator already gives generated screenshots and accepted checkpoint diffs to Codex. Submit changes with an empty edits array when no source edit is needed.');
            }
            reply = validateReply(output?.reply);
            if (reply.type === 'submit_changes') break;
            if (exchange === manifest.limits.contextRequests) throw new AttemptError('Context request limit reached; submit a focused edit batch');
            const files = await journal.memo(`${operationKey}/files-${exchange}`, () => workspace.readFiles(reply.paths), { paths: reply.paths });
            context.push({ request: reply, files });
            if (Buffer.byteLength(JSON.stringify(context)) > 512 * 1024) throw new AttemptError('Context exceeds 512 KiB; request fewer files');
          }
          guard();
          await workspace.apply(operationKey, stage, reply.edits);
          checkResults = await journal.memo(`${operationKey}/checks`, () => checks.run(manifest.permissions.checks.filter(check => stage.checks.includes(check.id)), operationKey, controller.signal));
          if (checkResults.length !== stage.checks.length || stage.checks.some(id => !checkResults.some(check => check.id === id))) throw new Pause('Required check evidence is missing', 'evidence');
          guard();
          const allPassed = checkResults.every(check => check.passed === true);
          let feedback;
          if (!allPassed) {
            // Deterministic verdict first: a failing check never spends a Codex call.
            feedback = `Required checks failed: ${checkResults.filter(check => !check.passed).map(check => check.id).join(', ')}. Read the check output and repair it in the next attempt.`;
          } else {
            const reviewKey = `${operationKey}/review`;
            const priorCalls = frontierCalls(journal).filter(event => event.data.kind === 'review' && event.data.stageId === stage.id);
            const legacyRounds = journal.events.filter(event => event.type === 'attempt.finished' && event.data.stageId === stage.id && event.data.review).length;
            if (!journal.completed(reviewKey) && Math.max(priorCalls.length, legacyRounds) >= reviewRounds) {
              throw new Pause(`Codex review budget of ${reviewRounds} calls is spent; inspect the stage before continuing`, 'needs_review');
            }
            reviewRound = priorCalls.find(event => event.data.key === reviewKey)?.data.round ?? Math.max(priorCalls.length, legacyRounds) + 1;
            const raw = await workspace.evidence();
            const compact = compactFiles(raw.newFiles, REVIEW_CONTEXT_BYTES);
            const diff = raw.diff.length > DIFF_LIMIT ? raw.diff.slice(0, DIFF_LIMIT) + '\n[diff truncated; inspect the worktree directly]' : raw.diff;
            const evidence = { diff, diffTruncated: raw.diff.length > DIFF_LIMIT, newFiles: compact.files, newFilesTruncated: compact.truncated,
              checks: checkResults.map(check => ({ ...check, stdout: check.stdout?.slice(-CHECK_TAIL), stderr: check.stderr?.slice(-CHECK_TAIL),
                outputTruncated: (check.stdout?.length ?? 0) > CHECK_TAIL || (check.stderr?.length ?? 0) > CHECK_TAIL })),
              ...(stage.kind === 'verification' ? { acceptedDiffs: await workspace.acceptedDiffs() } : {}) };
            const reviewInput = { brief: manifest.brief, approvedPlan: manifest.plan, stage, assignment: assignmentWithHistory,
              acceptedStages: summarize(journal).stages.filter(item => item.status === 'accepted'),
              workerSummary: reply.summary, evidence };
            review = await provider(reviewKey, async s => {
              const spent = frontierCalls(journal).filter(event => event.data.kind === 'review' && event.data.stageId === stage.id).length;
              if (Math.max(spent, legacyRounds) >= reviewRounds) throw new Pause('Codex review call budget is spent', 'needs_review');
              await beforeReview?.({ journal, stage, reviewKey });
              guard();
              const started = now(), callId = randomUUID();
              await journal.append('frontier.call.started', { callId, kind: 'review', key: reviewKey, stageId: stage.id, round: Math.max(spent, legacyRounds) + 1 });
              try {
                const value = await frontier.reviewCode(reviewInput, s);
                await journal.append('frontier.call', { callId, kind: 'review', key: reviewKey, stageId: stage.id, round: Math.max(spent, legacyRounds) + 1, durationMs: now() - started, decision: value?.decision ?? 'returned' });
                return value;
              } catch (error) {
                await journal.append('frontier.call', { callId, kind: 'review', key: reviewKey, stageId: stage.id, round: Math.max(spent, legacyRounds) + 1, durationMs: now() - started, decision: 'error' });
                throw error;
              }
            }, reviewInput);
            reviewRound = journal.events.findLast(event => event.type === 'frontier.call' && event.data.kind === 'review' && event.data.key === reviewKey)?.data.round ?? reviewRound;
            if (!['accept', 'revise', 'blocked'].includes(review?.decision) || typeof review.feedback !== 'string' || !Array.isArray(review.unverified)) throw new Pause('Invalid frontier review', 'provider');
            if (review.decision === 'blocked') throw new Pause(review.feedback, 'blocked');
            feedback = review.feedback;
          }
          accepted = allPassed && review?.decision === 'accept';
          await journal.append('attempt.finished', { key, stageId: stage.id, role: 'local', number, accepted, feedback,
            review: review?.decision ?? null, unverified: review?.unverified ?? [],
            checks: checkResults.map(({ id, passed, code, stdout, stderr }) => ({ id, passed, code, stdout: stdout?.slice(-CHECK_TAIL), stderr: stderr?.slice(-CHECK_TAIL) })) });
          // Stop before spending another DeepSeek attempt that cannot be accepted.
          if (!accepted && review?.decision === 'revise' && reviewRound >= reviewRounds) {
            throw new Pause(`Checks pass but Codex asked for revisions twice; revise the plan, widen checks, or accept the work manually`, 'needs_review');
          }
        } catch (error) {
          if (!(error instanceof AttemptError)) throw error;
          await journal.append('attempt.finished', { key, stageId: stage.id, role: 'local', number, accepted: false, feedback: error.message, checks: [] });
        }
        if (accepted) break;
      }
      if (!accepted) throw new Pause(`Stage ${stage.id} did not pass after ${attemptsLimit} DeepSeek attempts and ${reviewRounds} review rounds; resume with --extend-attempts or revise the plan`, 'needs_review');
      guard();
      const checkpoint = await journal.memo(`${stage.id}/checkpoint`, () => workspace.checkpoint(stage));
      await journal.append('stage.accepted', { stageId: stage.id, ...checkpoint });
      await writeReport(journal);
    }
    await journal.append('run.finished', { status: 'accepted', reason: 'Every approved stage passed its checks and Codex review' });
  } catch (error) {
    const budgetExpired = stopReason === 'Job time budget exhausted';
    const status = error instanceof Pause
      ? (['needs_review', 'blocked'].includes(error.code) ? error.code : 'paused')
      : controller.signal.aborted ? 'paused' : 'failed';
    await journal.append('run.finished', { status, reason: stopReason ?? error.message, code: budgetExpired ? 'budget' : error.code ?? 'error' });
  } finally {
    clearTimeout(timer); clearInterval(stopPoll); awake?.close();
    signal?.removeEventListener('abort', cancel);
    await release();
  }
  return writeReport(journal);
}
