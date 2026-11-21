import assert from 'node:assert/strict';
import {access, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {runFirstTask} from '../src/beta/first-task.mjs';
import {recordHostConnection, hostConnectionIdentity} from '../src/beta/hosts/connection-evidence.mjs';
import {locations, privateDirectories, saveJson} from '../src/beta/files.mjs';
import {configuredPolicies} from '../src/beta/settings.mjs';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';
import {ProviderRegistry} from '../src/harness/providers/registry.mjs';
import {sourceClosure} from '../scripts/lib/beta-archive.mjs';
import {repository, repositoryBytes} from './fixtures/mosaic-assignment/repository.mjs';
import {artifact} from './fixtures/mosaic-pb15-v2-backend/artifact.mjs';

const profile = id => ({
  schema: 1, id, revision: 'r1', displayName: id, transport: 'openai-chat',
  baseUrl: 'https://worker.invalid/v1', model: 'fixture-model', roles: ['worker'],
  capabilities: {workerProtocol: 'mosaic-structured-v1', transports: ['json'], modelDiscovery: 'manual', taskKinds: ['coding']},
  maxContextTokens: null, maxOutputTokens: 4096, concurrency: 1, capacityGroup: 'shared', credentialRef: null, streaming: false,
});

async function fixture(t, providers = [], native) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mosaic-first-task-test-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  const home = path.join(root, 'home');
  await mkdir(home, {mode: 0o700});
  const paths = locations(home, true);
  await privateDirectories(paths);
  const settings = {
    schema: 2, host: {id: 'cursor', options: {}}, providers,
    defaults: {workerId: providers[0]?.id ?? null, plannerWorkerId: providers[0]?.id ?? null, review: {source: 'host', hostId: 'cursor'}},
    execution: native ? {backend: 'darwin-seatbelt', backendRevision: 2, runtimeFingerprint: native.config.artifactManifestSha256}
      : {backend: 'codex-sandbox', backendRevision: 1},
    ...(native ? {nativeCheckRuntime: native.config} : {codexPath: '/fixture/codex'}),
    serviceMaxConcurrentTasks: 1, capacityGroups: providers.length ? [{id: 'shared', limit: 1}] : [],
  };
  if (providers.length) settings.defaults.routing = {version: 1, defaultWorkerId: providers[0].id, rules: []};
  await saveJson(paths.config, settings);
  const c = new Coordinator({root: paths.state, beta: true, selectedHost: 'cursor',
    ...(native ? {executionPolicy: {version: 1, ...settings.execution}, nativeCheckRuntime: native.config} : {}),
    ...(providers.length ? {providerRegistry: ProviderRegistry({profiles: providers}), configuredPolicies: configuredPolicies(settings)} : {}),
  });
  t.after(() => c.close());
  const dispatcher = new Dispatcher({c, config: {beta: true}});
  const calls = [];
  const invoke = (name, input) => {
    calls.push(name);
    return dispatcher.invoke(name, input);
  };
  const env = {PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'};
  return {root, env, paths, c, invoke, calls, settings};
}

const answers = () => ['codex-only', 'Add CSV export', 'Every row is exported', 'src/, checks/', 'src/', 'node checks/verify.mjs'];
function terminal(input = []) {
  let text = '';
  return {
    ask: async () => input.shift() ?? '',
    output: {write: chunk => { text += chunk; }},
    read: () => text,
  };
}

test('the first-task wizard binds the bundled check launcher before asking for approval',
  {skip: process.platform !== 'darwin' || process.arch !== 'arm64'}, async t => {
    const native = await artifact();
    t.after(() => rm(native.root, {recursive: true, force: true}));
    const f = await fixture(t, [profile('spark')], native);
    const repo = await repository(f);
    const choices = answers();
    choices[0] = 'collaborative';
    const rejected = terminal([...choices.slice(0, -1), 'npm test']);
    assert.equal(await runFirstTask(f.paths, [repo.root], {...rejected, invoke: f.invoke}), 1);
    assert.match(rejected.read(), /bundled Node/);
    assert.equal(f.calls.length, 0);

    choices[5] = JSON.stringify(['node', 'checks/verify.mjs', 'a b']);
    const io = terminal(choices);
    assert.equal(await runFirstTask(f.paths, [repo.root], {...io, invoke: f.invoke}), 0);
    const [goal] = f.c.store.all('goal');
    const argv = [path.join(native.root, 'node'), 'checks/verify.mjs', 'a b'];
    assert.deepEqual(goal.manifest.project.checks, [{id: 'check-1', argv}]);
    assert.ok(io.read().includes(JSON.stringify(argv)));
    assert.equal(goal.status, 'draft');
    assert.equal(f.c.store.db.prepare('SELECT count(*) AS n FROM requests').get().n, 0);

    const invalid = f.c.preparePortableGoal({
      submissionId: 'unbound-check', mode: 'collaborative', objective: goal.manifest.objective,
      acceptance: goal.manifest.acceptance,
      project: {...goal.manifest.project, checks: [{id: 'check-1', argv: ['node', 'checks/verify.mjs']}]},
    }, 'prepare-unbound-check');
    await assert.rejects(f.c.preflightExecution({goalId: invalid.id, hash: invalid.hash}, {
      checksFactory: () => ({
        backendIdentity: {id: 'darwin-seatbelt', revision: 2},
        verify: async () => ({passed: true}),
      }),
    }), /check-1.*bundled Node/);
    assert.equal(f.c.getGoal(invalid.id).status, 'draft');
    assert.equal(f.c.store.all('native_preflight').length, 0);
  });

test('guided task prepares an exact draft from the current Git project and prints the app handoff', async t => {
  const f = await fixture(t);
  const repo = await repository(f);
  const io = terminal(answers());
  const before = await repositoryBytes(repo.root);
  await recordHostConnection(f.paths, hostConnectionIdentity(f.settings));
  assert.equal(await runFirstTask(f.paths, [], {...io, invoke: f.invoke, cwd: path.join(repo.root, 'src')}), 0);
  assert.deepEqual(f.calls, ['assignment_prepare', 'goal_get']);
  const [goal] = f.c.store.all('goal');
  assert.equal(goal.status, 'draft');
  assert.equal(goal.activatedAt, null);
  assert.equal(goal.deadline, null);
  assert.deepEqual(f.c.store.all('task'), []);
  assert.equal(f.c.store.db.prepare('SELECT count(*) AS n FROM requests').get().n, 0);
  assert.equal(goal.manifest.mode.id, 'codex_only');
  assert.deepEqual(goal.manifest.project, {
    repo: repo.root, baseCommit: repo.baseCommit, readPaths: ['src/', 'checks/'], writePaths: ['src/'],
    checks: [{id: 'check-1', argv: ['node', 'checks/verify.mjs']}],
  });
  assert.equal(goal.manifest.limits.hours, 1);
  assert.equal(goal.manifest.limits.maxTasks, 1);
  assert.equal(goal.manifest.limits.reviewAgentRuns, 1);
  assert.equal(goal.manifest.limits.taskLimits.coding.reviews, 1);
  assert.match(io.read(), /Last bridge registry call/);
  assert.match(io.read(), /Cursor/);
  assert.match(io.read(), /goal_get/);
  assert.match(io.read(), /After I approve activation and work, run one coding assignment/);
  assert.match(io.read(), /saved check, review, and integration state/);
  assert.match(io.read(), new RegExp(goal.id));
  assert.match(io.read(), new RegExp(goal.hash));
  assert.match(io.read(), /mosaic first-task result --goal/);
  assert.match(io.read(), /checks\/verify\.mjs/);
  assert.match(io.read(), /checks\//);
  assert.deepEqual(await repositoryBytes(repo.root), before);
  await assert.rejects(access(repo.marker), {code: 'ENOENT'});
});

for (const kind of ['dirty', 'unborn']) {
  test(`guided task leaves a ${kind} explicit Git project intact`, async t => {
    const f = await fixture(t);
    const repo = await repository(f, {committed: kind !== 'unborn'});
    if (kind === 'dirty') await writeFile(path.join(repo.root, 'src', 'export.mjs'), 'owner edits\n');
    const before = await repositoryBytes(repo.root);
    const io = terminal(answers());
    assert.equal(await runFirstTask(f.paths, ['--repo', repo.root], {...io, invoke: f.invoke}), 1);
    assert.match(io.read(), kind === 'dirty' ? /staged, unstaged or untracked changes/ : /no resolvable committed HEAD/);
    assert.deepEqual(await repositoryBytes(repo.root), before);
    assert.deepEqual(f.c.store.all('goal'), []);
    assert.deepEqual(f.calls, ['assignment_prepare']);
  });
}

test('without a configured worker, an explicit setup choice exits without preparing a draft', async t => {
  const f = await fixture(t);
  const repo = await repository(f);
  const io = terminal(['setup']);
  assert.equal(await runFirstTask(f.paths, ['--repo', repo.root], {...io, invoke: f.invoke}), 0);
  assert.match(io.read(), /mosaic setup/);
  assert.match(io.read(), /Codex-only/);
  assert.doesNotMatch(io.read(), /Last bridge registry call/);
  assert.deepEqual(f.calls, []);
});

test('demo records real fixture checks, reviews and commits in its own store and can be revisited', async t => {
  const f = await fixture(t);
  const io = terminal();
  const unexpected = () => { throw Error('Demo accessed live configuration or coordinator'); };
  assert.equal(await runFirstTask(f.paths, ['--demo'], {...io, cwd: f.root, demoParent: f.root, invoke: unexpected, loadSettings: unexpected}), 0);
  assert.match(io.read(), /scripted demo/i);
  assert.match(io.read(), /no live providers/i);
  assert.match(io.read(), /Goal ID: [a-z0-9-]+ · Complete/);
  assert.doesNotMatch(io.read(), / · (blocked|queued)/);
  assert.match(io.read(), /Candidate checks.*verify.*passed/i);
  assert.match(io.read(), /Review.*accepted/i);
  assert.match(io.read(), /Candidate commit.*[0-9a-f]{40}/i);
  assert.match(io.read(), /Integrated commit.*[0-9a-f]{40}/i);
  const match = /mosaic first-task result --goal (\S+) --demo-run (\S+)/.exec(io.read());
  assert.ok(match, io.read());
  const result = terminal();
  assert.equal(await runFirstTask(f.paths, ['result', '--goal', match[1], '--demo-run', match[2]], {
    ...result, demoParent: f.root, invoke: unexpected, loadSettings: unexpected,
  }), 0);
  assert.match(result.read(), /Integrated commit.*[0-9a-f]{40}/i);
  assert.match(result.read(), /Goal ID: [a-z0-9-]+ · Complete/);
  assert.deepEqual(f.c.store.all('goal'), []);
});


test('preset worker, literal checks and overnight preflight are recorded only in the approved draft details', async t => {
  const f = await fixture(t, [profile('default-worker'), profile('project-worker')]);
  const repo = await repository(f);
  const io = terminal();
  const input = Readable.from([
    'overnight-review\nAdd CSV export\nEvery row is exported\nsrc/, checks/\nsrc/\n',
    '[["node","--check","checks/verify.mjs"],["node","checks/verify.mjs"]]\ncheck-1\ncheck-2\ny\n',
  ]);
  const before = await readFile(f.paths.config);
  assert.equal(await runFirstTask(f.paths, [repo.root], {
    input, output: io.output, invoke: f.invoke,
    readPreset: async requestedRepo => {
      assert.equal(requestedRepo, repo.root);
      return {mode: 'overnight_review', workerId: 'project-worker', checks: [{id: 'old-check', definitionHash: 'a'.repeat(64)}]};
    },
  }), 0);
  const [goal] = f.c.store.all('goal');
  assert.equal(goal.status, 'draft');
  assert.equal(goal.manifest.mode.id, 'overnight_review');
  assert.equal(goal.manifest.mode.version, 2);
  assert.equal(goal.manifest.reviewPolicy.source, 'host');
  assert.equal(goal.manifest.limits.reviewAgentRuns, 1);
  assert.equal(goal.manifest.providerPolicy.defaultWorkerId, 'project-worker');
  assert.equal(goal.manifest.providerPolicy.plannerWorkerId, 'default-worker');
  assert.equal(goal.manifest.routingPolicy.defaultWorkerId, 'project-worker');
  assert.deepEqual(goal.manifest.overnightPolicy.preflightCheckIds, ['check-1']);
  assert.deepEqual(goal.manifest.overnightPolicy.finalOnlyCheckIds, ['check-2']);
  assert.deepEqual(goal.manifest.project.checks.map(check => check.id), ['check-1', 'check-2']);
  assert.deepEqual(f.calls, ['assignment_prepare', 'goal_get']);
  assert.match(io.read(), /Saved protected check suggestions: old-check/);
  assert.doesNotMatch(io.read(), /a{64}/);
  assert.match(io.read(), /before running overnight_preflight/);
  assert.match(io.read(), /let the coordinator's overnight planner/);
  assert.deepEqual(await readFile(f.paths.config), before);
  await assert.rejects(access(repo.marker), {code: 'ENOENT'});
});

test('another guided run prepares against the new committed base instead of replaying an older draft', async t => {
  const f = await fixture(t);
  const repo = await repository(f);
  assert.equal(await runFirstTask(f.paths, [repo.root], {...terminal(answers()), invoke: f.invoke}), 0);
  await repo.git('commit', '--allow-empty', '-m', 'Advance baseline');
  const newBase = await repo.git('rev-parse', 'HEAD');
  assert.equal(await runFirstTask(f.paths, [repo.root], {...terminal(answers()), invoke: f.invoke}), 0);
  assert.deepEqual(f.c.store.all('goal').map(goal => goal.manifest.project.baseCommit), [repo.baseCommit, newBase]);
});

test('the package source closure includes the scripted demo runner', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const sources = await sourceClosure(root, ['src/beta/first-task.mjs']);
  assert.ok(sources.includes('src/harness/outcomes/demo.mjs'));
});

for (const [mode, reviewerRuns] of [['collaborative', 1], ['deepseek_only', 0]]) {
  test(`guided ${mode} budgets match the saved review policy`, async t => {
    const f = await fixture(t, [profile('default-worker')]);
    const repo = await repository(f);
    const prompts = [mode, ...answers().slice(1)];
    const io = terminal(prompts);
    assert.equal(await runFirstTask(f.paths, [repo.root], {...io, invoke: f.invoke}), 0);
    const [goal] = f.c.store.all('goal');
    assert.equal(goal.manifest.limits.reviewAgentRuns, reviewerRuns);
    assert.equal(goal.manifest.limits.taskLimits.coding.reviews, reviewerRuns);
    assert.equal(goal.manifest.reviewPolicy?.source, reviewerRuns ? 'host' : undefined);
    assert.match(io.read(), reviewerRuns ? /run one coding assignment/ : /let the coordinator's API-worker planner/);
    assert.equal(/interactive Cursor chat that can ask for tool approval/.test(io.read()), !!reviewerRuns);
    assert.deepEqual(f.calls, ['assignment_prepare', 'goal_get']);
  });
}
