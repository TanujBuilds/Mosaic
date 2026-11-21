#!/usr/bin/env node
// Offline data verification only. Never extract/import/execute candidate bytes.
import {lstat,realpath,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {createGunzip} from 'node:zlib';
import {Transform} from 'node:stream';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {CURRENT_NODE_RELEASE,NATIVE_NODE_RELEASES} from '../../src/project/check-backends/native-node-releases.mjs';

const MiB=1024*1024;
export const LIMITS=Object.freeze({candidate:MiB,json:2*MiB,archive:128*MiB,expanded:512*MiB,member:256*MiB,entries:10000,record:8*MiB,evidence:64*MiB,records:64,sourceFile:16*MiB,sourceTotal:128*MiB,sourceFiles:10000,gitOutput:4*MiB});
const GATES=['final-source-suite','independent-review','clean-machine','real-host-accounts','live-providers','other-platforms','signing-notarization','authenticated-download','public-source-license-audit','publication'];
const EXTERNAL=['actual-host-discovery','real-owner-project-quality','live-model-quality','three-independent-workers','native-network-and-postgres','clean-mac','other-platforms','signing-notarization','authenticated-public-download','final-beta-acceptance'];
const BUILD_INPUTS=['package-lock.json','scripts/package-beta.mjs','scripts/lib/beta-archive.mjs','scripts/lib/beta-candidate.mjs','scripts/lib/beta-candidate.schema.json'];
const CURRENT_BUILD_INPUTS=[...BUILD_INPUTS,'scripts/build-native-check-artifact.mjs','src/project/check-backends/native-node-releases.mjs'];
const NATIVE_MANIFEST='runtime/check-artifact/artifact-manifest.json';
const ROLES=['acceptance','test-command','test-result','test-log','review','publication'];
const SCOPES=['source-fixture','installed-fixture','live-claim','unknown'];
const MODES=['100600','100644','100755'];
const hash=b=>createHash('sha256').update(b).digest('hex');
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
class EvidenceError extends Error{constructor(code){super(code);this.code=code;}}
const need=(ok,code)=>{if(!ok)throw new EvidenceError(code);};
function fields(v,required,optional=[]){need(v&&typeof v==='object'&&!Array.isArray(v),'invalid_object');need(required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k)),'invalid_fields');}
const sha=v=>need(typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),'invalid_digest');
const gitId=v=>need(typeof v==='string'&&/^[a-f0-9]{40}$/.test(v),'invalid_source_identity');
const list=(v,max)=>need(Array.isArray(v)&&v.length<=max,'invalid_list');
const integer=(v,max)=>need(Number.isSafeInteger(v)&&v>=0&&v<=max,'invalid_size');
function relative(v){need(typeof v==='string'&&Buffer.byteLength(v)<=255&&/^[\x20-\x7e]+$/.test(v)&&!v.includes('\\')&&!v.includes(':')&&!v.startsWith('/')&&v.split('/').length<=32&&v.split('/').every(p=>p&&p!=='.'&&p!=='..'),'unsafe_relative_path');return v;}
// Lex strings before tracking object keys/depth; JSON.parse handles full grammar.
function json(bytes,max=LIMITS.json){
 need(bytes.length<=max,'json_too_large');let s;try{s=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new EvidenceError('malformed_json');}
 const stack=[];let tokens=0;
 for(let i=0;i<s.length;i++){
  const c=s[i];if(/\s/.test(c))continue;need(++tokens<=300000,'json_too_complex');
  if(c==='"'){let j=i+1;for(;j<s.length;j++){if(s[j]==='\\'){j++;continue;}if(s[j]==='"')break;}need(j<s.length,'malformed_json');if(/^\s*:/.test(s.slice(j+1))){let key;try{key=JSON.parse(s.slice(i,j+1));}catch{throw new EvidenceError('malformed_json');}need(stack.at(-1) instanceof Set,'malformed_json');need(!stack.at(-1).has(key),'duplicate_json_key');stack.at(-1).add(key);}i=j;}
  else if(c==='{'||c==='['){stack.push(c==='{'?new Set():null);need(stack.length<=20,'json_too_deep');}else if(c==='}'||c===']'){need(stack.length>0,'malformed_json');stack.pop();}
 }
 need(stack.length===0,'malformed_json');try{return JSON.parse(s);}catch{throw new EvidenceError('malformed_json');}
}
async function cleanPath(input){
 need(typeof input==='string'&&input.length>0&&input.length<4096&&!/[\x00-\x1f\x7f]/.test(input)&&!input.split(/[\\/]/).includes('..'),'unsafe_path');
 let p=path.resolve(input);if(process.platform==='darwin')p=p.replace(/^\/var(?=\/|$)/,'/private/var').replace(/^\/tmp(?=\/|$)/,'/private/tmp');
 let current=path.parse(p).root;for(const part of p.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);let st;try{st=await lstat(current);}catch{throw new EvidenceError('path_unavailable');}need(!st.isSymbolicLink(),'symlink_path');if(current!==p)need(st.isDirectory(),'non_directory_parent');}
 need(await realpath(p)===p,'noncanonical_path');return p;
}
const same=(a,b)=>['dev','ino','mode','size','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);
async function regular(file,max){
 const p=await cleanPath(file),before=await lstat(p);need(before.isFile(),'nonregular_file');need(before.size<=max,'file_too_large');
 let h;try{h=await open(p,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch{throw new EvidenceError('file_unavailable');}
 try{const st=await h.stat();need(st.isFile()&&same(before,st),'file_changed');return {p,h,st};}catch(e){await h.close();throw e;}
}
async function unchanged(f){need(same(f.st,await f.h.stat())&&same(f.st,await lstat(f.p)),'file_changed');}
async function read(file,max){
 const f=await regular(file,max);try{const b=Buffer.alloc(f.st.size+1);let n=0;while(n<b.length){const r=await f.h.read(b,n,b.length-n,null);if(!r.bytesRead)break;n+=r.bytesRead;}need(n===f.st.size,'file_changed');await unchanged(f);return b.subarray(0,n);}finally{await f.h.close();}
}
function fileRecord(f){fields(f,['path','sha256','bytes','mode']);relative(f.path);sha(f.sha256);integer(f.bytes,LIMITS.member);need(MODES.includes(f.mode),'invalid_inventory_mode');}
function candidateContract(c){
 fields(c,['schema','kind','version','platform','fixture','source','archive','inventory','versions','build','verification','unpassedGates']);need(c.schema===1&&c.kind==='mosaic-portable-beta-candidate'&&c.platform==='darwin-arm64'&&typeof c.fixture==='boolean','unsupported_candidate');need(typeof c.version==='string'&&c.version.length<=64&&/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(c.version),'invalid_version');
 fields(c.source,['commit','tree','dirty','closureHash']);gitId(c.source.commit);gitId(c.source.tree);sha(c.source.closureHash);need(c.source.dirty===false,'dirty_candidate_source');
 fields(c.archive,['file','sha256']);need(c.archive.file===`mosaic-beta-${c.version}-darwin-arm64.tar.gz`,'archive_version_path_mismatch');sha(c.archive.sha256);
 fields(c.inventory,['file','sha256','contentHash']);need(c.inventory.file==='payload/package-manifest.json','inventory_path_mismatch');sha(c.inventory.sha256);sha(c.inventory.contentHash);
 fields(c.versions,['coordinatorNode','checkNode','sdk','settingsSchemas','databaseSchemas']);
 const {coordinatorNode,checkNode,sdk}=c.versions;
 for(const v of [coordinatorNode,sdk])need(typeof v==='string'&&/^\d+\.\d+\.\d+$/.test(v),'invalid_version');
 need(Object.hasOwn(NATIVE_NODE_RELEASES,coordinatorNode),'unsupported_coordinator_node');
 need(checkNode===null||typeof checkNode==='string'&&Object.hasOwn(NATIVE_NODE_RELEASES,checkNode),'unsupported_check_node');
 need(checkNode===null||checkNode===coordinatorNode,'inventory_native_version_mismatch');
 for(const a of [c.versions.settingsSchemas,c.versions.databaseSchemas]){list(a,16);a.forEach(v=>integer(v,1000));}
 const inputs=coordinatorNode===CURRENT_NODE_RELEASE.version?CURRENT_BUILD_INPUTS:BUILD_INPUTS;
 fields(c.build,['archiveFormat','timestamp','owner','group','inputs','runtimeInputs']);need(c.build.archiveFormat==='ustar-gzip-v1'&&c.build.timestamp===0&&c.build.owner===0&&c.build.group===0,'unsupported_archive_format');list(c.build.inputs,inputs.length);need(c.build.inputs.length===inputs.length,'invalid_build_inputs');
 const seenInputs=new Set();for(const f of c.build.inputs){fields(f,['path','sha256']);need(inputs.includes(f.path)&&!seenInputs.has(f.path),'invalid_build_inputs');seenInputs.add(f.path);sha(f.sha256);}list(c.build.runtimeInputs,3);c.build.runtimeInputs.forEach(fileRecord);
 fields(c.verification,['references','nativePreflight']);list(c.verification.references,16);const refs=new Set();for(const r of c.verification.references){fields(r,['path','sha256']);relative(r.path);sha(r.sha256);need(!refs.has(r.path),'duplicate_reference');refs.add(r.path);}
 if(c.verification.nativePreflight!==null){const p=c.verification.nativePreflight;fields(p,['backend','runtimeFingerprint','childProcessWorks','quiescent','kernelContainment']);fields(p.backend,['id','revision']);need(p.backend.id==='darwin-seatbelt'&&p.backend.revision===2&&p.childProcessWorks===true&&p.quiescent===true&&p.kernelContainment===true,'unsupported_preflight_claim');sha(p.runtimeFingerprint);}
 list(c.unpassedGates,GATES.length);need(c.unpassedGates.length>0&&new Set(c.unpassedGates).size===c.unpassedGates.length&&c.unpassedGates.every(g=>GATES.includes(g)),'unsupported_candidate_gate_labels');
}
const execute=promisify(execFile);
async function git(root,args){
 try{return (await execute('/usr/bin/git',['--no-replace-objects','--no-optional-locks','-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','core.excludesFile=/dev/null',...args],{cwd:root,encoding:'utf8',timeout:10000,maxBuffer:LIMITS.gitOutput,env:{PATH:'/usr/bin:/bin',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'}})).stdout;}catch{throw new EvidenceError('source_git_failed');}
}
async function sourceSnapshot(root,c,options){
 const commit=(await git(root,['rev-parse','--verify','HEAD'])).trim(),tree=(await git(root,['rev-parse','--verify','HEAD^{tree}'])).trim();need(commit===c.source.commit&&tree===c.source.tree,'source_identity_mismatch');
 if(options.expectedCommit!==undefined){gitId(options.expectedCommit);need(commit===options.expectedCommit,'source_commit_pin_mismatch');}if(options.expectedTree!==undefined){gitId(options.expectedTree);need(tree===options.expectedTree,'source_tree_pin_mismatch');}
 need((await git(root,['rev-parse','--show-toplevel'])).trim()===root,'source_checkout_root_required');
 const committed=await git(root,['ls-tree','-r','-z','--full-tree','HEAD']),indexed=await git(root,['ls-files','--stage','-z']);
 const entries=committed.split('\0').filter(Boolean),index=indexed.split('\0').filter(Boolean);need(entries.length>0&&entries.length<=LIMITS.sourceFiles&&index.length===entries.length,'source_index_mismatch');
 const files=new Map();let total=0;
 for(let i=0;i<entries.length;i++){
  const m=entries[i].match(/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/s);need(m,'unsupported_source_entry');const [,mode,oid,p]=m;relative(p);need(index[i]===`${mode} ${oid} 0\t${p}`,'source_index_mismatch');
  const b=await read(path.join(root,p),LIMITS.sourceFile);total+=b.length;need(total<=LIMITS.sourceTotal,'source_too_large');need(createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex')===oid,'dirty_source_bytes');const st=await lstat(path.join(root,p));need(!!(st.mode&0o111)===(mode==='100755'),'dirty_source_mode');files.set(p,{sha256:hash(b),bytes:b.length,mode});
 }
 need((await git(root,['ls-files','--others','--exclude-standard','-z'])).length===0,'dirty_source_untracked');
 return {commit,tree,files,signature:hash(committed+'\0'+indexed)};
}
// Pull exact chunks; memory is bounded by one inflater chunk plus requested data.
class Reader{
 constructor(stream){this.it=stream[Symbol.asyncIterator]();this.chunk=Buffer.alloc(0);this.offset=0;this.total=0;}
 async take(n,optional=false){const out=Buffer.alloc(n);let used=0;while(used<n){if(this.offset===this.chunk.length){const r=await this.it.next();if(r.done){need(optional&&used===0,'archive_short');return null;}this.chunk=r.value;this.offset=0;this.total+=this.chunk.length;need(this.total<=LIMITS.expanded,'archive_expanded_too_large');}const count=Math.min(n-used,this.chunk.length-this.offset);this.chunk.copy(out,used,this.offset,this.offset+count);used+=count;this.offset+=count;}return out;}
}
function tarText(h,start,len){const b=h.subarray(start,start+len),end=b.indexOf(0);need(b.every(v=>v===0||v>=32&&v<=126),'archive_nonascii_header');need(end<0||b.subarray(end).every(v=>v===0),'archive_noncanonical_header');return b.subarray(0,end<0?b.length:end).toString('ascii');}
function octal(h,start,len){const raw=h.subarray(start,start+len);need(raw.every(v=>v===0||v===32||v>=48&&v<=55),'archive_invalid_number');const s=raw.toString('ascii').replace(/[\0 ]+$/g,'').replace(/^ +/,'');need(/^[0-7]+$/.test(s),'archive_invalid_number');const n=parseInt(s,8);need(Number.isSafeInteger(n),'archive_invalid_number');return n;}
async function archiveInventory(file,c){
 need(path.basename(file)===c.archive.file,'archive_version_path_mismatch');const f=await regular(file,LIMITS.archive);need(f.st.size>0,'archive_short');
 const compressed=createHash('sha256'),meter=new Transform({transform(chunk,encoding,cb){compressed.update(chunk);cb(null,chunk);}}),input=f.h.createReadStream({autoClose:false,start:0,end:f.st.size-1,highWaterMark:65536}),gunzip=createGunzip({chunkSize:65536});
 // Forward source errors; the bounded reader owns teardown, including on rejection.
 input.on('error',e=>gunzip.destroy(e));meter.on('error',e=>gunzip.destroy(e));input.pipe(meter).pipe(gunzip);
 const reader=new Reader(gunzip),stem=c.archive.file.slice(0,-7),members=new Map(),metadata=new Map();let previous='',ended=false;
 const nativeManifestPath=stem+'/payload/'+NATIVE_MANIFEST;
 const retain=new Set([stem+'/payload/package-manifest.json',stem+'/verify.sha256',stem+'/payload/runtime/package-lock.json',stem+'/payload/runtime/node_modules/@modelcontextprotocol/sdk/package.json',nativeManifestPath]);
 try{
  while(true){const h=await reader.take(512,true);need(h,'archive_missing_terminator');if(h.every(v=>v===0)){const h2=await reader.take(512);need(h2.every(v=>v===0),'archive_invalid_terminator');need(await reader.take(1,true)===null,'archive_trailing_data');ended=true;break;}
   need(members.size<LIMITS.entries,'archive_too_many_entries');const checksum=octal(h,148,8),check=Buffer.from(h);check.fill(32,148,156);need(check.reduce((a,b)=>a+b,0)===checksum,'archive_header_checksum');need(h.subarray(257,265).equals(Buffer.from([117,115,116,97,114,0,48,48])),'archive_not_ustar');
   const leaf=tarText(h,0,100),prefix=tarText(h,345,155),name=prefix?prefix+'/'+leaf:leaf,type=String.fromCharCode(h[156]);need(type==='0'||type==='5','archive_nonregular_member');const directory=type==='5';need(directory===name.endsWith('/'),'archive_path_type_mismatch');relative(directory?name.slice(0,-1):name);need(name.startsWith(stem+'/'),'archive_version_path_mismatch');need(name>previous&&!members.has(name),'archive_noncanonical_inventory');previous=name;
   const size=octal(h,124,12),mode=octal(h,100,8);integer(size,LIMITS.member);need(octal(h,108,8)===0&&octal(h,116,8)===0&&octal(h,136,12)===0,'archive_owner_timestamp');need(h.subarray(157,257).every(v=>v===0)&&h.subarray(265,345).every(v=>v===0)&&h.subarray(500).every(v=>v===0),'archive_noncanonical_header');need(directory?size===0&&[0o700,0o755].includes(mode):[0o600,0o644,0o755].includes(mode),'archive_invalid_mode');
   if(retain.has(name))need(size<=(name===nativeManifestPath?128*1024:LIMITS.json),'archive_metadata_too_large');const chunks=[],sum=createHash('sha256');let left=size;while(left){const chunk=await reader.take(Math.min(left,65536));sum.update(chunk);if(retain.has(name))chunks.push(chunk);left-=chunk.length;}const padding=(512-size%512)%512;if(padding)need((await reader.take(padding)).every(v=>v===0),'archive_nonzero_padding');
   members.set(name,{sha256:sum.digest('hex'),bytes:size,mode:'100'+mode.toString(8).padStart(3,'0'),directory});if(retain.has(name))metadata.set(name,Buffer.concat(chunks));
  }
  need(ended&&compressed.digest('hex')===c.archive.sha256,'archive_digest_mismatch');await unchanged(f);
 }catch(e){if(e instanceof EvidenceError)throw e;throw new EvidenceError('archive_decode_failed');}finally{input.destroy();meter.destroy();gunzip.destroy();await f.h.close();}
 for(const [name,member] of members){
  if(!member.directory)need(!members.has(name+'/'),'archive_path_collision');
  let parent=path.posix.dirname(member.directory?name.slice(0,-1):name);
  while(parent!=='.'){need(members.get(parent+'/')?.directory===true&&!members.has(parent),'archive_path_collision');parent=path.posix.dirname(parent);}
 }
 const mb=metadata.get(stem+'/payload/package-manifest.json');need(mb&&hash(mb)===c.inventory.sha256,'inventory_digest_mismatch');const m=json(mb);
 fields(m,['schema','layout','version','dependenciesInstalled','nodeVersion','fixture','stateCompatibility','files','contentHash'],['nativeCheckArtifact']);need(m.schema===1&&['terminal-beta-v1','terminal-beta-v2'].includes(m.layout)&&m.version===c.version&&m.fixture===c.fixture&&m.dependenciesInstalled===true&&m.nodeVersion===c.versions.coordinatorNode,'inventory_candidate_mismatch');
 fields(m.stateCompatibility,['settings','database'],['providerTransport']);
 need(canonical(m.stateCompatibility.settings)===canonical(c.versions.settingsSchemas)&&canonical(m.stateCompatibility.database)===canonical(c.versions.databaseSchemas)&&(m.stateCompatibility.providerTransport===undefined||m.stateCompatibility.providerTransport==='https-or-http-loopback'),'inventory_schema_mismatch');
 list(m.files,LIMITS.entries);need(m.files.length>0,'empty_inventory');const found=new Set();let prev='',total=0;for(const r of m.files){fileRecord(r);need(r.path>prev&&!found.has(r.path),'noncanonical_inventory');prev=r.path;found.add(r.path);total+=r.bytes;need(total<=LIMITS.expanded,'inventory_too_large');}
 need(m.contentHash===hash(canonical(m.files))&&m.contentHash===c.inventory.contentHash,'inventory_content_hash_mismatch');const runtime=m.files.filter(r=>r.path.startsWith('runtime/src/'));need(runtime.length>0&&hash(JSON.stringify(runtime))===c.source.closureHash,'runtime_source_closure_mismatch');
 const expected=new Set([stem+'/',stem+'/README.md',stem+'/install',stem+'/verify.sha256',stem+'/payload/package-manifest.json']);
 for(const r of m.files){const name=stem+'/payload/'+r.path,actual=members.get(name);need(actual&&!actual.directory&&['sha256','bytes','mode'].every(k=>actual[k]===r[k]),'inventory_member_mismatch');expected.add(name);}
 for(const n of [...expected]){let d=path.posix.dirname(n);while(d!=='.'){expected.add(d+'/');d=path.posix.dirname(d);}}
 need(members.size===expected.size&&[...members.keys()].every(n=>expected.has(n))&&[...expected].every(n=>members.has(n)),'archive_inventory_paths_mismatch');for(const n of [stem+'/README.md',stem+'/verify.sha256',stem+'/payload/package-manifest.json'])need(members.get(n).mode==='100644'&&!members.get(n).directory,'archive_outer_mode_mismatch');need(members.get(stem+'/install').mode==='100755','archive_outer_mode_mismatch');
 const checksums=Buffer.from([...m.files,{path:'package-manifest.json',sha256:hash(mb)}].map(r=>r.sha256+'  payload/'+r.path).join('\n')+'\n');need(metadata.get(stem+'/verify.sha256')?.equals(checksums),'inventory_checksum_list_mismatch');
 const runtimeInputs=m.files.filter(r=>['runtime/bin/node','runtime/NODE-LICENSE',NATIVE_MANIFEST].includes(r.path));need(canonical(runtimeInputs)===canonical(c.build.runtimeInputs),'inventory_runtime_inputs_mismatch');
 const coordinator=runtimeInputs.find(f=>f.path==='runtime/bin/node'),license=runtimeInputs.find(f=>f.path==='runtime/NODE-LICENSE'),release=NATIVE_NODE_RELEASES[c.versions.coordinatorNode];
 need(coordinator?.mode==='100755'&&license?.mode==='100644','inventory_required_runtime_missing');
 if(!c.fixture)need(coordinator.sha256===release.coordinatorSha256&&license.sha256===release.licenseSha256,'inventory_coordinator_provenance_mismatch');
 const native=m.layout==='terminal-beta-v2',nativeFiles=m.files.filter(f=>f.path.startsWith('runtime/check-artifact/'));
 need(native===(c.verification.nativePreflight!==null)&&native===(c.versions.checkNode!==null)&&(c.fixture||native),'inventory_native_claim_mismatch');
 if(native){
  fields(m.nativeCheckArtifact,['fingerprint','backend']);
  const record=runtimeInputs.find(f=>f.path===NATIVE_MANIFEST);
  need(canonical(m.nativeCheckArtifact.backend)===canonical(c.verification.nativePreflight.backend)&&m.nativeCheckArtifact.fingerprint===c.verification.nativePreflight.runtimeFingerprint&&record?.sha256===m.nativeCheckArtifact.fingerprint&&record.mode==='100600','inventory_native_binding_mismatch');
  bindNativeArtifact(json(metadata.get(nativeManifestPath),128*1024),m.files,nativeFiles,release,c.fixture);
 }else need(!Object.hasOwn(m,'nativeCheckArtifact')&&nativeFiles.length===0,'inventory_native_claim_mismatch');
 const lock=metadata.get(stem+'/payload/runtime/package-lock.json'),sdk=metadata.get(stem+'/payload/runtime/node_modules/@modelcontextprotocol/sdk/package.json');need(lock&&json(lock).packages?.['node_modules/@modelcontextprotocol/sdk']?.version===c.versions.sdk,'inventory_sdk_mismatch');need(sdk&&json(sdk).version===c.versions.sdk,'inventory_sdk_mismatch');return {manifest:m,runtime,entries:members.size,expanded:reader.total,archiveBytes:f.st.size};
}
function bindNativeArtifact(manifest,files,nativeFiles,release,fixture){
 fields(manifest,['schema','platform','arch','nodeVersion','supervisorProtocol','files','provenance']);
 need(manifest.schema===1&&manifest.platform==='darwin'&&manifest.arch==='arm64'&&manifest.supervisorProtocol===1,'unsupported_native_artifact');
 need(manifest.nodeVersion===release.version,'inventory_native_version_mismatch');
 const p=manifest.provenance;
 fields(p,['nodeSource','nodePatch','supervisorSourceSha256','build']);
 fields(p.nodeSource,['version','url','sha256']);fields(p.nodePatch,['sha256','description']);fields(p.build,['compiler','platform']);
 need(p.nodeSource.version===release.version&&p.nodeSource.url===release.sourceUrl&&p.nodeSource.sha256===release.sourceSha256&&p.nodePatch.sha256===release.patchSha256&&typeof p.nodePatch.description==='string'&&p.nodePatch.description.trim().length>0&&p.nodePatch.description.length<=2000&&p.build.platform==='darwin-arm64'&&typeof p.build.compiler==='string'&&p.build.compiler.length>0,'inventory_native_provenance_mismatch');
 need(files.some(f=>f.path==='runtime/provenance/fork-only.patch'&&f.sha256===p.nodePatch.sha256&&f.mode==='100644')&&files.some(f=>f.path==='runtime/src/project/check-backends/native-supervisor.c'&&f.sha256===p.supervisorSourceSha256),'inventory_native_provenance_mismatch');
 list(manifest.files,3);need(manifest.files.length===3&&nativeFiles.length===4,'inventory_native_files_mismatch');
 const modes=new Map([['node','100755'],['mosaic-check-supervisor','100755'],['NODE-LICENSE','100644']]);
 for(const f of manifest.files){
  fileRecord(f);
  const outer=nativeFiles.find(r=>r.path==='runtime/check-artifact/'+f.path);
  need(modes.get(f.path)===f.mode&&f.bytes>0&&outer&&['sha256','bytes','mode'].every(k=>f[k]===outer[k]),'inventory_native_files_mismatch');
  modes.delete(f.path);
  if(!fixture&&f.path==='node')need(f.sha256!==release.coordinatorSha256,'inventory_native_provenance_mismatch');
  if(!fixture&&f.path==='NODE-LICENSE')need(f.sha256===release.licenseSha256,'inventory_native_provenance_mismatch');
 }
}
async function runtimeClosure(root,s){
 const expected=new Set(),pending=['src/beta/cli.mjs'];
 while(pending.length){
  const p=pending.pop();if(expected.has(p))continue;
  need(/^src\/(?:beta|harness|project|adapters)\/[\w./-]+\.mjs$/.test(p)&&s.files.has(p),'runtime_source_closure_missing');
  expected.add(p);need(expected.size<=LIMITS.sourceFiles,'runtime_source_closure_too_large');
  const b=await read(path.join(root,p),LIMITS.sourceFile);need(hash(b)===s.files.get(p).sha256,'source_changed');
  for(const m of b.toString('utf8').matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"](\.[^'"]+\.mjs)['"]/g))pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(p),m[1])));
 }
 const prefix='src/harness/workflow-recipes/definitions/';
 for(const p of s.files.keys())if(p.startsWith(prefix))expected.add(p);
 const native='src/project/check-backends/native-supervisor.c';need(s.files.has(native),'runtime_source_closure_missing');expected.add(native);
 return [...expected].sort();
}
function bindSource(c,a,s){
 const compare=(p,r)=>{const f=s.files.get(p);need(f&&f.sha256===r.sha256&&(!Object.hasOwn(r,'bytes')||f.bytes===r.bytes),'runtime_source_bytes_mismatch');};
 for(const f of [...c.build.inputs,...c.verification.references])compare(f.path,f);
 for(const f of a.runtime){need(f.mode==='100644','runtime_source_mode_mismatch');compare(f.path.slice('runtime/'.length),f);}
 for(const f of a.manifest.files){let source;if(f.path==='LICENSE')source='LICENSE';else if(['runtime/package.json','runtime/package-lock.json'].includes(f.path)||f.path.startsWith('runtime/docs/'))source=f.path.slice('runtime/'.length);else source=({'runtime/provenance/fork-only.patch':'test/fixtures/mosaic-pb15-v2-composition/fork-only.patch','runtime/provenance/build-native-check-artifact.mjs':'scripts/build-native-check-artifact.mjs','runtime/provenance/beta-candidate.schema.json':'scripts/lib/beta-candidate.schema.json'})[f.path];if(source)compare(source,f);}
 if(c.versions.coordinatorNode===CURRENT_NODE_RELEASE.version){
  for(const source of ['THIRD_PARTY_NOTICES.md','docs/DISTRIBUTION_PROVENANCE.md']){
   const record=a.manifest.files.find(f=>f.path==='runtime/'+source);
   need(record,'inventory_notice_paths_mismatch');
   need(record.mode==='100644','inventory_notice_mode_mismatch');
   compare(source,record);
  }
  const prefix='distribution/notices/',expected=[...s.files.keys()].filter(p=>p.startsWith(prefix)).map(p=>p.slice(prefix.length)).sort();
  const inventory=a.manifest.files.filter(f=>f.path.startsWith('runtime/notices/'));
  need(expected.length>2&&expected.includes('INDEX.md')&&expected.includes('SHA256SUMS')&&canonical(inventory.map(f=>f.path.slice('runtime/notices/'.length)))===canonical(expected),'inventory_notice_paths_mismatch');
  for(const f of inventory){need(f.mode==='100644','inventory_notice_mode_mismatch');compare(prefix+f.path.slice('runtime/notices/'.length),f);}
 }
}
async function evidence(root,indexPath,c,candidateHash){
 const bytes=await read(indexPath,LIMITS.json),i=json(bytes);fields(i,['schema','kind','binding','records']);need(i.schema===1&&i.kind==='mosaic-portable-evidence-index','unsupported_evidence_index');fields(i.binding,['candidateSha256','archiveSha256','sourceCommit','sourceTree']);need(i.binding.candidateSha256===candidateHash&&i.binding.archiveSha256===c.archive.sha256&&i.binding.sourceCommit===c.source.commit&&i.binding.sourceTree===c.source.tree,'evidence_binding_mismatch');
 list(i.records,LIMITS.records);const seen=new Set(),records=[];let total=bytes.length;for(const r of i.records){fields(r,['path','sha256','bytes','role','scope']);relative(r.path);sha(r.sha256);integer(r.bytes,LIMITS.record);need(ROLES.includes(r.role)&&SCOPES.includes(r.scope)&&!seen.has(r.path),'invalid_evidence_record');seen.add(r.path);total+=r.bytes;need(total<=LIMITS.evidence,'evidence_too_large');const b=await read(path.join(root,r.path),LIMITS.record);need(b.length===r.bytes&&hash(b)===r.sha256,'evidence_record_digest_mismatch');records.push({file:`record-${String(records.length+1).padStart(3,'0')}`,sha256:r.sha256,bytes:r.bytes,role:r.role,scope:r.scope,interpretation:r.scope==='live-claim'?'unverified-claim':'supplied-only'});}
 return {indexSha256:hash(bytes),authority:'not-established',records,localAcceptance:records.some(r=>r.role==='acceptance')?'supplied-unverified':'not-supplied',publication:records.some(r=>r.role==='publication')?'supplied-dated-record-only':'not-supplied'};
}
const overlaps=(a,b)=>a===b||a.startsWith(b+path.sep)||b.startsWith(a+path.sep);
/** Returns a sanitized sidecar; the only write is the separate CLI output step. */
export async function verifyPortableCandidate(options){
 const source=await cleanPath(options.source),root=await cleanPath(options.evidenceRoot),index=await cleanPath(options.evidenceIndex),candidate=await cleanPath(options.candidate),archive=await cleanPath(options.archive);need((await lstat(source)).isDirectory()&&(await lstat(root)).isDirectory(),'input_directory_required');
 const cb=await read(candidate,LIMITS.candidate),c=json(cb,LIMITS.candidate);candidateContract(c);const s=await sourceSnapshot(source,c,options),a=await archiveInventory(archive,c);bindSource(c,a,s);need(canonical(await runtimeClosure(source,s))===canonical(a.runtime.map(f=>f.path.slice('runtime/'.length))),'runtime_source_closure_mismatch');const e=await evidence(root,index,c,hash(cb));
 const after=await sourceSnapshot(source,c,options);need(after.signature===s.signature&&canonical([...after.files])===canonical([...s.files]),'source_changed');need(hash(await read(candidate,LIMITS.candidate))===hash(cb),'candidate_changed');
 return {schema:1,kind:'mosaic-portable-evidence',readOnly:true,releaseAuthority:false,readiness:'pending-external-qualification',candidate:{file:'candidate.json',sha256:hash(cb),version:c.version,platform:c.platform,fixture:c.fixture,source:{commit:c.source.commit,tree:c.source.tree,clean:true},archive:{file:c.archive.file,sha256:c.archive.sha256,bytes:a.archiveBytes},inventory:{file:c.inventory.file,sha256:c.inventory.sha256,contentHash:c.inventory.contentHash,files:a.manifest.files.length,runtimeSourceFiles:a.runtime.length},originalUnpassedGates:[...c.unpassedGates]},integrity:{status:'verified',archive:'digest-and-canonical-inventory',source:'exact-clean-checkout-and-runtime-bytes',evidence:'supplied-record-digests',authenticity:'not-established'},suppliedEvidence:e,externalGates:EXTERNAL.map(g=>({gate:g,status:'pending',reason:'separate-qualified-evidence-required'})),limitations:['hashes-do-not-prove-execution-or-reviewer-trust','fixture-evidence-does-not-establish-live-readiness','no-build-test-provider-or-installation-executed','native-preflight-is-an-immutable-builder-claim','source-availability-does-not-qualify-downloads']};
}
const HELP=`Usage: node scripts/release/verify-portable-candidate.mjs --candidate FILE --archive FILE --source DIR --evidence-root DIR --evidence-index FILE --report-dir PRIVATE_DIR --output NEW_FILE [--expected-commit SHA1] [--expected-tree SHA1]\nOffline read-only verification. Exit 0 means byte/evidence integrity; external readiness remains pending. Exit 2 rejects input. No archive extraction, test/build execution, installation or network.\n`;
function options(argv){const o={},flags=new Map(['candidate','archive','source','evidence-root','evidence-index','report-dir','output','expected-commit','expected-tree'].map(k=>['--'+k,k.replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]));while(argv.length){const flag=argv.shift();need(flags.has(flag)&&argv.length>0&&!argv[0].startsWith('--')&&!Object.hasOwn(o,flags.get(flag)),'invalid_cli_arguments');o[flags.get(flag)]=argv.shift();}need(['candidate','archive','source','evidenceRoot','evidenceIndex','reportDir','output'].every(k=>Object.hasOwn(o,k)),'missing_cli_arguments');return o;}
async function main(){
 if(process.argv.length===3&&process.argv[2]==='--help'){process.stdout.write(HELP);return;}
 const o=options(process.argv.slice(2)),dir=await cleanPath(o.reportDir),st=await lstat(dir);need(st.isDirectory()&&st.uid===process.getuid()&&(st.mode&0o077)===0,'output_private_owned_directory_required');need(typeof o.output==='string'&&!o.output.split(/[\\/]/).includes('..'),'unsafe_output_path');const name=relative(path.basename(o.output)),parent=await cleanPath(path.dirname(path.resolve(o.output)));need(parent===dir,'output_must_be_direct_child');const output=path.join(parent,name);
 for(const p of [o.source,o.evidenceRoot,o.candidate,o.archive,o.evidenceIndex])need(!overlaps(dir,await cleanPath(p)),'output_overlaps_input');
 const report=await verifyPortableCandidate(o);need(await cleanPath(dir)===dir&&same(st,await lstat(dir)),'output_directory_changed');let h;try{h=await open(output,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch{throw new EvidenceError('output_unavailable');}try{await h.writeFile(JSON.stringify(report,null,2)+'\n');}finally{await h.close();}process.stdout.write('portable-evidence: integrity_verified; readiness_pending\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{process.stderr.write('portable-evidence: '+(error instanceof EvidenceError?error.code:'input_or_output_unavailable')+'\n');process.exitCode=2;});
