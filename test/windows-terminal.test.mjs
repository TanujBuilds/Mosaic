import assert from 'node:assert/strict';
import {execFile, execFileSync, spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {cp, mkdir, mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const source = fileURLToPath(new URL('../', import.meta.url));
const initial = 'Saved overview project';
const current = 'Most recent terminal project';
const decision = 'Fixture owner decision';
const details = 'Fixture decision details.';
const assignment = 'Queued terminal assignment';

async function stage(t) {
  const parent = await realpath(process.env.RUNNER_TEMP ?? tmpdir());
  const root = await realpath(await mkdtemp(path.join(parent, 'Mosaic terminal ')));
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 5}));
  const runtime = path.join(root, 'runtime');
  const bin = path.join(runtime, 'bin');
  const home = path.join(root, 'disposable profile');
  await Promise.all([
    mkdir(bin, {recursive: true}), mkdir(home),
    cp(path.join(source, 'src'), path.join(runtime, 'src'), {recursive: true}),
  ]);

  const helper = path.join(bin, 'mosaic-files.exe');
  execFileSync(process.env.ComSpec, ['/d', '/s', '/c', 'call "%MOSAIC_TERMINAL_FILE_BUILD%" "%MOSAIC_TERMINAL_FILES%"'], {
    cwd: root, windowsVerbatimArguments: true, stdio: 'inherit', timeout: 30_000,
    env: {
      ...process.env,
      MOSAIC_TERMINAL_FILE_BUILD: path.join(source, 'distribution', 'win32-files', 'build.cmd'),
      MOSAIC_TERMINAL_FILES: helper,
    },
  });
  const finder = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const visualStudio = execFileSync(finder, [
    '-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath',
  ], {encoding: 'utf8', timeout: 5_000}).trim();
  assert.ok(path.isAbsolute(visualStudio), 'Visual Studio x64 toolchain');
  const probe = path.join(root, 'terminal-probe.exe');
  execFileSync(process.env.ComSpec, ['/d', '/s', '/c',
    'call "%MOSAIC_TERMINAL_VS%" -arch=x64 -host_arch=x64 && cl /nologo /std:c++17 /EHsc /W4 "%MOSAIC_TERMINAL_CPP%" /Fe:"%MOSAIC_TERMINAL_PROBE%"',
  ], {
    cwd: root, windowsVerbatimArguments: true, stdio: 'inherit', timeout: 30_000,
    env: {
      ...process.env,
      MOSAIC_TERMINAL_VS: path.join(visualStudio, 'Common7', 'Tools', 'VsDevCmd.bat'),
      MOSAIC_TERMINAL_CPP: path.join(source, 'test-support', 'windows-terminal-probe.cpp'),
      MOSAIC_TERMINAL_PROBE: probe,
    },
  });
  const {locations, privateDirectories, saveJson} = await import(pathToFileURL(path.join(runtime, 'src', 'beta', 'files.mjs')).href);
  const paths = locations(home, true);
  await privateDirectories(paths);
  const args = [path.join(runtime, 'src', 'beta', 'cli.mjs'), '--home', home, '--source', 'beta', 'status'];
  return {root, paths, saveJson, probe, args};
}

function fixtureReplies() {
  const now = Date.now();
  const goal = {
    id: 'overview', objective: initial, status: 'active', mode: 'codex_only',
    createdAt: now - 3000, deadline: now + 60_000, taskCount: 1, maxTasks: 3,
  };
  const latest = {...goal, id: 'latest', objective: current, status: 'draft', taskCount: 0};
  return {
    tools_list: [
      {name: 'observer_current_activity'},
      {name: 'observer_timeline', inputSchema: {properties: {recent: {type: 'boolean'}}}},
    ],
    observer_snapshot: {
      goals: [goal, latest],
      tasks: [{
        id: 'sample-task', goalId: goal.id, actor: 'codex', kind: 'coding', status: 'queued',
        objective: assignment, priority: 'normal', lastActivityAt: now - 3000, attempts: 0, reviews: 0,
      }],
      agents: [], reviewers: [], planning: [],
      needsYou: {items: [{id: 'sample-decision', kind: 'result', title: decision, detail: details}]},
      cursor: 2,
    },
    observer_timeline: {events: [], cursor: 2, hasMore: false},
    observer_current_activity: {
      activity: [{goalId: latest.id, at: now - 1000}], cursor: 2, hasMore: false,
    },
  };
}

async function viewerFixture(t, stage) {
  const token = randomBytes(32).toString('hex');
  const calls = [];
  const replies = fixtureReplies();
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 8192) throw Error('unexpected request size');
      }
      const {name, input} = JSON.parse(body);
      const allowed = req.method === 'POST' && req.url === '/api/invoke'
        && req.headers.authorization === 'Bearer ' + token && Object.hasOwn(replies, name);
      calls.push({name, input, allowed});
      res.writeHead(allowed ? 200 : 403, {'content-type': 'application/json'});
      res.end(JSON.stringify(allowed ? replies[name] : {error: 'Fixture accepts viewer reads only'}));
    } catch {
      calls.push({allowed: false});
      res.writeHead(400).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const connection = path.join(stage.paths.state, 'viewer-connection.json');
  await stage.saveJson(connection, {url: `http://127.0.0.1:${server.address().port}`, token, role: 'viewer'});
  return {calls, connection, before: await readFile(connection), token};
}

function withoutVt(output) {
  return output.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '');
}

async function interactive(stage, env) {
  const requireTty = 'data:text/javascript,' + encodeURIComponent(`
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw Error('ConPTY observer needs native stdin and stdout: ' +
        JSON.stringify({stdin: Boolean(process.stdin.isTTY), stdout: Boolean(process.stdout.isTTY)}));
    }
  `);
  const child = spawn(stage.probe, [process.execPath, '--import', requireTty, ...stage.args], {
    cwd: stage.root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let transcript = '', stderr = '', result;
  const exit = new Promise(resolve => {
    child.once('error', error => resolve({error}));
    child.once('close', (code, signal) => resolve({code, signal}));
  }).then(outcome => { result = outcome; return outcome; });
  child.stdin.on('error', () => {}); // A prematurely exited child is diagnosed through its exit result.
  child.stdout.setEncoding('utf8').on('data', chunk => { transcript += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  const screen = async (label, markers, from = 0) => {
    const deadline = Date.now() + 7_000;
    while (Date.now() < deadline) {
      const visible = withoutVt(transcript.slice(from));
      if (markers.every(marker => visible.includes(marker))) return;
      if (result) break;
      await delay(25);
    }
    assert.fail(`${label} did not render: ${JSON.stringify(result)}\n${stderr}\n${withoutVt(transcript).slice(-3500)}`);
  };
  const key = async (value, label, markers) => {
    const offset = transcript.length;
    child.stdin.write(value);
    await screen(label, markers, offset);
  };

  try {
    await screen('initial interactive observer', [initial, 'n Needs You']);
    await key('n', 'Needs You', [decision, details]);
    await key('b', 'Queue', [assignment, 'Enter Details']);
    await key('a', 'Current', [current]);
    child.stdin.write('q');
    const stopped = await Promise.race([exit, delay(8_000, undefined, {ref: false})]);
    assert.deepEqual(stopped, {code: 0, signal: null}, stderr + '\n' + withoutVt(transcript).slice(-3500));
    assert.match(transcript, /\x1b\[/u, 'interactive ConPTY produced virtual terminal output');
  } finally {
    if (!result && child.pid) child.kill('SIGKILL');
    await exit;
  }
}

// Source CLI and native file IO on a real Windows ConPTY. The viewer endpoint
// supplies only disposable saved state. Installation and a real coordinator
// session are separate qualification lanes.
test('Windows terminal observer navigates saved views by key and exits, and redirected reads run once', {
  skip: process.platform !== 'win32',
  timeout: 145_000,
}, async t => {
  const runtime = await stage(t);
  const viewer = await viewerFixture(t, runtime);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'NO_COLOR'));

  await t.test('interactive ConPTY keyboard and viewer reads', async () => {
    await interactive(runtime, env);
    assert.ok(viewer.calls.some(call => call.name === 'observer_current_activity' && call.input.after === 0),
      'Current requested saved activity through the viewer connection');
  });

  await t.test('redirected output returns once per invocation', async () => {
    for (const flags of [[], ['--once']]) {
      const from = viewer.calls.length;
      const {stdout, stderr} = await exec(process.execPath, [...runtime.args, ...flags], {
        cwd: runtime.root, env, windowsHide: true, timeout: 12_000, maxBuffer: 256 * 1024,
      });
      assert.equal(stderr, '');
      assert.ok(stdout.includes(initial));
      assert.match(stdout, /Terminal observer/u);
      assert.doesNotMatch(stdout, /\x1b/u);
      assert.equal(stdout.includes(viewer.token), false);
      const calls = viewer.calls.slice(from);
      assert.equal(calls.filter(call => call.name === 'observer_snapshot').length, 1);
      assert.equal(calls.some(call => call.name === 'observer_current_activity'), false);
    }
  });

  assert.ok(viewer.calls.length > 0 && viewer.calls.every(call => call.allowed), 'the observer used only authenticated read tools');
  assert.deepEqual(await readFile(viewer.connection), viewer.before);
  await assert.rejects(readFile(path.join(runtime.paths.state, 'connection.json')), {code: 'ENOENT'});
});
