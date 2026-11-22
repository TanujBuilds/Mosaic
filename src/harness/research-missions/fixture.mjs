import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {lstat, mkdir, realpath, rename, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {windowsFile} from '../../beta/windows-files.mjs';
import {Coordinator} from '../coordinator.mjs';
import {Integration} from '../integration.mjs';
import {ResearchAdapter} from '../research.mjs';
import {Dispatcher} from '../tools.mjs';

const exec = promisify(execFile);
const windows = process.platform === 'win32';
const driver = fileURLToPath(new URL('./fixture-driver.py', import.meta.url));
const fixture = {
  sourceBasis: 'invented_local_sources',
  reviewer: 'simulated_independent_reviewer',
  liveValidation: 'not_run',
};
const brief = {
  question: 'How do a fictional lease queue and journal queue recover entries after process restart?',
  scope: 'Invented lease and journal specifications and one invented staging note. Compare restart recovery and limits.',
  outputShape: 'Conditional comparison, cited claims, unresolved source disagreement and remaining questions.',
  asOf: '2026-11-10',
};
const policy = {
  version: 3, finish: 'selectors_only', discovery: 'search_required',
  repairContextVersion: 1, correctionStrategy: 'targeted_v1',
  review: {version: 1, role: 'independent_operator', maxRounds: 2, maxRevisions: 1,
    maxCorrectionModelCalls: 2, rubricSha256: 'b'.repeat(64)},
};
const json = value => JSON.stringify(value, null, 2) + '\n';

async function claimOutput(output) {
  if (!path.isAbsolute(output) || output.split(path.sep).includes('..')) {
    throw Error('Use an absolute fresh path under the system temp directory');
  }
  const temp = await realpath(os.tmpdir());
  const normalized = path.resolve(output);
  // macOS provides OS aliases for the roots themselves. Reject symlinks
  // beneath the real temp root, including an aliased output parent.
  const prefixes = [path.resolve(os.tmpdir()), temp];
  const relative = prefixes.map(root => path.relative(root, normalized))
    .find(value => value && value !== '..' && !value.startsWith('..' + path.sep) && !path.isAbsolute(value));
  if (!relative) throw Error('Use a fresh path under the system temp directory');
  const parts = relative.split(path.sep);
  let parent = temp;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    const info = await lstat(parent);
    if (info.isSymbolicLink() || !info.isDirectory()) throw Error('Unsafe output parent or symlink');
  }
  const directory = path.join(parent, parts.at(-1));
  if (windows) {
    try {
      await windowsFile('private-directory', parent);
    } catch (error) {
      throw Error('Use a caller-owned, private Windows temp parent', {cause: error});
    }
    // Create with an explicit user owner and private ACL, then publish to a
    // fresh name. Windows directory renames fail if the destination exists.
    const staging = path.join(parent, '.mosaic-fixture-' + randomUUID());
    await windowsFile('mkdir', staging);
    try {
      await rename(staging, directory);
    } catch (error) {
      if (await lstat(directory).catch(failure => {
        if (failure.code !== 'ENOENT') throw failure;
      })) throw Error('Demo output must be a fresh directory', {cause: error});
      throw error;
    } finally {
      await rm(staging, {recursive: true, force: true});
    }
    await windowsFile('private-directory', directory);
    return directory;
  }
  const parentInfo = await lstat(parent);
  if (parentInfo.uid !== process.getuid?.() || (parentInfo.mode & 0o022) !== 0) {
    throw Error('Use a caller-owned, private temp parent created with mktemp -d');
  }
  try {
    await mkdir(directory, {mode: 0o700});
  } catch (error) {
    if (error.code === 'EEXIST') throw Error('Demo output must be a fresh directory');
    throw error;
  }
  return directory;
}

export async function runFixtureMission(output) {
  const root = await claimOutput(output);
  const coordinator = path.join(root, 'coordinator');
  const python = process.env.FRONTIER_TEST_PYTHON ?? (windows ? 'python.exe' : 'python3');
  const config = {environment: 'fixture', research: {pollMs: 0}};
  const stages = [];
  const checks = {};
  let c, dispatcher, adapter, owner;

  async function runPython(args, packet) {
    const child = exec(python, ['-ISB', '-X', 'utf8', driver, root, ...args],
      {timeout: 15_000, maxBuffer: 2 * 1024 * 1024});
    child.child.stdin.on('error', () => {});
    child.child.stdin.end(packet === undefined ? undefined : JSON.stringify(packet));
    try {
      return JSON.parse((await child).stdout);
    } catch (error) {
      throw Error('Offline research fixture failed: ' + (error.stderr?.trim().slice(-4000) || error.message));
    }
  }

  const open = () => {
    c = new Coordinator({root: coordinator});
    owner = randomUUID();
    c.acquireWorker(owner);
    // No worker service, provider client or background scheduler is started.
    const worker = {c, config, integration: new Integration({c}), adapters: {}};
    adapter = new ResearchAdapter(worker, {
      rpc: request => runPython(['rpc'], request),
      collect: (packet, destination) => {
        if (destination !== path.join(coordinator, 'research-results')) {
          throw Error('Unexpected offline collection destination');
        }
        return runPython(['collect'], packet);
      },
    });
    worker.adapters.research = adapter;
    dispatcher = new Dispatcher({c, worker, config});
  };
  const close = () => {
    if (!c) return;
    const current = c;
    c = undefined;
    try { current.releaseWorker(owner); }
    finally { current.close(); }
  };
  const call = (name, input) => dispatcher.invoke(name, input);
  const step = taskId => {
    const task = c.getTask(taskId);
    const owned = task.owner === owner ? task : c.claimNext(owner);
    if (owned?.id !== taskId) throw Error('Unexpected fixture task ownership');
    return adapter.step(owned, owner);
  };
  const drive = (remoteJobId, stage) => runPython([stage, remoteJobId]);

  async function review(input) {
    const operation = await call('research_review', input);
    await dispatcher.whenIdle();
    const result = await call('operation_get', {operationId: operation.id});
    if (result.status !== 'completed') throw Error(result.error ?? 'Research review did not complete');
    return result.result;
  }

  async function expectReviewFailure(input, pattern) {
    try {
      await review(input);
    } catch (error) {
      if (pattern.test(error.message)) return true;
      throw error;
    }
    throw Error('Offline fixture review unexpectedly succeeded');
  }

  async function record(taskId, status, name) {
    const task = c.getTask(taskId);
    const input = {taskId, limit: 20};
    const view = await call('research_mission_inspect', input);
    if (view.status !== status) {
      throw Error(`Fixture expected ${status}, got ${view.status}: ${JSON.stringify(view.diagnostics ?? [])}`);
    }
    stages.push({
      name, status, sourceStatus: task.status, goalId: task.goalId, taskId,
      candidateHash: view.review?.candidateHash ?? null,
      remoteJobId: task.checkpoint.remoteJobId,
      goalDeadline: c.getGoal(task.goalId).deadline, deadline: task.deadline,
      reviews: task.reviews, remoteSpent: task.remoteSpent,
    });
    if (name === 'initial-pending') return;
    const [exported, markdown] = await Promise.all([
      call('research_mission_export', {...input, format: 'json'}),
      call('research_mission_export', {...input, format: 'markdown'}),
    ]);
    const label = '> Offline fixture with invented local sources and a simulated independent reviewer.\n\n';
    await Promise.all([
      writeFile(path.join(root, name + '.json'), json({...exported, fixture}), {flag: 'wx', mode: 0o600}),
      writeFile(path.join(root, name + '.md'), label + markdown.content, {flag: 'wx', mode: 0o600}),
    ]);
  }

  async function submitFixture(scenario) {
    const acceptance = ['Preserve source conditions and cite exact passages'];
    const goal = await call('legacy_goal_prepare', {
      manifest: {submissionId: scenario, objective: brief.question, acceptance, environment: 'fixture',
        mode: 'collaborative', scope: {includeDomains: ['fixture.invalid']}, researchPolicy: policy},
      idempotencyKey: scenario + '-goal',
    });
    await call('research_mission_prepare', {
      goalId: goal.id, expectedGoalHash: goal.hash, brief, idempotencyKey: scenario + '-brief',
    });
    await call('goal_activate', {goalId: goal.id, hash: goal.hash, idempotencyKey: scenario + '-activate'});
    const task = await call('task_submit', {
      goalId: goal.id,
      task: {submissionId: scenario, kind: 'research', objective: brief.question,
        acceptance, limits: {questions: 0, seconds: 120, modelCalls: 4, searches: 1, downloads: 1, reviews: 2}},
      idempotencyKey: scenario + '-task',
    });
    await step(task.id);
    const linked = await step(task.id);
    const jobId = linked.checkpoint.remoteJobId;
    if (!jobId) throw Error(linked.reason ?? 'Fixture failed to save the approved research job identity');
    await drive(jobId, 'initial');
    const pending = await step(task.id);
    if (pending.status !== 'awaiting_review') throw Error(pending.reason ?? 'Fixture did not stage a candidate');
    return {taskId: task.id, jobId, descriptor: pending.checkpoint.reviewCandidate};
  }

  try {
    open();
    const {taskId, jobId, descriptor: initial} = await submitFixture('targeted-repair');
    const binding = {taskId, candidateHash: initial.candidateHash, rubricHash: initial.rubricSha256};
    await record(taskId, 'awaiting_review', 'initial-pending');
    const reserve = {...binding, action: 'reserve', idempotencyKey: 'reserve-original'};
    const ticket = await review(reserve);

    // Reopen against the same durable coordinator records at a quiescent
    // boundary. Every Python fixture action also uses a fresh process.
    close();
    open();
    const replay = await review(reserve);
    checks.reservationReplay = replay.id === ticket.id && c.getTask(taskId).reviews === 1;
    if (!checks.reservationReplay) throw Error('Research reservation replay changed its identity or spending');

    await review({...binding, action: 'submit', decision: 'revise', ticketId: ticket.id,
      findings: [{unit: 'claims:C1', code: 'lost_condition',
        message: 'The cited lease passage permits recovery only while the lease is valid.', evidence: []}],
      coverage: initial.units, idempotencyKey: 'revise-original'});
    await record(taskId, 'revision_needed', 'revision-needed');

    close();
    open();
    await drive(jobId, 'correct');
    const revised = await step(taskId);
    if (revised.status !== 'awaiting_review') throw Error(revised.reason ?? 'Fixture did not stage the repair');
    const fresh = revised.checkpoint.reviewCandidate;
    if (fresh.version !== 2 || fresh.assembly.baseCandidateHash !== initial.candidateHash ||
        fresh.sourcesSha256 !== initial.sourcesSha256 || fresh.reportSha256 === initial.reportSha256) {
      throw Error('Offline targeted repair lost its base report or source binding');
    }
    await record(taskId, 'awaiting_review', 'fresh-pending');
    checks.staleCandidateRejected = await expectReviewFailure(
      {...binding, action: 'reserve', idempotencyKey: 'reserve-stale'}, /stale/i);
    const freshBinding = {...binding, candidateHash: fresh.candidateHash};
    const freshTicket = await review({...freshBinding, action: 'reserve', idempotencyKey: 'reserve-fresh'});
    const accept = {...freshBinding, action: 'submit', ticketId: freshTicket.id, decision: 'accept',
      findings: [], coverage: fresh.units, idempotencyKey: 'accept-fresh'};
    checks.incompleteCoverageRejected = await expectReviewFailure(
      {...accept, coverage: fresh.units.slice(1), idempotencyKey: 'accept-incomplete'}, /full unique coverage/i);
    const verdict = await review(accept);
    close();
    open();
    const replayedVerdict = await review(accept);
    checks.fullReviewReplay = replayedVerdict.ticketId === verdict.ticketId && c.getTask(taskId).reviews === 2;
    if (!checks.fullReviewReplay) throw Error('Research acceptance replay changed its identity or spending');
    checks.changedReplayRejected = await expectReviewFailure({...accept, coverage: fresh.units.slice(1)}, /conflict/i);
    await drive(jobId, 'finalize');
    const done = await step(taskId);
    if (done.status !== 'accepted') throw Error(done.reason ?? 'Fixture receipt was not accepted');
    await record(taskId, 'accepted', 'accepted');

    const partial = await submitFixture('cannot-repair');
    const partialBinding = {taskId: partial.taskId, candidateHash: partial.descriptor.candidateHash,
      rubricHash: partial.descriptor.rubricSha256};
    const partialTicket = await review({...partialBinding, action: 'reserve', idempotencyKey: 'reserve-partial'});
    await review({...partialBinding, action: 'submit', decision: 'revise', ticketId: partialTicket.id,
      findings: [{unit: 'claims:C1', code: 'material_omission',
        message: 'Determine whether the previous release differs. Its versioned documentation is outside the retained source catalog.',
        evidence: []}], coverage: partial.descriptor.units, idempotencyKey: 'revise-partial'});
    await drive(partial.jobId, 'decline');
    const incomplete = await step(partial.taskId);
    if (incomplete.status !== 'partial') throw Error(incomplete.reason ?? 'Fixture did not finalize a partial report');
    await record(partial.taskId, 'partial', 'partial');
  } finally {
    close();
  }

  await writeFile(path.join(root, 'transcript.json'), json({
    schemaVersion: 1, generatedAt: new Date().toISOString(), fixture, sourceRevision: null,
    sourceRevisionReason: 'The fixture goals have no approved source checkout.',
    explanation: 'Fixture stage snapshots come from the same approved job and durable review operations. Search and model counters represent scripted local responses.',
    stages, checks,
  }), {flag: 'wx', mode: 0o600});
  return {fixture: true, output: root, transcript: 'transcript.json', statuses: stages.map(row => row.status)};
}
