import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createPolicy } from '../src/project/check-backends/contracts.mjs';
import {
  createWindowsBackend,
  validateWindowsQuiescenceReceipt,
  windowsDependencyInventory,
  windowsRelativePath,
  WINDOWS_BACKEND,
} from '../src/project/check-backends/windows-appcontainer.mjs';
import { digest } from '../src/project/contracts.mjs';

const requestId = randomUUID(),
  bindingHash = digest('binding');
const expected = { requestId, bindingHash, helperPid: 42, leaderPid: 43 };
const receipt = {
  schema: 2,
  type: 'complete',
  ...expected,
  reason: 'exit',
  code: 0,
  termSignal: 0,
  activeProcesses: 0,
  leaderExited: true,
};

test('Windows staging accepts canonical Git paths and rejects ambiguous NTFS names', () => {
  for (const file of ['src/a.js', 'some folder/É.txt']) assert.equal(windowsRelativePath(file), file);
  for (const file of [
    'D:/other',
    '\\\\server\\share',
    'a/b:extra',
    'a/CON.txt',
    'nul',
    'a/com¹.txt',
    'a/aux.',
    'foo/..',
    'a//b',
    'x/y ',
    'x\\y',
    'x/PROGRA~1',
    'name?',
    'e\u0301.txt',
  ])
    assert.throws(() => windowsRelativePath(file), { code: 'isolation' });
});

test('Windows completion requires matching request, binding, helper, leader and zero Job membership', () => {
  assert.deepEqual(validateWindowsQuiescenceReceipt(receipt, expected), receipt);
  for (const patch of [
    { schema: 1 },
    { requestId: randomUUID() },
    { helperPid: 43 },
    { leaderPid: 42 },
    { bindingHash: digest('other') },
    { reason: 'interrupted' },
    { activeProcesses: 1 },
    { leaderExited: false },
    { groupESRCH: true },
    { termSignal: 15 },
  ])
    assert.throws(() => validateWindowsQuiescenceReceipt({ ...receipt, ...patch }, expected), {
      executionOutcome: 'unknown',
    });
});

test(
  'an unavailable Windows check backend refuses execution on other platforms',
  { skip: process.platform === 'win32' },
  () => {
    assert.throws(() => createWindowsBackend({ workspace: {} }), { code: 'isolation' });
  },
);

const native = { skip: process.platform !== 'win32', timeout: 180000 };
async function fixture(t) {
  assert.equal(process.arch, 'x64');
  assert.equal(process.versions.node, '24.22.3', 'run the exact Windows release Node');
  const helper = process.env.MOSAIC_TEST_WINDOWS_SUPERVISOR;
  assert.ok(
    helper && path.isAbsolute(helper),
    'set MOSAIC_TEST_WINDOWS_SUPERVISOR to the compiled, absolute helper executable',
  );
  const dir = await mkdtemp(path.join(os.tmpdir(), 'Mosaic protected checks '));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const artifacts = path.join(dir, 'artifact'),
    journal = path.join(dir, 'journal'),
    root = path.join(journal, 'worktree');
  await mkdir(artifacts);
  await mkdir(root, { recursive: true });
  const files = [];
  for (const [name, from] of [
    ['node.exe', process.execPath],
    ['mosaic-windows-supervisor.exe', helper],
  ]) {
    const file = path.join(artifacts, name);
    await copyFile(from, file);
    const data = await readFile(file);
    files.push({ path: name, sha256: digest(data), bytes: data.length });
  }
  const manifest = {
    schema: 1,
    platform: 'win32',
    arch: 'x64',
    backend: WINDOWS_BACKEND,
    nodeVersion: '24.22.3',
    files,
    supervisorSourceSha256: digest(
      await readFile(new URL('../src/project/check-backends/windows-supervisor.cpp', import.meta.url)),
    ),
  };
  const artifactManifestPath = path.join(artifacts, 'artifact-manifest.json'),
    content = JSON.stringify(manifest);
  await writeFile(artifactManifestPath, content);
  const config = { schema: 1, artifactManifestPath, artifactManifestSha256: digest(content) };
  await writeFile(path.join(root, 'allowed.txt'), 'approved');
  await writeFile(path.join(root, 'denied.txt'), 'outside scope');
  await writeFile(path.join(journal, 'private-canary'), 'private state');
  const workspace = {
    root,
    journal: { dir: journal },
    manifest: { permissions: { readPaths: ['allowed.txt'], checks: [] } },
    file: async (file) => path.join(root, file),
    inventory: async () => [
      { path: 'allowed.txt', hash: digest(await readFile(path.join(root, 'allowed.txt'))) },
    ],
    snapshot: async () => ({ 'allowed.txt': digest('approved'), 'denied.txt': digest('outside scope') }),
  };
  const history = [];
  let onPrepared = () => {},
    onGo = () => {};
  const ownership = {
    begin: async (binding) => {
      const requestId = randomUUID(),
        owned = path.join(dir, 'owner-' + requestId);
      await mkdir(owned);
      const receiptPath = path.join(owned, 'completion.json');
      history.push({ type: 'begin', binding });
      return {
        requestId,
        receiptPath,
        prepared: (event) => {
          history.push(event);
          onPrepared(event);
        },
        authorizeGo: () => {
          history.push({ type: 'go' });
          onGo();
        },
        complete: (event) => history.push(event),
        uncertain: (reason) => history.push({ type: 'uncertain', reason }),
      };
    },
  };
  const backend = createWindowsBackend({
    workspace,
    options: {
      nativeCheckRuntime: config,
      expectedRuntimeFingerprint: config.artifactManifestSha256,
      expectedDependencyHash: windowsDependencyInventory(path.join(root, 'node_modules')).hash,
      ownership,
    },
  });
  const node = backend.identity().runtime.runtime.executable;
  return {
    dir,
    journal,
    root,
    config,
    workspace,
    backend,
    history,
    prepared: (fn) => {
      onPrepared = fn;
    },
    go: (fn) => {
      onGo = fn;
    },
    run: async (program, { timeoutMs = 8000, signal } = {}) =>
      backend.execute({
        argv: [node, '-e', program],
        cwd: root,
        env: {},
        permissions: await createPolicy(workspace),
        timeoutMs,
        signal,
      }),
  };
}

test(
  'real LPAC check reads approved input, writes scratch, denies private I/O and loopback, and records completion',
  native,
  async (t) => {
    const f = await fixture(t);
    const server = net.createServer((socket) => socket.end());
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const outcome = await f.run(`
    const fs=require('fs'),net=require('net'),cp=require('child_process');
    const result={input:fs.readFileSync('allowed.txt','utf8')};
    fs.writeFileSync('.overnight-output/result.txt','ok');result.output=fs.readFileSync('.overnight-output/result.txt','utf8');
    for(const [key,fn] of [['private',()=>fs.readFileSync(${JSON.stringify(path.join(f.journal, 'private-canary'))})],['denied',()=>fs.readFileSync(${JSON.stringify(path.join(f.root, 'denied.txt'))})],['write',()=>fs.writeFileSync('allowed.txt','bad')]]){try{fn();result[key]='ALLOWED';}catch(e){result[key]=e.code;}}
    result.child=cp.execFileSync(process.execPath,['-e',"process.stdout.write('child ok')"],{encoding:'utf8'});
    const s=net.connect(${server.address().port},'127.0.0.1');s.on('connect',()=>{result.network='ALLOWED';s.destroy();console.log(JSON.stringify(result));});s.on('error',e=>{result.network=e.code;console.log(JSON.stringify(result));});
  `);
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.equal(outcome.stopped, false);
    const value = JSON.parse(outcome.stdout);
    assert.equal(value.input, 'approved');
    assert.equal(value.output, 'ok');
    assert.equal(value.child, 'child ok');
    for (const key of ['private', 'write', 'denied', 'network'])
      assert.ok(['EACCES', 'EPERM'].includes(value[key]), key + ' ' + value[key]);
    assert.equal(outcome.quiescence.activeProcesses, 0);
    assert.deepEqual(
      f.history.map((x) => x.type),
      ['begin', 'prepared', 'go', 'complete'],
    );
    assert.equal(await readFile(path.join(f.root, 'allowed.txt'), 'utf8'), 'approved');
  },
);

test('real Job kills a detached descendant before publishing completion', native, async (t) => {
  const f = await fixture(t);
  const outcome = await f.run(
    `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(c.pid);c.unref();`,
  );
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(outcome.quiescence.activeProcesses, 0);
  const pid = Number(outcome.stdout.trim());
  assert.ok(pid > 0);
  assert.throws(
    () => process.kill(pid, 0),
    (error) => error.code === 'ESRCH',
  );
});

test('real Job enforces timeout, output bound and pre-GO cancellation', native, async (t) => {
  const f = await fixture(t);
  const timed = await f.run('setInterval(()=>{},1000)', { timeoutMs: 300 });
  assert.equal(timed.stopped, true);
  assert.equal(timed.quiescence.reason, 'timeout');
  const noisy = await f.run("process.stdout.write('x'.repeat(400000))");
  assert.equal(noisy.stopped, true);
  assert.equal(noisy.quiescence.reason, 'output-limit');
  assert.ok(Buffer.byteLength(noisy.stdout) <= 256 * 1024);
  const ctl = new AbortController();
  f.prepared(() => ctl.abort());
  const canceled = await f.run("console.log('unexpected execution')", { signal: ctl.signal });
  assert.equal(canceled.stdout, '');
  assert.equal(canceled.quiescence.reason, 'startup-cancel');
});

test('changed pinned artifact stops before acquiring the execution owner', native, async (t) => {
  const f = await fixture(t);
  await writeFile(f.config.artifactManifestPath, '{}');
  await assert.rejects(f.run('console.log(1)'), /manifest bytes changed/);
  assert.deepEqual(f.history, []);
});
