import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const directory = process.argv[2];
const candidate = JSON.parse(await readFile(path.join(directory,'candidate.json'),'utf8'));
assert.equal(candidate.sourceCommit, process.env.GITHUB_SHA);
assert.match(candidate.javascriptFingerprint, /^[a-f0-9]{64}$/);
const bootstrap = path.join(directory,'install.ps1'), archive = path.join(directory,candidate.archiveName);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(digest(await readFile(bootstrap)), candidate.bootstrapSha256);
assert.equal(digest(await readFile(archive)), candidate.archiveSha256);
const root = await mkdtemp(path.join(process.env.RUNNER_TEMP,'Mosaic isolated JS install '));
const env = {...process.env, LOCALAPPDATA:root};
const exec = promisify(execFile);
const ps = path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
try {
  await exec(ps,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',bootstrap,
    '-Archive',archive,'-ArchiveSha256',candidate.archiveSha256,'-Version',candidate.version,'-NoGuide'],
  {env, windowsHide:true, timeout:150000});
  const installed = path.join(root,'Mosaic Beta','versions',candidate.version);
  const runtime = path.join(installed,'runtime'), artifact = path.join(runtime,'javascript-check-artifact');
  const metadata = await readFile(path.join(installed,'package-manifest.json'));
  assert.equal(digest(metadata), candidate.packageManifestSha256);
  assert.equal(JSON.parse(metadata).javascriptCheckArtifact.fingerprint, candidate.javascriptFingerprint);
  const node = path.join(runtime,'bin','node.exe');
  const verify = String.raw`
    import {validateWindowsJavaScriptArtifact} from ${JSON.stringify(pathToFileURL(path.join(runtime,'src','project','check-backends','windows-js-artifact.mjs')).href)};
    import {readBundledNativeCheckRuntime} from ${JSON.stringify(pathToFileURL(path.join(runtime,'src','beta','package-contract.mjs')).href)};
    const old = await readBundledNativeCheckRuntime();
    if (old.artifactManifestSha256 !== ${JSON.stringify(candidate.nativeFingerprint)}) throw Error('Legacy runtime changed identity');
    const result = validateWindowsJavaScriptArtifact(JSON.parse(process.argv[1]));
    process.stdout.write(JSON.stringify(result));
  `;
  const check = dir => exec(node,['--input-type=module','-e',verify,JSON.stringify({schema:1,
    artifactManifestPath:path.join(dir,'javascript-artifact.json'), artifactManifestSha256:candidate.javascriptFingerprint})],
  {env, windowsHide:true, timeout:30000});
  const verified = JSON.parse((await check(artifact)).stdout);
  assert.equal(verified.files.length,12);
  assert.equal(verified.backend.id,'windows-isolated-js');
  const tampered = path.join(root,'tampered runtime');
  await cp(artifact,tampered,{recursive:true});
  await writeFile(path.join(tampered,'isolated-js-program.mjs'),'throw Error("Must never run");\n');
  await assert.rejects(check(tampered), error => error.stderr.includes('Isolated JavaScript artifact file changed'));
  const help = await exec(path.join(root,'Mosaic Beta','bin','mosaic.exe'),['--help'],{env,windowsHide:true,timeout:30000});
  assert.match(help.stdout,/Mosaic/);
  console.log(JSON.stringify({source:candidate.sourceCommit, fingerprint:verified.fingerprint, verified:verified.files.length,
    tamperedBootstrapRejected:true, productionCodingEnabled:false}));
} finally {
  await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:200});
}
