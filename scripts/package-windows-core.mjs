import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {windowsGitProcess} from '../src/project/windows-git.mjs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {packageHarness} from '../src/harness/package.mjs';
import {isEntry} from '../src/harness/entry.mjs';
import {digest} from '../src/harness/contracts.mjs';
import {validatePackagePaths, writeWindowsZip} from './package-windows-beta.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const platformFiles = ['runtime/bin/node.exe', 'runtime/bin/mosaic-files.exe', 'runtime/NODE-LICENSE',
  'runtime/check-artifact/artifact-manifest.json', 'runtime/check-artifact/node.exe',
  'runtime/check-artifact/mosaic-windows-supervisor.exe'];

// The build worker can reuse native binaries from its reviewed Beta payload.
// The installed core contains its own copies and does not look up a Beta installation.
export async function packageWindowsCore({payload, manifestHash, destination}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Build the Windows core on Windows x64');
  const bytes = await readFile(path.join(payload, 'package-manifest.json'));
  if (sha256(bytes) !== manifestHash) throw Error('Windows inputs differ from the selected build receipt');
  const inputs = JSON.parse(bytes);
  if (inputs.layout !== 'windows-beta-v1' || inputs.platform !== 'win32' || inputs.arch !== 'x64') throw Error('Invalid Windows runtime inputs');
  validatePackagePaths(inputs.files.map(entry => entry.path));
  const git = windowsGitProcess();
  if (!git) throw Error('Build core with a trusted Git for Windows installation');
  const exec = promisify(execFile);
  const readGit = async (cwd,...args) => (await exec(git.executable,['-C',cwd,...args],
    {cwd:git.cwd,env:git.env,timeout:30_000,windowsHide:true})).stdout.trim();
  const core = await packageHarness({sourceRoot: repository, destination, dependencies: true, readGit});
  if (core.sourceDirty) throw Error('Build core from a clean committed checkout');
  async function add(relative, data) {
    const filename = path.join(destination, relative);
    await mkdir(path.dirname(filename), {recursive: true});
    await writeFile(filename, data, {flag: 'wx'});
    core.files.push({path: relative, bytes: data.length, sha256: sha256(data)});
  }
  for (const relative of platformFiles) {
    const expected = inputs.files.find(entry => entry.path === relative);
    const data = await readFile(path.join(payload, relative));
    if (expected?.sha256 !== sha256(data) || expected.bytes !== data.length) throw Error('Native input checksum differs: ' + relative);
    await add(relative, data);
  }
  for (const relative of ['LICENSE', 'THIRD_PARTY_NOTICES.md','distribution/windows-core/core.mjs','distribution/windows-core/mosaic-core.ps1']) {
    await add(relative, await readFile(path.join(repository, relative)));
  }
  core.platform = 'win32';
  core.arch = 'x64';
  core.runtimeInputHash = manifestHash;
  core.files.sort((a,b) => a.path.localeCompare(b.path));
  core.contentHash = digest(core.files);
  const manifest = Buffer.from(JSON.stringify(core, null, 2));
  await writeFile(path.join(destination, 'package-manifest.json'), manifest);
  const archive = destination + '.zip';
  const names = [...core.files.map(entry => entry.path), 'package-manifest.json'];
  await writeWindowsZip(archive, names.map(name => ({path:name, file:path.join(destination,name)})));
  return {archive, source:core.sourceCommit, manifestSha256:sha256(manifest), archiveSha256:sha256(await readFile(archive))};
}

if (isEntry(import.meta.url)) {
  const [payload, manifestHash, destination] = process.argv.slice(2);
  if (!payload || !/^[a-f0-9]{64}$/.test(manifestHash) || !destination) throw Error('Provide extracted Windows runtime directory, its pinned manifest SHA256 and new core destination');
  console.log(JSON.stringify(await packageWindowsCore({payload,manifestHash,destination})));
}
