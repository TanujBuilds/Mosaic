import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {digest} from '../src/harness/contracts.mjs';
import {git} from '../src/project/process.mjs';

// Exercise the public surfaces together, with real Git/check execution and
// explicitly scripted native edits/review. No provider or installed state.
async function fixture(t, beta) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mosaic-second-composition-'));
  const repo = path.join(root, 'repo'), state = path.join(root, 'state');
  let now = Date.now(), sequence = 0, c, d;
  const config = {environment: 'fixture', beta};
  const connect = () => {
    c = new Coordinator({root: state, beta, selectedHost:'codex', now: () => now});
    const worker = new Worker({c, config, provider: {complete: async () => assert.fail('No model inference in native fixture')}});
    d = new Dispatcher({c, worker, config});
  };
  connect();
  t.after(async () => {await d.whenIdle(); c.close(); await rm(root, {recursive: true, force: true});});
  await mkdir(path.join(repo, 'src'), {recursive: true});
  await mkdir(path.join(repo, 'checks'));
  await writeFile(path.join(repo, 'src/parser.mjs'), 'export const parse = input => input;\n');
  await writeFile(path.join(repo, 'checks/unit.mjs'), "import assert from 'node:assert/strict'; import {parse} from '../src/parser.mjs'; assert.equal(parse(' parser '), 'parser');\n");
  await writeFile(path.join(repo, 'checks/empty.mjs'), "import assert from 'node:assert/strict'; import {parse} from '../src/parser.mjs'; assert.equal(parse('   '), '');\n");
  await git(repo, 'init', '-q'); await git(repo, 'add', '.');
  await git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');
  const project = {
    repo, baseCommit: await git(repo, 'rev-parse', 'HEAD'), readPaths: ['src/', 'checks/'], writePaths: ['src/'],
    checks: [{id: 'parser-unit', argv: [process.execPath, 'checks/unit.mjs']}, {id: 'parser-empty', argv: [process.execPath, 'checks/empty.mjs']}],
    behavioralChecks: [{criterionId: 'empty', description: 'Whitespace parser input becomes empty', checkIds: ['parser-empty']}],
  };
  const read = (name, input) => d.invoke(name, input);
  const mutate = (name, input, key = `composition-${++sequence}`) => d.invoke(name, {...input, idempotencyKey: key});
  const operation = async (name, input) => {
    const pending = await mutate(name, input); await d.whenIdle();
    const done = await read('operation_get', {operationId: pending.id});
    assert.equal(done.status, 'completed', done.error); return done.result;
  };
  const goal = async (submissionId, overrides = {}) => {
    const draft = await mutate('assignment_prepare', {manifest: {
      submissionId, objective: 'Correct parser in src/parser.mjs', acceptance: ['Parser checks pass'],
      environment: 'fixture', mode: 'codex_only', project,
      limits: {hours: 1, maxTasks: 10, reviewAgentRuns: 2}, ...overrides,
    }});
    assert.equal(draft.status, 'prepared');
    return mutate('goal_activate', {goalId: draft.goalId, hash: draft.hash});
  };
  return {project, goal, read, mutate, operation, current: () => c,
    restart: async () => {await d.whenIdle(); c.close(); connect();},
    expire: () => {now += 2 * 60 * 60 * 1000;},
  };
}

const query = 'Update parser in src/parser.mjs';
const itemFor = (view, id) => view.groups.flatMap(group => group.items).find(item => item.taskId === id);

for (const beta of [false, true]) test(`recipes, backlog, outcomes and learned checks compose through restart (${beta ? 'beta' : 'core'})`, async t => {
  const f = await fixture(t, beta), g = await f.goal('source');
  const parameters = {issue: query, context: 'Correct parser whitespace in src/parser.mjs',
    readPaths: ['src/parser.mjs', 'checks/'], writePaths: ['src/parser.mjs'], checks: f.project.checks.map(check => check.id)};
  const preview = await f.read('workflow_recipe_preview', {goalId: g.id, recipeId: 'bugfix', version: 1, parameters});
  assert.equal(preview.launchable, true, JSON.stringify(preview.diagnostics));
  const input = {goalId: g.id, expectedGoalHash: preview.goalHash, recipeId: 'bugfix', version: 1, parameters,
    definitionDigest: preview.definitionDigest, parameterDigest: preview.parameterDigest, previewDigest: preview.previewDigest, submissionId: 'parser-fix'};
  const recipe = await f.mutate('workflow_recipe_submit', input, 'recipe');
  const sourceId = recipe.tasks[0];
  assert.equal(recipe.tasks.length, 1);
  const task = await f.read('task_get', {taskId: sourceId});
  assert.deepEqual(task.spec.permissions, {readPaths: parameters.readPaths, writePaths: parameters.writePaths, checks: parameters.checks});
  const before = f.current().store.all('task');
  const queued = await f.read('backlog_inspect', {goalId: g.id});
  assert.ok(itemFor(queued, sourceId), 'Recipe tasks must be visible in the existing backlog');
  assert.equal(itemFor(queued, sourceId).status, 'waiting_host');
  assert.deepEqual(f.current().store.all('task'), before, 'Inspection must not create or mutate tasks');
  assert.equal(f.current().store.all('backlog_group').length, 0, 'Recipe visibility must not manufacture authoritative backlog records');

  await f.restart();
  assert.deepEqual(await f.mutate('workflow_recipe_submit', input, 'recipe'), recipe);
  assert.equal(f.current().store.all('task').length, 1);
  assert.equal((await f.read('goal_get', {goalId: g.id})).deadline, g.deadline);
  assert.equal(itemFor(await f.read('backlog_inspect', {goalId: g.id}), sourceId).status, 'waiting_host');
  const started = await f.operation('native_start', {taskId: sourceId, layout: 'candidate_v1'});
  await writeFile(path.join(started.native.worktree, 'src/parser.mjs'), 'export const parse = input => input.trim();\n');
  await f.operation('native_finish', {taskId: sourceId, summary: 'Scripted native fixture trims parser input'});
  assert.equal((await f.read('outcomes_report', {goalId: g.id})).counts.usefulAccepted, 0, 'Passing candidate checks alone are not useful acceptance');
  const item=(await f.read('review_inbox',{goalId:g.id})).items.find(item=>item.taskId===sourceId);
  const ticket=await f.mutate('review_reserve',item.binding);
  await f.mutate('review_submit',{ticketId:ticket.ticketId,...item.binding,verdict:{decision:'accept',feedback:'Scripted host assessment of protected parser candidate',findings:[]}});
  const action = beta ? await f.read('owner_action_context', {goalId: g.id, taskId: sourceId}) : null;
  const accepted = await f.operation('task_integrate', {taskId: sourceId, feedback: 'Scripted native fixture accepts checked change',
    ...(action ? {expectedIntegrationBinding: action.candidate.binding} : {})});
  assert.equal(accepted.status, 'accepted');
  assert.ok(accepted.integration.checks.every(check => check.passed));
  assert.equal(accepted.integration.behavioralEvidence.criteria[0].status, 'passed');
  assert.equal(accepted.integration.candidateBehavioralEvidence.criteria[0].status, 'passed');
  assert.equal(itemFor(await f.read('backlog_inspect', {goalId: g.id}), sourceId).status, 'accepted');
  const outcomes = await f.read('outcomes_report', {goalId: g.id});
  assert.equal(outcomes.counts.acceptedCoding, 1);
  assert.equal(outcomes.counts.usefulAccepted, 1);
  assert.equal(outcomes.usage.nativeHost.tokens, null);
  assert.equal(outcomes.tasks.filter(row => row.id === sourceId).length, 1);

  const captured = await f.read('learning_get', {goalId: g.id});
  const source = captured.outcome.find(row => row.taskId === sourceId && row.kind === 'task.integrated');
  assert.ok(source);
  const maintenance = await f.mutate('task_submit', {goalId: g.id, task: {
    submissionId: 'learn', actor: 'codex', kind: 'learning', objective: 'Record parser check guidance', acceptance: ['Protected evaluation passes'],
  }});
  await f.mutate('native_text_start', {taskId: maintenance.id});
  const lesson = await f.mutate('learning_propose', {taskId: maintenance.id, proposal: {
    family: 'project_check_guidance', scope: 'project', evidence: [source.id], rationale: 'Checks passed in this actual recipe integration',
    parameters: {checkIds: parameters.checks, checkDefinitionHashes: Object.fromEntries(f.project.checks.map(check => [check.id, digest(check)])),
      relatedPaths: ['src/parser.mjs'], whenTerms: ['parser']},
  }});
  const evaluation = await f.mutate('learning_evaluate', {lessonId: lesson.id});
  assert.equal(evaluation.passed, true, JSON.stringify(evaluation.cases));
  const active = await f.mutate('learning_promote', {lessonId: lesson.id});
  await f.mutate('native_text_finish', {taskId: maintenance.id, content: 'Fixture guidance lifecycle complete'});
  assert.equal((await f.read('outcomes_report', {goalId: g.id})).counts.usefulAccepted, 1, 'Captured learning events do not duplicate coding acceptance');

  const next = await f.goal('follow-up');
  const backlogInput = {goalId: next.id, expectedGoalHash: next.hash, expectedGoalVersion: next.version, submissionId: 'next-parser', items: [{
    key: 'parser', dependsOnKeys: [], task: {actor: 'codex', kind: 'coding', objective: query, context: parameters.context,
      acceptance: ['Parser checks remain valid'], permissions: task.spec.permissions},
  }]};
  const group = await f.mutate('backlog_submit', backlogInput, 'backlog');
  assert.deepEqual(await f.mutate('backlog_submit', backlogInput, 'backlog'), group);
  const followId = group.items[0].taskId;
  const follow = await f.operation('native_start', {taskId: followId, layout: 'candidate_v1'});
  assert.equal(follow.memory.length, 1);
  assert.equal(follow.memory[0].id, active.id);
  assert.equal(follow.memory[0].version, active.version);
  assert.deepEqual(follow.memory[0].evidence, [source.id]);
  assert.deepEqual(follow.spec.permissions, task.spec.permissions, 'Learning cannot widen recipe/backlog authority');
  const pin = JSON.stringify(follow.memory);
  const changed = await f.goal('stale-check', {project: {...f.project, checks: f.project.checks.map(check =>
    check.id === 'parser-unit' ? {...check, argv: [...check.argv, 'changed-definition']} : check)}});
  assert.deepEqual(await f.read('memory_retrieve', {goalId: changed.id, capability: 'coding', query}), []);
  await f.restart();
  assert.equal(JSON.stringify((await f.read('task_get', {taskId: followId})).memory), pin);
  assert.equal((await f.read('outcomes_report', {goalId: g.id})).counts.acceptedCoding, 1);
  f.expire();
  assert.equal((await f.read('goal_get', {goalId: next.id})).deadline, next.deadline);
  assert.notEqual(itemFor(await f.read('backlog_inspect', {goalId: next.id}), followId).status, 'ready');
  const expiredPreview = await f.read('workflow_recipe_preview', {goalId: next.id, recipeId: 'bugfix', version: 1, parameters});
  assert.equal(expiredPreview.launchable, false);
  assert.ok(expiredPreview.diagnostics.some(row => row.code === 'goal_expired'));
  assert.equal(JSON.stringify((await f.read('task_get', {taskId: followId})).memory), pin);
});
