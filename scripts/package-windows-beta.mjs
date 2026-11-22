import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {access, copyFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {crc32, deflateRawSync} from 'node:zlib';
import {listFiles, sourceClosure} from './lib/beta-archive.mjs';
import {digest} from '../src/harness/contracts.mjs';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
const nodeVersion = '24.22.3';
const nodeStem = 'node-v' + nodeVersion + '-win-x64';
const nodeZipHash = 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f';
const nodeExeHash = '86fc4785327db5f5c7558dc6156c543b433c313e813a222e088086222ab4afa6';
const versionSyntax = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})(?:-beta\.(?:0|[1-9]\d{0,8}))?$/;
const shaSyntax = /^[a-f0-9]{64}$/;
const ceiling = 512 * 1024 * 1024;
const maxFile = 128 * 1024 * 1024;
const fileLimit = 10_000;
const supervisorSource = 'src/project/check-backends/windows-supervisor.cpp';
const filesSource = 'distribution/win32-files/mosaic-files.cpp';
const filesHelper = 'runtime/bin/mosaic-files.exe';
const locator = 'distribution/windows/mosaic.exe';
const betaCli = 'src/beta/cli.mjs';

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function hashFile(file) {
  const stream = createReadStream(file);
  const checksum = createHash('sha256');
  for await (const chunk of stream) checksum.update(chunk);
  return checksum.digest('hex');
}

export function validatePackagePaths(entries) {
  if (entries.length > fileLimit) throw Error('Too many Windows package paths');
  const map = new Map();
  for (const relative of entries) {
    if (typeof relative !== 'string' || relative.length > 220) throw Error('Invalid Windows package path');
    const parts = relative.split('/');
    if (parts.some(part => !/^[A-Za-z0-9._+@-]{1,100}$/.test(part) || part.endsWith('.') ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw Error('Invalid Windows package path: ' + relative);
    }
    let prefix = '';
    for (const [index, part] of parts.entries()) {
      prefix += (prefix ? '/' : '') + part;
      const key = prefix.toLowerCase(), existing = map.get(key), isFile = index === parts.length - 1;
      if (existing && (existing.path !== prefix || existing.isFile || isFile)) throw Error('Conflicting Windows package path: ' + relative);
      map.set(key, {path: prefix, isFile});
    }
  }
}

function zipHeader(kind, size) {
  const result = Buffer.alloc(size);
  result.writeUInt32LE(kind, 0);
  return result;
}

export async function writeWindowsZip(destination, inputs) {
  const entries = [...inputs].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  validatePackagePaths(entries.map(entry => entry.path));
  const file = await open(destination, 'wx');
  const index = [];
  let offset = 0, expanded = 0;
  try {
    for (const entry of entries) {
      const info = await lstat(entry.file);
      if (!info.isFile() || info.size > maxFile || expanded + info.size > ceiling) throw Error('Windows package input exceeds bounds: ' + entry.path);
      const name = Buffer.from(entry.path, 'ascii'), bytes = await readFile(entry.file);
      if (bytes.length !== info.size) throw Error('Windows package input changed: ' + entry.path);
      const zip = deflateRawSync(bytes, {level: 9});
      const fields = Buffer.alloc(22);
      fields.writeUInt16LE(20, 0);
      fields.writeUInt16LE(8, 4);
      fields.writeUInt16LE(0x21, 8);
      fields.writeUInt32LE(crc32(bytes), 10);
      fields.writeUInt32LE(zip.length, 14);
      fields.writeUInt32LE(bytes.length, 18);
      const header = zipHeader(0x04034b50, 30);
      fields.copy(header, 4);
      header.writeUInt16LE(name.length, 26);
      await file.writeFile(header);
      await file.writeFile(name);
      await file.writeFile(zip);
      const central = zipHeader(0x02014b50, 46);
      central.writeUInt16LE(20, 4);
      fields.copy(central, 6);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(offset, 42);
      index.push(central, name);
      offset += header.length + name.length + zip.length;
      expanded += bytes.length;
    }
    const central = Buffer.concat(index), end = zipHeader(0x06054b50, 22);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(offset, 16);
    await file.writeFile(central);
    await file.writeFile(end);
    await file.sync();
  } finally {
    await file.close();
  }
}

function httpsUri(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/u.test(value)) throw Error('Use a bounded HTTPS artifact URL');
  let uri;
  try { uri = new URL(value); } catch { throw Error('Use a valid HTTPS artifact URL'); }
  if (uri.protocol !== 'https:' || uri.username || uri.password || uri.hash) throw Error('Use an HTTPS URL without credentials or a fragment');
  return uri.href;
}

const psLiteral = value => "'" + value.replaceAll("'", "''") + "'";

export function makeInstallCommand(candidate, {bootstrapUri, archiveUri}) {
  if (!versionSyntax.test(candidate.version) || !shaSyntax.test(candidate.bootstrapSha256) || !shaSyntax.test(candidate.archiveSha256)) {
    throw Error('The release candidate must provide an exact version and both SHA-256 digests');
  }
  return '& { $ErrorActionPreference = \'Stop\'; ' +
    '$curl = Join-Path ([Environment]::SystemDirectory) \'curl.exe\'; ' +
    '$p = Join-Path ([IO.Path]::GetTempPath()) (\'mosaic-\' + [guid]::NewGuid().ToString(\'N\') + \'.ps1\'); ' +
    'try { & $curl -q --fail --silent --show-error --location --proto \'=https\' --proto-redir \'=https\' ' +
    '--max-redirs 3 --connect-timeout 15 --max-time 90 --max-filesize 1048576 --output $p -- ' + psLiteral(httpsUri(bootstrapUri)) + '; ' +
    'if ($LASTEXITCODE -ne 0) { throw \'Mosaic could not download its installer.\' }; ' +
    '$stream = [IO.File]::OpenRead($p); try { $sha = [Security.Cryptography.SHA256]::Create(); ' +
    'try { $sum = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace(\'-\', \'\') } ' +
    'finally { $sha.Dispose() } } finally { $stream.Dispose() }; ' +
    'if ($sum -ine ' + psLiteral(candidate.bootstrapSha256) + ') { throw \'Mosaic installer checksum mismatch.\' }; ' +
    '& ([ScriptBlock]::Create([IO.File]::ReadAllText($p))) -Version ' + psLiteral(candidate.version) +
    ' -ArchiveUri ' + psLiteral(httpsUri(archiveUri)) + ' -ArchiveSha256 ' + psLiteral(candidate.archiveSha256) +
    ' } finally { Remove-Item -LiteralPath $p -ErrorAction SilentlyContinue } }';
}

async function nodeArchive(staging, supplied) {
  if (supplied) {
    const info = await lstat(supplied);
    if (!info.isFile() || info.size > maxFile || await hashFile(supplied) !== nodeZipHash) throw Error('Official Windows Node archive checksum mismatch');
  }
  const archive = path.join(staging, nodeStem + '.zip');
  if (supplied) await copyFile(supplied, archive);
  else {
    const url = 'https://nodejs.org/dist/v' + nodeVersion + '/' + nodeStem + '.zip';
    const response = await fetch(url, {redirect: 'error', signal: AbortSignal.timeout(120_000)});
    if (!response.ok || !response.body) throw Error('Could not download the pinned official Windows Node archive');
    let bytes = 0;
    const bounded = async function* (stream) {
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > maxFile) throw Error('Windows Node archive exceeded its download bound');
        yield chunk;
      }
    };
    await pipeline(bounded(Readable.fromWeb(response.body)), createWriteStream(archive, {flags: 'wx'}));
  }
  if (await hashFile(archive) !== nodeZipHash) throw Error('Official Windows Node archive checksum mismatch');
  const tar = path.join(process.env.SystemRoot, 'System32', 'tar.exe');
  await exec(tar, ['-xf', archive, '-C', staging, nodeStem + '/node.exe', nodeStem + '/LICENSE'], {timeout: 60_000});
  const node = path.join(staging, nodeStem, 'node.exe'), license = path.join(staging, nodeStem, 'LICENSE');
  if (await hashFile(node) !== nodeExeHash) throw Error('Official Windows node.exe checksum mismatch');
  const {stdout} = await exec(node, ['-p', 'JSON.stringify([process.versions.node,process.platform,process.arch])'], {timeout: 10_000});
  if (stdout.trim() !== JSON.stringify([nodeVersion, 'win32', 'x64'])) throw Error('Windows Node runtime identity mismatch');
  return {node, license};
}

async function copyInto(source, payload, relative) {
  const output = path.join(payload, relative);
  await mkdir(path.dirname(output), {recursive: true});
  await copyFile(source, output);
  return output;
}

async function compile(source, output, staging, libraries = []) {
  await mkdir(path.dirname(output), {recursive: true});
  await exec('cl.exe', ['/nologo', '/std:c++17', '/EHsc', '/W4', '/O2', '/MT', '/Brepro', '/DUNICODE', '/D_UNICODE',
    source, '/Fe:' + output, '/link', ...libraries], {cwd: staging, timeout: 120_000, maxBuffer: 512 * 1024});
}

async function enumerate(payload) {
  const result = [];
  for (const relative of await listFiles(payload)) {
    const file = path.join(payload, relative), info = await lstat(file);
    result.push({path: relative, bytes: info.size, sha256: await hashFile(file)});
  }
  validatePackagePaths(result.map(entry => entry.path));
  return result;
}

async function build(options) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Build this archive with the x64 Visual Studio developer environment on Windows');
  if (!versionSyntax.test(options.version) || !options.output) throw Error('Provide a version and output directory');
  const git = async (...argv) => (await exec('git.exe', ['-C', repository, ...argv], {timeout: 15_000})).stdout.trim();
  if (await git('status', '--porcelain')) throw Error('Build Windows release bytes from a clean committed source tree');
  const sourceCommit = await git('rev-parse', 'HEAD'), sourceTree = await git('rev-parse', 'HEAD^{tree}');
  const output = path.resolve(options.output), archiveName = 'mosaic-beta-' + options.version + '-win-x64.zip';
  const candidates = [archiveName, archiveName + '.sha256', 'install.ps1', 'candidate.json', 'install-command.txt'];
  await mkdir(output, {recursive: true});
  for (const name of candidates) {
    if (await lstat(path.join(output, name)).catch(error => { if (error.code !== 'ENOENT') throw error; return null; })) throw Error('Release output already exists: ' + name);
  }
  const staging = await mkdtemp(path.join(output, '.mosaic-win-build-'));
  try {
    const payload = path.join(staging, 'payload');
    await mkdir(payload);
    const {node, license} = await nodeArchive(staging, options['node-zip'] && path.resolve(options['node-zip']));
    await copyInto(node, payload, 'runtime/bin/node.exe');
    await copyInto(license, payload, 'runtime/NODE-LICENSE');
    const sources = await sourceClosure(repository, [betaCli]);
    for (const relative of [...sources, supervisorSource, 'package.json', 'package-lock.json']) {
      await copyInto(path.join(repository, relative), payload, 'runtime/' + relative);
    }
    for (const relative of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'docs/TERMINAL_BETA.md', 'distribution/onboarding/host.mjs', 'distribution/onboarding/windows-host.mjs',
      'distribution/windows/guide.ps1', 'distribution/windows/lifecycle.mjs']) {
      await copyInto(path.join(repository, relative), payload, relative);
    }
    const notices = await listFiles(path.join(repository, 'distribution', 'notices'));
    for (const notice of notices) {
      const relative = 'distribution/notices/' + notice;
      await copyInto(path.join(repository, relative), payload, relative);
    }
    const launcherSource = 'distribution/windows/launcher.cpp';
    await copyInto(path.join(repository, launcherSource), payload, launcherSource);
    await compile(path.join(repository, launcherSource), path.join(payload, locator), staging);
    const hasFilesHelper = await lstat(path.join(repository, filesSource)).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (hasFilesHelper) {
      if (!hasFilesHelper.isFile()) throw Error('Windows filesystem helper source is unavailable');
      await copyInto(path.join(repository, filesSource), payload, filesSource);
      await compile(path.join(repository, filesSource), path.join(payload, filesHelper), staging, ['advapi32.lib']);
    }
    const artifact = 'runtime/check-artifact/';
    await copyInto(node, payload, artifact + 'node.exe');
    await compile(path.join(repository, supervisorSource), path.join(payload, artifact + 'mosaic-windows-supervisor.exe'), staging, ['advapi32.lib', 'userenv.lib']);
    const artifactFiles = [];
    for (const name of ['node.exe', 'mosaic-windows-supervisor.exe']) {
      const file = path.join(payload, artifact, name);
      artifactFiles.push({path: name, sha256: await hashFile(file), bytes: (await lstat(file)).size});
    }
    const backend = {id: 'windows-appcontainer', revision: 1};
    const artifactManifest = Buffer.from(JSON.stringify({schema: 1, platform: 'win32', arch: 'x64', backend,
      nodeVersion, files: artifactFiles, supervisorSourceSha256: await hashFile(path.join(payload, 'runtime', supervisorSource))}) + '\n');
    await writeFile(path.join(payload, artifact, 'artifact-manifest.json'), artifactManifest);
    const npm = path.resolve(options['npm-cli'] ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    await access(npm);
    await exec(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--bin-links=false', '--no-audit', '--no-fund'],
      {cwd: path.join(payload, 'runtime'), timeout: 120_000, maxBuffer: 1024 * 1024});
    const files = await enumerate(payload);
    const manifest = Buffer.from(JSON.stringify({schema: 1, platform: 'win32', arch: 'x64', layout: 'windows-beta-v1',
      version: options.version, nodeVersion, nativeCheckArtifact: {backend, fingerprint: hash(artifactManifest)}, contentHash: digest(files), files}) + '\n');
    const manifestPath = path.join(payload, 'package-manifest.json');
    await writeFile(manifestPath, manifest);
    const archivePath = path.join(staging, archiveName);
    await writeWindowsZip(archivePath, [...files.map(file => ({path: file.path, file: path.join(payload, file.path)})),
      {path: 'package-manifest.json', file: manifestPath}]);
    const bootstrap = await readFile(path.join(repository, 'install.ps1'));
    const candidate = {schema: 1, kind: 'mosaic-windows-beta-candidate', version: options.version, platform: 'win32-x64',
      sourceCommit, sourceTree, archiveName, archiveSha256: await hashFile(archivePath), archiveBytes: (await lstat(archivePath)).size,
      bootstrapSha256: hash(bootstrap), packageManifestSha256: hash(manifest), nodeZipSha256: nodeZipHash, nodeExeSha256: nodeExeHash,
      nativeFingerprint: hash(artifactManifest)};
    await writeFile(path.join(staging, archiveName + '.sha256'), candidate.archiveSha256 + '  ' + archiveName + '\n');
    await writeFile(path.join(staging, 'install.ps1'), bootstrap);
    await writeFile(path.join(staging, 'candidate.json'), JSON.stringify(candidate, null, 2) + '\n');
    if (options['bootstrap-uri']) {
      await writeFile(path.join(staging, 'install-command.txt'), makeInstallCommand(candidate,
        {bootstrapUri: options['bootstrap-uri'], archiveUri: options['archive-uri']}) + '\n');
    }
    const outputs = candidates.filter(name => name !== 'candidate.json' && (name !== 'install-command.txt' || options['bootstrap-uri']));
    for (const name of [...outputs, 'candidate.json']) await rename(path.join(staging, name), path.join(output, name));
    console.log(path.join(output, 'candidate.json'));
  } finally {
    await rm(staging, {recursive: true, force: true});
  }
}

function options(argv) {
  const result = {};
  const supported = new Set(['version', 'output', 'node-zip', 'npm-cli', 'candidate', 'bootstrap-uri', 'archive-uri']);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index].slice(2), value = argv[index + 1];
    if (!argv[index].startsWith('--') || !supported.has(name) || !value || value.startsWith('--') || Object.hasOwn(result, name)) throw Error('Invalid Windows package option');
    result[name] = value;
  }
  if (Boolean(result['bootstrap-uri']) !== Boolean(result['archive-uri'])) throw Error('Supply both staging artifact URLs together');
  return result;
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('Build: node scripts/package-windows-beta.mjs --version VERSION --output DIRECTORY [--node-zip ZIP] [--npm-cli FILE]');
    console.log('Stage: node scripts/package-windows-beta.mjs --candidate candidate.json --bootstrap-uri HTTPS_URL --archive-uri HTTPS_URL');
    return;
  }
  const input = options(argv);
  if (!input.candidate) return build(input);
  if (Object.keys(input).length !== 3 || !input['archive-uri']) throw Error('Staging requires one candidate and both staging artifact URLs');
  const candidatePath = path.resolve(input.candidate), directory = path.dirname(candidatePath);
  const candidate = JSON.parse(await readFile(candidatePath, 'utf8'));
  if (candidate.kind !== 'mosaic-windows-beta-candidate' || candidate.schema !== 1 || candidate.platform !== 'win32-x64' ||
      !versionSyntax.test(candidate.version) || candidate.archiveName !== 'mosaic-beta-' + candidate.version + '-win-x64.zip' ||
      await hashFile(path.join(directory, candidate.archiveName)) !== candidate.archiveSha256 ||
      await hashFile(path.join(directory, 'install.ps1')) !== candidate.bootstrapSha256) throw Error('The staged bootstrap or archive does not match the candidate');
  console.log(makeInstallCommand(candidate, {bootstrapUri: input['bootstrap-uri'], archiveUri: input['archive-uri']}));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    if (error.stderr) console.error(error.stderr);
    process.exitCode = 1;
  });
}
