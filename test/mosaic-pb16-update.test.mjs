import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,lstat,realpath,chmod,copyFile,rename,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {client} from '../src/beta/client.mjs';
import {assertMaintenanceIdle} from '../src/beta/service.mjs';
import {digest} from '../src/harness/contracts.mjs';
import {locations,hash,saveJson,withLock} from '../src/beta/files.mjs';
import * as installer from '../src/beta/install.mjs';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {ProviderRegistry} from '../src/harness/providers/registry.mjs';
import {buildNativeCheckArtifact} from '../scripts/build-native-check-artifact.mjs';
import {readBundledNativeCheckRuntime} from '../src/beta/package-contract.mjs';
import {git} from '../src/project/process.mjs';
import {artifact as validationArtifact} from './fixtures/mosaic-pb15-v2-backend/artifact.mjs';
const nativeSources=['native-supervisor.c','native-supervisor.mjs','darwin-seatbelt-v2.mjs','darwin-seatbelt.mjs','contracts.mjs','../sandbox.mjs'];
const nativeAvailable=process.platform==='darwin'&&process.arch==='arm64'&&!!process.env.MOSAIC_NATIVE_TEST_NODE;
const nativeRequired=process.env.MOSAIC_REQUIRE_NATIVE==='1';
const nativeTestLicense=process.env.MOSAIC_NATIVE_TEST_LICENSE??(nativeAvailable?path.resolve(process.env.MOSAIC_NATIVE_TEST_NODE,'../../../LICENSE'):undefined);
async function fixture(t){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'Mosaic update 16 '))),home=path.join(root,'User');await mkdir(home);const paths=locations(home,true);
 t.after(async()=>{
  const database=path.join(paths.state,'harness.sqlite3');let retained=false;
  try{
   await lstat(database);const db=new DatabaseSync(database,{readOnly:true});
   try{if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='records'").get())retained=!!db.prepare("SELECT 1 FROM records WHERE kind='execution_owner' AND json_extract(data,'$.status')!='quiescent' LIMIT 1").get();}finally{db.close();}
  }catch(error){if(error.code!=='ENOENT'){retained=true;t.diagnostic('Retained update fixture after ownership inspection failed: '+error.message);}}
  if(retained)t.diagnostic('Retained native ownership fixture at '+root);else await rm(root,{recursive:true,force:true});
 });
 return {root,paths};
}
async function payload(root,version,{settings=[1,2],database=[0,1],providerTransport,supervisor="reviewed C source",implementation={},artifactRoot,artifactFingerprint}={}){
 const directory=path.join(root,version);await mkdir(directory);const sources={'runtime/src/project/check-backends/native-supervisor.c':supervisor,'runtime/bin/node':'#!/bin/sh\nexit 0\n','runtime/src/beta/cli.mjs':'// entry\n','runtime/package-lock.json':JSON.stringify({packages:{'node_modules/@modelcontextprotocol/sdk':{version:'1.32.2'}}}),'runtime/node_modules/@modelcontextprotocol/sdk/package.json':JSON.stringify({version:'1.32.2'})};const files=[];
 for(const source of new Set([...nativeSources,...Object.keys(implementation)]))sources[path.posix.normalize('runtime/src/project/check-backends/'+source)]=implementation[source]??(source==='native-supervisor.c'?supervisor:'reviewed '+source);
 if(artifactRoot)for(const name of ['node','mosaic-check-supervisor','NODE-LICENSE','artifact-manifest.json'])sources['runtime/check-artifact/'+name]=await readFile(path.join(artifactRoot,name));
 for(const [name,bytes] of Object.entries(sources)){const target=path.join(directory,name);await mkdir(path.dirname(target),{recursive:true});const mode=['runtime/bin/node','runtime/check-artifact/node','runtime/check-artifact/mosaic-check-supervisor'].includes(name)?'100755':name==='runtime/check-artifact/artifact-manifest.json'?'100600':'100644';await writeFile(target,bytes,{mode:parseInt(mode.slice(3),8)});files.push({path:name,sha256:hash(bytes),bytes:Buffer.byteLength(bytes),mode});}
 const manifest={schema:1,layout:artifactFingerprint?'terminal-beta-v2':'terminal-beta-v1',version,dependenciesInstalled:true,...(artifactFingerprint?{nativeCheckArtifact:{fingerprint:artifactFingerprint,backend:{id:'darwin-seatbelt',revision:2}}}:{}),stateCompatibility:{settings,database,...(providerTransport===undefined?{}:{providerTransport})},files,contentHash:digest(files)};await writeFile(path.join(directory,'package-manifest.json'),JSON.stringify(manifest));return directory;
}
test('update and compatible rollback preserve private state and every older version',async t=>{
 const f=await fixture(t),a=await payload(f.root,'0.1.0-beta.161'),b=await payload(f.root,'0.1.0-beta.162');await installer.install(f.paths,a,{noPath:true});await writeFile(f.paths.config,JSON.stringify({schema:2,host:{id:'cursor'}}),{mode:0o600});const evidence=path.join(f.paths.state,'kept-evidence.json');await writeFile(evidence,'kept');const before=await readFile(f.paths.config);
 await installer.install(f.paths,b,{noPath:true});assert.equal(typeof installer.rollbackVersion,'function');await installer.rollbackVersion(f.paths,'0.1.0-beta.161');assert.deepEqual(await readFile(f.paths.config),before);assert.equal(await readFile(evidence,'utf8'),'kept');assert.ok(await lstat(path.join(f.paths.versions,'0.1.0-beta.162')));
});
for(const [name,configFor,allowedUrl] of [
 ['legacy worker',baseUrl=>({schema:1,worker:{profile:{baseUrl}}}),'http://127.0.0.1:8000/v1'],
 ['API reviewer',baseUrl=>({schema:2,providers:[{roles:['worker'],baseUrl:'http://[::1]:8000/v1'},{roles:['reviewer'],baseUrl}]}),'https://reviewer.example.invalid/v1'],
])test(`a remote HTTP ${name} blocks the update before registered service or launcher changes`,async t=>{
 const {root,paths}=await fixture(t),oldVersion='0.1.0-beta.161',newVersion='0.1.0-beta.162';
 const oldPackage=await payload(root,oldVersion),newPackage=await payload(root,newVersion,{providerTransport:'https-or-http-loopback'});
 await installer.install(paths,oldPackage,{noPath:true});
 await writeFile(paths.config,JSON.stringify(configFor('http://private-workstation.example.invalid/v1')),{mode:0o600});
 const protectedFiles=[paths.launcher,paths.installation,paths.config];
 const before=await Promise.all(protectedFiles.map(file=>readFile(file)));
 const lifecycleCalls=[];
 const lifecycle={
  async verifyLaunchAgent(){lifecycleCalls.push('verify');return true;},
  async stopForMaintenance(){lifecycleCalls.push('stop');return true;},
  async startLaunchAgent(){lifecycleCalls.push('start');return true;},
 };
 await assert.rejects(installer.install(paths,newPackage,{noPath:true,lifecycle}),error=>{
  assert.match(error.message,/HTTPS is required.*previous installed version/i);
  assert.doesNotMatch(error.message,/private-workstation/);
  return true;
 });
 assert.deepEqual(lifecycleCalls,[]);
 assert.deepEqual(await Promise.all(protectedFiles.map(file=>readFile(file))),before);
 await assert.rejects(lstat(path.join(paths.configDir,'install-transaction.json')),{code:'ENOENT'});
 await assert.rejects(lstat(path.join(paths.versions,newVersion)),{code:'ENOENT'});

 const compatibleConfig=JSON.stringify(configFor(allowedUrl));
 await writeFile(paths.config,compatibleConfig,{mode:0o600});
 await installer.install(paths,newPackage,{noPath:true,lifecycle});
 assert.deepEqual(lifecycleCalls,['verify','stop','start']);
 assert.equal(JSON.parse(await readFile(paths.installation)).version,newVersion);
 assert.equal(await readFile(paths.config,'utf8'),compatibleConfig);
});
test('rollback uses the old target transport policy and preserves saved settings',async t=>{
 const {root,paths}=await fixture(t),oldVersion='0.1.0-beta.161',newVersion='0.1.0-beta.162';
 await installer.install(paths,await payload(root,oldVersion),{noPath:true});
 await installer.install(paths,await payload(root,newVersion,{providerTransport:'https-or-http-loopback'}),{noPath:true});
 const settings=JSON.stringify({schema:2,providers:[{roles:['worker'],baseUrl:'http://worker.example.invalid/v1'}]});
 await writeFile(paths.config,settings,{mode:0o600});
 await installer.rollbackVersion(paths,oldVersion);
 assert.equal(JSON.parse(await readFile(paths.installation)).version,oldVersion);
 assert.equal(await readFile(paths.config,'utf8'),settings);
});
test('rollback refuses incompatible live settings/database rather than restore old state',async t=>{
 const f=await fixture(t),a=await payload(f.root,'0.1.0-beta.161',{settings:[1],database:[0]}),b=await payload(f.root,'0.1.0-beta.162');await installer.install(f.paths,a,{noPath:true});await installer.install(f.paths,b,{noPath:true});await writeFile(f.paths.config,JSON.stringify({schema:2}),{mode:0o600});const launcher=await readFile(f.paths.launcher);await assert.rejects(installer.rollbackVersion(f.paths,'0.1.0-beta.161'),/incompatible.*settings|settings.*schema/i);assert.deepEqual(await readFile(f.paths.launcher),launcher);
 await rm(f.paths.config);const db=new DatabaseSync(path.join(f.paths.state,'harness.sqlite3'));db.exec('CREATE TABLE records(kind TEXT,id TEXT,data TEXT); PRAGMA user_version=1');db.close();await chmod(path.join(f.paths.state,'harness.sqlite3'),0o600);await assert.rejects(installer.rollbackVersion(f.paths,'0.1.0-beta.161'),/database.*schema|incompatible.*database/i);
});
for(const phase of ['transaction-prepared','version-staged','launcher-switched','receipt-switched'])test('durable recovery after SIGKILL at '+phase,async t=>{
 const f=await fixture(t),a=await payload(f.root,'0.1.0-beta.161'),b=await payload(f.root,'0.1.0-beta.162');await installer.install(f.paths,a,{noPath:true});const original=await readFile(f.paths.launcher);const evidence=path.join(f.paths.state,'evidence');await writeFile(evidence,'new live state retained');
 const script=`import {install} from ${JSON.stringify(new URL('../src/beta/install.mjs',import.meta.url).href)};import {locations} from ${JSON.stringify(new URL('../src/beta/files.mjs',import.meta.url).href)};await install(locations(${JSON.stringify(f.paths.home)},true),${JSON.stringify(b)},{noPath:true,afterStep(step){if(step===${JSON.stringify(phase)})process.kill(process.pid,'SIGKILL')}});`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:15000});assert.equal(child.signal,'SIGKILL',child.stderr);assert.equal(typeof installer.recoverInstallation,'function');await installer.recoverInstallation(f.paths);assert.deepEqual(await readFile(f.paths.launcher),original);assert.equal(JSON.parse(await readFile(f.paths.installation)).version,'0.1.0-beta.161');assert.equal(await readFile(evidence,'utf8'),'new live state retained');await assert.rejects(lstat(path.join(f.paths.configDir,'install-transaction.json')),{code:'ENOENT'});
});
test('interrupted update recovery preserves a user-modified pointer for inspection',async t=>{
 const f=await fixture(t),a=await payload(f.root,'0.1.0-beta.161'),b=await payload(f.root,'0.1.0-beta.162');await installer.install(f.paths,a,{noPath:true});
 const script=`import {install} from ${JSON.stringify(new URL('../src/beta/install.mjs',import.meta.url).href)};import {locations} from ${JSON.stringify(new URL('../src/beta/files.mjs',import.meta.url).href)};await install(locations(${JSON.stringify(f.paths.home)},true),${JSON.stringify(b)},{noPath:true,afterStep(step){if(step==='launcher-switched')process.kill(process.pid,'SIGKILL')}});`;assert.equal(spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'}).signal,'SIGKILL');await writeFile(f.paths.launcher,'user change\n',{mode:0o755});await assert.rejects(installer.recoverInstallation(f.paths),/modified|changed|inspection/);assert.equal(await readFile(f.paths.launcher,'utf8'),'user change\n');
});
test('uninstall retains modified launcher, state, unrelated host files and immutable versions',async t=>{
 const f=await fixture(t),a=await payload(f.root,'0.1.0-beta.161');await installer.install(f.paths,a,{noPath:true});await writeFile(f.paths.launcher,'user change\n',{mode:0o755});const custom=path.join(f.paths.home,'custom-host.json');await writeFile(custom,'unrelated');await installer.uninstall(f.paths);assert.equal(await readFile(f.paths.launcher,'utf8'),'user change\n');assert.equal(await readFile(custom,'utf8'),'unrelated');assert.ok(await lstat(path.join(f.paths.versions,'0.1.0-beta.161')));assert.ok(await lstat(f.paths.state));
});

test('unchanged historical managed launcher is accepted for update and uninstall',async t=>{
 const f=await fixture(t),a=await payload(f.root,'0.1.0-beta.161'),b=await payload(f.root,'0.1.0-beta.162');await installer.install(f.paths,a,{noPath:true});
 // Literal historical bytes are constructed independently of the new generator.
 const quote=v=>"'"+v.replaceAll("'","'\"'\"'")+"'",runtime=path.join(f.paths.versions,'0.1.0-beta.161/runtime');
 const old='#!/bin/sh\n# Mosaic Beta managed launcher v1\nPATH='+quote(path.join(runtime,'bin'))+':'+quote(path.dirname(f.paths.launcher))+':/opt/homebrew/bin:/usr/local/bin:\"$PATH\"\nexport PATH\nexec '+quote(path.join(runtime,'bin/node'))+' '+quote(path.join(runtime,'src/beta/cli.mjs'))+' --home '+quote(f.paths.home)+' \"$@\"\n';
 const receipt=JSON.parse(await readFile(f.paths.installation));await writeFile(f.paths.launcher,old,{mode:0o755});await writeFile(f.paths.installation,JSON.stringify({...receipt,launcherHash:hash(old)}),{mode:0o600});
 assert.deepEqual((await installer.installedLauncher(f.paths)).bytes,Buffer.from(old));await installer.install(f.paths,b,{noPath:true});assert.doesNotMatch(await readFile(f.paths.launcher,'utf8'),/opt\/homebrew|usr\/local/);await installer.uninstall(f.paths);await assert.rejects(lstat(f.paths.launcher),{code:'ENOENT'});
});

test('SIGKILL after committed pointer keeps the new verified version',async t=>{
 const f=await fixture(t),a=await payload(f.root,'0.1.0-beta.161'),b=await payload(f.root,'0.1.0-beta.162');await installer.install(f.paths,a,{noPath:true});
 const script=`import {install} from ${JSON.stringify(new URL('../src/beta/install.mjs',import.meta.url).href)};import {locations} from ${JSON.stringify(new URL('../src/beta/files.mjs',import.meta.url).href)};await install(locations(${JSON.stringify(f.paths.home)},true),${JSON.stringify(b)},{noPath:true,afterStep(step){if(step==='committed')process.kill(process.pid,'SIGKILL')}});`;assert.equal(spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'}).signal,'SIGKILL');
 await installer.recoverInstallation(f.paths);assert.equal(JSON.parse(await readFile(f.paths.installation)).version,'0.1.0-beta.162');assert.match(await readFile(f.paths.launcher,'utf8'),/0\.1\.0-beta\.162/);assert.ok(await lstat(path.join(f.paths.versions,'0.1.0-beta.161')));
});
test('uncommitted recovery never restores a pointer incompatible with newer live state',async t=>{
 const f=await fixture(t),a=await payload(f.root,'0.1.0-beta.161',{settings:[1],database:[0,1]}),b=await payload(f.root,'0.1.0-beta.162');await installer.install(f.paths,a,{noPath:true});
 const script=`import {install} from ${JSON.stringify(new URL('../src/beta/install.mjs',import.meta.url).href)};import {locations} from ${JSON.stringify(new URL('../src/beta/files.mjs',import.meta.url).href)};await install(locations(${JSON.stringify(f.paths.home)},true),${JSON.stringify(b)},{noPath:true,afterStep(step){if(step==='launcher-switched')process.kill(process.pid,'SIGKILL')}});`;assert.equal(spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'}).signal,'SIGKILL');const pointer=await readFile(f.paths.launcher);await writeFile(f.paths.config,JSON.stringify({schema:2,retained:'newer state'}),{mode:0o600});
 await assert.rejects(installer.recoverInstallation(f.paths),/incompatible.*settings|settings.*schema/i);assert.deepEqual(await readFile(f.paths.launcher),pointer);assert.equal(JSON.parse(await readFile(f.paths.config)).retained,'newer state');assert.ok(await lstat(path.join(f.paths.configDir,'install-transaction.json')));
});

async function nativeUpdateFixture(t){
 const f=await fixture(t),materialized=path.join(f.root,'built-node');await copyFile(process.env.MOSAIC_NATIVE_TEST_NODE,materialized);await chmod(materialized,0o755);
 const license=process.env.MOSAIC_NATIVE_TEST_LICENSE??path.resolve(process.env.MOSAIC_NATIVE_TEST_NODE,'../../../LICENSE');
 const artifact=await buildNativeCheckArtifact({builtNode:materialized,builtNodeSha256:hash(await readFile(materialized)),nodeLicense:license,nodeSource:{version:'24.22.0',url:'https://nodejs.org/dist/v24.22.0/node-v24.22.0.tar.xz',sha256:'41f97cff2c666f1f8293dc5f85c65e8dd605c16b43fd9febd49ede32ee1e0329'},nodePatch:{sha256:'840109e32a582faf92ed07f75987c6eb03c9b5659cf74b2f5231ac1e72594741',description:'Disable the Apple posix_spawn branch before file actions; use the existing libuv fork path.'},outputDir:path.join(f.root,'artifact')});
 const implementation={};for(const source of nativeSources)implementation[source]=await readFile(new URL('../src/project/check-backends/'+source,import.meta.url));
 const a=await payload(f.root,'0.1.0-beta.161',{implementation,artifactRoot:artifact.root});await installer.install(f.paths,a,{noPath:true});
 const nativeCheckRuntime=await readBundledNativeCheckRuntime(path.join(f.paths.versions,'0.1.0-beta.161/runtime')),executionPolicy={version:1,backend:'darwin-seatbelt',backendRevision:2,runtimeFingerprint:nativeCheckRuntime.artifactManifestSha256};
 const profile={schema:1,id:'worker',revision:'r1',displayName:'Uncalled loopback worker',transport:'openai-chat',baseUrl:'http://127.0.0.1:1/v1',model:'fixture',roles:['worker'],capabilities:{workerProtocol:'mosaic-structured-v1',transports:['json'],modelDiscovery:'manual',taskKinds:['coding']},maxContextTokens:32000,maxOutputTokens:2048,concurrency:1,capacityGroup:'fixture',credentialRef:null,streaming:false};
 const providers=ProviderRegistry({profiles:[profile]}),context={root:f.paths.state,beta:true,selectedHost:'cursor',providerRegistry:providers,nativeCheckRuntime,executionPolicy};
 const config=JSON.stringify({schema:2,host:{id:'cursor',options:{}},nativeCheckRuntime,execution:executionPolicy,providers:[profile]});await writeFile(f.paths.config,config,{mode:0o600});
 return {...f,implementation,artifact,config,context,nativeCheckRuntime,executionPolicy,providers};
}
test('an archive switch retains the configured legacy runtime and rollback checks the configured current implementation', {skip:process.platform!=='darwin'||process.arch!=='arm64'||!nativeTestLicense,timeout:30000},async t=>{
 const f=await fixture(t),oldVersion='0.1.0-beta.203',currentVersion='0.1.0-beta.204';
 const legacy=await validationArtifact(),current=await validationArtifact();
 t.after(()=>Promise.all([legacy.root,current.root].map(root=>rm(root,{recursive:true,force:true}))));
 const license=await readFile(nativeTestLicense);
 await writeFile(path.join(current.root,'NODE-LICENSE'),license);
 const files=current.manifest.files.map(file=>file.path==='NODE-LICENSE'?{...file,sha256:hash(license),bytes:license.length}:file);
 const currentManifest={...current.manifest,files,nodeVersion:'24.22.3',provenance:{
  ...current.manifest.provenance,
  nodeSource:{version:'24.22.3',url:'https://nodejs.org/dist/v24.22.3/node-v24.22.3.tar.xz',sha256:'48ca3aa8a9b02133356922ef4fc80200e00598c80a4ef446f7c39a459222593d'},
  nodePatch:{...current.manifest.provenance.nodePatch,sha256:'840109e32a582faf92ed07f75987c6eb03c9b5659cf74b2f5231ac1e72594741'},
 }};
 const currentBytes=JSON.stringify(currentManifest)+'\n';await writeFile(current.config.artifactManifestPath,currentBytes);
 const historicalSources={},currentSources={};
 for(const file of nativeSources)historicalSources[file]=await readFile(new URL('../src/project/check-backends/'+file,import.meta.url));
 Object.assign(currentSources,historicalSources);
 for(const file of ['../contracts.mjs','darwin-seatbelt-v2-node-24223.mjs','native-runtime-dispatch.mjs','native-node-releases.mjs']){
  currentSources[file]=await readFile(new URL('../src/project/check-backends/'+file,import.meta.url));
 }
 const oldPackage=await payload(f.root,oldVersion,{implementation:historicalSources,artifactRoot:legacy.root,artifactFingerprint:legacy.config.artifactManifestSha256});
 const currentPackage=await payload(f.root,currentVersion,{implementation:currentSources,artifactRoot:current.root,artifactFingerprint:hash(currentBytes)});
 await installer.install(f.paths,oldPackage,{noPath:true});
 async function configure(version){
  const nativeCheckRuntime=await readBundledNativeCheckRuntime(path.join(f.paths.versions,version,'runtime'));
  const executionPolicy={version:1,backend:'darwin-seatbelt',backendRevision:2,runtimeFingerprint:nativeCheckRuntime.artifactManifestSha256};
  const config={schema:1,nativeCheckRuntime,executionPolicy};await writeFile(f.paths.config,JSON.stringify(config),{mode:0o600});
  const coordinator=new Coordinator({root:f.paths.state,nativeCheckRuntime,executionPolicy});
  try{return coordinator.store.get('execution_configuration','coordinator');}finally{coordinator.close();}
 }
 const legacyIdentity=await configure(oldVersion),savedSettings=await readFile(f.paths.config);
 await installer.install(f.paths,currentPackage,{noPath:true});
 assert.deepEqual(await readFile(f.paths.config),savedSettings);
 await installer.rollbackVersion(f.paths,oldVersion);
 assert.deepEqual(await readFile(f.paths.config),savedSettings);
 assert.equal(legacyIdentity.identity.nativeRuntime.implementationHash,'53e0ee50362b30b690168457766aa49b59e689cebf97e309861ee238aa7a8eca');
 await installer.install(f.paths,currentPackage,{noPath:true});
 const currentIdentity=await configure(currentVersion);
 assert.equal(currentIdentity.identity.nativeRuntime.nodeVersion,'24.22.3');
 await installer.install(f.paths,currentPackage,{noPath:true});
 const protectedFiles=[f.paths.launcher,f.paths.installation,f.paths.config,path.join(f.paths.state,'harness.sqlite3')];
 const before=await Promise.all(protectedFiles.map(file=>readFile(file)));
 await assert.rejects(installer.rollbackVersion(f.paths,oldVersion),/missing native implementation source inventory/i);
 assert.deepEqual(await Promise.all(protectedFiles.map(file=>readFile(file))),before);
 await assert.rejects(lstat(path.join(f.paths.configDir,'install-transaction.json')),{code:'ENOENT'});
});
test('required update proof has the explicit actual native runtime',()=>{if(nativeRequired)assert.ok(nativeAvailable,'MOSAIC_REQUIRE_NATIVE=1 needs Darwin arm64 and MOSAIC_NATIVE_TEST_NODE');});
test('compatible pointer update restarts and resumes exact stopped native approval with retained artifact',{skip:!nativeAvailable&&!nativeRequired,timeout:45000},async t=>{
 const f=await nativeUpdateFixture(t),repo=path.join(f.root,'approved-repo');await mkdir(path.join(repo,'src'),{recursive:true});await mkdir(path.join(repo,'checks'));await writeFile(path.join(repo,'src/value.mjs'),'export const value=1;\n');await writeFile(path.join(repo,'checks/value.mjs'),'process.stdout.write("native");\n');await git(repo,'init','-q');await git(repo,'add','.');await git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Approved base');
 let c=new Coordinator(f.context);t.after(()=>c?.close());const goal=c.preparePortableGoal({submissionId:'retained-update',mode:'collaborative',objective:'Retain exact native approval across compatible pointer update',acceptance:['Resume original immutable approval'],environment:'fixture',providerPolicy:{version:1,defaultWorkerId:'worker',plannerWorkerId:'worker',workers:[f.providers.get('worker','r1')],capacityGroups:[{id:'fixture',limit:1}]},executionPolicy:f.executionPolicy,project:{repo,baseCommit:await git(repo,'rev-parse','HEAD'),readPaths:['src/','checks/'],writePaths:['src/'],checks:[{id:'value',argv:[path.join(path.dirname(f.nativeCheckRuntime.artifactManifestPath),'node'),'checks/value.mjs'],timeoutMs:1000}]}},'prepare');
 const proof=await c.preflightExecution({goalId:goal.id,hash:goal.hash});assert.equal(proof.passed,true);c.activateGoal({goalId:goal.id,hash:goal.hash},'activate');const task=c.submitTask({goalId:goal.id,submissionId:'retained-task',kind:'coding',objective:'Retain exact provider pin',acceptance:['No dispatch on update'],permissions:{readPaths:['src/','checks/'],writePaths:['src/'],checks:['value']}},'task');c.control({goalId:goal.id,action:'stop'},'stop');assert.equal(c.store.get('task',task.id).providerBinding.providerId,'worker');
 const before={goal:c.store.get('goal',goal.id),task:c.store.get('task',task.id),spend:c.store.spent(task.id),execution:c.store.get('execution_configuration','coordinator')};c.close();c=null;
 const b=await payload(f.root,'0.1.0-beta.162',{implementation:f.implementation,artifactRoot:f.artifact.root});await installer.install(f.paths,b,{noPath:true});assert.equal(JSON.parse(await readFile(f.paths.installation)).version,'0.1.0-beta.162');assert.equal(await readFile(f.paths.config,'utf8'),f.config);assert.ok(await lstat(path.dirname(f.nativeCheckRuntime.artifactManifestPath)));
 c=new Coordinator(f.context);assert.deepEqual(c.store.get('execution_configuration','coordinator'),before.execution);assert.deepEqual(c.store.get('goal',goal.id),before.goal);assert.deepEqual(c.store.get('task',task.id),before.task);c.control({goalId:goal.id,action:'resume'},'resume');c.verifyGoalBinding(c.store.get('goal',goal.id));const resumed=c.store.get('goal',goal.id);assert.equal(resumed.hash,before.goal.hash);assert.deepEqual(resumed.manifest,before.goal.manifest);assert.equal(resumed.deadline,before.goal.deadline);assert.deepEqual(c.store.spent(task.id),before.spend);const resumedTask=c.store.get('task',task.id);assert.equal(resumedTask.hash,before.task.hash);assert.deepEqual(resumedTask.provider,before.task.provider);assert.deepEqual(resumedTask.providerBinding,before.task.providerBinding);assert.deepEqual(resumedTask.spec,before.task.spec);assert.equal(resumedTask.attempts,before.task.attempts);c.close();c=null;
});
test('pointer switch rejects every changed native implementation module against saved execution identity',{skip:!nativeAvailable&&!nativeRequired,timeout:45000},async t=>{
 const f=await nativeUpdateFixture(t),c=new Coordinator(f.context);const saved=c.store.get('execution_configuration','coordinator');c.close();const launcher=await readFile(f.paths.launcher),receipt=await readFile(f.paths.installation),state=await readFile(path.join(f.paths.state,'harness.sqlite3'));
 for(const [index,source] of nativeSources.entries())await t.test(source,async()=>{
  const changed={...f.implementation,[source]:Buffer.concat([f.implementation[source],Buffer.from('\n/* independently changed implementation */\n')])};const bad=await payload(f.root,'0.1.0-beta.'+(170+index),{implementation:changed,artifactRoot:f.artifact.root});await assert.rejects(installer.install(f.paths,bad,{noPath:true}),/native.*implementation|supervisor source|artifact.*incompatible/i);assert.deepEqual(await readFile(f.paths.launcher),launcher);assert.deepEqual(await readFile(f.paths.installation),receipt);assert.deepEqual(await readFile(path.join(f.paths.state,'harness.sqlite3')),state);assert.equal(await readFile(f.paths.config,'utf8'),f.config);await assert.rejects(lstat(path.join(f.paths.configDir,'install-transaction.json')),{code:'ENOENT'});
 });
 const verify=new Coordinator(f.context);assert.deepEqual(verify.store.get('execution_configuration','coordinator'),saved);verify.close();
});
test('native update fallback requires a verified owned old package and no held approval',{skip:!nativeAvailable&&!nativeRequired,timeout:30000},async t=>{
 const f=await nativeUpdateFixture(t),b=await payload(f.root,'0.1.0-beta.162',{implementation:f.implementation,artifactRoot:f.artifact.root});
 // Setup can precede the first coordinator boot; no runtime identity exists yet.
 await assert.rejects(lstat(path.join(f.paths.state,'harness.sqlite3')),{code:'ENOENT'});await installer.install(f.paths,b,{noPath:true});assert.equal(JSON.parse(await readFile(f.paths.installation)).version,'0.1.0-beta.162');assert.equal(await readFile(f.paths.config,'utf8'),f.config);
 const c=new Coordinator(f.context),goal=c.preparePortableGoal({submissionId:'missing-runtime-record',mode:'codex_only',objective:'Retain a stopped approval if its runtime record is missing',acceptance:['Refuse inferred replacement runtime identity'],environment:'fixture',executionPolicy:f.executionPolicy},'prepare');c.control({goalId:goal.id,action:'stop'},'stop');const saved=c.store.get('execution_configuration','coordinator');c.close();
 const next=await payload(f.root,'0.1.0-beta.163',{implementation:f.implementation,artifactRoot:f.artifact.root}),launcher=await readFile(f.paths.launcher),receipt=await readFile(f.paths.installation),db=new DatabaseSync(path.join(f.paths.state,'harness.sqlite3'));db.prepare("UPDATE records SET data=? WHERE kind='execution_configuration' AND id='coordinator'").run(JSON.stringify({...saved,hash:'0'.repeat(64)}));db.close();await assert.rejects(installer.install(f.paths,next,{noPath:true}),/saved native execution identity/i);assert.deepEqual(await readFile(f.paths.launcher),launcher);assert.deepEqual(await readFile(f.paths.installation),receipt);
 const damaged=new DatabaseSync(path.join(f.paths.state,'harness.sqlite3'));damaged.prepare("DELETE FROM records WHERE kind='execution_configuration' AND id='coordinator'").run();damaged.close();await assert.rejects(installer.install(f.paths,next,{noPath:true}),/implementation identity is missing.*resumable/i);assert.deepEqual(await readFile(f.paths.launcher),launcher);assert.deepEqual(await readFile(f.paths.installation),receipt);assert.equal(await readFile(f.paths.config,'utf8'),f.config);
});

test('retained native artifact damage rejects compatible update before any pointer or state writes',{skip:!nativeAvailable&&!nativeRequired,timeout:60000},async t=>{
 const f=await nativeUpdateFixture(t),repo=path.join(f.root,'retained-repo');await mkdir(path.join(repo,'checks'),{recursive:true});await mkdir(path.join(repo,'src'));await writeFile(path.join(repo,'src/value.mjs'),'export const value=1;\n');await writeFile(path.join(repo,'checks/value.mjs'),'process.stdout.write("native");\n');await git(repo,'init','-q');await git(repo,'add','.');await git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Retained base');
 const c=new Coordinator(f.context),nodePath=path.join(path.dirname(f.nativeCheckRuntime.artifactManifestPath),'node');const goal=c.preparePortableGoal({submissionId:'retained-artifact',mode:'codex_only',objective:'Preserve exact retained native runtime availability',acceptance:['Refuse unavailable approved literal runtime'],environment:'fixture',executionPolicy:f.executionPolicy,project:{repo,baseCommit:await git(repo,'rev-parse','HEAD'),readPaths:['src/','checks/'],writePaths:['src/'],checks:[{id:'value',argv:[nodePath,'checks/value.mjs'],timeoutMs:1000}]}},'prepare');c.control({goalId:goal.id,action:'stop'},'stop');const stopped=c.store.get('goal',goal.id),saved=c.store.get('execution_configuration','coordinator');c.close();assert.equal(stopped.manifest.project.checks[0].argv[0],nodePath);
 const b=await payload(f.root,'0.1.0-beta.162',{implementation:f.implementation,artifactRoot:f.artifact.root}),artifactRoot=path.dirname(f.nativeCheckRuntime.artifactManifestPath),database=path.join(f.paths.state,'harness.sqlite3'),launcher=await readFile(f.paths.launcher),receipt=await readFile(f.paths.installation),state=await readFile(database),config=await readFile(f.paths.config);
 const originals={};for(const file of ['node','mosaic-check-supervisor','NODE-LICENSE'])originals[file]=await readFile(path.join(artifactRoot,file));
 const scenarios=[];
 for(const file of ['node','mosaic-check-supervisor','NODE-LICENSE']){
  scenarios.push({name:'missing '+file,async mutate(){await rename(path.join(artifactRoot,file),path.join(f.root,'retained-'+file));return ()=>rename(path.join(f.root,'retained-'+file),path.join(artifactRoot,file));}});
  scenarios.push({name:'changed '+file,async mutate(){await writeFile(path.join(artifactRoot,file),Buffer.concat([originals[file],Buffer.from('changed')]));return ()=>writeFile(path.join(artifactRoot,file),originals[file]);}});
  scenarios.push({name:'changed mode '+file,async mutate(){const mode=(await lstat(path.join(artifactRoot,file))).mode&0o777;await chmod(path.join(artifactRoot,file),file==='NODE-LICENSE'?0o600:0o644);return ()=>chmod(path.join(artifactRoot,file),mode);}});
 }
 scenarios.push({name:'symlink node alias',async mutate(){const backup=path.join(f.root,'aliased-node');await rename(nodePath,backup);await symlink(backup,nodePath);return async()=>{await rm(nodePath);await rename(backup,nodePath);};}});
 scenarios.push({name:'symlink artifact directory',async mutate(){const backup=path.join(f.root,'aliased-artifact');await rename(artifactRoot,backup);await symlink(backup,artifactRoot);return async()=>{await rm(artifactRoot);await rename(backup,artifactRoot);};}});
 scenarios.push({name:'writable artifact ancestor',async mutate(){const ancestor=path.dirname(artifactRoot),mode=(await lstat(ancestor)).mode&0o777;await chmod(ancestor,0o777);return ()=>chmod(ancestor,mode);}});
 for(const scenario of scenarios)await t.test(scenario.name,async()=>{
  const restore=await scenario.mutate();try{await assert.rejects(installer.install(f.paths,b,{noPath:true}),/native.*artifact|retained native|runtime.*changed|canonical|aliased|writable|mode/i);assert.deepEqual(await readFile(f.paths.launcher),launcher);assert.deepEqual(await readFile(f.paths.installation),receipt);assert.deepEqual(await readFile(database),state);assert.deepEqual(await readFile(f.paths.config),config);await assert.rejects(lstat(path.join(f.paths.configDir,'install-transaction.json')),{code:'ENOENT'});await assert.rejects(lstat(path.join(f.paths.versions,'0.1.0-beta.162')),{code:'ENOENT'});}finally{await restore();}
 });
 const reopened=new Coordinator(f.context);assert.deepEqual(reopened.store.get('execution_configuration','coordinator'),saved);assert.deepEqual(reopened.store.get('goal',goal.id),stopped);reopened.close();
});
test('retained artifact disappearing during staging cannot switch the pointer',{skip:!nativeAvailable&&!nativeRequired,timeout:30000},async t=>{
 const f=await nativeUpdateFixture(t),c=new Coordinator(f.context),goal=c.preparePortableGoal({submissionId:'retained-staging',mode:'codex_only',objective:'Recheck retained runtime at pointer authority',acceptance:['No pointer switch after retained node disappears'],environment:'fixture',executionPolicy:f.executionPolicy},'prepare');c.control({goalId:goal.id,action:'stop'},'stop');const stopped=c.store.get('goal',goal.id);c.close();
 const b=await payload(f.root,'0.1.0-beta.162',{implementation:f.implementation,artifactRoot:f.artifact.root}),nodePath=path.join(path.dirname(f.nativeCheckRuntime.artifactManifestPath),'node'),backup=path.join(f.root,'staged-retained-node'),database=path.join(f.paths.state,'harness.sqlite3'),launcher=await readFile(f.paths.launcher),receipt=await readFile(f.paths.installation),state=await readFile(database),config=await readFile(f.paths.config);let moved=false;
 try{
  await assert.rejects(installer.install(f.paths,b,{noPath:true,async afterStep(step){if(step==='version-staged'){await rename(nodePath,backup);moved=true;}}}),/native.*artifact|retained.*runtime/i);assert.deepEqual(await readFile(f.paths.launcher),launcher);assert.deepEqual(await readFile(f.paths.installation),receipt);assert.deepEqual(await readFile(database),state);assert.deepEqual(await readFile(f.paths.config),config);assert.equal(JSON.parse(await readFile(path.join(f.paths.configDir,'install-transaction.json'))).phase,'staged');
 }finally{if(moved)await rename(backup,nodePath);}
 await installer.recoverInstallation(f.paths);assert.deepEqual(await readFile(f.paths.launcher),launcher);assert.deepEqual(await readFile(f.paths.installation),receipt);assert.deepEqual(await readFile(database),state);await assert.rejects(lstat(path.join(f.paths.configDir,'install-transaction.json')),{code:'ENOENT'});const resumed=new Coordinator(f.context);assert.deepEqual(resumed.store.get('goal',goal.id),stopped);resumed.close();
});

function restartLifecycle(paths,events,expectedVersion,{startFailure=false}={}){
 let coordinator=null;const owner='fixture-owned-restart';
 const ready=async kind=>withLock(paths,async()=>{
  assert.equal(await installer.assertInstallationStartupReady(paths),true);const tx=JSON.parse(await readFile(path.join(paths.configDir,'install-transaction.json')));assert.equal(tx.phase,kind==='rollback'?'restored':'committed');assert.equal(JSON.parse(await readFile(paths.installation)).version,expectedVersion);events.push('startup-mutex');
  if(startFailure)throw Error('Owned service did not become ready');
  coordinator=new Coordinator({root:paths.state});coordinator.acquireWorker(owner);events.push('ready');return true;
 });
 return {lifecycle:{verifyLaunchAgent:async()=>true,stopForMaintenance:async()=>true,startLaunchAgent:()=>ready('forward'),rollbackLaunchAgent:()=>ready('rollback')},close(){if(coordinator){coordinator.releaseWorker(owner);coordinator.close();coordinator=null;}}};
}
for(const point of ['before service shutdown','after service shutdown'])test('recover the registered service after installer termination '+point,async t=>{
 const {root,paths}=await fixture(t);
 const previous='0.1.0-beta.161',next='0.1.0-beta.162';
 await installer.install(paths,await payload(root,previous),{noPath:true});
 const nextPackage=await payload(root,next),registration=path.join(root,'synthetic-registration');
 await writeFile(registration,'running');
 const before=await Promise.all([paths.launcher,paths.installation].map(file=>readFile(file)));
 const script=`import {install} from ${JSON.stringify(new URL('../src/beta/install.mjs',import.meta.url).href)};
  import {locations} from ${JSON.stringify(new URL('../src/beta/files.mjs',import.meta.url).href)};
  import {writeFile} from 'node:fs/promises';
  await install(locations(${JSON.stringify(paths.home)},true),${JSON.stringify(nextPackage)},{
   noPath:true,lifecycle:{verifyLaunchAgent:async()=>true,async stopForMaintenance(paths,options={}){
    await options.beforeRegisteredStop?.();
    if(${JSON.stringify(point)}==='after service shutdown')await writeFile(${JSON.stringify(registration)},'stopped');
    process.kill(process.pid,'SIGKILL');
   }}
  });`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:15000});
 assert.equal(child.signal,'SIGKILL',child.stderr);
 const alreadyStopped=point==='after service shutdown',priorState=alreadyStopped?'stopped':'running';
 assert.equal(await readFile(registration,'utf8'),priorState);
 const transaction=path.join(paths.configDir,'install-transaction.json'),retained=await readFile(transaction);
 assert.equal(JSON.parse(retained).phase,'stopping');
 await assert.rejects(installer.assertInstallationStartupReady(paths),/incomplete/);
 const c=new Coordinator({root:paths.state});let goal;
 try{
  await assert.rejects(installer.recoverInstallation(paths,{lifecycle:{
   async stopForMaintenance(_paths,{recovering}){
    assert.equal(recovering,true);
    if(alreadyStopped)c.acquireWorker('retained-lease');
    else goal=c.prepareGoal({submissionId:'late',mode:'codex_only',environment:'fixture',objective:'Preserve admitted work',acceptance:['Keep draft']},'late');
    // A service can accept a draft after recovery's first idle read. An
    // unreachable service with a retained lease has no offline stop proof.
    await assertMaintenanceIdle(paths,{offline:alreadyStopped});
   },
   async rollbackLaunchAgent(){assert.fail('Busy service must keep its recovery receipt');},
  }}),alreadyStopped?/coordinator lease/:/prepared, active or unresolved/);
  assert.deepEqual(await readFile(transaction),retained);
  assert.equal(await readFile(registration,'utf8'),priorState);
  if(goal)c.control({goalId:goal.id,action:'stop'},'settled');
  else c.releaseWorker('retained-lease');
 }finally{c.close();}
 let quiesced=false;
 const recovered=await installer.recoverInstallation(paths,{lifecycle:{
  async stopForMaintenance(_paths,{recovering}){
   assert.equal(recovering,true);
   await assertMaintenanceIdle(paths,{offline:alreadyStopped});
   await writeFile(registration,'stopped');quiesced=true;
   return !alreadyStopped;
  },
  async rollbackLaunchAgent(paths,{existed,registered}){
   assert.equal(quiesced,true);assert.equal(await readFile(registration,'utf8'),'stopped');
   assert.equal(existed,true);assert.equal(registered,true);
   await withLock(paths,()=>installer.assertInstallationStartupReady(paths));
   await writeFile(registration,'running');
  },
 }});
 assert.equal(recovered,true);
 assert.equal(await readFile(registration,'utf8'),'running');
 assert.deepEqual(await Promise.all([paths.launcher,paths.installation].map(file=>readFile(file))),before);
 await assert.rejects(lstat(path.join(paths.versions,next)),{code:'ENOENT'});
 assert.equal(await installer.recoverInstallation(paths),false);
});
test('interrupted shutdown verifies the exact old installation and settings before asking its service to stop',async t=>{
 const {root,paths}=await fixture(t),previous='0.1.0-beta.161';
 await installer.install(paths,await payload(root,previous),{noPath:true});
 const next=await payload(root,'0.1.0-beta.162');
 await assert.rejects(installer.install(paths,next,{noPath:true,lifecycle:{
  verifyLaunchAgent:async()=>true,
  async stopForMaintenance(_paths,{beforeRegisteredStop}){
   await beforeRegisteredStop();throw Error('Interrupted before shutdown');
  },
 }}),/Interrupted before shutdown/);
 const transaction=path.join(paths.configDir,'install-transaction.json'),retained=await readFile(transaction);
 let stops=0;
 const recover=()=>installer.recoverInstallation(paths,{lifecycle:{async stopForMaintenance(){stops++;}}});
 await saveJson(paths.config,{schema:2,changed:true});
 await assert.rejects(recover(),/settings changed/i);await rm(paths.config);
 const receipt=await readFile(paths.installation);
 await rm(paths.installation);await assert.rejects(recover(),/pointer or receipt changed/i);
 await writeFile(paths.installation,receipt,{mode:0o600});
 const installed=path.join(paths.versions,previous),replacement=path.join(root,'replacement');await mkdir(replacement);
 const changed=await payload(replacement,previous,{supervisor:'other valid package inventory'});
 await rename(installed,path.join(root,'original'));await rename(changed,installed);
 await assert.rejects(recover(),/inventory differs/i);
 assert.equal(stops,0);assert.deepEqual(await readFile(transaction),retained);
});
test('owned forward restart acquires startup mutex only after committed pointer writes',async t=>{
 const f=await fixture(t),a=await payload(f.root,'0.1.0-beta.161'),b=await payload(f.root,'0.1.0-beta.162');await installer.install(f.paths,a,{noPath:true});const events=[],service=restartLifecycle(f.paths,events,'0.1.0-beta.162');t.after(()=>service.close());
 await installer.install(f.paths,b,{noPath:true,lifecycle:service.lifecycle});assert.deepEqual(events,['startup-mutex','ready']);await assert.rejects(lstat(path.join(f.paths.configDir,'install-transaction.json')),{code:'ENOENT'});service.close();
});
test('precommit rollback releases maintenance mutex before restoring owned service',async t=>{
 const f=await fixture(t),a=await payload(f.root,'0.1.0-beta.161'),b=await payload(f.root,'0.1.0-beta.162');await installer.install(f.paths,a,{noPath:true});const launcher=await readFile(f.paths.launcher),events=[],service=restartLifecycle(f.paths,events,'0.1.0-beta.161');t.after(()=>service.close());
 await assert.rejects(installer.install(f.paths,b,{noPath:true,lifecycle:service.lifecycle,afterStep(step){if(step==='launcher-switched')throw Error('Interrupted before receipt commit');}}),/Interrupted before receipt commit/);assert.deepEqual(events,['startup-mutex','ready']);assert.deepEqual(await readFile(f.paths.launcher),launcher);await assert.rejects(lstat(path.join(f.paths.configDir,'install-transaction.json')),{code:'ENOENT'});service.close();
});

test('a persistent database lock after owned shutdown retains a recoverable upgrade', {timeout: 12000}, async t => {
 const {root,paths}=await fixture(t);
 const oldVersion='0.1.0-beta.161',newVersion='0.1.0-beta.162';
 const oldPackage=await payload(root,oldVersion),newPackage=await payload(root,newVersion);
 await installer.install(paths,oldPackage,{noPath:true});
 await writeFile(paths.config,JSON.stringify({schema:1,host:{id:'cursor'}}),{mode:0o600});
 const [launcher,receipt,settings]=await Promise.all([paths.launcher,paths.installation,paths.config].map(file=>readFile(file)));
 const original=new Coordinator({root:paths.state,selectedHost:'codex'}), owner='original-coordinator';
 const goal=original.preparePortableGoal({submissionId:'retained-lock',mode:'codex_only',environment:'fixture',
  objective:'Keep a saved goal during interrupted upgrade',acceptance:['Preserve the exact stopped approval']},'prepare');
 original.control({goalId:goal.id,action:'stop'},'stop');
 const savedGoal=original.store.get('goal',goal.id);
 assert.equal(savedGoal.status,'stopped');
 original.acquireWorker(owner);
 let running=true;
 const closeOriginal=()=>{
  if(!running)return;
  original.releaseWorker(owner);
  original.close();
  running=false;
 };
 const events=[],service=restartLifecycle(paths,events,oldVersion);
 const database=path.join(paths.state,'harness.sqlite3');
 const transaction=path.join(paths.configDir,'install-transaction.json');
 let blocker,failedInstall;
 try{
  await assert.rejects(installer.install(paths,newPackage,{noPath:true,lifecycle:{...service.lifecycle,
   async stopForMaintenance(){
    closeOriginal();
    blocker=new DatabaseSync(database);
    blocker.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE');
    return true;
   },
  }}),error=>{
   assert.match(error.message,/database is locked.*installation recovery needs inspection/i);
   failedInstall=error;
   return true;
  });
  const pending=JSON.parse(await readFile(transaction));
  assert.equal(pending.phase,'prepared');
  assert.equal(pending.registered,true);
  assert.equal(pending.oldReceipt.version,oldVersion);
  assert.equal(pending.newReceipt.version,newVersion);
  const cli=path.resolve(import.meta.dirname,'../src/beta/cli.mjs');
  const result=spawnSync(process.execPath,[cli,'--home',paths.home,'recover'],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,1,result.stderr);
  assert.match(result.stderr,/database is locked.*then retry.*mosaic recover/i);
  assert.equal(failedInstall.cause?.cause?.code,'ERR_SQLITE_ERROR');
  await assert.rejects(installer.recoverInstallation(paths,{lifecycle:service.lifecycle}),error=>{
   assert.match(error.message,/database is locked.*then retry.*mosaic recover/i);
   assert.equal(error.cause?.code,'ERR_SQLITE_ERROR');
   assert.equal(error.cause.errcode&0xff,5);
   return true;
  });
  assert.deepEqual(JSON.parse(await readFile(transaction)),pending);
  assert.deepEqual(events,[]);
  blocker.close();
  blocker=null;

  assert.equal(await installer.recoverInstallation(paths,{lifecycle:service.lifecycle}),true);
  assert.deepEqual(events,['startup-mutex','ready']);
  assert.deepEqual(await readFile(paths.launcher),launcher);
  assert.deepEqual(await readFile(paths.installation),receipt);
  assert.deepEqual(await readFile(paths.config),settings);
  await assert.rejects(lstat(transaction),{code:'ENOENT'});
  await assert.rejects(lstat(path.join(paths.versions,newVersion)),{code:'ENOENT'});
  const current=new DatabaseSync(database,{readOnly:true});
  try{
   assert.deepEqual(JSON.parse(current.prepare("SELECT data FROM records WHERE kind='goal' AND id=?").get(goal.id).data),savedGoal);
  }finally{current.close();}
 }finally{
  blocker?.close();
  closeOriginal();
  service.close();
 }
});

test('failed owned restart retains committed handoff until recovery obtains startup mutex',async t=>{
 const f=await fixture(t),a=await payload(f.root,'0.1.0-beta.161'),b=await payload(f.root,'0.1.0-beta.162');await installer.install(f.paths,a,{noPath:true});const failedEvents=[],failed=restartLifecycle(f.paths,failedEvents,'0.1.0-beta.162',{startFailure:true});
 await assert.rejects(installer.install(f.paths,b,{noPath:true,lifecycle:failed.lifecycle}),/did not become ready/);assert.deepEqual(failedEvents,['startup-mutex']);assert.equal(JSON.parse(await readFile(path.join(f.paths.configDir,'install-transaction.json'))).phase,'committed');
 const events=[],service=restartLifecycle(f.paths,events,'0.1.0-beta.162');t.after(()=>service.close());assert.equal(await installer.recoverInstallation(f.paths,{lifecycle:service.lifecycle}),true);assert.deepEqual(events,['startup-mutex','ready']);await assert.rejects(lstat(path.join(f.paths.configDir,'install-transaction.json')),{code:'ENOENT'});service.close();
});

test('owned restart admits actual CLI service through shared startup mutex after pointer commit',{timeout:15000},async t=>{
 const f=await fixture(t),a=await payload(f.root,'0.1.0-beta.161'),b=await payload(f.root,'0.1.0-beta.162');await installer.install(f.paths,a,{noPath:true});await writeFile(f.paths.config,JSON.stringify({schema:1,host:{id:'cursor',options:{}},codexPath:process.execPath}),{mode:0o600});let child,closed;const events=[];
 const lifecycle={verifyLaunchAgent:async()=>true,stopForMaintenance:async()=>true,async startLaunchAgent(){
  await withLock(f.paths,async()=>{assert.equal(await installer.assertInstallationStartupReady(f.paths),true);assert.equal(JSON.parse(await readFile(f.paths.installation)).version,'0.1.0-beta.162');events.push('startup-mutex');});
  child=spawn(process.execPath,[path.resolve(import.meta.dirname,'../src/beta/cli.mjs'),'--home',f.paths.home,'serve'],{env:{PATH:'/usr/bin:/bin',HOME:f.paths.home},stdio:['ignore','pipe','pipe']});closed=once(child,'exit');closed.catch(()=>{});
  await new Promise((resolve,reject)=>{let stdout='',stderr='';const timer=setTimeout(()=>reject(Error('Owned CLI did not become ready: '+stderr)),8000);child.stderr.on('data',bytes=>stderr+=bytes);child.stdout.on('data',bytes=>{stdout+=bytes;if(stdout.includes('"status":"ready"')){clearTimeout(timer);events.push('ready');resolve();}});child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);reject(Error('Owned CLI exited '+code+': '+stderr));});});
 }};
 try{await installer.install(f.paths,b,{noPath:true,lifecycle});assert.deepEqual(events,['startup-mutex','ready']);assert.ok((await client(f.paths)('tools_list')).some(tool=>tool.name==='goal_prepare'));await assert.rejects(lstat(path.join(f.paths.configDir,'install-transaction.json')),{code:'ENOENT'});const db=new DatabaseSync(path.join(f.paths.state,'harness.sqlite3'),{readOnly:true});try{assert.ok(db.prepare("SELECT 1 FROM records WHERE kind='lease' AND id='coordinator'").get());}finally{db.close();}}
 finally{if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await closed;}}
 const stopped=new DatabaseSync(path.join(f.paths.state,'harness.sqlite3'),{readOnly:true});try{assert.equal(stopped.prepare("SELECT 1 FROM records WHERE kind='lease' AND id='coordinator'").get(),undefined);}finally{stopped.close();}
});
test('startup readiness rejects incomplete writes and retains changed handoff settings',async t=>{
 const f=await fixture(t),a=await payload(f.root,'0.1.0-beta.161'),b=await payload(f.root,'0.1.0-beta.162');await installer.install(f.paths,a,{noPath:true});assert.equal(await installer.assertInstallationStartupReady(f.paths),false);const custom=JSON.stringify({schema:1,codexPath:process.execPath});let incomplete=false;
 const lifecycle={verifyLaunchAgent:async()=>true,stopForMaintenance:async()=>true,async startLaunchAgent(){await withLock(f.paths,()=>installer.assertInstallationStartupReady(f.paths));await writeFile(f.paths.config,custom,{mode:0o600});}};
 await assert.rejects(installer.install(f.paths,b,{noPath:true,lifecycle,async afterStep(step){if(step==='version-staged'){await assert.rejects(installer.assertInstallationStartupReady(f.paths),/incomplete/);incomplete=true;}}}),/Settings changed.*recovery/);assert.equal(incomplete,true);assert.equal(await readFile(f.paths.config,'utf8'),custom);assert.equal(JSON.parse(await readFile(path.join(f.paths.configDir,'install-transaction.json'))).phase,'committed');await assert.rejects(installer.assertInstallationStartupReady(f.paths),/Settings changed/);
 await rm(f.paths.config);const events=[],service=restartLifecycle(f.paths,events,'0.1.0-beta.162');t.after(()=>service.close());await installer.recoverInstallation(f.paths,{lifecycle:service.lifecycle});assert.deepEqual(events,['startup-mutex','ready']);service.close();
});
