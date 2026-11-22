import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {inflateRawSync} from 'node:zlib';
import {makeInstallCommand, validatePackagePaths, writeWindowsZip} from '../scripts/package-windows-beta.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const exec = promisify(execFile);
const powershell = process.env.MOSAIC_TEST_POWERSHELL || (process.platform === 'win32' ? 'powershell.exe' : null);
const repository = fileURLToPath(new URL('../', import.meta.url));

test('Windows archive records stable paths and real file content', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'mosaic-win-package-'));
  t.after(() => rm(folder, {recursive: true, force: true}));
  const source = path.join(folder, 'file');
  const fixture = Buffer.from('Fixture bytes\n');
  await writeFile(source, fixture);
  const entries = [{path: 'runtime/bin/node.exe', file: source}];
  const first = path.join(folder, 'first.zip'), second = path.join(folder, 'second.zip');
  await writeWindowsZip(first, entries);
  await writeWindowsZip(second, entries);
  const bytes = await readFile(first);
  assert.deepEqual(bytes, await readFile(second));
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  const nameLength = bytes.readUInt16LE(26);
  const contentStart = 30 + nameLength + bytes.readUInt16LE(28);
  assert.equal(bytes.subarray(30, 30 + nameLength).toString(), entries[0].path);
  assert.deepEqual(inflateRawSync(bytes.subarray(contentStart, contentStart + bytes.readUInt32LE(18))), fixture);
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
});

test('package paths reject Windows case, directory, device and alternate-stream aliases', () => {
  validatePackagePaths(['package-manifest.json', 'runtime/bin/node.exe', 'runtime/node_modules/@mosaic/file-_.js']);
  for (const names of [
    ['../a'], ['a\\b'], ['a:b'], ['a/aux.json'], ['a/a.'], ['runtime/Node.exe', 'runtime/node.exe'],
    ['runtime/node.exe', 'RUNTIME/package.json'], ['runtime', 'runtime/a'],
  ]) assert.throws(() => validatePackagePaths(names), /Windows package path/);
});

test('single-line install pins the verified bootstrap and archive and rejects non-HTTPS URLs', () => {
  const candidate = {
    version: '0.1.0-beta.229',
    bootstrapSha256: sha256('sample bootstrap'),
    archiveSha256: sha256('sample archive'),
  };
  const urls = {
    bootstrapUri: 'https://example.invalid/releases/229/install.ps1',
    archiveUri: 'https://example.invalid/releases/229/mosaic-win-x64.zip',
  };
  const line = makeInstallCommand(candidate, urls);
  assert.equal(line.split('\n').length, 1);
  assert.ok(line.includes('.ComputeHash('));
  assert.ok(line.indexOf('.ComputeHash(') < line.indexOf('ScriptBlock'));
  assert.ok(line.includes(candidate.bootstrapSha256));
  assert.ok(line.includes(candidate.archiveSha256));
  assert.ok(line.includes(urls.archiveUri));
  assert.throws(() => makeInstallCommand(candidate, {...urls, bootstrapUri: 'http://example.invalid/install.ps1'}), /HTTPS/);
  assert.throws(() => makeInstallCommand({...candidate, archiveSha256: 'placeholder'}, urls), /digests/);
});

test('PowerShell checks the archive and installs only its verified inventory', {skip: !powershell}, async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'Mosaic package paths '));
  t.after(() => rm(folder, {recursive: true, force: true}));
  const sample = path.join(folder, 'sample');
  const content = Buffer.from('Byte fixture only; no executable runs.\n');
  await writeFile(sample, content);
  const required = ['runtime/bin/node.exe', 'runtime/src/beta/cli.mjs', 'runtime/check-artifact/node.exe',
    'runtime/check-artifact/mosaic-windows-supervisor.exe', 'runtime/check-artifact/artifact-manifest.json',
    'distribution/windows/mosaic.exe', 'distribution/windows/guide.ps1', 'distribution/windows/lifecycle.mjs',
    'distribution/windows/install.ps1', 'distribution/windows/maintenance.mjs', 'distribution/onboarding/windows-host.mjs'];
  const files = required.map(path => ({path, sha256: sha256(content), bytes: content.length}));
  const version = '0.1.0-beta.229';
  const manifest = Buffer.from(JSON.stringify({schema: 1, platform: 'win32', arch: 'x64', layout: 'windows-beta-v1',
    version, nodeVersion: '24.22.3', contentHash: sha256('fixture-only'), files}));
  const manifestPath = path.join(folder, 'manifest');
  const archive = path.join(folder, 'fixture package.zip');
  await writeFile(manifestPath, manifest);
  await writeWindowsZip(archive, [...required.map(path => ({path, file: sample})), {path: 'package-manifest.json', file: manifestPath}]);
  const archiveHash = sha256(await readFile(archive));
  const bootstrapPath = path.join(repository, 'install.ps1');
  const guidePath = path.join(repository, 'distribution/windows/guide.ps1');
  const command = makeInstallCommand({version, archiveSha256: archiveHash, bootstrapSha256: sha256(await readFile(bootstrapPath))},
    {bootstrapUri: 'https://example.invalid/install.ps1', archiveUri: 'https://example.invalid/release.zip'});
  const destination = path.join(folder, 'Installed runtime');
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  const verify = [
    '$ErrorActionPreference = "Stop"',
    'function Get-FileHash { throw "Windows fixture has no Get-FileHash cmdlet" }',
    '$tokens = $errors = $null',
    '$ast = [System.Management.Automation.Language.Parser]::ParseFile(' + literal(bootstrapPath) + ', [ref]$tokens, [ref]$errors)',
    'if ($errors) { throw ($errors -join "; ") }',
    '$null = [System.Management.Automation.Language.Parser]::ParseFile(' + literal(guidePath) + ', [ref]$tokens, [ref]$errors)',
    'if ($errors) { throw ($errors -join "; ") }',
    '$null = [System.Management.Automation.Language.Parser]::ParseInput(' + literal(command) + ', [ref]$tokens, [ref]$errors)',
    'if ($errors) { throw ($errors -join "; ") }',
    'Add-Type -AssemblyName System.IO.Compression',
    '$preamble = foreach ($line in $ast.EndBlock.Statements) { if ($line -isnot [System.Management.Automation.Language.AssignmentStatementAst]) { break }; $line.Extent.Text }',
    '$functions = $ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.FunctionDefinitionAst] } | ForEach-Object { $_.Extent.Text }',
    '$definitions = ($preamble + $functions) -join [char]10',
    '. ([ScriptBlock]::Create($definitions))',
    'if ($env:OS -eq "Windows_NT") { $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User }',
    '$Version = ' + literal(version),
    '$archive = ' + literal(archive),
    '$destination = ' + literal(destination),
    '$ArchiveSha256 = "0" * 64',
    '$rejected = $false',
    'try { Expand-Release $archive $destination } catch { if ($_.Exception.Message -notmatch "checksum mismatch") { throw }; $rejected = $true }',
    'if (-not $rejected -or (Get-Item -LiteralPath $destination -ErrorAction SilentlyContinue)) { throw "Wrong archive was extracted" }',
    '$ArchiveSha256 = ' + literal(archiveHash),
    '$verified = Expand-Release $archive $destination',
    'if ($verified.ManifestSha256 -cne ' + literal(sha256(manifest)) + ') { throw "Manifest hash mismatch" }',
    '$null = Test-VersionDirectory $destination $verified.ManifestSha256 $Version',
    '$null = Test-VersionDirectory ($destination + [IO.Path]::DirectorySeparatorChar) $verified.ManifestSha256 $Version',
    '$history = New-Item -ItemType Directory -Path (Join-Path ' + literal(folder) + ' "history")',
    '$launcher = Join-Path ' + literal(folder) + ' "mosaic.exe"',
    '$backup = Join-Path ' + literal(folder) + ' "backup.exe"',
    '$pointer = Join-Path ' + literal(folder) + ' "active.txt"',
    '$disabled = Join-Path ' + literal(folder) + ' "disabled.json"',
    '$record = @{schema=1; platform="win32-x64"; version=$Version; archiveSha256=$ArchiveSha256; manifestSha256=$verified.ManifestSha256; launcherHash=$verified.LauncherSha256; contentHash=$verified.ContentHash}',
    '[IO.File]::Copy((Join-Path $destination "distribution/windows/mosaic.exe"), $launcher)',
    'Write-Atomic $pointer ($utf8.GetBytes($Version + [char]10))',
    'Save-VersionReceipt $history.FullName $record',
    'Save-VersionReceipt $history.FullName $record',
    '$saved = Read-JsonFile (Join-Path $history.FullName ($Version + ".json")) 8192',
    'if (-not (Test-SameRecord $record $saved)) { throw "The retained receipt changed" }',
    'Complete-Uninstall $record $pointer $launcher $backup $disabled',
    'Complete-Uninstall $record $pointer $launcher $backup $disabled',
    '$inactive = Read-JsonFile $disabled 8192',
    'if ((Get-PlainItem $pointer) -or (Get-PlainItem $launcher) -or (Get-Sha256 $backup) -cne $record.launcherHash -or -not (Test-SameRecord $record $inactive)) { throw "Uninstall did not preserve the exact inactive receipt and backup" }',
    '$leaf = Join-Path $destination "runtime/bin/node.exe"',
    'Write-Atomic $leaf ([byte[]](1, 2, 3))',
    '$rejected = $false',
    'try { Test-VersionDirectory $destination $verified.ManifestSha256 $Version } catch { if ($_.Exception.Message -notmatch "Unverified installed Mosaic file") { throw }; $rejected = $true }',
    'if (-not $rejected) { throw "Tampered installed file was accepted" }',
  ];
  await exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(verify.join('\n'), 'utf16le').toString('base64')], {timeout: 45_000, maxBuffer: 256 * 1024});
});
