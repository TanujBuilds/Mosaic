import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const source = fileURLToPath(new URL('../', import.meta.url));
const nodeVersion = '24.22.3';
const backend = {id: 'windows-appcontainer', revision: 1};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const workerModel = 'mosaic-fixture-worker';
const setupMessage = 'Mosaic setup connectivity probe. Reply with setup ok.';

export async function loopbackSetupProvider(t) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const request = {method: req.method, path: req.url, body: '', authorization: req.headers.authorization};
    requests.push(request);
    const chunks = [];
    let length = 0;
    try {
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 32_768) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
    } catch {
      res.destroy();
      return;
    }
    const body = Buffer.concat(chunks).toString('utf8');
    request.body = body;

    let result;
    if (req.method === 'GET' && req.url === '/v1/models' && !body && !req.headers.authorization) {
      result = {object: 'list', data: [{id: workerModel}]};
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions' && !req.headers.authorization) {
      try {
        const input = JSON.parse(body);
        if (input.model === workerModel && input.max_tokens === 16 && !input.stream
          && JSON.stringify(input.messages) === JSON.stringify([{role: 'user', content: setupMessage}])) {
          result = {
            model: workerModel,
            choices: [{message: {role: 'assistant', content: 'setup ok'}, finish_reason: 'stop'}],
            usage: {prompt_tokens: 11, completion_tokens: 2, total_tokens: 13},
          };
        }
      } catch {
        // An invalid setup request receives the same closed response as any other unexpected request.
      }
    }
    res.writeHead(result ? 200 : 400, {'content-type': 'application/json'});
    res.end(JSON.stringify(result ?? {error: {message: 'Only the fixed setup diagnostics are supported'}}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return {url: `http://127.0.0.1:${server.address().port}/v1`, requests};
}

export async function stageWindowsSource(t) {
  assert.equal(process.platform, 'win32');
  assert.equal(process.arch, 'x64');
  assert.equal(process.versions.node, nodeVersion, 'use the pinned Windows release Node runtime');
  const supervisor = process.env.MOSAIC_TEST_WINDOWS_SUPERVISOR;
  assert.ok(supervisor && path.isAbsolute(supervisor), 'supply the native x64 supervisor built from this checkout');

  const parent = await realpath(process.env.RUNNER_TEMP ?? tmpdir());
  const root = await realpath(await mkdtemp(path.join(parent, 'Mosaic workflows ')));
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 5}));
  const runtime = path.join(root, 'runtime');
  const bin = path.join(runtime, 'bin');
  const artifacts = path.join(runtime, 'check-artifact');
  await Promise.all([
    mkdir(bin, {recursive: true}),
    mkdir(artifacts, {recursive: true}),
    cp(path.join(source, 'src'), path.join(runtime, 'src'), {recursive: true}),
    cp(path.join(source, 'node_modules'), path.join(runtime, 'node_modules'), {
      recursive: true,
      filter: file => file !== path.join(source, 'node_modules', '.bin'),
    }),
  ]);

  execFileSync(process.env.ComSpec, ['/d', '/s', '/c', 'call "%MOSAIC_BUILD_SCRIPT%" "%MOSAIC_TEST_BINARY%"'], {
    cwd: root,
    env: {
      ...process.env,
      MOSAIC_BUILD_SCRIPT: path.join(source, 'distribution', 'win32-files', 'build.cmd'),
      MOSAIC_TEST_BINARY: path.join(bin, 'mosaic-files.exe'),
    },
    windowsVerbatimArguments: true,
    stdio: 'inherit',
  });

  const executable = path.join(bin, 'node.exe');
  const checkNode = path.join(artifacts, 'node.exe');
  const files = await Promise.all(Object.entries({
    'node.exe': process.execPath,
    'mosaic-windows-supervisor.exe': supervisor,
  }).map(async ([name, input]) => {
    const dest = path.join(artifacts, name);
    await copyFile(input, dest);
    const bytes = await readFile(dest);
    return {path: name, sha256: hash(bytes), bytes: bytes.length};
  }));
  await copyFile(checkNode, executable);

  const manifest = {
    schema: 1, platform: 'win32', arch: 'x64', backend, nodeVersion, files,
    supervisorSourceSha256: hash(await readFile(path.join(runtime, 'src', 'project', 'check-backends', 'windows-supervisor.cpp'))),
  };
  const artifactManifestPath = path.join(artifacts, 'artifact-manifest.json');
  const bytes = JSON.stringify(manifest);
  await writeFile(artifactManifestPath, bytes);
  const runtimeFingerprint = hash(bytes);
  return {
    root, runtime, executable, checkNode,
    cli: path.join(runtime, 'src', 'beta', 'cli.mjs'),
    load: name => import(pathToFileURL(path.join(runtime, 'src', name)).href),
    execution: {backend: backend.id, backendRevision: backend.revision, runtimeFingerprint},
    nativeCheckRuntime: {schema: 1, artifactManifestPath, artifactManifestSha256: runtimeFingerprint},
  };
}

export async function createWorkflowRepository(stage) {
  const {git} = await stage.load('project/git.mjs');
  const repo = path.join(stage.root, 'Mosaic sample project');
  await mkdir(path.join(repo, 'src'), {recursive: true});
  await mkdir(path.join(repo, 'checks'));
  await writeFile(path.join(repo, 'src', 'sample.mjs'), 'export const sample = 1;\n');
  await writeFile(path.join(repo, 'checks', 'verify.mjs'), [
    "import assert from 'node:assert/strict';",
    "import {sample} from '../src/sample.mjs';",
    'assert.equal(sample, 1);',
    '',
  ].join('\n'));
  await git(repo, 'init', '-q');
  await git(repo, 'add', '--', 'src/sample.mjs', 'checks/verify.mjs');
  await git(repo, '-c', 'user.name=Mosaic Workflow Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'Commit the Windows workflow fixture');
  const baseCommit = (await git(repo, 'rev-parse', 'HEAD')).trim();
  assert.match(baseCommit, /^[a-f0-9]{40}$/);
  return {repo, baseCommit, git};
}

function assertInTime(result, ms, message) {
  return Promise.race([
    result,
    delay(ms, undefined, {ref: false}).then(() => { throw Error(message()); }),
  ]);
}

export async function startWorkflowService(t, stage, paths) {
  const child = spawn(stage.executable, [stage.cli, '--home', paths.home, 'serve'], {
    cwd: stage.runtime, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = createInterface({input: child.stdout});
  let diagnostic = '';
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-8192); });
  const exit = new Promise(resolve => {
    child.once('error', error => resolve({error}));
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null && child.pid) child.kill('SIGKILL');
    await assertInTime(exit, 15000, () => 'owned source-test coordinator did not exit');
  });
  const firstLine = once(lines, 'line').then(([line]) => JSON.parse(line));
  const ready = await assertInTime(Promise.race([
    firstLine,
    exit.then(result => { throw Error(`Source-test coordinator exited during startup ${JSON.stringify(result)}\n${diagnostic}`); }),
  ]), 30000, () => `Source-test coordinator did not report ready\n${diagnostic}`);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.root, paths.state);
  assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+$/u);

  const {client} = await stage.load('beta/client.mjs');
  return async () => {
    const result = await client(paths)('service_stop', {idempotencyKey: randomUUID()});
    assert.deepEqual(result, {stopping: true});
    assert.deepEqual(await assertInTime(exit, 15000, () => `Source-test coordinator did not stop\n${diagnostic}`),
      {code: 0, signal: null}, diagnostic);
  };
}

export async function connectScriptedMcp(t, stage, paths) {
  const client = new Client({name: 'Mosaic Windows scripted qualification client', version: '1.0.0'});
  const transport = new StdioClientTransport({
    command: stage.executable,
    args: [stage.cli, '--home', paths.home, 'mcp'],
    cwd: stage.runtime,
    stderr: 'pipe',
  });
  let diagnostic = '';
  transport.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-8192); });
  t.after(() => transport.close());
  try {
    await assertInTime(client.connect(transport), 30000, () => 'MCP handshake timed out');
  } catch (error) {
    throw Error(`Scripted MCP handshake failed\n${diagnostic}`, {cause: error});
  }
  return {
    client,
    async call(name, args = {}, {error = false} = {}) {
      const result = await client.callTool({name, arguments: args}, undefined, {timeout: 35_000});
      assert.equal(result.content[0]?.type, 'text', name);
      const data = JSON.parse(result.content[0].text);
      assert.equal(Boolean(result.isError), error, `${name}: ${JSON.stringify(data)}`);
      return data;
    },
  };
}
