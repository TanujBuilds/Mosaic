import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {appendFile, copyFile, mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {entry, fileBytes, hash, locations} from '../../src/beta/files.mjs';
import {install, installedLauncher, verifyVersion} from '../../src/beta/install.mjs';
import {readBundledNativeCheckRuntime} from '../../src/beta/package-contract.mjs';

const run = promisify(execFile);
export const version = '0.1.0-beta.228';
const stem = 'mosaic-beta-' + version + '-darwin-arm64';
const url = 'https://github.com/TanujBuilds/Mosaic/releases/download/v' + version + '/' + stem + '.tar.gz';
const archiveBytes = 86315923;
const archiveHash = 'a43a5bfba1eea70ed213ad401782250cb4193c0e011940b0f592f963fcfdd6d2';
const manifestHash = 'ecd13a265d568d7cb8bcdf35cf0cbcb9022f3b8097194973873c12d11284e5ae';
const contentHash = 'e58f5372e93df910cc06ff8373edb1d285bac7a62d3dd268acdd66553be3beec';
const thisFile = fileURLToPath(import.meta.url);

async function verifyManifest(directory) {
  const bytes = await fileBytes(path.join(directory, 'package-manifest.json'), {max: 8 * 1024 * 1024});
  if (!bytes || hash(bytes) !== manifestHash) throw Error('The Mosaic runtime differs from the published release. Repair it with the Terminal installer.');
}

async function installation(paths) {
  for (const relative of ['.local/bin', 'Library/Application Support/Mosaic Beta/config', 'Library/Application Support/Mosaic Beta/versions']) {
    let directory = paths.home;
    for (const part of relative.split('/')) {
      directory = path.join(directory, part);
      const info = await entry(directory);
      if (!info) break;
      if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o022)
        throw Error('Mosaic setup requires owned directories. Check the installation in Terminal.');
    }
  }
  if (await entry(path.join(paths.configDir, 'install-transaction.json')))
    throw Error('An installation is pending. Finish installation or recovery in Terminal, then reopen Connections.');
  const {receipt, bytes} = await installedLauncher(paths);
  if (!receipt && !bytes) {
    if (await entry(paths.config) || await entry(path.join(paths.versions, version)))
      throw Error('Existing Mosaic settings or runtime need their installation receipt. Run the Terminal installer to restore it.');
    return null;
  }
  if (receipt?.version !== version)
    throw Error('This desktop release uses Mosaic ' + version + '. Open your existing version in Terminal to manage setup.');
  if (!bytes || !((await stat(paths.launcher)).mode & 0o100) || receipt.contentHash !== contentHash)
    throw Error('Restore the Mosaic launcher using the Terminal installer, then reopen Connections.');
  const directory = path.join(paths.versions, version);
  await verifyManifest(directory);
  await verifyVersion(directory, version);
  const runtimeRoot = path.join(directory, 'runtime');
  return {version, runtimeRoot, nativeCheckRuntime: await readBundledNativeCheckRuntime(runtimeRoot)};
}

async function download(directory, archive) {
  const part = path.join(directory, 'part');
  const chunkSize = 4 * 1024 * 1024;
  const deadline = Date.now() + 10 * 60_000;
  for (let offset = 0; offset < archiveBytes; offset += chunkSize) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Error('The runtime download timed out. Save again to retry.');
    const end = Math.min(archiveBytes, offset + chunkSize) - 1;
    let response;
    try {
      ({stdout: response} = await run('/usr/bin/curl', ['-q','--silent','--show-error','--fail','--location',
        '--proto','=https','--proto-redir','=https','--range',offset + '-' + end,
        '--max-filesize',String(archiveBytes),'--max-time','90','--connect-timeout','12','--retry','2',
        '--output',part,'--write-out','%{http_code}',url], {timeout: remaining}));
    } catch { throw Error('Could not download the Mosaic runtime. Check your connection and save again.'); }
    const length = (await stat(part)).size;
    if (response === '200' && length === archiveBytes) {
      await copyFile(part, archive);
      return;
    }
    if (response !== '206' || length !== end - offset + 1) throw Error('Mosaic received an incomplete runtime download. Save again to retry.');
    await appendFile(archive, await readFile(part), {mode: 0o600});
  }
}

export async function ensureCore(context) {
  const paths = locations(context.home, context.isolated === true);
  const existing = await installation(paths);
  if (existing) return existing;
  const temporary = await mkdtemp('/private/tmp/mosaic-desktop-install-');
  try {
    const archive = path.join(temporary, 'release.tar.gz');
    if (context.isolated === true && context.archivePath) await copyFile(context.archivePath, archive);
    else await download(temporary, archive);
    if ((await stat(archive)).size !== archiveBytes) throw Error('Mosaic runtime download has the wrong size.');
    const checksum = createHash('sha256');
    for await (const bytes of createReadStream(archive)) checksum.update(bytes);
    if (checksum.digest('hex') !== archiveHash) throw Error('Mosaic runtime checksum failed. Save again to download a fresh copy.');
    await run('/usr/bin/tar', ['-xzpf',archive,'--no-same-owner','-C',temporary], {timeout: 120_000});
    const payload = path.join(temporary, stem, 'payload');
    await verifyManifest(payload);
    // The terminal installer writes a human-readable receipt to stdout. Keep
    // its output separate from the native bridge's single JSON reply.
    await run(process.execPath, [thisFile,'--install-fresh',paths.home,paths.isolated ? 'fixture' : 'user',payload], {timeout: 180_000})
      .catch(error => { throw Error(error.stderr?.trim().split('\n').at(-1) || 'Mosaic runtime setup failed. Reopen Connections or run the Terminal installer.'); });
    const installed = await installation(paths);
    if (!installed) throw Error('Runtime setup did not finish. Save again.');
    return installed;
  } finally { await rm(temporary, {recursive: true, force: true}); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  try {
    const [action,home,mode,payload] = process.argv.slice(2);
    if (action !== '--install-fresh' || !['fixture','user'].includes(mode)) throw Error('Unknown runtime setup operation.');
    const paths = locations(home, mode === 'fixture');
    if (!await installation(paths)) {
      await verifyManifest(payload);
      await install(paths, payload, {noPath: true, afterStep: async step => {
        if (step === 'transaction-prepared' && (await installedLauncher(paths)).receipt)
          throw Error('Another installation changed the launcher. Reopen Connections.');
      }});
    }
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
