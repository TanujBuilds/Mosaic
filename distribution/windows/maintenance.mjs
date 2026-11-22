import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fileBytes, hash, jsonFile, locations} from '../../runtime/src/beta/files.mjs';

const versionSyntax = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})(?:-beta\.(?:0|[1-9]\d{0,8}))?$/;
const actions = new Set(['recover', 'rollback', 'uninstall', 'verify']);
const literal = value => "'" + value.replaceAll("'", "''") + "'";

async function trustedBootstrap(action) {
  const paths = locations(os.homedir());
  const versionRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const version = path.basename(versionRoot);
  const pointer = await fileBytes(path.join(paths.root, 'current-version.txt'), {privateFile: true, max: 64});
  if (!versionSyntax.test(version) || pointer?.toString() !== version + '\n' ||
      path.resolve(paths.versions, version).toLowerCase() !== versionRoot.toLowerCase()) {
    throw Error('The active Mosaic release changed. Rerun its verified install command.');
  }
  const receipt = await jsonFile(paths.installation, {privateFile: true, max: 8192});
  const intent = action === 'recover'
    ? await jsonFile(path.join(paths.root, 'install-intent.json'), {privateFile: true, max: 32768})
    : null;
  const records = [receipt, intent?.previous, intent?.target].filter(record =>
    record?.schema === 1 && record.platform === 'win32-x64' && record.version === version);
  const manifestBytes = await fileBytes(path.join(versionRoot, 'package-manifest.json'), {max: 4 * 1024 * 1024});
  if (!manifestBytes || !records.some(record => record.manifestSha256 === hash(manifestBytes))) throw Error('Mosaic maintenance could not verify the active release inventory.');
  const manifest = JSON.parse(manifestBytes.toString());
  const script = fileURLToPath(new URL('./install.ps1', import.meta.url));
  const expected = manifest.files?.find(file => file.path === 'distribution/windows/install.ps1');
  const bytes = await fileBytes(script, {max: 1024 * 1024});
  if (!expected || !bytes || expected.bytes !== bytes.length || expected.sha256 !== hash(bytes)) throw Error('Mosaic maintenance script checksum mismatch.');
  return script;
}

export async function runWindowsInstallMaintenance(action, targetVersion) {
  if (process.platform !== 'win32' || !actions.has(action) ||
      (action === 'rollback' ? !versionSyntax.test(targetVersion) : targetVersion !== undefined)) {
    throw Error('Invalid Windows installation maintenance command.');
  }
  const script = await trustedBootstrap(action);
  const shell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = '$ErrorActionPreference = \'Stop\'; & ([ScriptBlock]::Create([IO.File]::ReadAllText(' +
    literal(script) + '))) -Maintenance ' + literal(action) +
    (targetVersion ? ' -TargetVersion ' + literal(targetVersion) : '');
  await new Promise((resolve, reject) => {
    const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64')], {stdio: action === 'verify' ? 'ignore' : 'inherit', windowsHide: true});
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(Error('Windows installation ' + action + ' did not complete.')));
  });
}
