import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as detection from '../src/beta/hosts/detection.mjs';
import {formatHostRegistrationGuide} from '../src/beta/hosts/index.mjs';
import {runHost} from '../distribution/onboarding/windows-host.mjs';
import {runFirstTask} from '../src/beta/first-task.mjs';

const home = String.raw`C:\Users\Mosaic Tester`;
const local = home + String.raw`\AppData\Local`;
const launcher = local + String.raw`\Mosaic Beta\mosaic.exe`;
const appPaths = {
  'claude-code': home + String.raw`\.local\bin\claude.exe`,
  codex: local + String.raw`\Programs\OpenAI\Codex\bin\codex.exe`,
  cursor: local + String.raw`\Programs\cursor\Cursor.exe`,
  antigravity: local + String.raw`\Programs\Antigravity\Antigravity.exe`,
};

test('Windows discovers all four native apps with a stale or hostile PATH', async () => {
  const env = {LOCALAPPDATA: local, ProgramFiles: String.raw`C:\Program Files`,
    PATH: String.raw`C:\Work Project\node_modules\.bin`};
  const resolveExecutable = async path => Object.values(appPaths).includes(path) ? path : null;
  const found = await detection.detectCodingApps({home}, {platform: 'win32', env, resolveExecutable});
  assert.deepEqual(found, ['claude-code', 'codex', 'cursor', 'antigravity']);
});

test('Windows discovery declines a known filename redirected into a project', async () => {
  const options = {
    platform: 'win32',
    env: {LOCALAPPDATA: local, PATH: String.raw`C:\Project`},
    resolveExecutable: async path => path === appPaths['claude-code'] ? String.raw`C:\Project\claude.exe` : null,
  };
  assert.deepEqual(await detection.detectCodingApps({home}, options), []);
});

test('manual CLI instructions are executable PowerShell syntax for paths with spaces and apostrophes', () => {
  const command = String.raw`C:\Users\Mosaic Tester's\mosaic.exe`;
  const help = formatHostRegistrationGuide({
    hostId: 'claude-code', command: 'claude', argv: ['mcp', 'add', '--', command, 'mcp'],
    launcher: command, target: home + String.raw`\.claude.json`,
  }, {platform: 'win32'});
  assert.ok(help.includes(String.raw`& 'claude' 'mcp' 'add' '--' 'C:\Users\Mosaic Tester''s\mosaic.exe' 'mcp'`));
});

function hostFixture(id, answers) {
  const messages = [], opened = [], calls = [];
  const entry = {command: launcher, args: ['mcp']};
  const argv = ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'mosaic-beta', '--', launcher, 'mcp'];
  const context = {
    id, home, platform: 'win32', preview: {launcher, entry, argv},
    checkSettings: async () => {},
    receipt: async () => null,
  };
  const io = {
    ask: async prompt => {
      const answer = answers.shift();
      assert.notEqual(answer, undefined, 'Unexpected prompt ' + prompt);
      return answer;
    },
    say: message => messages.push(message),
    installed: async () => appPaths[id],
    capture: async (file, args) => {
      calls.push([file, args]);
      if (args[0] === 'auth') return {status: 0};
      assert.deepEqual(args, argv);
      return {status: 0, stdout: 'Added stdio MCP server mosaic-beta with command fixture'};
    },
    open: (target, args) => { opened.push({target, args}); return true; },
    interactive: () => assert.fail('Windows must not call a macOS launcher'),
    install: () => assert.fail('Windows guided install must not invoke a POSIX shell'),
    registerCodex: () => assert.fail('Unexpected Codex settings write'),
  };
  return {context, io, messages, opened, calls};
}

test('a missing Windows Claude Code opens its native vendor setup only with consent', async () => {
  const f = hostFixture('claude-code', ['open', 'recheck', 'add', 'check']);
  let calls = 0;
  f.io.installed = async () => calls++ ? appPaths['claude-code'] : null;
  let receiptReads = 0;
  f.context.receipt = async () => receiptReads++
    ? {hostId: 'claude-code', kind: 'registry_call', at: Date.now()}
    : null;
  assert.equal(await runHost(f.context, f.io), 0);
  assert.deepEqual(f.opened, [{target: 'https://code.claude.com/docs/en/setup#install-on-native-windows', args: undefined}]);
  assert.ok(f.calls.every(([file]) => file === appPaths['claude-code']));
  assert.match(f.messages.join('\n'), /fresh registry call/);
});

test('Windows Cursor link passes the absolute executable as JSON data', async () => {
  const f = hostFixture('cursor', ['continue', 'free', 'open', 'confirmed', 'later']);
  assert.equal(await runHost(f.context, f.io), 2);
  assert.equal(f.opened.length, 1);
  assert.equal(f.opened[0].target, appPaths.cursor);
  assert.deepEqual(f.opened[0].args.slice(0, 2), ['--open-url', '--']);
  const url = new URL(f.opened[0].args[2]);
  assert.equal(url.protocol, 'cursor:');
  assert.equal(url.pathname, '/mcp/install');
  assert.equal(url.searchParams.get('name'), 'mosaic-beta');
  assert.deepEqual(JSON.parse(Buffer.from(url.searchParams.get('config'), 'base64')),
    {command: launcher, args: ['mcp']});
  assert.match(f.messages.join('\n'), /mosaic connect/);
  assert.doesNotMatch(f.messages.join('\n'), /~\/\.local\/bin/);
});

test('Windows Antigravity uses its config manager and exact stdio launcher', async () => {
  const f = hostFixture('antigravity', ['continue', 'confirmed', 'later']);
  assert.equal(await runHost(f.context, f.io), 2);
  assert.deepEqual(f.opened, []);
  assert.match(f.messages.join('\n'), /Open MCP Config/);
  assert.ok(f.messages.join('\n').includes(JSON.stringify(launcher)));
});

test('Windows Codex keeps its guarded save and requires a fresh bridge call', async () => {
  const f = hostFixture('codex', ['save', 'check', 'check']);
  let saved = false;
  f.io.capture = async (file, args) => {
    assert.equal(file, appPaths.codex);
    if (args[0] === 'login') return {status: 0};
    assert.deepEqual(args, ['mcp', 'get', '--json', 'mosaic-beta']);
    return saved ? {status: 0, stdout: JSON.stringify({name: 'mosaic-beta', enabled: true,
      transport: {type: 'stdio', command: launcher, args: ['mcp']}})}
      : {status: 1, stderr: "Error: No MCP server named 'mosaic-beta' found."};
  };
  f.io.registerCodex = async (file, command) => {
    assert.equal(file, appPaths.codex);
    assert.equal(command, launcher);
    saved = true;
    return 'written';
  };
  const baseline = {hostId: 'codex', kind: 'registry_call', at: Date.now() - 5000};
  let reads = 0;
  f.context.receipt = async () => ++reads <= 2 ? baseline : {...baseline, at: Date.now()};
  assert.equal(await runHost(f.context, f.io), 0);
  assert.match(f.messages.join('\n'), /yet to record a new registry call/);
  assert.match(f.messages.join('\n'), /fresh registry call/);
});

test('first-task menu and saved draft name Claude Code while retaining codex_only in protocol', async () => {
  const answers = ['1', 'Repair value', 'Check passes', 'src/', 'src/', 'node checks/verify.mjs'];
  const settings = {schema: 2, host: {id: 'claude-code'}, providers: [],
    defaults: {workerId: null, plannerWorkerId: null, review: {source: 'host', hostId: 'claude-code'}},
    execution: {backend: 'codex-sandbox', backendRevision: 1}, codexPath: process.execPath,
    serviceMaxConcurrentTasks: 1, capacityGroups: []};
  let output = '', submitted;
  const invoke = async (name, input) => {
    if (name === 'assignment_prepare') {
      submitted = input.manifest;
      return {status: 'prepared', goalId: 'first-task', hash: 'approval', summary: {limits: {hours: 1, maxTasks: 1,
        reviewAgentRuns: 1, coding: input.manifest.limits.taskLimits.coding}}};
    }
    assert.equal(name, 'goal_get');
    return {id: 'first-task', hash: 'approval', status: 'draft',
      manifest: {...submitted, project: {...submitted.project, baseCommit: 'a'.repeat(40)},
        mode: {id: submitted.mode, version: 1}, reviewPolicy: settings.defaults.review}};
  };
  const location = {home: process.cwd(), configDir: process.cwd(), config: 'unused', isolated: true};
  if(process.platform==='win32'){
    assert.equal(await runFirstTask(location,[process.cwd()],{invoke,loadSettings:async()=>settings,
      output:{write:text=>{output+=text;}},ask:async()=>assert.fail('A held task must not request project setup')}),1);
    assert.match(output,/qualified Windows filesystem boundary/);
    assert.equal(submitted,undefined);
    return;
  }
  assert.equal(await runFirstTask(location, [process.cwd()], {invoke, loadSettings: async () => settings,
    output: {write: text => { output += text; }}, ask: async () => answers.shift()}), 0);
  assert.equal(submitted.mode, 'codex_only');
  assert.match(output, /1\. Claude Code only/);
  assert.match(output, /Workflow: Claude Code only/);
  assert.match(output, /Paste into Claude Code/);
  assert.doesNotMatch(output, /Codex-only/);
});
