import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,rm,symlink,chmod,mkdir,stat} from 'node:fs/promises';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {fixture,sha,digest,gates} from './fixtures/portable-release-evidence/fixture.mjs';
import {NATIVE_NODE_RELEASES} from '../src/project/check-backends/native-node-releases.mjs';
const script=fileURLToPath(new URL('../scripts/release/verify-portable-candidate.mjs',import.meta.url));
const args=f=>Object.entries(f.opts).flatMap(([k,v])=>['--'+k.replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),v]);
const run=f=>spawnSync(process.execPath,[script,...args(f)],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
async function setup(t){const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));return f;}
async function reject(f,code){const r=run(f);assert.equal(r.status,2,r.stderr);assert.match(r.stderr,new RegExp(code));await assert.rejects(readFile(f.output),{code:'ENOENT'});}
function payloadEntry(f,file,bytes,mode='100644'){
 f.payload.set(file,bytes);
 const item={path:file,sha256:sha(bytes),bytes:bytes.length,mode};
 const index=f.manifest.files.findIndex(v=>v.path===file);
 if(index<0)f.manifest.files.push(item);else f.manifest.files[index]=item;
 return item;
}
async function nativeFixture(t,version){
 const f=await setup(t),release=NATIVE_NODE_RELEASES[version];
 const patchFile='test/fixtures/mosaic-pb15-v2-composition/fork-only.patch';
 const patch=await readFile(new URL('../'+patchFile,import.meta.url));
 const assets=[[patchFile,'runtime/provenance/fork-only.patch',patch]];
 if(version==='24.22.3'){
  for(const file of ['THIRD_PARTY_NOTICES.md','docs/DISTRIBUTION_PROVENANCE.md'])assets.push([file,'runtime/'+file,Buffer.from(file+'\n')]);
  for(const name of ['INDEX.md','SHA256SUMS','terms/source.txt'])assets.push(['distribution/notices/'+name,'runtime/notices/'+name,Buffer.from(name+'\n')]);
  for(const file of ['scripts/build-native-check-artifact.mjs','src/project/check-backends/native-node-releases.mjs']){
   const b=Buffer.from('// fixture build input '+file+'\n');
   assets.push([file,null,b]);
   f.c.build.inputs.push({path:file,sha256:sha(b)});
  }
 }
 for(const [source,destination,bytes] of assets){await mkdir(path.dirname(path.join(f.source,source)),{recursive:true});await writeFile(path.join(f.source,source),bytes);if(destination)payloadEntry(f,destination,bytes);}
 f.git('add','.');f.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','native fixture');
 f.c.source.commit=f.git('rev-parse','HEAD');f.c.source.tree=f.git('rev-parse','HEAD^{tree}');
 f.c.versions.coordinatorNode=f.c.versions.checkNode=f.manifest.nodeVersion=version;
 f.manifest.layout='terminal-beta-v2';
 const nativePrefix='runtime/check-artifact/';
 const files=[['node','100755'],['mosaic-check-supervisor','100755'],['NODE-LICENSE','100644']].map(([file,mode])=>({...payloadEntry(f,nativePrefix+file,Buffer.from(file+' fixture\n'),mode),path:file}));
 const artifact={schema:1,platform:'darwin',arch:'arm64',nodeVersion:version,supervisorProtocol:1,files,provenance:{
  nodeSource:{version,url:release.sourceUrl,sha256:release.sourceSha256},
  nodePatch:{sha256:release.patchSha256,description:'Fork-only fixture'},
  supervisorSourceSha256:sha(f.payload.get('runtime/src/project/check-backends/native-supervisor.c')),
  build:{compiler:'fixture clang',platform:'darwin-arm64'}
 }};
 const save=async artifactBytes=>{
  const manifest=payloadEntry(f,nativePrefix+'artifact-manifest.json',artifactBytes??Buffer.from(JSON.stringify(artifact)+'\n'),'100600');
  const backend={id:'darwin-seatbelt',revision:2};
  f.manifest.nativeCheckArtifact={fingerprint:manifest.sha256,backend};
  f.c.verification.nativePreflight={backend,runtimeFingerprint:manifest.sha256,childProcessWorks:true,quiescent:true,kernelContainment:true};
  f.manifest.files.sort((a,b)=>a.path<b.path?-1:1);f.manifest.contentHash=digest(f.manifest.files);
  f.c.build.runtimeInputs=f.manifest.files.filter(r=>['runtime/bin/node','runtime/NODE-LICENSE',manifest.path].includes(r.path));
  await f.saveArchive();
  f.index.binding.sourceCommit=f.c.source.commit;f.index.binding.sourceTree=f.c.source.tree;
  await writeFile(f.evidenceIndex,JSON.stringify(f.index));
 };
 return {f,artifact,save};
}
test('schema1 fixture binds archive/source/evidence without copying private-looking record text or changing inputs',async t=>{
 const f=await setup(t),before=await Promise.all([f.candidate,f.archive,f.evidenceIndex,...f.records.map(r=>path.join(f.evidenceRoot,r.path))].map(p=>readFile(p)));
 const r=run(f);assert.equal(r.status,0,r.stderr);const raw=await readFile(f.output,'utf8'),s=JSON.parse(raw);
 assert.equal(s.kind,'mosaic-portable-evidence');assert.equal(s.integrity.status,'verified');assert.equal(s.candidate.fixture,true);assert.deepEqual(s.candidate.originalUnpassedGates,gates);assert.equal(s.readiness,'pending-external-qualification');assert.equal(s.suppliedEvidence.records.length,3);assert.ok(s.externalGates.every(g=>g.status==='pending'));assert.equal(s.suppliedEvidence.authority,'not-established');
 for(const secret of [f.root,'/Users/example','https://example.invalid','token=DEMONSTRATION','harmless'])assert.ok(!raw.includes(secret),secret);
 assert.deepEqual(await Promise.all([f.candidate,f.archive,f.evidenceIndex,...f.records.map(r=>path.join(f.evidenceRoot,r.path))].map(p=>readFile(p))),before);assert.equal(f.git('status','--porcelain'),'');assert.equal((await stat(f.output)).mode&0o777,0o600);
});
test('the archive verifier accepts the supported provider transport policy and rejects unknown policies',async t=>{
 const supported=await setup(t);
 supported.manifest.stateCompatibility.providerTransport='https-or-http-loopback';
 await supported.saveArchive();
 const result=run(supported);
 assert.equal(result.status,0,result.stderr);

 const unknown=await setup(t);
 unknown.manifest.stateCompatibility.providerTransport='unknown-policy';
 await unknown.saveArchive();
 await reject(unknown,'inventory_schema_mismatch');
});
test('archive corruption and truncation cannot pass with stale candidate digest',async t=>{for(const kind of ['corrupt','short']){const f=await setup(t),b=await readFile(f.archive);await writeFile(f.archive,kind==='short'?b.subarray(0,20):Buffer.concat([b.subarray(0,-4),Buffer.from('oops')]));await reject(f,'archive');}});
test('an unsupported coordinator runtime cannot be blessed by matching inventory and archive digests',async t=>{
 const f=await setup(t);f.c.versions.coordinatorNode=f.manifest.nodeVersion='24.22.1';await f.saveArchive();
 await reject(f,'unsupported_coordinator_node');
});
test('legacy and current native fixture metadata verify against their own exact provenance',async t=>{
 for(const version of ['24.22.0','24.22.3']){
  const {f,save}=await nativeFixture(t,version);await save();
  const r=run(f);assert.equal(r.status,0,r.stderr);
 }
});
test('changed native version, upstream source, fork patch and member pins fail with a fully rebound archive',async t=>{
 for(const [kind,code] of [['candidate','inventory_native_version_mismatch'],['manifest','inventory_native_version_mismatch'],['source-version','inventory_native_provenance_mismatch'],['source-digest','inventory_native_provenance_mismatch'],['patch','inventory_native_provenance_mismatch'],['member','inventory_native_files_mismatch']]){
  const {f,artifact,save}=await nativeFixture(t,'24.22.3');
  if(kind==='candidate')f.c.versions.checkNode='24.22.0';
  if(kind==='manifest')artifact.nodeVersion='24.22.0';
  if(kind==='source-version')artifact.provenance.nodeSource.version='24.22.0';
  if(kind==='source-digest')artifact.provenance.nodeSource.sha256=NATIVE_NODE_RELEASES['24.22.0'].sourceSha256;
  if(kind==='patch')artifact.provenance.nodePatch.sha256='0'.repeat(64);
  if(kind==='member')artifact.files[0].sha256='0'.repeat(64);
  await save();await reject(f,code);
 }
});
test('current release requires exact stock bytes even when candidate and archive agree',async t=>{
 const {f,save}=await nativeFixture(t,'24.22.3');
 f.c.fixture=f.manifest.fixture=false;await save();
 await reject(f,'inventory_coordinator_provenance_mismatch');
});
test('current notice paths and content are bound to the source checkout',async t=>{
 for(const kind of ['missing','changed']){
  const {f,save}=await nativeFixture(t,'24.22.3'),file='runtime/notices/terms/source.txt';
  if(kind==='missing')f.manifest.files.splice(f.manifest.files.findIndex(r=>r.path===file),1);
  else payloadEntry(f,file,Buffer.from('changed terms'));
  await save();await reject(f,kind==='missing'?'inventory_notice_paths_mismatch':'runtime_source_bytes_mismatch');
 }
});
test('current candidate verification rejects omitted and replaced source notice documents',async t=>{
 for(const file of ['runtime/THIRD_PARTY_NOTICES.md','runtime/docs/DISTRIBUTION_PROVENANCE.md'])for(const kind of ['missing','changed'])await t.test(file+' '+kind,async t=>{
  const {f,save}=await nativeFixture(t,'24.22.3');
  if(kind==='missing')f.manifest.files.splice(f.manifest.files.findIndex(r=>r.path===file),1);
  else payloadEntry(f,file,Buffer.from('changed notice'));
  await save();
  await reject(f,kind==='missing'?'inventory_notice_paths_mismatch':'runtime_source_bytes_mismatch');
 });
});
test('native artifact metadata rejects an inflated member above its bounded read',async t=>{
 const {f,save}=await nativeFixture(t,'24.22.3');await save(Buffer.alloc(128*1024+1,32));
 await reject(f,'archive_metadata_too_large');
});
test('dirty tracked, staged and untracked source and stale commit/tree are rejected',async t=>{for(const kind of ['dirty','staged','untracked','stale']){const f=await setup(t);if(kind==='stale'){f.opts.expectedCommit='1'.repeat(40);}else{await writeFile(path.join(f.source,kind==='untracked'?'extra.txt':'src/beta/cli.mjs'),'changed');if(kind==='staged')f.git('add','.');}await reject(f,'source');}});
test('inventory bytes, mode, runtime source and canonical content hash mismatches fail',async t=>{for(const kind of ['bytes','mode','source','hash']){const f=await setup(t);if(kind==='bytes')f.payload.set('runtime/NODE-LICENSE',Buffer.from('corrupt bytes'));if(kind==='mode')await f.saveArchive(e=>e.map(v=>v[0].endsWith('/NODE-LICENSE')?[v[0],v[1],0o755]:v));else if(kind==='source'){const file=f.manifest.files.find(x=>x.path.startsWith('runtime/src/'));const b=Buffer.from('mismatched source\n');f.payload.set(file.path,b);file.bytes=b.length;file.sha256=sha(b);f.manifest.contentHash=digest(f.manifest.files);f.c.source.closureHash=sha(JSON.stringify(f.manifest.files.filter(r=>r.path.startsWith('runtime/src/'))));await f.saveArchive();}else{if(kind==='hash')f.manifest.contentHash='0'.repeat(64);await f.saveArchive();}await reject(f,'inventory|source|content');}});
test('changed, missing, out of scope and symlink evidence paths fail closed',async t=>{for(const kind of ['changed','missing','escape','absolute','link']){const f=await setup(t),p=path.join(f.evidenceRoot,'review.json');if(kind==='changed')await writeFile(p,'changed');if(kind==='missing')await rm(p);if(kind==='link'){await rm(p);await symlink(f.candidate,p);}if(kind==='escape'||kind==='absolute'){f.index.records[2].path=kind==='escape'?'../candidate.json':f.candidate;await writeFile(f.evidenceIndex,JSON.stringify(f.index));}await reject(f,'evidence|path|symlink|unavailable');}});
test('untrusted live-success text cannot clear a gate or promote fixture evidence',async t=>{const f=await setup(t);f.records[2].scope='live-claim';f.records[2].text=JSON.stringify({verified:true,status:'passed',liveModelCalls:true,cleanMac:true,releaseApproved:true,secret:'PRIVATE-TRANSCRIPT'});await f.saveIndex();const r=run(f);assert.equal(r.status,0,r.stderr);const s=JSON.parse(await readFile(f.output));assert.equal(s.suppliedEvidence.records[2].scope,'live-claim');assert.equal(s.suppliedEvidence.records[2].interpretation,'unverified-claim');assert.ok(s.externalGates.every(g=>g.status==='pending'));assert.ok(!JSON.stringify(s).includes('PRIVATE-TRANSCRIPT'));});
test('malformed, duplicate-key, deep, oversized, symlink and FIFO candidate inputs have finite sanitized errors',async t=>{for(const kind of ['malformed','duplicate','deep','oversized','link','fifo']){const f=await setup(t);if(kind==='malformed')await writeFile(f.candidate,'{"private":"PRIVATE-DETAIL"');if(kind==='duplicate')await writeFile(f.candidate,'{"schema":1,"schema":1}');if(kind==='deep')await writeFile(f.candidate,'['.repeat(40)+'0'+']'.repeat(40));if(kind==='oversized')await writeFile(f.candidate,Buffer.alloc(1024*1024+1));if(kind==='link'){await rm(f.candidate);await symlink(f.archive,f.candidate);}if(kind==='fifo'){await rm(f.candidate);execFileSync('/usr/bin/mkfifo',[f.candidate]);}const r=run(f);assert.equal(r.status,2,r.stderr);assert.ok(!r.stderr.includes(f.root));assert.ok(!r.stderr.includes('PRIVATE-DETAIL'));assert.ok(r.stderr.length<256);}});
test('output cannot overwrite inputs, escape the owned report directory, or use a public directory',async t=>{for(const kind of ['input','escape','public','exists']){const f=await setup(t);if(kind==='input'){f.opts.reportDir=f.evidenceRoot;f.opts.output=f.evidenceIndex;}if(kind==='escape')f.opts.output=path.join(f.root,'outside.json');if(kind==='public')await chmod(f.reportDir,0o755);if(kind==='exists')await writeFile(f.output,'preserved');const r=run(f);assert.equal(r.status,2,r.stderr);if(kind==='exists')assert.equal(await readFile(f.output,'utf8'),'preserved');}});
test('canonical tar rejects links, traversal, duplicates, missing members and excess data even with a matching digest',async t=>{
 for(const kind of ['link','traversal','duplicate','missing','extra']){const f=await setup(t);await f.saveArchive(entries=>{const pos=entries.findIndex(v=>v[0].endsWith('/install'));if(kind==='link')entries[pos][3]='2';if(kind==='traversal')entries[pos][0]=f.stem+'/../install';if(kind==='duplicate')entries.splice(pos,0,entries[pos]);if(kind==='missing')entries.splice(pos,1);if(kind==='extra')entries.push([f.stem+'/zzz-private-name',Buffer.from('private')]);return entries;});await reject(f,'archive|unsafe_relative_path');}
});
test('source symlink, evidence parent symlink and evidence FIFO are refused',async t=>{
 for(const kind of ['source','parent','fifo']){const f=await setup(t);if(kind==='source'){await rm(path.join(f.source,'src/beta/cli.mjs'));await symlink(f.candidate,path.join(f.source,'src/beta/cli.mjs'));}if(kind==='parent'){await mkdir(path.join(f.root,'external'));await symlink(path.join(f.root,'external'),path.join(f.evidenceRoot,'alias'));f.index.records[0].path='alias/record.json';await writeFile(f.evidenceIndex,JSON.stringify(f.index));}if(kind==='fifo'){await rm(path.join(f.evidenceRoot,'review.json'));execFileSync('/usr/bin/mkfifo',[path.join(f.evidenceRoot,'review.json')]);}await reject(f,'symlink|nonregular');}
});
test('oversized archive and evidence record are rejected by stat before reading',async t=>{for(const kind of ['archive','record']){const f=await setup(t);const {open}=await import('node:fs/promises');const h=await open(kind==='archive'?f.archive:path.join(f.evidenceRoot,'review.json'),'w');await h.truncate(kind==='archive'?128*1024*1024+1:8*1024*1024+1);await h.close();await reject(f,'too_large');}});
test('unknown CLI selectors and output symlink produce fixed errors without private details',async t=>{const f=await setup(t);await symlink(f.candidate,f.output);const before=await readFile(f.candidate);const r=run(f);assert.equal(r.status,2);assert.match(r.stderr,/output_unavailable/);assert.deepEqual(await readFile(f.candidate),before);const unknown=spawnSync(process.execPath,[script,'--endpoint','PRIVATE-API-SECRET'],{encoding:'utf8',timeout:15000});assert.equal(unknown.status,2);assert.equal(unknown.stderr,'portable-evidence: invalid_cli_arguments\n');});
test('a self-consistent inventory cannot omit a required runtime source module',async t=>{
 const f=await setup(t);await writeFile(path.join(f.source,'src/beta/required.mjs'),'export const value=1;\n');await writeFile(path.join(f.source,'src/beta/cli.mjs'),'import {value} from "./required.mjs";\n');f.git('add','.');f.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','required module');f.c.source.commit=f.git('rev-parse','HEAD');f.c.source.tree=f.git('rev-parse','HEAD^{tree}');
 const b=await readFile(path.join(f.source,'src/beta/cli.mjs')),entry=f.manifest.files.find(r=>r.path==='runtime/src/beta/cli.mjs');entry.sha256=sha(b);entry.bytes=b.length;f.payload.set(entry.path,b);f.manifest.contentHash=digest(f.manifest.files);f.c.source.closureHash=sha(JSON.stringify(f.manifest.files.filter(r=>r.path.startsWith('runtime/src/'))));await f.saveArchive();f.index.binding.sourceCommit=f.c.source.commit;f.index.binding.sourceTree=f.c.source.tree;await writeFile(f.evidenceIndex,JSON.stringify(f.index));await reject(f,'runtime_source_closure');
});
test('pinned digest alone cannot bless malformed gzip, short tar, non-ASCII headers or nonzero tail bytes',async t=>{
 const {gzipSync,gunzipSync}=await import('node:zlib');
 for(const kind of ['gzip','short-tar','header','tail','member-size']){const f=await setup(t);let bytes=await readFile(f.archive),raw=gunzipSync(bytes);if(kind==='gzip')bytes=Buffer.from('not gzip');else{if(kind==='short-tar')raw=raw.subarray(0,-1024);if(kind==='tail')raw=Buffer.concat([raw,Buffer.from('private-tail')]);if(kind==='header'||kind==='member-size'){raw=Buffer.from(raw);if(kind==='header')raw[0]|=128;else raw.write((256*1024*1024+1).toString(8).padStart(11,'0')+'\0',124,12);raw.fill(32,148,156);raw.write(raw.subarray(0,512).reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148);}bytes=gzipSync(raw);}await writeFile(f.archive,bytes);f.c.archive.sha256=sha(bytes);await writeFile(f.candidate,JSON.stringify(f.c));await f.saveIndex();await reject(f,'archive|invalid_size');}
});
test('candidate gate text and extra fields cannot inject private data into public output',async t=>{
 for(const kind of ['gate','field','archive-name']){const f=await setup(t);if(kind==='gate')f.c.unpassedGates.push('PRIVATE: /Users/fictional/secret');if(kind==='field')f.c.privatePrompt='PRIVATE-PROMPT';if(kind==='archive-name')f.c.archive.file='/Users/fictional/secret.tar.gz';await writeFile(f.candidate,JSON.stringify(f.c));await f.saveIndex();const r=run(f);assert.equal(r.status,2);assert.ok(!r.stderr.includes('PRIVATE'));assert.ok(!r.stderr.includes('/Users/'));await assert.rejects(readFile(f.output),{code:'ENOENT'});}
});
test('build and runtime input digests are bound independently of the archive digest',async t=>{for(const kind of ['build','runtime']){const f=await setup(t);(kind==='build'?f.c.build.inputs:f.c.build.runtimeInputs)[0].sha256='f'.repeat(64);await writeFile(f.candidate,JSON.stringify(f.c));await f.saveIndex();await reject(f,'source|runtime_inputs');}});
test('Git replacement trees cannot substitute source bytes behind exact commit/tree pins',async t=>{
 const f=await setup(t),commit=f.c.source.commit,tree=f.c.source.tree,b=Buffer.from('export const message="replacement";\n');await writeFile(path.join(f.source,'src/beta/cli.mjs'),b);f.git('add','.');const changedTree=f.git('write-tree');f.git('replace',tree,changedTree);const entry=f.manifest.files.find(r=>r.path==='runtime/src/beta/cli.mjs');entry.bytes=b.length;entry.sha256=sha(b);f.payload.set(entry.path,b);f.manifest.contentHash=digest(f.manifest.files);f.c.source.closureHash=sha(JSON.stringify(f.manifest.files.filter(r=>r.path.startsWith('runtime/src/'))));await f.saveArchive();f.opts.expectedCommit=commit;f.opts.expectedTree=tree;await reject(f,'source_index_mismatch');
});
test('canonical inventory cannot use one path as both regular file and parent directory',async t=>{
 const f=await setup(t),b=Buffer.from('file and parent collision');for(const p of ['runtime/collision','runtime/collision/child.txt']){f.payload.set(p,b);f.manifest.files.push({path:p,sha256:sha(b),bytes:b.length,mode:'100644'});}f.manifest.files.sort((a,b)=>a.path<b.path?-1:1);f.manifest.contentHash=digest(f.manifest.files);await f.saveArchive();await reject(f,'archive_path_collision');
});
test('private output directory accepts canonical paths and macOS aliases when available',async t=>{
 const f=await setup(t);if(process.platform==='darwin'){const alias=p=>p.replace(/^\/private\/(var|tmp)(?=\/)/,'/$1');assert.notEqual(alias(f.reportDir),f.reportDir);f.opts.reportDir=alias(f.reportDir);f.opts.output=alias(f.output);}else t.diagnostic('Canonical-path assertions only; macOS alias assertions are not exercised on this platform.');const r=run(f);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(await readFile(f.output)).integrity.status,'verified');
});
test('output filenames with control characters fail before creating a report',async t=>{const f=await setup(t);f.opts.output=path.join(f.reportDir,'private\nname.json');const r=run(f);assert.equal(r.status,2,r.stderr);await assert.rejects(readFile(f.opts.output),{code:'ENOENT'});});
