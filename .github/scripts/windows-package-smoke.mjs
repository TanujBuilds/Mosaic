import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {access, copyFile, lstat, mkdtemp, open, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use a fresh GitHub-hosted Windows runner account');
const [directory, pwsh, updateDirectory] = process.argv.slice(2);
const candidate = JSON.parse(await readFile(path.join(directory, 'candidate.json'), 'utf8'));
assert.equal(candidate.kind, 'mosaic-windows-beta-candidate');
assert.match(candidate.version, /^\d+\.\d+\.\d+-beta\.\d+$/);
assert.match(candidate.archiveSha256, /^[a-f0-9]{64}$/);
assert.equal(candidate.archiveName, 'mosaic-beta-' + candidate.version + '-win-x64.zip');
const archive = path.join(directory, candidate.archiveName);
const bootstrap = path.join(directory, 'install.ps1');
const scratch = await mkdtemp(path.join(process.env.RUNNER_TEMP, 'Mosaic package smoke '));
const win = process.env.SystemRoot;
const system32 = path.join(win, 'System32');
const windowsPowerShell = path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
env.Path = [system32, win].join(';');
delete env.NODE_OPTIONS;
delete env.NODE_PATH;
const root = path.join(process.env.LOCALAPPDATA, 'Mosaic Beta');
const pointer = path.join(root, 'current-version.txt');
const lock = path.join(root, 'install-intent.json');
const installReceipt = path.join(root, 'config', 'installation.json');
const launcher = path.join(root, 'bin', 'mosaic.exe');
const versions = path.join(root, 'versions');
const version = path.join(versions, candidate.version);

async function exists(file) {
  try { await access(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function sha256(file) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

function launch(file, args, label, input) {
  const child = spawn(file, args, {cwd: scratch, env, windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe']});
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', data => { output = (output + data).slice(-64 * 1024); });
  }
  const timeout = setTimeout(() => child.kill('SIGKILL'), 180_000);
  const result = new Promise(resolve => {
    child.once('error', error => resolve({error, output}));
    child.once('close', (code, signal) => resolve({code, signal, output}));
  }).finally(() => clearTimeout(timeout));
  if (input) {
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  }
  return {child, result, label};
}

async function done(run, expectation) {
  const result = await run.result;
  console.log(run.label, 'exit:', result.code, 'signal:', result.signal ?? 'none');
  if (result.error) throw result.error;
  if (expectation === 0) assert.equal(result.code, 0, result.output);
  if (expectation instanceof RegExp) {
    assert.equal(typeof result.code, 'number', result.output);
    assert.notEqual(result.code, 0, result.output);
    assert.match(result.output, expectation);
  }
  return result;
}

const literal = text => "'" + text.replaceAll("'", "''") + "'";
function install(shell, file, label, release = candidate) {
  const source = '$ErrorActionPreference = \'Stop\'; & ([ScriptBlock]::Create([IO.File]::ReadAllText(' + literal(bootstrap) +
    '))) -Version ' + literal(release.version) + ' -Archive ' + literal(file) +
    ' -ArchiveSha256 ' + literal(release.archiveSha256) + ' -NoGuide';
  return launch(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(source, 'utf16le').toString('base64')], label);
}

assert.equal(await exists(root), false, 'The runner profile already contains Mosaic state');
assert.equal(await sha256(bootstrap), candidate.bootstrapSha256);
assert.equal(await sha256(archive), candidate.archiveSha256);
assert.equal((await lstat(archive)).size, candidate.archiveBytes);
const tamperedArchive = path.join(scratch, 'tampered release.zip');
await copyFile(archive, tamperedArchive);
const corrupt = await open(tamperedArchive, 'r+');
try {
  const byte = Buffer.alloc(1);
  await corrupt.read(byte, 0, 1, 0);
  byte[0] ^= 1;
  await corrupt.write(byte, 0, 1, 0);
} finally { await corrupt.close(); }
await done(install(windowsPowerShell, tamperedArchive, 'Windows PowerShell 5.1 rejects a modified archive'), /archive checksum mismatch/i);
assert.equal(await exists(pointer), false);
assert.equal(await exists(launcher), false);

const interrupted = install(windowsPowerShell, archive, 'Windows PowerShell 5.1 installation interrupted during extraction');
let closed = false;
void interrupted.result.then(() => { closed = true; });
const deadline = Date.now() + 120_000;
let sawExtraction = false;
try {
  while (Date.now() < deadline && !closed) {
    if ((await readdir(versions)).some(entry => entry.startsWith('.incoming-'))) {
      sawExtraction = true;
      assert.equal(interrupted.child.kill('SIGKILL'), true, 'Terminate installer while extraction is active');
      break;
    }
    await delay(30);
  }
} finally { if (!closed) interrupted.child.kill('SIGKILL'); }
const stopped = await done(interrupted);
assert.ok(sawExtraction, stopped.output || 'No extraction observed');
assert.ok(stopped.code !== 0 || stopped.signal, stopped.output);
assert.equal(await exists(pointer), false, 'An interrupted extraction cannot activate a package');
assert.equal(await exists(launcher), false);

await done(install(windowsPowerShell, archive, 'Windows PowerShell 5.1 installs on rerun'), 0);
assert.equal(await readFile(pointer, 'utf8'), candidate.version + '\n');
assert.equal(await exists(lock), false);
const receiptBytes = await readFile(installReceipt);
const receipt = JSON.parse(receiptBytes);
assert.equal(receipt.version, candidate.version);
assert.equal(receipt.archiveSha256, candidate.archiveSha256);
assert.equal(await sha256(launcher), receipt.launcherHash);
assert.equal(await sha256(path.join(version, 'package-manifest.json')), candidate.packageManifestSha256);
const node = path.join(version, 'runtime', 'bin', 'node.exe');
assert.equal(await sha256(node), candidate.nodeExeSha256);
const runtime = await done(launch(node, ['-p', 'JSON.stringify([process.platform,process.arch,process.versions.node])'],
  'Bundled Node runs with system-only PATH'), 0);
assert.deepEqual(JSON.parse(runtime.output.trim()), ['win32', 'x64', '24.22.3']);
const entrypoint = await done(launch(launcher, ['--help'], 'Stable launcher runs with system-only PATH'), 0);
assert.match(entrypoint.output, /Mosaic Beta/);

await done(install(pwsh, archive, 'PowerShell 7 reruns the same installed candidate'), 0);
assert.deepEqual(await readFile(installReceipt), receiptBytes);
assert.equal(await sha256(launcher), receipt.launcherHash);

const sample = path.join(version, 'runtime', 'NODE-LICENSE');
const original = await readFile(sample);
try {
  await writeFile(sample, 'Test-only changed installed file.\n');
  await done(install(pwsh, archive, 'PowerShell 7 rejects a modified installed package'), /Unverified installed Mosaic file/i);
  assert.equal(await readFile(sample, 'utf8'), 'Test-only changed installed file.\n');
  assert.deepEqual(await readFile(installReceipt), receiptBytes);
} finally { await writeFile(sample, original); }
await done(install(pwsh, archive, 'PowerShell 7 reopens the verified installed package'), 0);
console.log('Verified local package install, extraction interruption, rerun, and tamper rejection in the hosted Windows profile.');

if (updateDirectory) {
  const update = JSON.parse(await readFile(path.join(updateDirectory, 'candidate.json'), 'utf8'));
  const updateArchive = path.join(updateDirectory, update.archiveName);
  assert.equal(update.sourceCommit, candidate.sourceCommit);
  assert.equal(update.bootstrapSha256, candidate.bootstrapSha256);
  assert.equal(update.nativeFingerprint, candidate.nativeFingerprint, 'The update fixture must share the check runtime identity');
  assert.equal(await sha256(updateArchive), update.archiveSha256);
  await done(install(pwsh, updateArchive, 'Install the compatible test update', update), 0);
  assert.equal(await readFile(pointer, 'utf8'), update.version + '\n');
  const updateReceipt = JSON.parse(await readFile(installReceipt, 'utf8'));
  assert.equal(updateReceipt.launcherHash, receipt.launcherHash);

  await done(launch(launcher, ['rollback', candidate.version], 'Rollback to the verified older release'), 0);
  assert.deepEqual(JSON.parse(await readFile(installReceipt, 'utf8')), receipt);
  assert.equal(await readFile(pointer, 'utf8'), candidate.version + '\n');
  await done(install(pwsh, updateArchive, 'Reinstall the verified test update', update), 0);
  assert.equal(await readFile(pointer, 'utf8'), update.version + '\n');
  // Resume the exact durable state left after an authorized selection was recorded.
  assert.equal(await exists(lock), false);
  const intent = Buffer.from(JSON.stringify({schema: 1, operation: 'rollback', previous: updateReceipt, target: receipt}));
  const helper = path.join(versions, update.version, 'runtime', 'bin', 'mosaic-files.exe');
  await done(launch(helper, ['write', lock, String(intent.length)], 'Write the fixture recovery intent with the native ownership helper', intent), 0);
  await done(launch(launcher, ['recover'], 'Recover the saved rollback selection'), 0);
  assert.equal(await readFile(pointer, 'utf8'), candidate.version + '\n');
  assert.equal(await exists(lock), false);

  await done(launch(launcher, ['uninstall'], 'Deactivate the owned Windows installation'), 0);
  assert.equal(await exists(pointer), false);
  assert.equal(await exists(lock), false);
  assert.ok(await exists(version), 'Uninstall must retain verified releases');
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'config', 'installation-disabled.json'), 'utf8')), receipt);
  await done(install(windowsPowerShell, archive, 'Reinstall the retained release after uninstall'), 0);
  assert.equal(await readFile(pointer, 'utf8'), candidate.version + '\n');
  assert.equal(await sha256(launcher), receipt.launcherHash);
  assert.equal(await exists(path.join(root, 'config', 'installation-disabled.json')), false);
  console.log('Verified compatible update, rollback, saved-intent recovery, uninstall, and retained release reinstall.');
}
