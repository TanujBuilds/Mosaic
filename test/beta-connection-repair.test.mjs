import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { locations, privateDirectories, saveJson } from '../src/beta/files.mjs';
import { assertMaintenanceIdle } from '../src/beta/service.mjs';
import { readCredentials, readSettings } from '../src/beta/settings.mjs';
import { setup, setupComplete } from '../src/beta/setup.mjs';
import { runConnectionRepair } from '../src/beta/connection-repair.mjs';
import { Store } from '../src/harness/store.mjs';

const oldKey = 'fixture-shared-worker-secret-271';
const newKey = 'fixture-fresh-worker-secret-493';
function profile(id, baseUrl, credentialRef, roles = ['worker']) {
  const worker = roles.includes('worker');
  return {
    schema: 1, id, revision: 'r1', displayName: id, transport: 'openai-chat', baseUrl,
    model: 'fixture-model', roles,
    capabilities: { workerProtocol: worker ? 'mosaic-structured-v1' : null, transports: ['json'],
      modelDiscovery: 'manual', taskKinds: worker ? ['coding', 'consult'] : [] },
    maxContextTokens: null, maxOutputTokens: 4096, concurrency: 1, capacityGroup: 'fixture', credentialRef, streaming: false
  };
}

async function fixture(t, { baseUrl = 'http://localhost:9000/v1', shared = false, manual = false } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'Mosaic connection repair '));
  t.after(() => rm(home, {recursive: true, force: true}));
  const paths = locations(home, true);
  await privateDirectories(paths);
  if (manual) paths.isolated = false;
  const settings = {
    schema: 2, host: { id: 'cursor', options: {} },
    providers: [profile('worker', baseUrl, shared ? 'shared-key' : null),
      profile('reviewer', 'http://localhost:9001/v1', shared ? 'shared-key' : null, ['reviewer'])],
    defaults: { workerId: 'worker', plannerWorkerId: 'worker', review: { source: 'api', reviewer: { id: 'reviewer', revision: 'r1' } } },
    execution: { backend: 'codex-sandbox', backendRevision: 1 }, codexPath: process.execPath,
    serviceMaxConcurrentTasks: 1, capacityGroups: [{ id: 'fixture', limit: 1 }]
  };
  if (shared) await saveJson(paths.credentials, {schema: 1, entries: {'shared-key': oldKey, 'unused-key': 'independent-key-488'}});
  const lifecycle = manual ? {verifyLaunchAgent: async () => false, stopForMaintenance: async () => false, startLaunchAgent: async () => true} : undefined;
  assert.equal(await setup(paths, { settings, lifecycle, input: Readable.from(['n\nn\ny\n']), output: new Writable({write(chunk, encoding, done) {done();}})}), true);
  const hostTarget = path.join(home, '.cursor', 'mcp.json');
  const binding = path.join(paths.configDir, 'portable-binding.json');
  const hostBinding = path.join(paths.configDir, 'host-cursor-binding.json');
  return {paths, binding, hostBinding, hostTarget};
}

function interaction(answer) {
  let text = '';
  const prompts = [];
  return {
    text: () => text, prompts,
    output: { write: chunk => {text += chunk;} },
    async ask(prompt, options) { prompts.push({prompt, options}); return typeof answer === 'function' ? answer(prompt, options) : (answer.shift() ?? ''); }
  };
}

async function providerFixture(t) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({method: request.method, url: request.url, body, authorization: request.headers.authorization});
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.method === 'GET' ? {data: [{id: 'fixture-model'}]} : {
      model: 'fixture-model', choices: [{message: {content: 'private fixture response'}, finish_reason: 'stop'}]
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {server.closeAllConnections();server.close(resolve);}));
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

const worker = ['--worker', 'worker'];

test('local diagnosis and host review make no provider calls or host writes', async t => {
  const {baseUrl, requests} = await providerFixture(t);
  const {paths, hostTarget} = await fixture(t, {baseUrl});
  const before = await readFile(hostTarget);
  const io = interaction([]);
  assert.equal(await runConnectionRepair(paths, [], io), true);
  assert.equal(await runConnectionRepair(paths, ['--host'], io), true);
  assert.match(io.text(), /mosaic repair --worker worker/);
  assert.match(io.text(), /mosaic-beta.*registry_list/);
  assert.deepEqual(await readFile(hostTarget), before);
  assert.deepEqual(requests, []);
});

test('editing one worker privately rotates its revision, preserving a shared credential and review binding', async t => {
  const {paths, binding, hostBinding, hostTarget} = await fixture(t, {shared: true});
  const before = await readSettings(paths);
  const [savedBinding, savedHostBinding, savedHost] = await Promise.all([binding, hostBinding, hostTarget].map(file => readFile(file)));
  const io = interaction(['https://new-worker.invalid/v1/', 'repaired-model', 'r', newKey, 'y']);
  assert.equal(await runConnectionRepair(paths, worker, io), true);
  const after = await readSettings(paths), credentials = await readCredentials(paths);
  assert.equal(after.providers[0].baseUrl, 'https://new-worker.invalid/v1');
  assert.equal(after.providers[0].model, 'repaired-model');
  assert.notEqual(after.providers[0].revision, before.providers[0].revision);
  assert.equal(credentials.entries[after.providers[0].credentialRef], newKey);
  assert.equal(credentials.entries['shared-key'], oldKey);
  assert.equal(credentials.entries['unused-key'], 'independent-key-488');
  assert.deepEqual(after.providers[1], before.providers[1]);
  assert.deepEqual(after.defaults, before.defaults);
  assert.notDeepEqual(await readFile(binding), savedBinding);
  assert.deepEqual(await readFile(hostBinding), savedHostBinding);
  assert.deepEqual(await readFile(hostTarget), savedHost);
  assert.equal(await setupComplete(paths), true);
  assert.equal(io.prompts.find(({options}) => options?.secret)?.options.secret, true);
  assert.ok(!io.text().includes(newKey) && !io.text().includes(oldKey));
});

test('an existing key cannot follow a changed URL without a fresh key entry', async t => {
  const {paths} = await fixture(t, {shared: true});
  const before = await readFile(paths.config);
  await assert.rejects(runConnectionRepair(paths, worker, interaction(['https://different.invalid/v1', '', 'k'])), /same API base URL|same URL/i);
  assert.deepEqual(await readFile(paths.config), before);
  await assert.rejects(readFile(paths.setupIntent), {code: 'ENOENT'});
});

test('optional model discovery and inference each require their own approval', async t => {
  const {baseUrl, requests} = await providerFixture(t);
  const {paths} = await fixture(t, {baseUrl});
  await runConnectionRepair(paths, [...worker, '--discover', '--probe'], interaction(['', '', '', 'y', 'n']));
  assert.deepEqual(requests.map(({method, url}) => [method, url]), [['GET', '/v1/models']]);
  const io = interaction(['', '', '', 'n', 'y']);
  await runConnectionRepair(paths, [...worker, '--discover', '--probe'], io);
  assert.deepEqual(requests.map(({method, url}) => [method, url]), [['GET', '/v1/models'], ['POST', '/v1/chat/completions']]);
  const body = JSON.parse(requests[1].body);
  assert.deepEqual(body.messages, [{role: 'user', content: 'Mosaic setup connectivity probe. Reply with setup ok.'}]);
  assert.equal(body.max_tokens, 16);
  assert.ok(!io.text().includes('private fixture response'));
});

test('declining a worker repair leaves the settings and receipts byte-for-byte unchanged', async t => {
  const {paths, binding, hostBinding, hostTarget} = await fixture(t, {shared: true});
  const files = [paths.config, paths.credentials, binding, hostBinding, hostTarget];
  const before = await Promise.all(files.map(file => readFile(file)));
  await runConnectionRepair(paths, worker, interaction(['', 'a-different-model', '', 'n']));
  assert.deepEqual(await Promise.all(files.map(file => readFile(file))), before);
  await assert.rejects(readFile(paths.setupIntent), {code: 'ENOENT'});
});

test('a competing edit during the maintenance stop is detected before repair stages anything', async t => {
  const {paths, binding} = await fixture(t, {shared: true});
  const beforeSettings = await readFile(paths.config), beforeBinding = await readFile(binding);
  const io = interaction(['', 'a-different-model', '', 'y']);
  const changed = {schema: 1, entries: {'shared-key': 'newer-rotation-527', 'unused-key': 'independent-key-488'}};
  await assert.rejects(runConnectionRepair(paths, worker, {...io, lifecycle: {stopForMaintenance: () => saveJson(paths.credentials, changed)}}), /changed/);
  assert.deepEqual(await readCredentials(paths), changed);
  assert.deepEqual(await readFile(paths.config), beforeSettings);
  assert.deepEqual(await readFile(binding), beforeBinding);
  await assert.rejects(readFile(paths.setupIntent), {code: 'ENOENT'});
  await assert.rejects(readFile(path.join(paths.configDir, 'setup-credentials.json')), {code: 'ENOENT'});
});

test('an approved interrupted repair resumes its exact intended revision with no added provider requests', async t => {
  const {baseUrl, requests} = await providerFixture(t);
  const {paths, hostBinding} = await fixture(t, {baseUrl});
  const before = await readFile(hostBinding);
  const io = interaction(['', 'new-model', 'r', newKey, 'y']);
  await assert.rejects(runConnectionRepair(paths, worker, {...io, afterStep(step) {if (step === 'credentials') throw Error('interrupted');}}), /interrupted/);
  const pendingText = await readFile(paths.setupIntent, 'utf8');
  const pending = JSON.parse(pendingText);
  assert.ok(!pendingText.includes(newKey));
  assert.equal(await runConnectionRepair(paths, ['--resume'], interaction([])), true);
  assert.equal((await readSettings(paths)).providers[0].revision, pending.settings.providers[0].revision);
  assert.deepEqual(await readFile(hostBinding), before);
  assert.deepEqual(requests, []);
  assert.equal(await setupComplete(paths), true);
});

test('uncertain ownership prevents repair from writing settings or sending provider diagnostics', async t => {
  const {baseUrl, requests} = await providerFixture(t);
  const {paths} = await fixture(t, {baseUrl});
  const store = new Store(paths.state);
  try { store.put('operation', {id: 'uncertain-fixture', status: 'uncertain'}); }
  finally { store.close(); }
  await assert.rejects(assertMaintenanceIdle(paths, {settingsChange:true}), /unresolved/);
  const before = await readFile(paths.config);
  await assert.rejects(runConnectionRepair(paths, [...worker, '--discover', '--probe'], interaction(['', 'new-model', '', 'y', 'y', 'y'])), /unresolved/);
  assert.deepEqual(await readFile(paths.config), before);
  assert.deepEqual(requests, []);
  await assert.rejects(readFile(paths.setupIntent), {code: 'ENOENT'});
});


test('repairing a worker keeps a manually configured app and avoids creating a LaunchAgent', async t => {
  const {paths, hostBinding, hostTarget} = await fixture(t, {manual: true});
  await mkdir(path.dirname(hostTarget), {recursive: true});
  await saveJson(hostTarget, {mcpServers: {'mosaic-beta': {command: '/user-managed/custom', args: ['start']}}});
  const before = await Promise.all([hostBinding, hostTarget, paths.ownership].map(file => readFile(file)));
  const io = interaction(['', 'a-different-model', '', 'y']);
  const lifecycle = {
    verifyLaunchAgent: async () => false,
    stopForMaintenance: async () => false,
    startLaunchAgent: async () => {throw Error('repair attempted to start an unrecorded service');}
  };
  assert.equal(await runConnectionRepair(paths, worker, {...io, lifecycle}), true);
  assert.deepEqual(await Promise.all([hostBinding, hostTarget, paths.ownership].map(file => readFile(file))), before);
  assert.equal(await setupComplete(paths), true);
});

test('a changed host binding during confirmation prevents the approved settings from being staged', async t => {
  const {paths, hostBinding} = await fixture(t);
  const before = await readFile(paths.config);
  const answers = ['', 'new-model', ''];
  const io = interaction(async prompt => {
    if (!prompt.startsWith('Save this worker')) return answers.shift();
    const receipt = JSON.parse(await readFile(hostBinding, 'utf8'));
    await saveJson(hostBinding, {...receipt, changed: true});
    return 'y';
  });
  await assert.rejects(runConnectionRepair(paths, worker, io), /binding changed/);
  assert.deepEqual(await readFile(paths.config), before);
  await assert.rejects(readFile(paths.setupIntent), {code: 'ENOENT'});
});


test('coding app repair can show registration steps when the worker credential store is unreadable', async t => {
  const {paths, hostTarget} = await fixture(t);
  await writeFile(paths.credentials, 'incomplete data', {mode: 0o600});
  const before = await readFile(hostTarget);
  const io = interaction([]);
  assert.equal(await runConnectionRepair(paths, ['--host'], io), true);
  assert.match(io.text(), /Connect Cursor/);
  assert.deepEqual(await readFile(hostTarget), before);
});
