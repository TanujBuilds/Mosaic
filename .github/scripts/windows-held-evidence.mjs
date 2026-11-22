import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {appendFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert.equal(process.versions.node, '24.22.3');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.GITHUB_REF, 'refs/heads/codex/windows-ci-followups');
assert.equal(process.argv.length, 6);
const [earlySource, heldSource, earlyInput, heldInput] = process.argv.slice(2).map(value => path.resolve(value));
const inputs = [
  {source: earlySource, directory: earlyInput, commit: '2f938fd74dd3920e11d4f33de636e1cc8cde388e', run: 44988516524, artifact: 14740862102},
  {source: heldSource, directory: heldInput, commit: 'a1b18fe835d633bee4d313e25e013f3d1d6c4d94', run: 44990711044, artifact: 14742095178,
    archiveSha256: 'bfcaf46c70228dea09b80746455233b89a6c3667c8e5549b24a8666d0cc4ddaf'},
];
const exec = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const system = path.join(process.env.SystemRoot, 'System32');
const powershell = path.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const tar = path.join(system, 'tar.exe');
const shellArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
const envBase = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(?:LOCALAPPDATA|USERPROFILE|PSMODULEPATH|NODE_OPTIONS|NODE_PATH)$/i.test(name)));
const scratch = await mkdtemp(path.join(process.env.RUNNER_TEMP, 'Mosaic held evidence '));
const appData = path.join(scratch, 'Disposable application data');
const profile = path.join(scratch, "Disposable account O'Brien");
await Promise.all([mkdir(appData), mkdir(profile)]);
const env = {...envBase, LOCALAPPDATA: appData, USERPROFILE: profile};
const report = {windows: null, inputs: [], checks: []};

async function digestFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function run(filename, args, {cwd = scratch, inputEnv = env} = {}) {
  try {
    const {stdout} = await exec(filename, args, {cwd, env: inputEnv, windowsHide: true, timeout: 180_000, maxBuffer: 1024 * 1024});
    return stdout.trim();
  } catch (error) {
    const detail = error.stderr?.trim() || error.stdout?.trim() || error.code;
    throw Error(path.basename(filename) + ' failed: ' + detail, {cause: error});
  }
}

function ps(source, fields = {}) {
  const encoded = Buffer.from("$ErrorActionPreference = 'Stop'\n" + source, 'utf16le').toString('base64');
  return run(powershell, [...shellArgs, '-EncodedCommand', encoded], {inputEnv: {...env, ...fields}});
}

async function buildCore(input, label) {
  const {source, directory, commit} = input;
  const git = (...args) => run('git.exe', ['-C', source, ...args]);
  assert.equal(await git('rev-parse', 'HEAD'), commit);
  assert.equal(await git('status', '--porcelain'), '');
  const candidate = JSON.parse(await readFile(path.join(directory, 'candidate.json'), 'utf8'));
  assert.equal(candidate.kind, 'mosaic-windows-beta-candidate');
  assert.equal(candidate.platform, 'win32-x64');
  assert.equal(candidate.sourceCommit, commit);
  assert.equal(candidate.sourceTree, await git('rev-parse', 'HEAD^{tree}'));
  assert.equal(candidate.archiveName, 'mosaic-beta-' + candidate.version + '-win-x64.zip');
  assert.match(candidate.archiveSha256, /^[a-f0-9]{64}$/);
  if (input.archiveSha256) assert.equal(candidate.archiveSha256, input.archiveSha256);
  const archive = path.join(directory, candidate.archiveName);
  assert.equal(await digestFile(archive), candidate.archiveSha256);
  const payload = path.join(scratch, label + ' extracted Beta');
  const destination = path.join(scratch, label + ' built Core');
  await mkdir(payload);
  await run(tar, ['-xf', archive, '-C', payload]);
  assert.equal(await digestFile(path.join(payload, 'package-manifest.json')), candidate.packageManifestSha256);
  const result = await run(process.execPath, ['scripts/package-windows-core.mjs', payload, candidate.packageManifestSha256, destination], {cwd: source});
  const build = JSON.parse(result.split(/\r?\n/).at(-1));
  assert.equal(build.source, commit);
  assert.equal(build.archive, destination + '.zip');
  assert.equal(await digestFile(build.archive), build.archiveSha256);
  assert.equal(await digestFile(path.join(destination, 'package-manifest.json')), build.manifestSha256);
  const manifest = JSON.parse(await readFile(path.join(destination, 'package-manifest.json'), 'utf8'));
  assert.equal(manifest.runtimeInputHash, candidate.packageManifestSha256);
  assert.equal(await git('status', '--porcelain'), '');
  report.inputs.push({label, commit, tree: candidate.sourceTree, upstreamRun: input.run, upstreamArtifact: input.artifact,
    betaSha256: candidate.archiveSha256, betaManifest: candidate.packageManifestSha256,
    coreSha256: build.archiveSha256, coreManifest: build.manifestSha256, nativeFingerprint: candidate.nativeFingerprint});
  return {...build, activate: path.join(source, 'distribution', 'windows-core', 'activate.ps1')};
}

const activate = build => run(powershell, [...shellArgs, '-File', build.activate, '-Archive', build.archive,
  '-Sha256', build.archiveSha256]);
const root = path.join(appData, 'Mosaic');
const launcher = path.join(root, 'mosaic-core.ps1');
const pointer = path.join(root, 'active-core.json');
const state = path.join(root, 'state');
const invoke = (...args) => run(powershell, [...shellArgs, '-File', launcher, ...args]);

async function verifyLegacyUpgrade(early, held) {
  await activate(early);
  const oldPointer = await readFile(pointer);
  assert.deepEqual(JSON.parse(oldPointer), {archiveSha256: early.archiveSha256});
  const oldLauncher = await readFile(launcher);
  const retained = path.join(root, 'versions', early.archiveSha256, 'distribution', 'windows-core', 'mosaic-core.ps1');
  assert.deepEqual(await readFile(retained), oldLauncher);
  assert.equal(JSON.parse(await invoke('status')).status, 'not_started');
  const altered = Buffer.concat([oldLauncher, Buffer.from('\n# Disposable, deliberately changed wrapper.\n')]);
  for (const mutateRetained of [false, true]) {
    const foreign = mutateRetained ? Buffer.from('throw "Disposable foreign wrapper; do not execute"\n') : altered;
    await writeFile(launcher, foreign);
    if (mutateRetained) await writeFile(retained, foreign);
    try {
      await assert.rejects(activate(held), /Unrecognized legacy core launcher/);
      assert.deepEqual(await readFile(pointer), oldPointer);
      assert.deepEqual(await readFile(launcher), foreign);
      assert.deepEqual(await readFile(retained), mutateRetained ? foreign : oldLauncher);
    } finally {
      await writeFile(launcher, oldLauncher);
      if (mutateRetained) await writeFile(retained, oldLauncher);
    }
  }
  report.checks.push('Changed and foreign legacy wrappers were rejected without changing their locator or bytes');
  await activate(held);
  const upgraded = JSON.parse(await readFile(pointer));
  assert.equal(upgraded.archiveSha256, held.archiveSha256);
  assert.equal(upgraded.launcherSha256, await digestFile(launcher));
  assert.deepEqual(await readFile(retained), oldLauncher);
  const version = path.join(root, 'versions', held.archiveSha256);
  assert.equal(await digestFile(path.join(version, 'package-manifest.json')), held.manifestSha256);
  const installed = file => import(pathToFileURL(path.join(version, 'runtime', file)).href);
  try {
    const output = await invoke('connect');
    assert.match(output, /Mosaic core is ready/);
    const position = output.lastIndexOf('\n{');
    assert.ok(position >= 0);
    const entry = JSON.parse(output.slice(position + 1)).mcpServers['frontier-harness'];
    assert.deepEqual(entry.args.slice(-3), ['-File', launcher, 'mcp']);
    const {Client} = await installed('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
    const {StdioClientTransport} = await installed('node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
    const client = new Client({name: 'windows-held-core-evidence', version: '1'});
    try {
      await client.connect(new StdioClientTransport({...entry, env}));
      assert.ok((await client.listTools()).tools.some(tool => tool.name === 'registry_list'));
      const reply = await client.callTool({name: 'registry_list', arguments: {}});
      assert.ok(!reply.isError && reply.content?.some(item => item.type === 'text' && item.text.includes('codex_only')));
    } finally { await client.close(); }
    report.checks.push('Genuine cold legacy upgrade selected the exact new core and served registry_list via scripted stdio');
  } finally {
    await invoke('stop').catch(() => {});
    await invoke('remove-startup');
  }
  const service = await installed('src/beta/windows-service.mjs');
  assert.equal((await service.registration({core:true, configDir:root, state, launcher})).registered, false);
}

const localAccounts = String.raw`
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.LocalAccounts\Microsoft.PowerShell.LocalAccounts.psd1')
`;
const taskControls = String.raw`
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')
$task = @($folder.GetTasks(1) | Where-Object Name -ceq $env:MOSAIC_TEST_TASK) | Select-Object -First 1
if (!$task) { if ($env:MOSAIC_TEST_ACTION -eq 'remove') { exit 0 }; throw 'Disposable task is missing' }
$d = $task.Definition
if ($d.RegistrationInfo.Description -cne $env:MOSAIC_TEST_DESCRIPTION -or
    $d.Actions.Count -ne 1 -or $d.Actions.Item(1).WorkingDirectory -cne $env:MOSAIC_TEST_STATE -or
    !$d.Actions.Item(1).Arguments.Contains($env:MOSAIC_TEST_LAUNCHER)) { throw 'Refuse to touch a non-fixture task' }
if ($env:MOSAIC_TEST_ACTION -eq 'remove') { $folder.DeleteTask($task.Name,0); exit 0 }
if ($env:MOSAIC_TEST_ACTION -eq 'principal') { $d.Principal.UserId = $env:MOSAIC_TEST_OTHER_SID }
if ($env:MOSAIC_TEST_ACTION -eq 'trigger') { $d.Triggers.Item(1).UserId = $env:MOSAIC_TEST_OTHER_SID }
if ($env:MOSAIC_TEST_ACTION -in @('principal','trigger')) {
    $task = $folder.RegisterTaskDefinition($task.Name,$d,36,$d.Principal.UserId,$null,3,$null)
}
function Sid([string]$identity) {
    if ($identity -match '^S-[0-9]+-[0-9-]+$') { return ([Security.Principal.SecurityIdentifier]::new($identity)).Value }
    return ([Security.Principal.NTAccount]::new($identity)).Translate([Security.Principal.SecurityIdentifier]).Value
}
$d = $task.Definition
@{xml=$task.Xml;principal=(Sid $d.Principal.UserId);trigger=(Sid $d.Triggers.Item(1).UserId);logon=$d.Principal.LogonType} | ConvertTo-Json -Compress
`;

async function verifySchedulerAdoption(held) {
  const runtime = path.join(held.archive.slice(0, -4), 'runtime');
  const installed = file => import(pathToFileURL(path.join(runtime, file)).href);
  const service = await installed('src/beta/windows-service.mjs');
  const files = await installed('src/beta/files.mjs');
  const windows = await installed('src/beta/windows-files.mjs');
  const sid = await ps('[Console]::Write([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)');
  assert.match(sid, /^S-[0-9-]+$/);
  const account = 'MosaicQa' + randomBytes(5).toString('hex');
  const description = 'Mosaic held evidence ' + randomUUID();
  const accountFields = {MOSAIC_TEST_ACCOUNT: account, MOSAIC_TEST_ACCOUNT_DESCRIPTION: description};
  const cleanups = [];
  try {
    const other = await ps(localAccounts + "$password=ConvertTo-SecureString $env:MOSAIC_TEST_PASSWORD -AsPlainText -Force\n" +
      '$user=New-LocalUser -Name $env:MOSAIC_TEST_ACCOUNT -Password $password -Description $env:MOSAIC_TEST_ACCOUNT_DESCRIPTION\n' +
      '[Console]::Write($user.SID.Value)', {...accountFields, MOSAIC_TEST_PASSWORD: 'Qa!' + randomBytes(16).toString('hex') + 'Z7'});
    assert.match(other, /^S-[0-9-]+$/);
    assert.notEqual(other, sid);
    const unrelated = {configDir: path.join(scratch, 'Unrelated fixture'), state: path.join(scratch, 'Unrelated fixture', 'state'),
      launcher: path.join(scratch, 'Unrelated fixture', 'mosaic.exe')};
    await windows.windowsFile('mkdir', unrelated.state);
    await service.ensureWindowsService(unrelated);
    cleanups.push(() => service.unregisterWindowsService(unrelated));
    const unrelatedBefore = await service.registration(unrelated);

    const results = await Promise.allSettled(['principal', 'trigger', 'genuine'].map(async action => {
      const configDir = path.join(scratch, 'Service fixture ' + action);
      const paths = {core:true, configDir, state:path.join(configDir, 'state'), launcher:path.join(configDir, 'mosaic-core.ps1')};
      const nonce = randomUUID();
      const receipt = service.serviceRecord(paths);
      const intent = {version:1, phase:'creating', definition:files.hash(service.serviceDefinition(paths)), nonce};
      const fields = {MOSAIC_TEST_TASK: 'Mosaic Core ' + sid + ' ' + sha(paths.launcher.toLowerCase()).slice(0, 16),
        MOSAIC_TEST_DESCRIPTION: 'Mosaic Core coordinator ' + nonce, MOSAIC_TEST_STATE: paths.state,
        MOSAIC_TEST_LAUNCHER: paths.launcher, MOSAIC_TEST_OTHER_SID: other};
      const control = operation => ps(taskControls, {...fields, MOSAIC_TEST_ACTION: operation});
      await windows.windowsFile('mkdir', paths.state);
      await windows.windowsWrite(paths.launcher, 'exit 0\n');
      assert.equal((await service.registration(paths)).registered, false);
      await files.saveJson(receipt, intent);
      cleanups.push(() => control('remove'));
      const xmlHash = await service.ensureWindowsService(paths);
      await files.saveJson(receipt, intent);
      const pending = await readFile(receipt);
      const before = JSON.parse(await control(action === 'genuine' ? 'query' : action));
      assert.equal(before.logon, 3);
      assert.equal(before.principal, action === 'principal' ? other : sid);
      assert.equal(before.trigger, action === 'trigger' ? other : sid);
      if (action === 'genuine') {
        assert.deepEqual(await service.registration(paths), {owned:true, registered:true, xmlHash});
        assert.deepEqual(JSON.parse(await readFile(receipt, 'utf8')), {version:1, definition:intent.definition, xmlHash});
      } else {
        await assert.rejects(service.registration(paths), /Interrupted registration differs from its saved intent/);
        assert.deepEqual(await readFile(receipt), pending);
      }
      assert.deepEqual(JSON.parse(await control('query')), before);
      assert.deepEqual(await service.registration(unrelated), unrelatedBefore);
    }));
    const failed = results.filter(result => result.status === 'rejected');
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Task Scheduler ownership evidence failed');
    report.checks.push('Native scheduler refused both mismatched SID definitions, adopted the genuine definition, and preserved an unrelated registration');
  } finally {
    try {
      const results = await Promise.allSettled(cleanups.map(cleanup => cleanup()));
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Disposable Task Scheduler cleanup failed');
    } finally {
      await ps(localAccounts + String.raw`
$user=Get-LocalUser -Name $env:MOSAIC_TEST_ACCOUNT -ErrorAction SilentlyContinue
if ($user) {
  if ($user.Description -cne $env:MOSAIC_TEST_ACCOUNT_DESCRIPTION) { throw 'Refuse to remove a non-fixture account' }
  Remove-LocalUser -SID $user.SID
}
`, accountFields);
    }
  }
}

try {
  report.windows = JSON.parse(await ps('Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,OSArchitecture | ConvertTo-Json -Compress'));
  const [early, held] = await Promise.all(inputs.map((input, index) => buildCore(input, index === 0 ? 'Early' : 'Held')));
  const results = await Promise.allSettled([verifyLegacyUpgrade(early, held), verifySchedulerAdoption(held)]);
  console.log(JSON.stringify(report, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    '### Held Windows follow-up evidence\n\n' + report.checks.map(check => '- ' + check).join('\n') +
    '\n\n    ' + JSON.stringify(report, null, 2).replaceAll('\n', '\n    ') + '\n');
  const failed = results.filter(result => result.status === 'rejected');
  if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Held Windows evidence failed');
} finally { await rm(scratch, {recursive:true, force:true, maxRetries:5}); }
