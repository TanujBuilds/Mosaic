import {execFile} from 'node:child_process';
import {chmod,copyFile,lstat,mkdir,mkdtemp,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {digest} from '../src/harness/contracts.mjs';
import {verifyPackage} from '../src/harness/package.mjs';
import {sourceClosure,listFiles,copyCheckArtifact,probeCheckArtifact,deterministicArchive,assertPortableArtifactPrivacy} from './lib/beta-archive.mjs';
import {candidateManifest} from './lib/beta-candidate.mjs';
import {CURRENT_NODE_RELEASE,NATIVE_NODE_RELEASES} from '../src/project/check-backends/native-node-releases.mjs';

const exec=promisify(execFile);
const repo=fileURLToPath(new URL('../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

// Fixed, factual source assets. Inventory construction below hashes every copy.
export async function copyRequiredAssets(sourceRoot,runtime,{nodeVersion=CURRENT_NODE_RELEASE.version}={}){
 const assets=[['src/project/check-backends/native-supervisor.c','src/project/check-backends/native-supervisor.c'],['test/fixtures/mosaic-pb15-v2-composition/fork-only.patch','provenance/fork-only.patch'],['scripts/build-native-check-artifact.mjs','provenance/build-native-check-artifact.mjs'],['docs/NATIVE_CHECK_ARTIFACT.md','docs/NATIVE_CHECK_ARTIFACT.md'],['docs/HOST_COMPATIBILITY.md','docs/HOST_COMPATIBILITY.md'],['docs/TERMINAL_BETA.md','docs/TERMINAL_BETA.md'],['docs/PORTABLE_BETA_INSTALL.md','docs/PORTABLE_BETA_INSTALL.md'],['docs/PORTABLE_BETA_RELEASE.md','docs/PORTABLE_BETA_RELEASE.md'],['scripts/lib/beta-candidate.schema.json','provenance/beta-candidate.schema.json'],['THIRD_PARTY_NOTICES.md','THIRD_PARTY_NOTICES.md'],['docs/DISTRIBUTION_PROVENANCE.md','docs/DISTRIBUTION_PROVENANCE.md']];
 if(nodeVersion===CURRENT_NODE_RELEASE.version){
  const notices=path.join(sourceRoot,'distribution','notices');
  if(!(await lstat(notices)).isDirectory())throw Error('Required package notices must be a regular directory');
  const files=await listFiles(notices);
  if(!files.includes('INDEX.md')||!files.includes('SHA256SUMS')||files.length<=2)throw Error('Required package notice inventory is missing');
  assets.push(...files.map(file=>['distribution/notices/'+file,'notices/'+file]));
 }
 for(const [source,target] of assets){
  const sourceInfo=await lstat(path.join(sourceRoot,source));if(!sourceInfo.isFile()||sourceInfo.isSymbolicLink())throw Error('Required package source is not a regular file: '+source);
  const destination=path.join(runtime,target);await mkdir(path.dirname(destination),{recursive:true});await copyFile(path.join(sourceRoot,source),destination);await chmod(destination,0o644);
 }
}

function options(args){
 const opts={};
 while(args.length){
  const option=args.shift();
  if(['--offline','--fixture'].includes(option)&&!opts[option.slice(2)]){opts[option.slice(2)]=true;continue;}
  if(['--version','--output','--node','--node-license','--check-artifact','--verification-ref'].includes(option)&&args[0]&&!opts[option.slice(2)]){opts[option.slice(2)]=args.shift();continue;}
  throw Error('Invalid package option. Run node scripts/package-beta.mjs --help');
 }
 if(!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(opts.version??'')||!opts.output)throw Error('A version and an output directory are required');
 if(opts.node&&!opts['node-license']||!opts.node&&opts['node-license']||opts.offline&&!opts.node||opts.fixture&&!opts.node)
  throw Error('An explicit Node executable requires --node-license. Offline and fixture builds also require --node.');
 if(!opts.fixture&&!opts['check-artifact'])throw Error('A separate --check-artifact is required for a release candidate');
 return opts;
}

async function runtimeNode(opts,staging){
 const release=CURRENT_NODE_RELEASE;
 let node=opts.node?path.resolve(opts.node):null,license=opts['node-license']?path.resolve(opts['node-license']):null;
 if(!node){
  const nodeName='node-v'+release.version+'-darwin-arm64';
  const response=await fetch(`https://nodejs.org/dist/v${release.version}/${nodeName}.tar.gz`,{redirect:'error',signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw Error('Could not download pinned Node distribution');
  const bytes=Buffer.from(await response.arrayBuffer());
  if(sha(bytes)!==release.archiveSha256)throw Error('Node archive SHA256 mismatch');
  const archive=path.join(staging,'node.tar.gz');
  await writeFile(archive,bytes);
  await exec('/usr/bin/tar',['-xzf',archive,'-C',staging,nodeName+'/bin/node',nodeName+'/LICENSE']);
  node=path.join(staging,nodeName,'bin','node');
  license=path.join(staging,nodeName,'LICENSE');
 }
 if(!opts.fixture&&(sha(await readFile(node))!==release.coordinatorSha256||sha(await readFile(license))!==release.licenseSha256))
  throw Error('The Node executable and license must match the pinned official Darwin arm64 distribution');
 const {stdout}=await exec(node,['-p','JSON.stringify([process.versions.node,process.platform,process.arch])'],{timeout:5000,maxBuffer:4096});
 const identity=stdout.trim();
 const detectedRelease=Object.values(NATIVE_NODE_RELEASES).find(input=>identity===JSON.stringify([input.version,'darwin','arm64']));
 if(!detectedRelease||(!opts.fixture&&detectedRelease!==release))throw Error('Packaging requires Node '+release.version+' for Darwin arm64');
 return {node,license,release:detectedRelease};
}

function bootstrap(inventoryHash){
 return `#!/bin/sh
set -eu
if [ "$(/usr/bin/uname -s)" != Darwin ] || [ "$(/usr/bin/uname -m)" != arm64 ]; then
  printf '%s\\n' 'Mosaic Beta requires an Apple Silicon Mac and a native arm64 terminal.' >&2
  exit 1
fi
CDPATH= cd -- "$(/usr/bin/dirname -- "$0")"
printf '%s  %s\\n' '${inventoryHash}' verify.sha256 | /usr/bin/shasum -a 256 --check --status
if ! /usr/bin/shasum -a 256 --check --status verify.sha256; then
  printf '%s\\n' 'Mosaic Beta package integrity verification failed.' >&2
  exit 1
fi
exec "$PWD/payload/runtime/bin/node" "$PWD/payload/runtime/src/beta/install.mjs" "$@"
`;
}

async function build(opts){
 const output=path.resolve(opts.output);
 const stem=`mosaic-beta-${opts.version}-darwin-arm64`;
 const archiveName=stem+'.tar.gz';
 await mkdir(output,{recursive:true});
 for(const file of [archiveName,archiveName+'.sha256',stem+'.candidate.json']){
  if(await lstat(path.join(output,file)).catch(error=>{if(error.code!=='ENOENT')throw error;}))throw Error('Output already exists: '+file);
 }
 const staging=await mkdtemp(path.join(output,'.mosaic-beta-build-'));
 try{
  const bundle=path.join(staging,stem),payload=path.join(bundle,'payload');
  await mkdir(path.join(payload,'runtime','bin'),{recursive:true});
  const {node,license,release}=await runtimeNode(opts,staging);
  await copyFile(node,path.join(payload,'runtime','bin','node'));
  await chmod(path.join(payload,'runtime','bin','node'),0o755);
  await copyFile(license,path.join(payload,'runtime','NODE-LICENSE'));
  await chmod(path.join(payload,'runtime','NODE-LICENSE'),0o644);
  await copyFile(path.join(repo,'LICENSE'),path.join(payload,'LICENSE'));
  await writeFile(path.join(bundle,'README.md'),await readFile(path.join(repo,'docs','TERMINAL_BETA.md'),'utf8')+'\n\n[Portable installation and recovery](payload/runtime/docs/PORTABLE_BETA_INSTALL.md) · [Release gates](payload/runtime/docs/PORTABLE_BETA_RELEASE.md)\n',{mode:0o644});
  const sources=await sourceClosure(repo,['src/beta/cli.mjs']);
  for(const relative of [...sources,'package.json','package-lock.json']){
   const target=path.join(payload,'runtime',relative);
   await mkdir(path.dirname(target),{recursive:true});await copyFile(path.join(repo,relative),target);await chmod(target,0o644);
  }
  const runtime=path.join(payload,'runtime');
  await copyRequiredAssets(repo,runtime,{nodeVersion:release.version});
  let nativeProof=null;
  if(opts['check-artifact']){
   const artifact=path.resolve(opts['check-artifact']);
   if(!opts.fixture)assertPortableArtifactPrivacy(await readFile(path.join(artifact,'node')));
   nativeProof=await probeCheckArtifact(artifact,{nodeVersion:release.version,...(!opts.fixture?{coordinatorSha256:release.coordinatorSha256,licenseSha256:release.licenseSha256}:{})});
   await copyCheckArtifact(artifact,path.join(runtime,'check-artifact'));
   if(sha(await readFile(path.join(runtime,'check-artifact/artifact-manifest.json')))!==nativeProof.runtimeFingerprint)throw Error('Artifact changed after the native packaging preflight');
  }
  await exec('npm',['ci','--omit=dev','--ignore-scripts','--bin-links=false','--no-audit','--no-fund',...(opts.offline?['--offline']:[])],{cwd:runtime,timeout:90000,maxBuffer:1048576});
  const modules=await listFiles(path.join(runtime,'node_modules'));
  const licenses=modules.filter(file=>/(?:^|\/)(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(file)).sort();
  if(!licenses.some(file=>file.startsWith('@modelcontextprotocol/sdk/')))throw Error('The pinned SDK license is missing');
  await writeFile(path.join(runtime,'DEPENDENCY-LICENSES.txt'),'License files included in node_modules\n\n'+licenses.join('\n')+'\n');
  const files=[];
  for(const relative of (await listFiles(payload)).sort()){
   const bytes=await readFile(path.join(payload,relative));
   const info=await lstat(path.join(payload,relative));files.push({path:relative,sha256:sha(bytes),bytes:bytes.length,mode:'100'+(info.mode&0o777).toString(8).padStart(3,'0')});
  }
  if(!opts.fixture&&(files.find(f=>f.path==='runtime/bin/node').sha256!==release.coordinatorSha256||files.find(f=>f.path==='runtime/NODE-LICENSE').sha256!==release.licenseSha256))throw Error('The Node executable and license changed while packaging');
  if(nativeProof&&!nativeProof.artifactFiles.every(expected=>files.some(f=>f.path==='runtime/check-artifact/'+expected.path&&f.sha256===expected.sha256&&f.bytes===expected.bytes&&f.mode===expected.mode)))throw Error('The check artifact inputs changed while packaging');
  const manifest={schema:1,layout:opts['check-artifact']?'terminal-beta-v2':'terminal-beta-v1',version:opts.version,dependenciesInstalled:true,nodeVersion:release.version,fixture:!!opts.fixture,
   stateCompatibility:{settings:[1,2],database:[0,1],providerTransport:'https-or-http-loopback'},...(nativeProof?{nativeCheckArtifact:{fingerprint:nativeProof.runtimeFingerprint,backend:{id:'darwin-seatbelt',revision:2}}}:{}),files,contentHash:digest(files)};
  const manifestBytes=JSON.stringify(manifest,null,2)+'\n';
  await writeFile(path.join(payload,'package-manifest.json'),manifestBytes);
  await verifyPackage(payload);
  const checksums=[...files,{path:'package-manifest.json',sha256:sha(manifestBytes)}].map(f=>f.sha256+'  payload/'+f.path).join('\n')+'\n';
  await writeFile(path.join(bundle,'verify.sha256'),checksums);
  await writeFile(path.join(bundle,'install'),bootstrap(sha(checksums)),{mode:0o755});
  const archive=path.join(staging,archiveName);
  await deterministicArchive(bundle,archive);
  const checksum=sha(await readFile(archive));
  await writeFile(archive+'.sha256',checksum+'  '+archiveName+'\n');
  await rename(archive,path.join(output,archiveName));
  await rename(archive+'.sha256',path.join(output,archiveName+'.sha256'));
  const candidate=await candidateManifest({repo,version:opts.version,archiveName,archiveHash:checksum,manifest,manifestBytes,fixture:!!opts.fixture,nativeProof,verificationRef:opts['verification-ref']});
  await writeFile(path.join(output,stem+'.candidate.json'),JSON.stringify(candidate,null,2)+'\n',{flag:'wx',mode:0o644});
  console.log(path.join(output,archiveName));
 }finally{await rm(staging,{recursive:true,force:true});}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.includes('--help'))console.log('node scripts/package-beta.mjs --version VERSION --output DIR [--node NODE --node-license LICENSE] [--check-artifact DIR] [--verification-ref REPO_RELATIVE_PATH] [--offline] [--fixture]');
 else build(options(process.argv.slice(2))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
