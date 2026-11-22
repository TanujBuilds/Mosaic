// Historical core approvals use explicit legacy preparation; beta exercises current bound host review.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {digest} from '../src/harness/contracts.mjs';
import {resolveGuidanceEvidence} from '../src/harness/project-guidance/evidence.mjs';
import {git} from '../src/project/process.mjs';

const relatedPath = 'src/parser.mjs';
const matchingQuery = 'Update parser in src/parser.mjs';
const sourceContext = 'The parser token handling in src/parser.mjs is changing.';

async function fixture(t, {beta = false} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mosaic-project-guidance-'));
  const repo = path.join(root, 'repo');
  const c = new Coordinator({root: path.join(root, 'state'), beta, ...(beta?{selectedHost:'codex'}:{})});
  const config = {environment: 'fixture', beta};
  const provider = {complete: async () => assert.fail('Fixture must not call a model provider')};
  const dispatcher = new Dispatcher({c, worker: new Worker({c, config, provider}), config});
  t.after(async () => {
    await dispatcher.whenIdle();
    c.close();
    await rm(root, {recursive: true, force: true});
  });
  await mkdir(path.join(repo, 'src'), {recursive: true});
  await mkdir(path.join(repo, 'checks'));
  await writeFile(path.join(repo, relatedPath), 'export const parse = input => input;\n');
  await writeFile(path.join(repo, 'src/other.mjs'), 'export const other = true;\n');
  await writeFile(path.join(repo, 'checks/unit.mjs'), `import assert from 'node:assert/strict';
import {parse} from '../src/parser.mjs';
assert.equal(parse(' parser '), 'parser');
`);
  await writeFile(path.join(repo, 'checks/regression.mjs'), `import assert from 'node:assert/strict';
import {parse} from '../src/parser.mjs';
assert.equal(parse('   '), '');
`);
  for (const args of [
    ['init', '-q'], ['config', 'user.email', 'fixture@example.invalid'],
    ['config', 'user.name', 'Fixture'], ['add', '.'], ['commit', '-qm', 'base'],
  ]) await git(repo, ...args);

  const project = {
    repo,
    baseCommit: await git(repo, 'rev-parse', 'HEAD'),
    readPaths: ['src/', 'checks/'],
    writePaths: ['src/'],
    checks: [
      {id: 'parser-unit', argv: [process.execPath, 'checks/unit.mjs']},
      {id: 'parser-regression', argv: [process.execPath, 'checks/regression.mjs']},
    ],
    behavioralChecks: [{
      criterionId: 'empty-parser',
      description: 'Whitespace-only parser input returns empty text',
      checkIds: ['parser-regression'],
    }],
  };

  let sequence = 0;
  const read = (name, input) => dispatcher.invoke(name, input);
  const mutate = (name, input, key = `fixture-${++sequence}`) =>
    dispatcher.invoke(name, {...input, idempotencyKey: key});
  async function operation(name, input) {
    const pending = await mutate(name, input);
    await dispatcher.whenIdle();
    const finished = await read('operation_get', {operationId: pending.id});
    assert.equal(finished.status, 'completed', finished.error);
    return finished.result;
  }
  function prepareGoal(submissionId, overrides = {}) {
    return mutate(beta ? 'goal_prepare' : 'legacy_goal_prepare', {manifest: {
      submissionId,
      mode: 'codex_only',
      environment: 'fixture',
      objective: 'Make a scoped parser change',
      acceptance: ['Registered parser checks pass'],
      project,
      ...overrides,
    }});
  }
  async function makeGoal(submissionId, overrides) {
    const prepared = await prepareGoal(submissionId, overrides);
    return mutate('goal_activate', {goalId: prepared.id, hash: prepared.hash});
  }
  async function makeTask(goalId, submissionId, overrides = {}) {
    return mutate('task_submit', {goalId, task: {
      submissionId,
      kind: 'coding',
      actor: 'codex',
      objective: matchingQuery,
      context: sourceContext,
      acceptance: ['Retain passing project checks'],
      ...overrides,
    }});
  }
  async function maintenance(goalId) {
    const task = await makeTask(goalId, 'learning', {
      kind: 'learning',
      objective: 'Record observed parser check guidance',
      acceptance: ['Protected guidance evaluation passes'],
    });
    return mutate('native_text_start', {taskId: task.id});
  }
  async function acceptedSource(goalId, layout = 'candidate_v1') {
    const source = await makeTask(goalId, 'source');
    const started = await operation('native_start', {taskId: source.id, ...(layout && {layout})});
    await writeFile(path.join(started.native.worktree, relatedPath), 'export const parse = input => input.trim();\n');
    const finished = await operation('native_finish', {taskId: source.id, summary: 'Fixture trims parser input'});
    const currentGoal=await read('goal_get',{goalId});
    if(currentGoal.manifest.reviewPolicy){
      const item=(await read('review_inbox',{goalId})).items.find(item=>item.taskId===source.id);
      const ticket=await mutate('review_reserve',item.binding);
      await mutate('review_submit',{ticketId:ticket.ticketId,...item.binding,verdict:{decision:'accept',feedback:'Fixture host assesses the exact checked parser candidate',findings:[]}});
    }
    const action = beta && layout === 'candidate_v1' ? await read('owner_action_context', {goalId, taskId: source.id}) : null;
    const accepted = layout === 'candidate_v1'
      ? await operation('task_integrate', {taskId: source.id, feedback: 'Fixture review accepts checked parser change',
        ...(action ? {expectedIntegrationBinding: action.candidate.binding} : {})})
      : finished;
    assert.equal(accepted.status, 'accepted');
    assert.match(accepted.integration.commit, /^[a-f0-9]{40}$/);
    assert.deepEqual(accepted.integration.checks.map(({id, code, passed}) => ({id, code, passed})),
      project.checks.map(({id}) => ({id, code: 0, passed: true})));
    const combinedEvidence = accepted.integration.behavioralEvidence;
    const candidateEvidence = accepted.integration.candidateBehavioralEvidence;
    const evidence = layout === 'candidate_v1' ? [candidateEvidence, combinedEvidence] : [combinedEvidence];
    for (const receipt of evidence) {
      assert.match(receipt.snapshotHash, /^[a-f0-9]{64}$/);
      assert.match(receipt.executableModesHash, /^[a-f0-9]{64}$/);
      assert.deepEqual(receipt.criteria, [{
        ...project.behavioralChecks[0],
        checks: [{id: 'parser-regression', status: 'passed'}],
        status: 'passed',
      }]);
    }
    if (layout !== 'candidate_v1') assert.equal(candidateEvidence, undefined);
    const records = await read('learning_get', {goalId});
    const kind = layout === 'candidate_v1' ? 'task.integrated' : 'task.native_finished';
    const outcome = records.outcome.find(o => o.taskId === source.id && o.kind === kind);
    assert.ok(outcome, `Missing captured ${kind} outcome`);
    return {accepted, outcome};
  }
  const retrieve = (goalId, query = matchingQuery, capability = 'coding') =>
    read('memory_retrieve', {goalId, query, capability});
  return {c, project, read, mutate, operation, prepareGoal, makeGoal, makeTask, maintenance, acceptedSource, retrieve};
}

function proposalFor(project, outcome, overrides = {}) {
  return {
    family: 'project_check_guidance',
    scope: 'project',
    parameters: {
      checkIds: project.checks.map(check => check.id),
      checkDefinitionHashes: Object.fromEntries(project.checks.map(check => [check.id, digest(check)])),
      relatedPaths: [relatedPath],
      whenTerms: ['parser'],
    },
    evidence: [outcome.id],
    rationale: 'These checks passed during the parser integration.',
    ...overrides,
  };
}

function changedCheckProject(project) {
  return {...project, checks: project.checks.map(check =>
    check.id === 'parser-unit' ? {...check, argv: [...check.argv, 'changed']} : check)};
}

test('project guidance public lifecycle demo', async t => {
  const f = await fixture(t);
  const goal = await f.makeGoal('source');
  const {accepted, outcome} = await f.acceptedSource(goal.id);
  t.diagnostic(`Fixture review and real Git integration ${accepted.integration.commit.slice(0, 12)}. Local sandbox checks passed: ${accepted.integration.checks.map(c => c.id).join(', ')}. The mapped parser regression passed on the candidate and combined checkout.`);
  assert.deepEqual(await f.retrieve(goal.id), []);

  const task = await f.maintenance(goal.id);
  const proposal = proposalFor(f.project, outcome, {rationale: 'UNTRUSTED_RATIONALE_SENTINEL'});
  const propose = (raw, key) => f.mutate('learning_propose', {taskId: task.id, proposal: raw}, key);
  const adversarial = {...proposal, parameters: {...proposal.parameters, argv: ['sh', '-c', 'exit 0']}};
  await assert.rejects(propose(adversarial, 'invalid'), /unknown field argv/i);
  await assert.rejects(propose(adversarial, 'invalid'), /unknown field argv/i);
  assert.equal((await f.read('task_get', {taskId: task.id})).attempts, 1);
  await assert.rejects(propose(proposal, 'invalid'), /idempotency|conflict/i);
  t.diagnostic('An injected argv field was rejected. The invalid proposal spent one attempt. Exact replay spent no additional attempt.');

  const candidate = await propose(proposal, 'valid');
  assert.equal(candidate.status, 'candidate');
  assert.doesNotMatch(candidate.content, /UNTRUSTED_RATIONALE_SENTINEL/);
  assert.equal((await propose(proposal, 'valid')).id, candidate.id);
  await assert.rejects(propose(proposal, 'third'), /exhausted/i);
  const counter = await f.read('task_get', {taskId: task.id});
  assert.equal(counter.attempts, 2);
  assert.equal(counter.spent.model, 0);
  assert.equal(counter.deadline, task.deadline);
  await assert.rejects(f.mutate('learning_promote', {lessonId: candidate.id}), /evaluation/i);
  await assert.rejects(f.mutate('learning_evaluate', {
    lessonId: candidate.id,
    protectedCases: [{expectedMatch: true}],
  }), /unknown field protectedCases/i);
  assert.deepEqual((await f.read('learning_get', {goalId: goal.id})).evaluation, []);
  t.diagnostic('Dispatcher rejected supplied evaluator cases before recording an evaluation.');

  const evaluation = await f.mutate('learning_evaluate', {lessonId: candidate.id});
  assert.equal(evaluation.passed, true, JSON.stringify(evaluation.cases));
  assert.ok(evaluation.cases.some(row => row.role === 'regression'));
  assert.ok(evaluation.cases.filter(row => row.role === 'heldout').length >= 2);
  const active = await f.mutate('learning_promote', {lessonId: candidate.id});
  assert.equal(active.status, 'active');
  assert.equal(active.evaluationId, evaluation.id);
  const inspected = await f.read('learning_get', {goalId: goal.id});
  assert.ok(inspected.evaluation.some(record => record.id === evaluation.id && record.passed));
  t.diagnostic(`Native proposal evaluated with ${evaluation.evaluatorVersion} and promoted as lesson version ${active.version}.`);

  const queryGoal = await f.makeGoal('same-project');
  const [packet, ...others] = await f.retrieve(queryGoal.id);
  assert.deepEqual(others, []);
  assert.equal(packet.id, active.id);
  assert.equal(packet.version, active.version);
  assert.equal(packet.recipeHash, active.recipeHash);
  assert.deepEqual(packet.evidence, [outcome.id]);
  assert.deepEqual(packet.explanation, {matchedPaths: [relatedPath], matchedTerms: ['parser']});
  assert.ok(Buffer.byteLength(JSON.stringify([packet])) <= 8192);
  assert.deepEqual(await f.retrieve(queryGoal.id, 'Update parser in src/parser.mjs.extra'), []);
  assert.deepEqual(await f.retrieve(queryGoal.id, 'Update tokenizer in src/parser.mjs'), []);
  assert.deepEqual(await f.retrieve(queryGoal.id, matchingQuery, 'consult'), []);

  const followUp = await f.makeTask(queryGoal.id, 'follow-up', {permissions: {
    readPaths: f.project.readPaths,
    writePaths: [relatedPath],
    checks: f.project.checks.map(check => check.id),
  }});
  const started = await f.operation('native_start', {taskId: followUp.id, layout: 'candidate_v1'});
  assert.deepEqual(started.memory, [packet]);
  assert.deepEqual(started.spec.permissions, followUp.spec.permissions);
  const pinned = JSON.stringify(started.memory);
  const readPinned = async () => JSON.stringify((await f.read('task_get', {taskId: followUp.id})).memory);
  t.diagnostic(`Pinned version ${packet.version} for path ${packet.explanation.matchedPaths.join(', ')} and term ${packet.explanation.matchedTerms.join(', ')}. Source outcome ${outcome.id}. Original check plan is unchanged.`);

  const restrictedTask = await f.makeTask(queryGoal.id, 'restricted-read-scope', {permissions: {
    readPaths: ['src/other.mjs', 'checks/'],
    writePaths: ['src/other.mjs'],
    checks: followUp.spec.permissions.checks,
  }});
  const restricted = await f.operation('native_start', {taskId: restrictedTask.id, layout: 'candidate_v1'});
  assert.deepEqual(restricted.memory, []);
  assert.deepEqual(restricted.spec.permissions, restrictedTask.spec.permissions);

  const other = await f.prepareGoal('renamed-project', {project: {...f.project, repo: f.project.repo + '-renamed'}});
  const differentEnvironment = await f.prepareGoal('different-environment', {environment: 'live'});
  assert.deepEqual(await f.retrieve(other.id), []);
  assert.deepEqual(await f.retrieve(differentEnvironment.id), []);
  const stale = await f.makeGoal('changed-check', {project: changedCheckProject(f.project)});
  assert.deepEqual(await f.retrieve(stale.id), []);
  const staleTask = await f.makeTask(stale.id, 'stale-new-task', {permissions: {
    readPaths: f.project.readPaths,
    writePaths: ['src/stale.mjs'],
    checks: f.project.checks.map(check => check.id),
  }});
  const staleStarted = await f.operation('native_start', {taskId: staleTask.id, layout: 'candidate_v1'});
  assert.deepEqual(staleStarted.memory, []);
  assert.deepEqual(staleStarted.spec.permissions.checks, followUp.spec.permissions.checks);
  assert.equal(await readPinned(), pinned);
  t.diagnostic('The same parser-unit ID with changed argv produced empty recall for a new task. The running task kept its original memory bytes.');

  const correctionGoal = await f.makeGoal('correction');
  const correctionTask = await f.maintenance(correctionGoal.id);
  const correction = await f.mutate('learning_correct', {
    lessonId: active.id,
    taskId: correctionTask.id,
    parameters: {
      ...proposal.parameters,
      checkIds: ['parser-unit'],
      checkDefinitionHashes: {'parser-unit': proposal.parameters.checkDefinitionHashes['parser-unit']},
    },
    rationale: 'Narrow the guidance to the unit check.',
  });
  assert.ok(correction.version > active.version);
  assert.equal(correction.correctedFrom, active.id);
  assert.equal((await f.retrieve(queryGoal.id))[0].id, active.id);
  await assert.rejects(f.mutate('learning_promote', {lessonId: correction.id}), /evaluation/i);
  const correctedEvaluation = await f.mutate('learning_evaluate', {lessonId: correction.id});
  assert.equal(correctedEvaluation.passed, true, JSON.stringify(correctedEvaluation.cases));
  await f.mutate('learning_promote', {lessonId: correction.id});
  assert.equal((await f.retrieve(queryGoal.id))[0].id, correction.id);
  await f.mutate('learning_rollback', {lessonId: correction.id});
  assert.equal((await f.retrieve(queryGoal.id))[0].id, active.id);
  assert.deepEqual(await f.retrieve(stale.id), []);
  assert.equal(await readPinned(), pinned);
  t.diagnostic('A separately evaluated correction was promoted and rolled back. The restored version remained inapplicable under the changed check.');

  await f.mutate('learning_quarantine', {lessonId: active.id, reason: 'Fixture quarantine'});
  assert.deepEqual(await f.retrieve(queryGoal.id), []);
  await f.mutate('learning_archive', {lessonId: active.id, reason: 'Fixture archive'});
  assert.deepEqual(await f.retrieve(queryGoal.id), []);
  assert.equal(await readPinned(), pinned);
  assert.equal((await f.read('learning_get', {goalId: goal.id})).lesson.find(record => record.id === active.id).status, 'archived');

  for (const assignment of [task, correctionTask]) {
    const finished = await f.mutate('native_text_finish', {taskId: assignment.id, content: 'Fixture protected evaluation complete'});
    assert.equal(finished.status, 'accepted');
  }
  for (const taskId of [followUp.id, restrictedTask.id, staleTask.id]) {
    await f.mutate('work_control', {taskId, action: 'stop'});
    await f.operation('native_release', {taskId, reason: 'Fixture writer confirmed quiescent'});
  }
  t.diagnostic('Quarantine and archive prevented future recall. The existing task retained its pinned version throughout.');
});

test('promotion requires unchanged candidate and source evidence under the original deadline', async t => {
  const f = await fixture(t, {beta: true});
  const goal = await f.makeGoal('native-source');
  const {outcome} = await f.acceptedSource(goal.id);
  // Advance the source approval, so evidence must still bind to the old,
  // accepted task version even when today's goal registers another definition.
  const {schema, capabilities, reviewPolicyHash, ...manifest} = goal.manifest;
  const revision = await f.mutate('goal_revision_prepare', {
    goalId: goal.id,
    expectedHash: goal.hash,
    manifest: {
      ...manifest,
      mode: manifest.mode.id,
      modeVersion: manifest.mode.version,
      project: changedCheckProject(f.project),
    },
  });
  await f.mutate('goal_revision_activate', {revisionId: revision.id, hash: revision.hash});

  const maintenanceGoal = await f.makeGoal('native-maintenance');
  const maintenance = await f.maintenance(maintenanceGoal.id);
  await assert.rejects(f.mutate('learning_propose', {
    taskId: maintenance.id,
    proposal: proposalFor(f.project, outcome, {scope: 'general'}),
  }), /project-only/i);
  assert.equal((await f.read('task_get', {taskId: maintenance.id})).attempts, 1);
  const sourceTask=f.c.store.get('task',outcome.taskId),sourceTicket=f.c.store.get('review_ticket',sourceTask.reviewAcceptance.ticketId);
  f.c.store.put('review_ticket',{...sourceTicket,verdictHash:'0'.repeat(64)});
  assert.throws(()=>resolveGuidanceEvidence({c:f.c,maintenanceTaskId:maintenance.id,outcomeIds:[outcome.id]}),/review ticket/i);
  f.c.store.put('review_ticket',sourceTicket);
  const candidate = await f.mutate('learning_propose', {taskId: maintenance.id, proposal: proposalFor(f.project, outcome)});
  assert.equal((await f.mutate('learning_evaluate', {lessonId: candidate.id})).passed, true);

  // Only the disposable store is altered. Both attempts exercise public promote.
  const savedLesson = f.c.store.get('lesson', candidate.id);
  f.c.store.put('lesson', {...savedLesson, content: 'Changed rendered guidance'});
  await assert.rejects(f.mutate('learning_promote', {lessonId: candidate.id}), /evaluation|changed|integrity|binding/i);
  f.c.store.put('lesson', savedLesson);

  const savedOutcome = f.c.store.get('outcome', outcome.id);
  f.c.store.put('outcome', {...savedOutcome, sourceHash: '0'.repeat(64)});
  await assert.rejects(f.mutate('learning_promote', {lessonId: candidate.id}), /evidence|integrity|source/i);
  f.c.store.put('outcome', savedOutcome);
  assert.deepEqual(await f.retrieve(maintenanceGoal.id), []);

  f.c.now = () => maintenance.deadline + 1;
  await assert.rejects(f.mutate('learning_promote', {lessonId: candidate.id}), /deadline|expired/i);
  const expired = await f.read('task_get', {taskId: maintenance.id});
  assert.equal(expired.attempts, 2);
  assert.equal(expired.deadline, maintenance.deadline);
  assert.equal(expired.spent.model, 0);
  assert.deepEqual(await f.retrieve(maintenanceGoal.id), []);
});

test('public recall enforces a shared four-item and 8 KiB limit', async t => {
  const f = await fixture(t);
  const goal = await f.makeGoal('recall-budget');
  const {outcome} = await f.acceptedSource(goal.id);
  const task = await f.maintenance(goal.id);
  const lesson = await f.mutate('learning_propose', {taskId: task.id, proposal: proposalFor(f.project, outcome)});
  assert.equal((await f.mutate('learning_evaluate', {lessonId: lesson.id})).passed, true);
  const active = await f.mutate('learning_promote', {lessonId: lesson.id});

  // Synthetic legacy packets stress aggregate limits beyond the demo's normal
  // promotion history. Retrieval itself runs through the real public tool.
  const legacyPackets = Array.from({length: 5}, (_, i) => ({
    id: `budget-${i}`,
    version: i + 1,
    status: 'active',
    scope: 'project',
    family: 'edit_batch',
    projectKey: active.projectKey,
    recipe: {family: 'edit_batch', maxFiles: 1, maxBytes: 24576},
    recipeHash: digest({family: 'edit_batch', maxFiles: 1, maxBytes: 24576}),
    content: 'Retain a bounded parser edit batch.',
    evidence: [],
    applicability: active.applicability,
  }));
  const index = f.c.store.db.prepare('INSERT INTO memory_fts(lesson_id,content) VALUES(?,?)');
  for (const record of legacyPackets) {
    f.c.store.put('lesson', record);
    index.run(record.id, record.content);
  }
  const small = await f.retrieve(goal.id);
  assert.equal(small.length, 4);
  assert.ok(small.some(packet => packet.id === active.id));

  for (const record of legacyPackets) {
    f.c.store.put('lesson', {...record, content: record.content + 'x'.repeat(2900)});
  }
  const large = await f.retrieve(goal.id);
  assert.ok(large.length > 1 && large.length < 4);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) <= 8192);

  // Simulate an oversized saved guidance packet without altering the fixtures
  // used by the evaluator or disabling normal legacy recall.
  f.c.store.put('lesson', {...f.c.store.get('lesson', active.id), content: 'x'.repeat(8192)});
  for (const record of legacyPackets) f.c.store.put('lesson', record);
  const withoutOversizedGuidance = await f.retrieve(goal.id);
  assert.equal(withoutOversizedGuidance.length, 4);
  assert.ok(withoutOversizedGuidance.every(packet => packet.id !== active.id));
  assert.ok(Buffer.byteLength(JSON.stringify(withoutOversizedGuidance)) <= 8192);
});

test('public guidance rollback preserves disabled history and one active version', async t => {
  const f = await fixture(t);
  const source = await f.makeGoal('rollback-source');
  const {outcome} = await f.acceptedSource(source.id);

  let sequence = 0;
  async function promote() {
    const goal = await f.makeGoal(`rollback-version-${++sequence}`);
    const task = await f.maintenance(goal.id);
    const candidate = await f.mutate('learning_propose', {taskId: task.id, proposal: proposalFor(f.project, outcome)});
    assert.equal((await f.mutate('learning_evaluate', {lessonId: candidate.id})).passed, true);
    const active = await f.mutate('learning_promote', {lessonId: candidate.id});
    await f.mutate('native_text_finish', {taskId: task.id, content: 'Fixture evaluation complete'});
    return active;
  }

  for (const [tool, status] of [['learning_quarantine', 'quarantined'], ['learning_archive', 'archived']]) {
    await t.test(`rollback cannot restore ${status} guidance`, async () => {
      const previous = await promote();
      const current = await promote();
      await f.mutate(tool, {lessonId: previous.id, reason: 'Fixture disables previous guidance'});

      await assert.rejects(f.mutate('learning_rollback', {lessonId: previous.id}), /only active.*roll back/i);
      await f.mutate('learning_rollback', {lessonId: current.id});
      assert.deepEqual(await f.retrieve(source.id), []);
      const inspected = await f.read('learning_get', {goalId: source.id});
      assert.equal(inspected.lesson.find(record => record.id === previous.id).status, status);
    });
  }

  await t.test('rollback rejects a superseded target and replays an exact active rollback', async () => {
    await promote();
    const previous = await promote();
    const current = await promote();
    await assert.rejects(f.mutate('learning_rollback', {lessonId: previous.id}), /only active.*roll back/i);
    assert.deepEqual((await f.retrieve(source.id)).map(packet => packet.id), [current.id]);

    const input = {lessonId: current.id};
    const result = await f.mutate('learning_rollback', input, 'active-guidance-rollback');
    assert.deepEqual((await f.retrieve(source.id)).map(packet => packet.id), [previous.id]);
    assert.deepEqual(await f.mutate('learning_rollback', input, 'active-guidance-rollback'), result);
    await assert.rejects(f.mutate('learning_rollback', input), /only active.*roll back/i);
  });
});
