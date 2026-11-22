import {constants} from 'node:fs';
import {lstat,open,realpath,link,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const SUPPORT_BUNDLE_LIMITS=Object.freeze({
 viewerCalls:2,viewerTimeoutMs:2400,deadlineMs:10000,events:100,rows:500,goals:100,
 metadataBytes:64*1024,connectionBytes:8192,viewerReplyBytes:8*1024*1024,outputBytes:256*1024
});
const L=SUPPORT_BUNDLE_LIMITS;
const windows=process.platform==='win32'?await import('./windows-support.mjs'):null;
const hosts=['codex','claude-code','cursor','antigravity'];
const taskStates=['queued','codex_ready','suspended','running','uncertain','codex_active','awaiting_supervisor','awaiting_user','awaiting_review','awaiting_legacy_review','legacy_reviewing','blocked','ready_to_integrate','accepted','failed','partial','cancelled'];
const eventTypes=new Set([
 'goal.prepared','goal.activated','goal.finalized','task.submitted','task.claimed','task.result',
 'task.question','task.answered','task.reviewed','task.integrated','task.native_started','task.native_finished',
 'task.native_released','task.taken_over','agent.registered','agent.reported','help.linked',
 'model.request.started','model.request.resolved','model.request.completed','model.request.failed',
 'coding.edit.proposed','coding.edit.applied','coding.checks.started','coding.checks.passed','coding.checks.failed',
 'coding.candidate.saved','coding.files.read','coding.context.refreshed','coding.context.evicted','coding.question',
 'execution.yield','task.blocked','task.uncertain','work.control','request.reserved','request.saved'
]);
const diagnosticCodes=new Set([
 'LOCAL_HOME_UNAVAILABLE','LOCAL_FILE_UNSAFE','LOCAL_FILE_TOO_LARGE','LOCAL_FILE_CHANGED','LOCAL_JSON_INVALID',
 'SETTINGS_ABSENT','SETTINGS_INVALID','INSTALLATION_ABSENT','INSTALLATION_INVALID','SETUP_RECEIPT_ABSENT','SETUP_RECEIPT_INVALID',
 'VIEWER_ABSENT','VIEWER_CONNECTION_UNSAFE','VIEWER_UNAVAILABLE','VIEWER_TIMEOUT','SNAPSHOT_INVALID','TIMELINE_INVALID',
 'ROW_LIMIT','GOAL_LIMIT','EVENT_LIMIT','STALE_AGENT_REPORTS','NATIVE_USAGE_UNKNOWN','USAGE_INVALID',
 'COLLECTION_DEADLINE','COLLECTOR_FAILED'
]);
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const choice=(value,values)=>values.includes(value)?value:'unknown';
const integer=(value,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=0&&value<=max?value:null;
const bool=value=>typeof value==='boolean'?value:null;
const shaPresent=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const add=(hist,key)=>{hist[key]=(hist[key]??0)+1;};
const error=code=>Object.assign(Error(code),{supportCode:code});
function absolute(value){return typeof value==='string'&&value.length<=4096&&path.isAbsolute(value)&&path.resolve(value)===value&&!/[\x00-\x1f\x7f]/u.test(value);}
function limit(value,max){if(value===undefined)return max;if(!Number.isSafeInteger(value)||value<1||value>max)throw error('INVALID_LIMIT');return value;}
function emptyBundle(){
 return {schemaVersion:1,kind:'mosaic-redacted-support',scope:'beta-explicit-home',
  collection:{status:'unavailable',viewerCalls:0},limits:{...L},local:{settings:{state:'absent'},installation:{state:'absent'},setup:{state:'absent'},legacyBinding:{state:'absent'}},
  snapshot:{state:'unavailable'},timeline:{state:'unavailable'},
  usage:{nativeTokens:null,nativeAccounting:'unavailable',reportedTokens:null,tasksWithReportedTokens:0,tasksWithUnknownTokens:0},diagnostics:['NATIVE_USAGE_UNKNOWN']};
}
function diagnostic(bundle,code){if(diagnosticCodes.has(code)&&!bundle.diagnostics.includes(code))bundle.diagnostics.push(code);}
function localFailure(bundle,cause){diagnostic(bundle,diagnosticCodes.has(cause?.supportCode)?cause.supportCode:'LOCAL_FILE_UNSAFE');}

async function stat(file){try{return await lstat(file);}catch(cause){if(cause.code==='ENOENT')return null;throw cause;}}
const inside=(parent,file)=>file===parent||file.startsWith(parent+path.sep);
// Check each component rather than letting realpath silently accept an alias.
async function directories(directory,{home,privateRoot}={}){
 if(windows)return windows.supportDirectory(directory,{home,privateRoot});
 let current=path.parse(directory).root;
 for(const part of directory.slice(current.length).split(path.sep).filter(Boolean)){
  current=path.join(current,part);const info=await stat(current);
  if(!info)return false;
  if(!info.isDirectory()||info.isSymbolicLink()||current===home&&info.uid!==process.getuid()||
     privateRoot&&inside(privateRoot,current)&&(info.uid!==process.getuid()||info.mode&0o077))throw error('LOCAL_FILE_UNSAFE');
 }
 return true;
}
function safeFile(info,max){
 if(!info?.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||info.mode&0o077)throw error('LOCAL_FILE_UNSAFE');
 if(info.size>max)throw error('LOCAL_FILE_TOO_LARGE');
}
function same(a,b){return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;}
async function metadata(paths,name){
 const file=path.join(paths.configDir,name),guards={home:paths.home,privateRoot:paths.root};
 if(!await directories(path.dirname(file),guards))return null;
 if(windows)return windows.supportMetadata(file,L.metadataBytes);
 const named=await stat(file);if(!named)return null;safeFile(named,L.metadataBytes);
 let handle;
 try{
  handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const before=await handle.stat();safeFile(before,L.metadataBytes);if(!same(before,named))throw error('LOCAL_FILE_CHANGED');
  const buffer=Buffer.alloc(L.metadataBytes+1);let bytes=0;
  while(bytes<buffer.length){const read=await handle.read(buffer,bytes,buffer.length-bytes,bytes);if(!read.bytesRead)break;bytes+=read.bytesRead;}
  if(bytes>L.metadataBytes)throw error('LOCAL_FILE_TOO_LARGE');
  const after=await handle.stat(),now=await stat(file);safeFile(after,L.metadataBytes);
  if(!now||!same(before,after)||!same(before,now)||!await directories(path.dirname(file),guards))throw error('LOCAL_FILE_CHANGED');
  let value;try{value=JSON.parse(buffer.subarray(0,bytes).toString('utf8'));}catch{throw error('LOCAL_JSON_INVALID');}
  if(!object(value))throw error('LOCAL_JSON_INVALID');return value;
 }finally{await handle?.close();}
}
async function localMetadata(paths,bundle){
 const specs=[
  ['settings','settings.json','SETTINGS',raw=>{
   if(![1,2].includes(raw.schema))throw error('SETTINGS_INVALID');
   return {schema:raw.schema,host:choice(raw.host?.id,hosts),providerCount:Array.isArray(raw.providers)&&raw.providers.length<=16?raw.providers.length:null,
    capacityGroupCount:Array.isArray(raw.capacityGroups)&&raw.capacityGroups.length<=16?raw.capacityGroups.length:null,
    serviceConcurrency:integer(raw.serviceMaxConcurrentTasks,4)||null,
    executionBackend:choice((raw.execution??raw.executionPolicy)?.backend,['darwin-seatbelt','codex-sandbox','windows-appcontainer']),
    executionRevision:choice((raw.execution??raw.executionPolicy)?.backendRevision,[1,2]),reviewSource:choice(raw.defaults?.review?.source,['host','api'])};
  }],
  ['installation','installation.json','INSTALLATION',raw=>{
   if(raw.schema!==1||typeof raw.version!=='string'||!/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-beta\.\d{1,6})?$/.test(raw.version))throw error('INSTALLATION_INVALID');
   return {schema:1,version:raw.version,contentSha256Present:shaPresent(raw.contentHash),launcherSha256Present:shaPresent(raw.launcherHash)};
  }],
  ['setup','portable-binding.json','SETUP_RECEIPT',raw=>{
   if(raw.schema!==1||typeof raw.complete!=='boolean')throw error('SETUP_RECEIPT_INVALID');
   return {schema:1,complete:raw.complete,manualHost:bool(raw.manualHost),host:choice(raw.hostId,hosts)};
  }],
  ['legacyBinding','bindings.json','SETUP_RECEIPT',raw=>{
   if(raw.schema!==1||typeof raw.complete!=='boolean')throw error('SETUP_RECEIPT_INVALID');
   return {schema:1,complete:raw.complete};
  }]
 ];
 for(const [key,name,prefix,project] of specs){
  try{const value=await metadata(paths,name);if(value)bundle.local[key]={state:'reported',...project(value)};else diagnostic(bundle,prefix+'_ABSENT');}
  catch(cause){bundle.local[key]={state:'invalid'};localFailure(bundle,cause);}
 }
}
function snapshotProjection(raw,bundle){
 if(!object(raw)||raw.version!==1||!Array.isArray(raw.goals)||!Array.isArray(raw.tasks)||!Array.isArray(raw.agents)){diagnostic(bundle,'SNAPSHOT_INVALID');return;}
 const goals={processed:0,byStatus:{},byMode:{}},tasks={processed:0,byStatus:{},byActor:{}},agents={processed:0,byActor:{},byRole:{},stale:0,stalenessUnknown:0};
 for(let i=0;i<Math.min(raw.goals.length,L.goals);i++){
  const row=raw.goals[i];goals.processed++;
  add(goals.byStatus,choice(row?.status,['draft','active','completed','accepted','failed','partial','cancelled','blocked']));
  add(goals.byMode,choice(row?.mode,['collaborative','deepseek_only','codex_only','overnight_review']));
 }
 for(let i=0;i<Math.min(raw.tasks.length,L.rows);i++){
  const row=raw.tasks[i],actor=choice(row?.actor,['codex','deepseek']);tasks.processed++;
  add(tasks.byStatus,choice(row?.status,taskStates));add(tasks.byActor,actor);
  // Host accounting is unavailable even when a server supplies a numeric zero.
  const tokens=actor==='deepseek'?integer(row?.usage?.reportedTokens):null;
  if(tokens===null){bundle.usage.tasksWithUnknownTokens++;continue;}
  const total=(bundle.usage.reportedTokens??0)+tokens;
  // A known subtotal can coexist with requests whose usage was unavailable.
  if(row?.usage?.usageUnavailable!==0||!Number.isSafeInteger(total))bundle.usage.tasksWithUnknownTokens++;
  if(!Number.isSafeInteger(total)){diagnostic(bundle,'USAGE_INVALID');continue;}
  bundle.usage.reportedTokens=total;bundle.usage.tasksWithReportedTokens++;
 }
 for(let i=0;i<Math.min(raw.agents.length,L.rows-tasks.processed);i++){
  const row=raw.agents[i];agents.processed++;
  add(agents.byActor,choice(row?.actor,['codex','deepseek']));
  add(agents.byRole,choice(row?.role,['implementer','reviewer','helper','planner','consultant']));
  if(row?.stale===true)agents.stale++;else if(row?.stale!==false)agents.stalenessUnknown++;
 }
 if(raw.tasks.length+raw.agents.length>L.rows||raw.overflow?.tasks===true)diagnostic(bundle,'ROW_LIMIT');
 if(raw.goals.length>L.goals)diagnostic(bundle,'GOAL_LIMIT');
 if(agents.stale)diagnostic(bundle,'STALE_AGENT_REPORTS');
 bundle.snapshot={state:'reported',goals,tasks,agents};
}
function timelineProjection(raw,bundle){
 if(!object(raw)||!Array.isArray(raw.events)){diagnostic(bundle,'TIMELINE_INVALID');return;}
 const timeline={state:'reported',processed:0,byType:{}};
 for(let i=0;i<Math.min(raw.events.length,L.events);i++){
  const type=raw.events[i]?.type;add(timeline.byType,eventTypes.has(type)?type:'unknown');timeline.processed++;
 }
 if(raw.events.length>L.events)diagnostic(bundle,'EVENT_LIMIT');bundle.timeline=timeline;
}
async function request(invoke,name,input,ms){
 const controller=new AbortController();let timer;
 try{return await Promise.race([
  Promise.resolve().then(()=>invoke(name,input,controller.signal)),
  new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(error('VIEWER_TIMEOUT'));},ms);})
 ]);}finally{clearTimeout(timer);controller.abort();}
}
async function collectDirect(home,{invoke,viewerTimeoutMs,deadlineMs}){
 const start=performance.now(),bundle=emptyBundle();
 // Dynamic import keeps the parent CLI free from the beta SQLite import/warning.
 const {locations}=await import('./files.mjs');const paths=locations(home,true);
 try{if(!await directories(home,{home})){diagnostic(bundle,'LOCAL_HOME_UNAVAILABLE');return bundle;}}
 catch{diagnostic(bundle,'LOCAL_HOME_UNAVAILABLE');return bundle;}
 await localMetadata(paths,bundle);
 if(!invoke){
  try{
   if(!await directories(paths.state,{home,privateRoot:paths.root})){diagnostic(bundle,'VIEWER_ABSENT');return bundle;}
   const file=path.join(paths.state,'viewer-connection.json');
   // Token bytes are read only by the private viewer client.
   if(windows){
    if(!await windows.supportViewerFile(file,L.connectionBytes)){diagnostic(bundle,'VIEWER_ABSENT');return bundle;}
   }else{
    const connection=await stat(file);
    if(!connection){diagnostic(bundle,'VIEWER_ABSENT');return bundle;}
    safeFile(connection,L.connectionBytes);
   }
  }catch{diagnostic(bundle,'VIEWER_CONNECTION_UNSAFE');return bundle;}
  const {client}=await import('./client.mjs');invoke=client(paths,{viewer:true,timeoutMs:viewerTimeoutMs});
 }
 for(const [name,input,project] of [['observer_snapshot',{},snapshotProjection],['observer_timeline',{recent:true,limit:L.events},timelineProjection]]){
  const remaining=deadlineMs-(performance.now()-start);
  if(remaining<=0){diagnostic(bundle,'COLLECTION_DEADLINE');break;}
  bundle.collection.viewerCalls++;
  try{project(await request(invoke,name,input,Math.min(viewerTimeoutMs,remaining)),bundle);}
  catch(cause){diagnostic(bundle,cause?.supportCode==='VIEWER_TIMEOUT'?'VIEWER_TIMEOUT':'VIEWER_UNAVAILABLE');}
 }
 const states=[bundle.snapshot.state,bundle.timeline.state];
 bundle.collection.status=states.every(x=>x==='reported')?'available':states.includes('reported')?'partial':'unavailable';
 return bundle;
}

// A parent deadline also covers private connection reads in the unchanged client.
// No detached process, service, provider probe, or mutable database is started.
function collectInChild(home,options){
 return new Promise(resolve=>{
  let result,timedOut=false,child;
  try{child=fork(fileURLToPath(import.meta.url),['--collect-worker'],{execArgv:[],stdio:['ignore','ignore','ignore','ipc'],serialization:'json'});}
  catch{const bundle=emptyBundle();diagnostic(bundle,'COLLECTOR_FAILED');resolve(bundle);return;}
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},options.deadlineMs);
  child.on('error',()=>{});
  child.on('message',message=>{if(message?.schemaVersion===1&&Buffer.byteLength(JSON.stringify(message))<=L.outputBytes)result=message;});
  child.on('close',()=>{
   clearTimeout(timer);
   if(timedOut||!result){result=emptyBundle();diagnostic(result,timedOut?'COLLECTION_DEADLINE':'COLLECTOR_FAILED');}
   resolve(result);
  });
  child.send({home,...options},()=>{});
 });
}

/** Fixture invoke is trusted: it replaces connection access and must be read-only. */
export async function collectSupportBundle({home}={},options={}){
 if(!absolute(home))throw error('INVALID_HOME');
 const controls={viewerTimeoutMs:limit(options.viewerTimeoutMs,L.viewerTimeoutMs),deadlineMs:limit(options.deadlineMs,L.deadlineMs)};
 if(options.invoke!==undefined){if(typeof options.invoke!=='function')throw error('INVALID_TRANSPORT');return collectDirect(home,{...controls,invoke:options.invoke});}
 return collectInChild(home,controls);
}
export function formatSupportBundle(bundle){
 const bytes=JSON.stringify(bundle,null,2)+'\n';
 if(Buffer.byteLength(bytes)>L.outputBytes)throw error('OUTPUT_TOO_LARGE');return bytes;
}
async function writeBundle(file,bytes){
 if(windows)return windows.writeSupportBundle(file,bytes);
 const directory=path.dirname(file);let temp;
 try{
  if(!await directories(directory))throw error('OUTPUT_UNSAFE');
  const parent=await lstat(directory);
  if(parent.uid!==process.getuid()||parent.mode&0o077||await realpath(directory)!==directory)throw error('OUTPUT_UNSAFE');
  if(await stat(file))throw error('OUTPUT_EXISTS');
  const candidate=path.join(directory,'.mosaic-support-'+randomUUID());
  const handle=await open(candidate,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  temp=candidate; // Cleanup authority starts only after successful exclusive creation.
  try{await handle.chmod(0o600);await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  const current=await lstat(directory);
  if(!await directories(directory)||parent.dev!==current.dev||parent.ino!==current.ino||current.uid!==process.getuid()||current.mode&0o077)throw error('OUTPUT_UNSAFE');
  // link is atomic and fails on every pre-existing destination, including symlinks.
  await link(temp,file);
 }catch(cause){throw error(cause.supportCode==='OUTPUT_EXISTS'||cause.code==='EEXIST'?'OUTPUT_EXISTS':'OUTPUT_UNSAFE');}
 finally{if(temp)await unlink(temp).catch(()=>{});}
}
function parseArgs(argv){
 const result={};
 for(let i=0;i<argv.length;i+=2){
  const key=argv[i]==='--home'?'home':argv[i]==='--output'?'output':null;
  if(!key||result[key]!==undefined||!absolute(argv[i+1]))throw error('USAGE');result[key]=argv[i+1];
 }
 if(!result.home)throw error('USAGE');return result;
}
const print=(stream,bytes)=>new Promise((resolve,reject)=>{
 let settled=false;
 const failure=()=>{if(!settled){settled=true;reject(error('STREAM_FAILED'));}};
 // Writable emits 'error' as well as invoking its callback. Retain this one-shot
 // listener after a failed callback to consume the subsequent error event.
 stream.once('error',failure);
 try{stream.write(bytes,cause=>{
  if(cause){failure();return;}
  if(!settled){settled=true;stream.removeListener('error',failure);resolve();}
 });}catch{failure();}
});
async function report(stream,code){try{await print(stream,code+'\n');}catch{/* A broken diagnostic stream must also remain contained. */}}
export async function runSupportBundle(argv,{stdout=process.stdout,stderr=process.stderr}={}){
 let args;
 try{args=parseArgs(argv);}catch{await report(stderr,'USAGE: --home ABS [--output ABS]');return 2;}
 try{
  const bundle=await collectSupportBundle({home:args.home}),bytes=formatSupportBundle(bundle);
  await print(stdout,bytes);
  if(args.output){try{await writeBundle(args.output,bytes);}catch(cause){await report(stderr,cause.supportCode==='OUTPUT_EXISTS'?'OUTPUT_EXISTS':'OUTPUT_UNSAFE');return 2;}}
  return 0;
 }catch{await report(stderr,'SUPPORT_BUNDLE_FAILED');return 1;}
}

if(process.argv[1]===fileURLToPath(import.meta.url)&&process.argv[2]==='--collect-worker'&&process.send){
 process.once('message',async message=>{
  let bundle;
  try{
   if(!absolute(message?.home))throw error('INVALID_HOME');
   bundle=await collectDirect(message.home,{viewerTimeoutMs:limit(message.viewerTimeoutMs,L.viewerTimeoutMs),deadlineMs:limit(message.deadlineMs,L.deadlineMs)});
  }catch{bundle=emptyBundle();diagnostic(bundle,'COLLECTOR_FAILED');}
  process.send(bundle,()=>process.disconnect());
 });
}
