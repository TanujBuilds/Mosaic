import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {access, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';

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
const appData = process.env.LOCALAPPDATA;
const fixtureProfile = path.join(scratch, "Core user O'Brien");
await Promise.all([mkdir(payload), mkdir(fixtureProfile)]);
const system32 = path.join(process.env.SystemRoot, 'System32');
const powershell = path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const shellArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];
const workspace = process.env.GITHUB_WORKSPACE;
const runnerEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^NODE_(?:OPTIONS|PATH)$/i.test(name)));
const env = {...Object.fromEntries(Object.entries(runnerEnv).filter(([name]) => !/^(?:LOCALAPPDATA|USERPROFILE)$/i.test(name))),
  LOCALAPPDATA: appData, USERPROFILE: fixtureProfile};

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

const betaRoot = path.join(process.env.LOCALAPPDATA, 'Mosaic Beta');
const betaState = path.join(betaRoot, 'state', 'connection.json');
assert.ok(await isAbsent(path.join(appData,'Mosaic')), 'Use a clean hosted Windows profile for core coexistence');
assert.ok(await isAbsent(betaRoot), 'Use a fresh disposable profile before the coexistence smoke');
const betaBootstrap = path.join(bundle, 'install.ps1');
assert.equal(sha256(await readFile(betaBootstrap)), candidate.bootstrapSha256);
await run(powershell, [...shellArgs, betaBootstrap, '-Archive', archive, '-ArchiveSha256', candidate.archiveSha256,
  '-Version', candidate.version, '-NoGuide'], {env: runnerEnv});
const betaReceipt = path.join(betaRoot, 'config', 'installation.json');
const betaPointer = path.join(betaRoot, 'current-version.txt');
const [betaReceiptBytes, betaPointerBytes] = await Promise.all([readFile(betaReceipt), readFile(betaPointer)]);
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
const skills = ['frontier-harness', 'frontier-collaborate', 'frontier-deepseek-only', 'frontier-codex-only'];
for (const skill of skills) {
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
const servicePaths = {core: true, root, configDir: root, state, launcher};
const installed = file => import(pathToFileURL(path.join(version, 'runtime', file)).href);
const {registration} = await installed('src/beta/windows-service.mjs');
const viewerFile = path.join(state, 'viewer-connection.json');
const runningService = path.join(state, 'service.json');

try {
  const reply = await invoke('connect');
  assert.match(reply, /Mosaic core is ready/);
  const jsonStart = reply.lastIndexOf('\n{');
  assert.ok(jsonStart >= 0, 'Core connect must print an actual fixture app configuration');
  const entry = JSON.parse(reply.slice(jsonStart + 1)).mcpServers['frontier-harness'];
  assert.equal(path.resolve(entry.command).toLowerCase(), powershell.toLowerCase());
  assert.deepEqual(entry.args.slice(-3), ['-File', launcher, 'mcp']);
  const installedSkills = path.join(fixtureProfile, '.agents', 'skills');
  for (const skill of skills) {
    const published = await readFile(path.join(version, 'skills', skill, 'SKILL.md'));
    assert.deepEqual(await readFile(path.join(installedSkills, skill, 'SKILL.md')), published);
  }
  const service = await registration(servicePaths);
  assert.equal(service.owned, true);
  assert.equal(service.registered, true);
  const serviceBytes = await readFile(runningService);
  assert.match(await invoke('start'), /Mosaic core is ready/);
  assert.deepEqual(await readFile(runningService), serviceBytes);
  assert.deepEqual(await registration(servicePaths), service);

  const profile = path.join(fixtureProfile, '.claude.json');
  const unrelated = {command: 'existing-fixture.exe', args: []};
  await writeFile(profile, JSON.stringify({mcpServers: {existing: unrelated, ...JSON.parse(reply.slice(jsonStart + 1)).mcpServers}}), {flag: 'wx'});
  const savedProfile = JSON.parse(await readFile(profile, 'utf8'));
  assert.deepEqual(savedProfile.mcpServers.existing, unrelated);
  const {Client} = await installed('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const {StdioClientTransport} = await installed('node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
  const transport = new StdioClientTransport({...savedProfile.mcpServers['frontier-harness'], cwd: fixtureProfile, env});
  const client = new Client({name: 'windows-core-scripted-fixture', version: '1'});
  try {
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'registry_list'));
    const result = await client.callTool({name: 'registry_list', arguments: {}});
    assert.ok(!result.isError && result.content?.some(item => item.type === 'text' && item.text.includes('codex_only')));
  } finally { await client.close(); }
  assert.deepEqual(JSON.parse(await readFile(profile, 'utf8')), savedProfile);
  console.log('A scripted MCP client discovered and called registry_list through the core configuration in an isolated app profile.');

  const viewer = JSON.parse(await readFile(viewerFile, 'utf8'));
  const url = new URL(viewer.url);
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
  const observed=await run(path.join(betaRoot,'bin','mosaic.exe'),['--source','core','status','--once'],{env:runnerEnv});
  assert.match(observed,/Mosaic core \(frontier-harness\)/);
  assert.ok(await isAbsent(betaState));
  console.log('The installed Beta observer read the active core while the separate Beta coordinator was offline.');
  await invoke('stop');
  let stopped = false;
  for (let attempt = 0; attempt < 40 && !stopped; attempt++) {
    stopped = await fetch(new URL('/api/health', url), {signal: AbortSignal.timeout(1000)})
      .then(() => false, error => {if (error.cause?.code === 'ECONNREFUSED') return true; throw error;});
    if (!stopped) await delay(150);
  }
  assert.ok(stopped, 'Core did not stop serving its authenticated loopback address');
  await invoke('remove-startup');
  assert.equal((await registration(servicePaths)).registered, false);
  assert.ok(await isAbsent(betaState));
  assert.deepEqual(await readFile(betaReceipt), betaReceiptBytes);
  assert.deepEqual(await readFile(betaPointer), betaPointerBytes);
  assert.match(await run(path.join(betaRoot, 'bin', 'mosaic.exe'), ['--help'], {env: runnerEnv}), /Mosaic Beta/);
  console.log('Core installed its skills, registered and started its own service, served an authenticated observer, and stopped without changing the offline Beta installation.');
} finally {
  await invoke('stop').catch(() => {});
  await invoke('remove-startup').catch(() => {});
}
