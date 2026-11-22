import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir, readFile, realpath} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {registerCodex} from '../../distribution/onboarding/host.mjs';
import {windowsHostExecutable} from '../../src/beta/hosts/detection.mjs';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const [home, vendor] = process.argv.slice(2);
assert.equal(vendor, path.join(home, '.codex', 'packages', 'standalone', 'current', 'bin', 'codex.exe'));
const env = {
  SystemRoot: process.env.SystemRoot,
  WINDIR: process.env.SystemRoot,
  Path: path.join(process.env.SystemRoot, 'System32'),
  HOME: home,
  USERPROFILE: home,
  CODEX_HOME: path.join(home, '.codex'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  TEMP: path.join(home, 'Temp'),
  TMP: path.join(home, 'Temp'),
};
for (const dir of [env.LOCALAPPDATA, env.APPDATA, env.TEMP]) await mkdir(dir, {recursive:true});
const executable = await windowsHostExecutable('codex', {home, isolated:true, env});
assert.equal(executable, await realpath(vendor));
const options = {env, cwd:home, windowsHide:true};
const exec = promisify(execFile);
async function cli(...args) {
  const {stdout} = await exec(executable, args, {...options, timeout:20000, maxBuffer:1024*1024});
  return stdout.trim();
}
const get = async name => JSON.parse(await cli('mcp', 'get', '--json', name));
const list = async () => JSON.parse(await cli('mcp', 'list', '--json'));
const name = 'mosaic-beta', foreign = 'unrelated-fixture';
// Configuration-only fixtures. Server executables are deliberately absent so
// this test cannot launch a registration target or produce an invocation receipt.
const launcher = path.join(env.LOCALAPPDATA, 'Mosaic Beta', 'bin', 'mosaic.exe');
const other = path.join(home, 'Foreign registration', 'foreign.exe');
assert.equal(await cli('--version'), 'codex-cli 0.171.0');
assert.deepEqual(await list(), []);
await cli('mcp', 'add', foreign, '--', other, '--preserve-this-argument');
const saved = await get(foreign);
assert.equal(saved.transport.command, other);
assert.deepEqual(saved.transport.args, ['--preserve-this-argument']);
await assert.rejects(cli('mcp', 'get', '--json', name), e => e.code === 1 && e.stderr.trim() === "Error: No MCP server named 'mosaic-beta' found.");

assert.equal(await registerCodex(executable, launcher, options), 'written');
const binding = await get(name);
assert.equal(binding.enabled, true);
assert.equal(binding.transport.type, 'stdio');
assert.equal(binding.transport.command, launcher);
assert.deepEqual(binding.transport.args, ['mcp']);
assert.deepEqual(await get(foreign), saved);
assert.deepEqual((await list()).map(entry => entry.name).sort(), [name,foreign].sort());
const config = path.join(env.CODEX_HOME, 'config.toml');
const before = await readFile(config);
assert.equal(await registerCodex(executable, launcher, options), 'changed');
assert.deepEqual(await readFile(config), before);

await cli('mcp', 'remove', name);
await cli('mcp', 'add', name, '--', other, '--conflicting-argument');
const conflict = await get(name), priorBytes = await readFile(config);
assert.equal(await registerCodex(executable, launcher, options), 'changed');
assert.deepEqual(await readFile(config), priorBytes);
assert.deepEqual(await get(name), conflict);
assert.deepEqual(await get(foreign), saved);
console.log('Codex CLI 0.171.0 detected at the staged standalone location. The real app-server saved Mosaic’s stdio registration. The CLI listed both entries and preserved a conflicting configuration. No sign-in or MCP invocation was exercised.');
