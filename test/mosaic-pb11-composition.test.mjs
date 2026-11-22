import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {ProviderRegistry} from '../src/harness/providers/registry.mjs';
import {Journal} from '../src/project/journal.mjs';
import {git} from '../src/project/process.mjs';

// Fixture inference and host review only. Git, workspace edits, sandbox probes,
// protected candidate checks and integration checks use production implementations.
const sourcePath = 'src/parser.mjs';
const original = 'export const parse = input => input;\n';
const repaired = id => `// Fixture worker ${id}\nexport const parse = input => input.trim();\n`;
const credentials = {a: 'dummy-composition-a', b: 'dummy-composition-b'};

async function endpoint(t, id, {failFirst = false} = {}) {
  const calls = [], errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const part of req) raw += part;
      const body = raw ? JSON.parse(raw) : null;
      calls.push({method: req.method, url: req.url, auth: req.headers.authorization, body});
      assert.equal(req.headers.authorization, `Bearer ${credentials[id]}`);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/models') {
        assert.equal(req.method, 'GET');
        return res.end(JSON.stringify({data: [{id: `parser-${id}`}]}));
      }
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(body.model, `parser-${id}`);
      assert.equal(body.stream, false);
      assert.equal(body.max_tokens, 2048);
      const input = JSON.parse(body.messages.at(-1).content);
      assert.equal(input.task.kind, 'coding');
      assert.equal(input.task.actor, 'deepseek');
      assert.deepEqual(input.task.permissions.writePaths, [sourcePath]);
      assert.ok(!input.goal, 'Collaborative host planning must not dispatch a planner');
      if (input.attempt > 1) {
        assert.equal(input.repair.failure.category, 'functional_check');
        assert.match(JSON.stringify(input.repair), /parser-unit/);
      }
      const entry = input.inventory.find(file => file.path === sourcePath);
      assert.ok(entry?.hash, 'Edit must bind the current candidate file');
      const content = failFirst && input.attempt === 1
        ? 'export const parse = input => input.toUpperCase();\n' : repaired(id);
      const action = {type: 'submit_changes', paths: [], summary: `Fixture ${id} attempt ${input.attempt}`,
        edits: [{path: sourcePath, action: 'write', baseHash: entry.hash, content}]};
      res.end(JSON.stringify({model: `parser-${id}`, choices: [{message: {content: JSON.stringify(action)}, finish_reason: 'stop'}], usage: {total_tokens: 17}}));
    } catch (error) {
      errors.push(error);
      res.writeHead(500).end(JSON.stringify({error: {message: 'Fixture contract assertion failed'}}));
    }
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  t.after(() => {server.closeAllConnections(); return new Promise(resolve => server.close(resolve));});
  return {id, calls, errors, posts: () => calls.filter(call => call.method === 'POST'),
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`};
}

const profile = endpoint => ({
  schema: 1, id: `worker-${endpoint.id}`, revision: 'revision-1', displayName: `Fixture ${endpoint.id}`,
  transport: 'openai-chat', baseUrl: endpoint.baseUrl, model: `parser-${endpoint.id}`, roles: ['worker'],
  capabilities: {workerProtocol: 'mosaic-structured-v1', transports: ['json'], modelDiscovery: 'advertised', taskKinds: ['coding']},
  maxContextTokens: null, maxOutputTokens: 2048, concurrency: 1, capacityGroup: `service-${endpoint.id}`,
  credentialRef: `fixture-key-${endpoint.id}`, streaming: false,
});

async function fixture(t, beta, endpoints) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mosaic-pb11-composition-')));
  const repo = path.join(root, 'repo'), state = path.join(root, 'state');
  const profiles = endpoints.map(profile);
  let sequence = 0, generation = 0, now = Date.now(), c, d, worker, owner;
  const connect = () => {
    // Rebuild the registry/client cache as well as the coordinator on restart.
    const providerRegistry = ProviderRegistry({profiles, credentialResolver: ref => credentials[ref.replace('fixture-key-', '')]});
    c = new Coordinator({root: state, beta, selectedHost:'codex', now: () => now, providerRegistry});
    owner = `composition-owner-${++generation}`;
    c.acquireWorker(owner);
    worker = new Worker({c, owner, config: {environment: 'fixture', beta}});
    d = new Dispatcher({c, worker, config: {environment: 'fixture', beta}});
  };
  connect();
  t.after(async () => {
    // Every sandbox/check subprocess is awaited by tick or the operation queue.
    // No detached child or provider request survives fixture disposal.
    await d.whenIdle();
    c.releaseWorker(owner);
    c.close();
    await rm(root, {recursive: true, force: true});
  });
  await mkdir(path.join(repo, 'src'), {recursive: true});
  await mkdir(path.join(repo, 'checks'));
  await writeFile(path.join(repo, sourcePath), original);
  const protectedCheck = "import assert from 'node:assert/strict';\nimport {parse} from '../src/parser.mjs';\nassert.equal(parse(' parser '), 'parser');\nassert.equal(parse('   '), '');\nconsole.log('protected parser behavior passed');\n";
  await writeFile(path.join(repo, 'checks/unit.mjs'), protectedCheck);
  await git(repo, 'init', '-q');
  await git(repo, 'add', '.');
  await git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');
  const project = {repo, baseCommit: await git(repo, 'rev-parse', 'HEAD'), readPaths: ['src/', 'checks/'], writePaths: ['src/'],
    checks: [{id: 'parser-unit', argv: [process.execPath, 'checks/unit.mjs'], timeoutMs: 10000}],
    behavioralChecks: [{criterionId: 'trim', description: 'Parser trims surrounding whitespace', checkIds: ['parser-unit']}]};
  const read = (name, input) => d.invoke(name, input);
  const mutate = (name, input, key = `composition-${++sequence}`) => d.invoke(name, {...input, idempotencyKey: key});
  const operation = async (name, input, key) => {
    const pending = await mutate(name, input, key);
    await d.whenIdle();
    const done = await read('operation_get', {operationId: pending.id});
    assert.equal(done.status, 'completed', done.error);
    return done.result;
  };
  const goal = async id => {
    const workers = c.providerRegistry.snapshot(profiles.map(({id, revision}) => ({id, revision})));
    const manifest = {submissionId: `goal-${id}`, objective: `Fix parser with fixture worker ${id}`, acceptance: ['Protected parser check passes'],
      environment: 'fixture', mode: 'collaborative', project, limits: {hours: 1, maxTasks: 2, reviewAgentRuns: 2},
      providerPolicy: {version: 1, workers, defaultWorkerId: `worker-${id}`, plannerWorkerId: `worker-${id}`,
        maxConcurrentTasks: 1, capacityGroups: workers.map(p => ({id: p.capacityGroup, limit: 1}))}};
    const draft = await mutate('assignment_prepare', {manifest}, `prepare-${id}`);
    assert.equal(draft.status, 'prepared', JSON.stringify(draft));
    assert.deepEqual(await mutate('assignment_prepare', {manifest}, `prepare-${id}`), draft);
    return mutate('goal_activate', {goalId: draft.goalId, hash: draft.hash}, `activate-${id}`);
  };
  return {root, state, repo, project, protectedCheck, read, mutate, operation, goal,
    current: () => c,
    tick: () => worker.tick(),
    restart: async () => {await d.whenIdle(); c.releaseWorker(owner); c.close(); now += 1000; connect();},
    recover: taskId => c.recoverSaved(taskId, owner),
  };
}

async function advance(f, taskId, predicate) {
  for (let n = 0; n < 16; n++) {
    const task = await f.read('task_get', {taskId});
    if (predicate(task)) return task;
    assert.ok(['queued', 'running'].includes(task.status), JSON.stringify({status: task.status, reason: task.reason, feedback: task.feedback}));
    await f.tick();
  }
  assert.fail('Bounded fixture did not reach expected task state');
}

for (const beta of [false, true]) test(`provider-pinned coding composes intake, recipe/backlog, failed gate restart, host review and integration (${beta ? 'beta' : 'core'})`, {timeout: 120000}, async t => {
  const a = await endpoint(t, 'a', {failFirst: true}), b = await endpoint(t, 'b');
  const f = await fixture(t, beta, [a, b]), ga = await f.goal('a'), gb = await f.goal('b');
  assert.equal(a.calls.length + b.calls.length, 0, 'Preparation/activation must not dispatch host planning');
  const permissions = {readPaths: [sourcePath, 'checks/'], writePaths: [sourcePath], checks: ['parser-unit']};
  const parameters = {issue: 'Fix parser whitespace in src/parser.mjs', context: 'Trim surrounding spaces', ...permissions};
  const preview = await f.read('workflow_recipe_preview', {goalId: ga.id, recipeId: 'bugfix', version: 1, parameters});
  assert.equal(preview.launchable, true, JSON.stringify(preview.diagnostics));
  const recipeInput = {goalId: ga.id, expectedGoalHash: preview.goalHash, recipeId: 'bugfix', version: 1, parameters,
    definitionDigest: preview.definitionDigest, parameterDigest: preview.parameterDigest, previewDigest: preview.previewDigest, submissionId: 'repair-parser'};
  const recipe = await f.mutate('workflow_recipe_submit', recipeInput, 'recipe-a');
  assert.equal(recipe.tasks.length, 1);
  const taskId = recipe.tasks[0];
  const backlogInput = {goalId: gb.id, expectedGoalHash: gb.hash, expectedGoalVersion: gb.version, submissionId: 'parser-b', items: [{
    key: 'parser', dependsOnKeys: [], task: {kind: 'coding', actor: 'deepseek', objective: 'Trim parser whitespace in src/parser.mjs',
      acceptance: ['Protected parser check passes'], permissions},
  }]};
  const backlog = await f.mutate('backlog_submit', backlogInput, 'backlog-b');
  const secondId = backlog.items[0].taskId;
  const before = await f.read('task_get', {taskId});
  const secondBefore = await f.read('task_get', {taskId: secondId});
  assert.equal(before.providerBinding.providerId, 'worker-a');
  assert.equal(secondBefore.providerBinding.providerId, 'worker-b');
  assert.deepEqual(before.spec.permissions, permissions);

  const failed = await advance(f, taskId, task => task.checkpoint.phase === 'attempt' && task.checkpoint.failedGate);
  assert.equal(failed.checkpoint.repairFailure.category, 'functional_check');
  assert.equal(failed.attempts, 1);
  assert.equal(failed.spent.model, 1);
  assert.equal(failed.reviews, 0);
  assert.equal(b.calls.length, 0);
  const journal = await new Journal(path.join(f.state, 'coding'), taskId).load();
  const failedReceipt = journal.completed('harness-attempt-1/checks');
  assert.equal(failedReceipt.value[0].passed, false);
  assert.match(failedReceipt.value[0].stderr, /AssertionError/);
  assert.deepEqual(Object.fromEntries(['readDenied', 'writeDenied', 'networkDenied', 'outputWorks'].map(key => [key, journal.last('harness.sandbox')[key]])),
    {readDenied: true, writeDenied: true, networkDenied: true, outputWorks: true});
  const requests = f.current().store.requestOutcomes(taskId);
  const originalRequest = f.current().store.request(taskId, 'code-1-0');
  assert.deepEqual(originalRequest.providerBinding, before.providerBinding);
  assert.equal(originalRequest.status, 'completed');

  await f.restart();
  assert.equal((await f.read('task_get', {taskId})).status, 'uncertain');
  const recovered = f.recover(taskId);
  assert.equal(recovered.status, 'queued');
  for (const field of ['providerBinding', 'checkpoint', 'spent', 'deadline', 'hash', 'goalVersion', 'attempts']) assert.deepEqual(recovered[field], failed[field], field);
  assert.deepEqual(f.current().store.requestOutcomes(taskId), requests);
  assert.deepEqual(await f.mutate('workflow_recipe_submit', recipeInput, 'recipe-a'), recipe);
  assert.deepEqual(await f.mutate('backlog_submit', backlogInput, 'backlog-b'), backlog);
  assert.equal(f.current().store.all('task').length, 2);
  for (const goal of [ga, gb]) assert.equal((await f.read('goal_get', {goalId: goal.id})).deadline, goal.deadline);

  const accepted = [];
  for (const [id, endpoint, initial, goal] of [[taskId, a, before, ga], [secondId, b, secondBefore, gb]]) {
    const candidate = await advance(f, id, task => task.status === 'awaiting_review');
    assert.ok(candidate.result.checks.every(check => check.passed && check.code === 0));
    assert.equal(await readFile(path.join(candidate.result.worktree, 'checks/unit.mjs'), 'utf8'), f.protectedCheck);
    assert.equal(await readFile(path.join(candidate.result.worktree, sourcePath), 'utf8'), repaired(endpoint.id));
    assert.equal((await f.read('outcomes_report', {goalId: goal.id})).counts.usefulAccepted, 0);
    const reviewInput = {taskId: id, decision: 'accept', feedback: 'Scripted fixture host reviewed the parser diff and protected check evidence'};
    const item=(await f.read('review_inbox',{goalId:goal.id})).items.find(item=>item.taskId===id);
    const ticket=await f.mutate('review_reserve',item.binding,`reserve-${endpoint.id}`);
    const boundReview={...item.binding,ticketId:ticket.ticketId,verdict:{decision:reviewInput.decision,feedback:reviewInput.feedback,findings:[]}};
    const reviewed = await f.mutate('review_submit', boundReview, `review-${endpoint.id}`);
    assert.equal(reviewed.status, 'ready_to_integrate');
    assert.equal(reviewed.reviews, 1);
    assert.deepEqual(await f.mutate('review_submit', boundReview, `review-${endpoint.id}`), reviewed);
    assert.equal((await f.read('outcomes_report', {goalId: goal.id})).counts.usefulAccepted, 0, 'Host review alone is not integrated acceptance');
    const action = beta ? await f.read('owner_action_context', {goalId: goal.id, taskId: id}) : null;
    const integrateInput = {taskId: id, feedback: 'Integrate the fixture-host-reviewed candidate',
      ...(action ? {expectedIntegrationBinding: action.candidate.binding} : {})};
    const result = await f.operation('task_integrate', integrateInput, `integrate-${endpoint.id}`);
    assert.equal(result.status, 'accepted');
    assert.deepEqual(result.providerBinding, initial.providerBinding);
    assert.equal(result.providerModel, `parser-${endpoint.id}`);
    assert.equal(result.hash, initial.hash);
    assert.equal(result.deadline, candidate.deadline);
    assert.equal(result.attempts, endpoint.id === 'a' ? 2 : 1);
    assert.equal(result.spent.model, result.attempts);
    assert.equal(result.reviews, 1);
    assert.ok(result.integration.checks.every(check => check.passed && check.code === 0));
    assert.equal(result.integration.behavioralEvidence.criteria[0].status, 'passed');
    assert.equal(result.integration.candidateBehavioralEvidence.criteria[0].status, 'passed');
    assert.equal(await readFile(path.join(result.integration.worktree, sourcePath), 'utf8'), repaired(endpoint.id));
    assert.equal(await readFile(path.join(result.integration.worktree, 'checks/unit.mjs'), 'utf8'), f.protectedCheck);
    const report = await f.read('outcomes_report', {goalId: goal.id});
    assert.equal(report.counts.acceptedCoding, 1);
    assert.equal(report.counts.usefulAccepted, 1);
    assert.equal(report.tasks.filter(row => row.id === id).length, 1);
    accepted.push({result, endpoint, goal, integrateInput, boundReview});
  }

  assert.deepEqual(a.errors.concat(b.errors), []);
  assert.deepEqual(a.posts().map(call => JSON.parse(call.body.messages.at(-1).content).attempt), [1, 2]);
  assert.deepEqual(b.posts().map(call => JSON.parse(call.body.messages.at(-1).content).attempt), [1]);
  const finalJournal = await new Journal(path.join(f.state, 'coding'), taskId).load();
  assert.deepEqual(finalJournal.completed('harness-attempt-1/checks'), failedReceipt);
  assert.equal(finalJournal.events.filter(event => event.type === 'operation.started' && event.data.key === 'harness-attempt-1/checks').length, 1);
  assert.equal(finalJournal.events.filter(event => event.type === 'edits.applied').length, 2);
  assert.deepEqual(f.current().store.request(taskId, 'code-1-0'), originalRequest);
  assert.deepEqual(f.current().store.request(taskId, 'code-2-0').providerBinding, before.providerBinding);
  assert.deepEqual(f.current().store.request(secondId, 'code-1-0').providerBinding, secondBefore.providerBinding);

  const requestsBeforeReplay = f.current().store.db.prepare('SELECT * FROM requests ORDER BY id').all();
  assert.equal(requestsBeforeReplay.length, 3, 'Only the two repair attempts and the second worker request are spent');
  await f.restart();
  for (const {result, endpoint, goal, integrateInput, boundReview} of accepted) {
    await f.mutate('review_submit', boundReview, `review-${endpoint.id}`);
    assert.deepEqual(await f.operation('task_integrate', integrateInput, `integrate-${endpoint.id}`), result);
    assert.equal((await f.read('outcomes_report', {goalId: goal.id})).counts.usefulAccepted, 1);
  }
  await f.tick();
  assert.equal(a.posts().length, 2);
  assert.equal(b.posts().length, 1);
  assert.deepEqual(f.current().store.db.prepare('SELECT * FROM requests ORDER BY id').all(), requestsBeforeReplay);
  const events = f.current().store.events(0, 1000);
  for (const id of [taskId, secondId]) {
    assert.equal(events.filter(event => event.task_id === id && event.type === 'task.reviewed').length, 1);
    assert.equal(events.filter(event => event.task_id === id && event.type === 'task.integrated').length, 1);
  }
  const saved = JSON.stringify({records: f.current().store.db.prepare('SELECT data FROM records').all(), requests: requestsBeforeReplay, events});
  for (const id of ['a', 'b']) {
    assert.equal(saved.includes(credentials[id]), false);
    assert.equal(saved.includes(`fixture-key-${id}`), false);
  }
  assert.equal(await readFile(path.join(f.repo, sourcePath), 'utf8'), original);
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), f.project.baseCommit);
  assert.equal(await git(f.repo, 'status', '--porcelain'), '');
});
