import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {installed, registerCodex, runHost} from '../distribution/onboarding/host.mjs';

const launcher = "/Users/Sample Mac/it's mine/.local/bin/mosaic";
const secret = 'UNRELATED_FIXTURE_MUST_STAY_PRIVATE';
const missing = {status: 1, stdout: '', stderr: "Error: No MCP server named 'mosaic-beta' found."};
const ok = {status: 0, stdout: '', stderr: ''};
const codexEntry = (transport = {}) => ({...ok, stdout: JSON.stringify({name: 'mosaic-beta', enabled: true,
  transport: {type: 'stdio', command: launcher, args: ['mcp'], ...transport}})});
const claudeArgs = ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'mosaic-beta', '--', launcher, 'mcp'];

function fixture(id, answers) {
  const lines = [], calls = [];
  const context = {
    id, preview: {launcher, argv: claudeArgs, entry: {type: 'stdio', command: launcher, args: ['mcp']}},
    checkSettings: async () => {}, receipt: async () => null
  };
  const io = {
    ask: async prompt => {
      const answer = answers.shift();
      assert.notEqual(answer, undefined, 'unexpected prompt: ' + prompt);
      return answer;
    },
    say: line => lines.push(line),
    installed: async () => '/fixture/' + id,
    capture: async (file, args) => {
      calls.push([file, args]);
      if (args[0] === 'login' || args[0] === 'auth') return ok;
      throw Error('Unexpected host command');
    },
    install: () => assert.fail('unexpected install'),
    interactive: () => assert.fail('unexpected interactive command'),
    registerCodex: () => assert.fail('unexpected Codex write')
  };
  return {context, io, lines, calls, run: () => runHost(context, io)};
}

test('a missing selected host waits for consent and explicit deferral stops installation', async () => {
  const f = fixture('claude-code', ['later']);
  f.io.installed = async host => { assert.equal(host.name, 'Claude Code'); return null; };
  assert.equal(await f.run(), 2);
  assert.match(f.lines.join('\n'), /code.claude.com/);
  assert.deepEqual(f.calls, []);
});

test('install, vendor sign-in, and add target only the selected Claude Code host', async () => {
  const f = fixture('claude-code', ['install', 'login', 'add', 'check']);
  let installed = false, signedIn = false, added = false, reads = 0;
  f.io.installed = async () => installed ? '/only/claude' : null;
  f.io.install = async host => {
    assert.equal(host.installer, 'https://claude.ai/install.sh');
    installed = true;
    return true;
  };
  f.io.capture = async (file, args) => {
    assert.equal(file, '/only/claude');
    if (args[0] === 'auth') return {...ok, status: signedIn ? 0 : 1, stdout: secret};
    assert.deepEqual(args, claudeArgs);
    added = true;
    return {...ok, stdout: 'Added stdio MCP server mosaic-beta with command: fixture to user config'};
  };
  f.io.interactive = (file, args) => {
    assert.equal(file, '/only/claude'); assert.deepEqual(args, ['auth', 'login']);
    signedIn = true; return true;
  };
  f.context.receipt = async () => ++reads === 1 ? null : {kind: 'registry_call', hostId: 'claude-code', at: Date.now()};
  assert.equal(await f.run(), 0);
  assert.ok(installed && signedIn && added);
  assert.doesNotMatch(f.lines.join('\n'), new RegExp(secret));
});

test('CLI refusal of a duplicate Claude Code registration preserves it and never launches a foreign health check', async () => {
  const f = fixture('claude-code', ['add', 'later']);
  f.io.capture = async (file, args) => {
    if (args[0] === 'auth') return ok;
    assert.deepEqual(args, claudeArgs);
    return {...ok, status: 1, stderr: 'already exists in user config ' + secret};
  };
  assert.equal(await f.run(), 2);
  assert.match(f.lines.join('\n'), /existing registration/);
  assert.doesNotMatch(f.lines.join('\n'), new RegExp(secret));
});

test('a saved identical Codex registration is reused and an old receipt cannot verify a new call', async () => {
  const f = fixture('codex', ['check', 'check', 'later']);
  f.io.capture = async (file, args) => args[0] === 'login' ? ok : codexEntry();
  const old = {kind: 'registry_call', hostId: 'codex', at: Date.now() - 5000};
  const receipts = [old, old, {kind: 'registry_call', hostId: 'cursor', at: Date.now()}];
  f.context.receipt = async () => receipts.shift();
  assert.equal(await f.run(), 2);
  assert.match(f.lines.join('\n'), /saved, enabled/);
  assert.equal(f.lines.filter(line => /yet to record/.test(line)).length, 2);
});

test('same-name Codex entry with a different environment is preserved even after manual confirmation', async () => {
  const f = fixture('codex', ['confirmed', 'later']);
  f.io.capture = async (file, args) => args[0] === 'login' ? ok : codexEntry({env: {TOKEN: secret}});
  assert.equal(await f.run(), 2);
  assert.match(f.lines.join('\n'), /still shows a missing or different entry/);
  assert.doesNotMatch(f.lines.join('\n'), new RegExp(secret));
});

test('missing is distinct from an unreadable CLI profile and an add is checked after it returns', async () => {
  const unknown = fixture('codex', ['later']);
  unknown.io.capture = async (file, args) => args[0] === 'login' ? ok : {...missing, stderr: 'bad config ' + secret};
  assert.equal(await unknown.run(), 2);
  assert.doesNotMatch(unknown.lines.join('\n'), new RegExp(secret));

  const f = fixture('codex', ['save', 'check']);
  let saved = false, reads = 0;
  f.io.capture = async (file, args) => args[0] === 'login' ? ok : saved ? codexEntry() : missing;
  f.io.registerCodex = async (file, arg) => {
    assert.equal(file, '/fixture/codex'); assert.equal(arg, launcher); saved = true; return 'written';
  };
  f.context.receipt = async () => ++reads === 1 ? null : {kind: 'registry_call', hostId: 'codex', at: Date.now()};
  assert.equal(await f.run(), 0);
  assert.ok(saved);
  assert.match(f.lines.join('\n'), /fresh registry call/);
});

test('Cursor opens a consented native install link with only the released command and literal args', async () => {
  const f = fixture('cursor', ['continue', 'free', 'open', 'confirmed', 'later']);
  const opened = [];
  f.io.interactive = (file, args) => { opened.push([file, args]); return true; };
  assert.equal(await f.run(), 2);
  assert.equal(opened.length, 1);
  const [[file, args]] = opened;
  assert.equal(file, '/usr/bin/open');
  assert.deepEqual(args.slice(0, 2), ['-a', '/fixture/cursor']);
  const target = new URL(args[2]);
  assert.equal(target.protocol, 'cursor:'); assert.equal(target.hostname, 'anysphere.cursor-deeplink');
  assert.equal(target.pathname, '/mcp/install');
  assert.deepEqual([...target.searchParams.keys()], ['name', 'config']);
  assert.equal(target.searchParams.get('name'), 'mosaic-beta');
  assert.deepEqual(JSON.parse(Buffer.from(target.searchParams.get('config'), 'base64')), {command: launcher, args: ['mcp']});
});

test('existing Cursor entries bypass the install link, and Antigravity uses its own config manager', async () => {
  for (const [id, answers, hint] of [
    ['cursor', ['continue', 'match', 'later'], /confirmed the existing entry/],
    ['cursor', ['continue', 'conflict', 'later'], /resolve the name conflict/],
    ['antigravity', ['continue', 'later'], /Open MCP Config/]
  ]) {
    const f = fixture(id, answers);
    assert.equal(await f.run(), 2);
    assert.match(f.lines.join('\n'), hint);
    assert.deepEqual(f.calls, []);
  }
});

test('settings changes abort before a host write', async () => {
  const f = fixture('codex', ['save']);
  f.io.capture = async (file, args) => args[0] === 'login' ? ok : missing;
  let checks = 0;
  f.context.checkSettings = async () => { if (++checks === 2) throw Error('Mosaic setup changed'); };
  await assert.rejects(f.run(), /Mosaic setup changed/);
});

test('Codex conditional registration writes only an absent name in an isolated real CLI profile', {
  skip: !process.env.MOSAIC_TEST_CODEX
}, async t => {
  const file = process.env.MOSAIC_TEST_CODEX;
  assert.ok(path.isAbsolute(file), 'provide an absolute test CLI executable');
  const home = await mkdtemp(path.join(os.tmpdir(), 'mosaic-codex-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const options = {cwd: home, env: {HOME: home, CODEX_HOME: home, PATH: '/usr/bin:/bin', TMPDIR: home}};
  const config = path.join(home, 'config.toml');
  await writeFile(config, '[mcp_servers.neighbor]\ncommand = "/bin/false"\n', {mode: 0o600});
  assert.equal(await registerCodex(file, launcher, options), 'written');
  const result = spawnSync(file, ['mcp', 'get', '--json', 'mosaic-beta'], {...options, encoding: 'utf8'});
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).transport.command, launcher);
  const expected = await readFile(config);
  assert.match(expected.toString(), /mcp_servers.neighbor/);
  assert.equal(await registerCodex(file, '/foreign/command', options), 'changed');
  assert.deepEqual(await readFile(config), expected);
});

test('automatic host lookup ignores project PATH and launchers linked back into the project', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mosaic-discovery-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const local = path.join(home, '.local/bin');
  const project = path.join(home, 'project/node_modules/.bin');
  const name = 'mosaic-host-test-only';
  await mkdir(local, {recursive: true});
  await mkdir(project, {recursive: true});
  const foreign = path.join(project, name);
  await writeFile(foreign, '#!/bin/sh\nexit 1\n', {mode: 0o755});
  const priorPath = process.env.PATH;
  process.env.PATH = project + path.delimiter + priorPath;
  t.after(() => {process.env.PATH = priorPath;});
  const host = {command: name};
  assert.equal(await installed(host, {home}), null);
  const launcher = path.join(local, name);
  await symlink(foreign, launcher);
  assert.equal(await installed(host, {home}), null);
  await rm(launcher);
  await writeFile(launcher, '#!/bin/sh\nexit 0\n', {mode: 0o755});
  assert.equal(await installed(host, {home}), await realpath(launcher));
});
