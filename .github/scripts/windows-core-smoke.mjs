import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {access, mkdir, mkdtemp, readFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use a disposable Windows runner');
const exec = promisify(execFile);
const [bundle] = process.argv.slice(2);
const candidate = JSON.parse(await readFile(path.join(bundle, 'candidate.json'), 'utf8'));
assert.equal(candidate.kind, 'mosaic-windows-beta-candidate');
const archive = path.join(bundle, candidate.archiveName);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(await readFile(archive)), candidate.archiveSha256);
const scratch = await mkdtemp(path.join(process.env.RUNNER_TEMP, 'Mosaic core smoke '));
const payload = path.join(scratch, 'Expanded Beta archive');
const corePackage = path.join(scratch, 'Core candidate');
const appData = path.join(scratch, 'Isolated core profile');
await Promise.all([mkdir(payload), mkdir(appData)]);
const system32 = path.join(process.env.SystemRoot, 'System32');
const powershell = path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const shellArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File'];
const workspace = process.env.GITHUB_WORKSPACE;
const env = {...process.env, LOCALAPPDATA: appData};
delete env.NODE_OPTIONS;
delete env.NODE_PATH;

async function run(executable, args, options = {}) {
  try {
    const {stdout} = await exec(executable, args, {cwd: workspace, env, windowsHide: true,
      timeout: 180_000, maxBuffer: 1024 * 1024, ...options});
    return stdout.trim();
  } catch (error) {
    throw Error(error.stderr || error.message);
  }
}

async function isAbsent(file) {
  try { await access(file); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

const betaState = path.join(process.env.LOCALAPPDATA, 'Mosaic Beta', 'state', 'connection.json');
assert.ok(await isAbsent(betaState), 'The Beta coordinator must remain offline during core qualification');
await run(path.join(system32, 'tar.exe'), ['-xf', archive, '-C', payload]);
const build = JSON.parse((await run(process.execPath, ['scripts/package-windows-core.mjs', payload,
  candidate.packageManifestSha256, corePackage])).split(/\r?\n/).at(-1));
assert.equal(build.source, candidate.sourceCommit);
assert.equal(path.resolve(build.archive), path.resolve(corePackage + '.zip'));
assert.equal(sha256(await readFile(build.archive)), build.archiveSha256);
await run(powershell, [...shellArgs, path.join(workspace, 'distribution/windows-core/activate.ps1'),
  '-Archive', build.archive, '-Sha256', build.archiveSha256]);

const root = path.join(appData, 'Mosaic');
const launcher = path.join(root, 'mosaic-core.ps1');
const version = path.join(root, 'versions', build.archiveSha256);
const manifest = await readFile(path.join(version, 'package-manifest.json'));
assert.equal(sha256(manifest), build.manifestSha256);
for (const skill of ['frontier-harness', 'frontier-collaborate', 'frontier-deepseek-only', 'frontier-codex-only']) {
  assert.match(await readFile(path.join(version, 'skills', skill, 'SKILL.md'), 'utf8'), /^---/);
}
for (const file of ['runtime/bin/node.exe', 'runtime/bin/mosaic-files.exe', 'runtime/src/harness/cli.mjs',
  'runtime/src/harness/dashboard/observer.html', 'runtime/check-artifact/mosaic-windows-supervisor.exe']) {
  await access(path.join(version, file));
}
const invoke = (...argv) => run(powershell, [...shellArgs, launcher, ...argv], {cwd: scratch});
assert.match(await invoke('--help'), /serve --root/);
console.log('Installed core launcher, four skills, bundled runtime and browser observer are present.');

const state = path.join(root, 'state');
const service = spawn(powershell, [...shellArgs, launcher, 'serve'], {
  cwd: scratch, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let serviceOutput = '';
for (const stream of [service.stdout, service.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', text => { serviceOutput = (serviceOutput + text).slice(-16 * 1024); });
}
let closed = false;
const result = new Promise(resolve => {
  service.once('error', error => resolve({error}));
  service.once('close', code => resolve({code}));
}).then(status => { closed = true; return status; });

try {
  const deadline = Date.now() + 25_000;
  let viewer, url;
  while (!closed && Date.now() < deadline) {
    try {
      viewer = JSON.parse(await readFile(path.join(state, 'viewer-connection.json'), 'utf8'));
      url = new URL(viewer.url);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await delay(150);
    }
  }
  assert.ok(viewer && url, serviceOutput || 'Core service did not write viewer credentials');
  assert.equal(viewer.role, 'viewer');
  assert.match(viewer.token, /^[a-f0-9]{64}$/);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.protocol, 'http:');
  const authorization = 'Bearer ' + viewer.token;
  const snapshot = await fetch(new URL('/api/invoke', url), {method: 'POST', signal: AbortSignal.timeout(4000),
    headers: {authorization, 'content-type': 'application/json'}, body: JSON.stringify({name: 'observer_snapshot', input: {}})});
  assert.equal(snapshot.status, 200);
  assert.deepEqual((await snapshot.json()).goals, []);
  const observer = await fetch(new URL('/observer', url), {headers: {authorization}, signal: AbortSignal.timeout(4000)});
  assert.equal(observer.status, 200);
  assert.match(await observer.text(), /Mosaic/);
  assert.ok(JSON.parse(await invoke('call', '--tool', 'tools_list')).some(tool => tool.name === 'registry_list'));
  await invoke('stop');
  const stopped = await Promise.race([result, delay(20_000, {timedOut: true}, {ref: false})]);
  assert.equal(stopped.code, 0, serviceOutput || 'Core service did not stop');
  assert.ok(await isAbsent(betaState));
  assert.ok(await isAbsent(path.join(appData, 'Mosaic Beta')));
  console.log('Core service returned an authenticated browser observer and stopped with Beta offline.');
} finally {
  if (!closed && service.pid) await run(path.join(system32, 'taskkill.exe'), ['/PID', String(service.pid), '/T', '/F']).catch(() => {});
}
