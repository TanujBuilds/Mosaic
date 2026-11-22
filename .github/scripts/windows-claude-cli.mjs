import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {lstat, mkdir, readFile, realpath} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {locations} from '../../src/beta/files.mjs';
import {claudeCode} from '../../src/beta/hosts/claude-code.mjs';
import {windowsHostExecutable} from '../../src/beta/hosts/detection.mjs';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const [home, vendor] = process.argv.slice(2);
assert.equal(path.dirname(home), process.env.RUNNER_TEMP);
assert.equal(vendor, path.join(home, '.local', 'bin', 'claude.exe'));
const paths = locations(home, true);
const env = {
  SystemRoot: process.env.SystemRoot,
  WINDIR: process.env.SystemRoot,
  Path: path.join(process.env.SystemRoot, 'System32'),
  HOME: home,
  USERPROFILE: home,
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  TEMP: path.join(home, 'Temp'),
  TMP: path.join(home, 'Temp'),
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
};
for (const dir of [env.LOCALAPPDATA, env.APPDATA, env.TEMP, env.CLAUDE_CONFIG_DIR]) await mkdir(dir, {recursive:true});
const executable = await windowsHostExecutable('claude-code', {home, isolated:true, env});
assert.equal(executable, await realpath(vendor));
const exec = promisify(execFile);
async function cli(...args) {
  const {stdout} = await exec(executable, args, {env, cwd:home, windowsHide:true, timeout:30000, maxBuffer:256*1024});
  return stdout.trim();
}

// All configuration comes from this fixture. Claude's list command can health-check
// entries, so confirm each configured stdio executable is absent before listing.
const name = 'mosaic-beta', foreign = 'unrelated-fixture';
const other = path.join(home, 'Foreign registration', 'foreign.exe');
const preview = claudeCode.previewRegistration({paths, launcher:paths.launcher});
const missing = async file => assert.rejects(lstat(file), {code:'ENOENT'});
await missing(paths.launcher);
await missing(other);
assert.match(await cli('--version'), /^2\.1\.323 \(Claude Code\)$/);
const seed = (serverName, arg) => cli('mcp', 'add', '--transport', 'stdio', '--scope', 'user', serverName, '--', other, arg);
await seed(foreign, '--preserve-this-argument');

const candidates = [path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'), path.join(home, '.claude.json')];
const configs = [];
for (const file of candidates) {
  try { await lstat(file); configs.push(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
assert.equal(configs.length, 1, 'Claude must write a single user configuration under the disposable profile');
const bindings = async () => JSON.parse(await readFile(configs[0], 'utf8')).mcpServers;
const seeded = await bindings();
assert.deepEqual(Object.keys(seeded), [foreign]);
assert.equal(seeded[foreign].type, 'stdio');
assert.equal(seeded[foreign].command, other);
assert.deepEqual(seeded[foreign].args, ['--preserve-this-argument']);

assert.match(await cli(...preview.argv), /^Added stdio MCP server mosaic-beta\b/im);
const registered = await bindings();
assert.deepEqual(Object.keys(registered).sort(), [name, foreign].sort());
assert.deepEqual(registered[foreign], seeded[foreign]);
assert.equal(registered[name].type, 'stdio');
assert.equal(registered[name].command, paths.launcher);
assert.deepEqual(registered[name].args, ['mcp']);
await missing(paths.launcher);
await missing(other);
const listing = await cli('mcp', 'list');
for (const server of [name, foreign]) {
  assert.ok(listing.split(/\r?\n/).some(line => line.trimStart().startsWith(server + ':')), 'Missing CLI list entry ' + server);
}
const duplicate = async before => {
  await assert.rejects(cli(...preview.argv), error => error.code === 1 && /mosaic-beta.*already exists/i.test(error.stderr + error.stdout));
  assert.deepEqual(await bindings(), before);
};
await duplicate(registered);
await cli('mcp', 'remove', '--scope', 'user', name);
await seed(name, '--conflicting-argument');
const conflict = await bindings();
assert.equal(conflict[name].command, other);
assert.deepEqual(conflict[name].args, ['--conflicting-argument']);
assert.deepEqual(conflict[foreign], seeded[foreign]);
await duplicate(conflict);
console.log('Claude Code 2.1.323 discovered the two registered names on Windows x64. The Mosaic adapter added the intended user-scope stdio entry and both duplicate attempts preserved the saved bindings. Both server executables were absent. Sign-in and tool invocation remain untested.');
