import {capacitySnapshot,canClaim,CapacityWaitError} from './scheduling/capacity.mjs';
import {validateQuiescenceReceipt} from '../project/check-backends/native-supervisor.mjs';
import {randomUUID} from 'node:crypto';
import {mkdirSync,lstatSync,readFileSync,realpathSync,constants,openSync,closeSync,fstatSync} from 'node:fs';
import path from 'node:path';
import {controlBinding,integrationBinding} from './owner-inbox.mjs';
import {execFileSync} from 'node:child_process';
import {digest} from './contracts.mjs';
import {digest as bindingDigest,Pause} from '../project/contracts.mjs';
const held=row=>row.status!=='quiescent';
const positive=value=>Number.isSafeInteger(value)&&value>0;
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function executionBootId(){
 try{if(process.platform==='darwin'){const id=execFileSync('/usr/sbin/sysctl',['-n','kern.bootsessionuuid'],{encoding:'utf8',timeout:2000,stdio:['ignore','pipe','ignore']}).trim();return /^[a-f0-9-]{36}$/i.test(id)?'darwin:'+id.toLowerCase():null;}if(process.platform==='linux'){const id=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();return /^[a-f0-9-]{36}$/i.test(id)?'linux:'+id:null;}}catch{}return null;
}
export function executionHolds(c,{goalId,taskId}={}){return c.store.all('execution_owner').filter(row=>held(row)&&(!goalId||row.goalId===goalId)&&(!taskId||row.taskId===taskId));}
function unknown(message){const error=new Pause(message,'isolation');error.executionOutcome='unknown';return error;}
function privateDirectory(dir){mkdirSync(dir,{recursive:true,mode:0o700});const s=lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||s.mode&0o077||s.uid!==process.getuid?.()||realpathSync(dir)!==dir)throw Error('Unsafe private native execution directory');}
function receiptFile(row){
 const directory=path.dirname(row.receiptPath);const d=lstatSync(directory);if(!d.isDirectory()||d.isSymbolicLink()||d.mode&0o077||d.uid!==process.getuid?.()||realpathSync(directory)!==directory)throw Error('Unsafe native completion receipt directory');
 const fd=openSync(row.receiptPath,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=fstatSync(fd);if(!s.isFile()||s.size>32768||s.mode&0o077||s.uid!==process.getuid?.())throw Error('Unsafe native completion receipt');return JSON.parse(readFileSync(fd,'utf8'));}finally{closeSync(fd);}
}
function exactReceipt(row,receipt){
 return validateQuiescenceReceipt(receipt,{requestId:row.id,bindingHash:row.bindingHash,helperPid:row.helperPid,leaderPid:row.leaderPid});
}
function adoptStartupIdentity(row,receipt){
 if(row.helperPid===null&&row.leaderPid===null&&!Object.hasOwn(row,'preparedAt')&&['startup-cancel','control-eof'].includes(receipt?.reason)&&row.binding?.runtimeFingerprint===row.runtimeFingerprint&&hex(row.runtimeFingerprint)){
  if(!positive(receipt.helperPid)||!positive(receipt.leaderPid)||receipt.helperPid===receipt.leaderPid)throw unknown('Invalid private startup process identity');
  const physical={...row,helperPid:receipt.helperPid,leaderPid:receipt.leaderPid};exactReceipt(physical,receipt);row.helperPid=physical.helperPid;row.leaderPid=physical.leaderPid;row.physicalIdentitySource='private-startup-receipt';
 }else exactReceipt(row,receipt);
}
export function executionApproval(c,{goalId,revisionId},{ignoreRequestId}={}){
 const goal=c.store.get('goal',goalId);if(!revisionId)return goal;
 const revision=c.store.get('goal_revision',revisionId);
 if(goal.deadline!=null&&c.now()>=goal.deadline)throw Error('Native revision goal deadline exceeded before preflight');
 if(!['draft','active'].includes(goal.status))throw Error('Native revision goal control changed before preflight');
 if(revision.goalId!==goalId||revision.status!=='draft'||revision.previousHash!==goal.hash||revision.version!==goal.version+1||digest(revision.manifest)!==revision.hash||['completed','partial'].includes(goal.status))throw Error('Native preflight draft revision identity changed or became stale');
 if(goal.integrationOwner||goal.integrationPending||c.store.all('task').some(t=>t.goalId===goalId&&(t.owner||t.native?.writerActive||['running','uncertain','taking_over','codex_active','legacy_reviewing'].includes(t.status)))||['running','uncertain'].includes(c.store.maybe('planning',goalId)?.status)||executionHolds(c,{goalId}).some(row=>row.id!==ignoreRequestId))throw Error('Native revision preflight requires verified quiescent owners');
 return {...goal,hash:revision.hash,manifest:revision.manifest,version:revision.version,status:'draft',revisionId,previousHash:revision.previousHash};
}
function taskAuthority(t){return {status:t.status,owner:t.owner??null,runnerGeneration:t.runnerGeneration??null,attempts:t.attempts,reviews:t.reviews,executionActor:t.executionActor??null,checkpoint:{phase:t.checkpoint?.phase??null,attempt:t.checkpoint?.attempt??null,executionBase:t.checkpoint?.executionBase??null,permissionsHash:t.checkpoint?.permissionsHash??null},native:t.native?{generationId:t.native.generationId??t.id,round:t.native.round??null,writerActive:t.native.writerActive??null,status:t.native.status??null,worktree:t.native.worktree??null,commit:t.native.commit??null}:null,resultHash:['awaiting_review','ready_to_integrate','awaiting_legacy_review','legacy_reviewing'].includes(t.status)?digest(t.result??null):null};}
function nativeIntegrationBinding(goal,task) {
 if(task?.executionActor!=='codex'||task.native?.layout!=='candidate_v1'||task.native.writerActive!==false||
    task.native.status!=='awaiting_review'||!task.native.commit||task.owner||!task.result||
    task.goalId!==goal.id||task.goalVersion!==goal.version||task.spec.kind!=='coding')return null;
 if(task.status==='ready_to_integrate'||goal.manifest.reviewPolicy)return integrationBinding(goal,task);
 // The original operator workflow reviews and accepts a finished candidate in one operation.
 if(task.status!=='awaiting_review'||goal.manifest.mode.review!=='operator')return null;
 return digest({goalHash:goal.hash,taskId:task.id,taskHash:task.hash,native:task.native,result:task.result});
}
function assertResumeProbe(c,goal,context,binding){
 if(!hex(context.resumeBinding)||context.taskId||context.revisionId||!/^native-preflight:[a-f0-9]{64}$/.test(context.operationKey)||
    binding.argv.length!==3||binding.argv[1]!=='-e'||!['paused','stopped'].includes(goal.status)||
    c.now()>=goal.deadline||controlBinding(c.store,goal)!==context.resumeBinding)
  throw Error('Native resume probe no longer matches the approved control state');
}
export class ExecutionOwnership{
 constructor(c,{bootId=executionBootId()}={}){this.c=c;this.bootId=bootId;this.lastScan=-Infinity;}
 holds(input={}){return executionHolds(this.c,input);}
 assertClear({goalId,taskId,workspaceRoot}={}){if(this.holds().some(row=>(row.goalId===goalId&&(!taskId||!row.taskId||row.taskId===taskId))||(workspaceRoot&&row.workspaceRoot===workspaceRoot)))throw unknown('Native execution ownership remains held; verify exact quiescence before reuse');}
 forContext(context){const self=this;return Object.freeze({begin(binding){return self.begin(context,binding);}});}
 begin(context,binding){
 const c=this.c,g=executionApproval(c,context),t=context.taskId?c.store.get('task',context.taskId):null;
 if(t&&t.goalId!==g.id||!context.operationKey||typeof context.operationKey!=='string'||context.operationKey.length>500||!context.workspaceRoot||realpathSync(binding.cwd)!==realpathSync(context.workspaceRoot))throw Error('Exact native execution context required');
 const {bindingHash,...raw}=binding;if(!hex(bindingHash)||bindingDigest(raw)!==bindingHash||raw.schema!==1||raw.backend?.id!=='darwin-seatbelt'||raw.backend.revision!==2||!hex(binding.dependencyInventoryHash)||binding.dependencyInventoryHash!==context.expectedDependencyHash||g.manifest.executionPolicy?.backendRevision!==2||g.manifest.executionPolicy?.backend!=='darwin-seatbelt'||g.manifest.executionPolicy.runtimeFingerprint!==binding.runtimeFingerprint||!['profileHash','inputInventoryHash','runtimeFingerprint','runtimeHash','supervisorHash'].every(key=>hex(binding[key]))||!Array.isArray(binding.argv)||!binding.argv.length)throw Error('Native execution binding differs from approved identity');
 c.verifyCurrentWorker?.();this.assertClear(context);
 if(context.resumeBinding)assertResumeProbe(c,g,context,binding);
 // A resume probe uses a new scratch checkout and does not write to the
 // stopped candidate. Keep normal process capacity and execution holds.
 const snapshot=capacitySnapshot(c),admissionTask=t??{id:'preflight:'+g.id,goalId:g.id,spec:{kind:context.resumeBinding?'maintenance':'coding',permissions:{writePaths:g.manifest.project?.writePaths??[]}}};const wait=canClaim({task:admissionTask,goal:g,snapshot:{...snapshot,activeTasks:snapshot.activeTasks.filter(task=>task.id!==t?.id)}});if(!wait.allowed)throw new CapacityWaitError(wait);
 const candidateBinding=context.integrationCandidate?nativeIntegrationBinding(g,context.integrationCandidate):null;
 if(context.integrationCandidate&&(!candidateBinding||nativeIntegrationBinding(g,t)!==candidateBinding))throw Error('Native integration candidate identity changed before reservation');
 const requestId=randomUUID(),parent=path.join(realpathSync(c.store.root),'execution-owners');privateDirectory(parent);const dir=path.join(parent,requestId);privateDirectory(dir);
 const row={id:requestId,schema:1,status:'starting',goalId:g.id,goalHash:g.hash,goalVersion:g.version,...(g.revisionId?{revisionId:g.revisionId,previousHash:g.previousHash}:{}),taskId:t?.id??null,taskHash:t?.hash??null,taskAuthority:t?taskAuthority(t):null,attempt:t?.attempts??null,taskOwner:t?.owner??null,runnerGeneration:t?.runnerGeneration??null,nativeWriter:!candidateBinding&&t?.executionActor==='codex'?{generationId:t.native?.generationId??t.id,round:t.native?.round??null,worktree:t.native?.worktree??null}:null,operationKey:context.operationKey,operationId:context.operationId??null,workspaceRoot:realpathSync(context.workspaceRoot),repository:g.manifest.project?.repo??null,writePaths:t?.spec.permissions?.writePaths??g.manifest.project?.writePaths??[],binding,bindingHash,runtimeFingerprint:binding.runtimeFingerprint,bootId:this.bootId,ownerLease:c.workerLease?.generation??null,helperPid:null,leaderPid:null,receiptPath:path.join(dir,'completion.json'),createdAt:c.now(),priorTaskStatus:t?.status??null};
 if(candidateBinding)row.integrationCandidateBinding=candidateBinding;
 if(context.resumeBinding)row.resumeBinding=context.resumeBinding;
 c.store.tx(()=>{this.assertClear(context);c.store.put('execution_owner',row);c.emit('execution.reserved',g.id,t?.id??null,{requestId,bindingHash});});
 return Object.freeze({requestId,receiptPath:row.receiptPath,prepared:event=>this.prepared(requestId,event),authorizeGo:()=>this.authorizeGo(requestId),complete:receipt=>this.complete(requestId,receipt),uncertain:reason=>this.uncertain(requestId,reason)});
 }
 prepared(id,event){const c=this.c;const row=c.store.tx(()=>{const current=c.store.get('execution_owner',id);
 if(event?.schema!==1||event.type!=='prepared'||event.requestId!==id||event.bindingHash!==current.bindingHash||!positive(event.helperPid)||!positive(event.leaderPid)||current.status!=='starting')throw unknown('Native helper preparation identity changed');
 current.helperPid=event.helperPid;current.leaderPid=event.leaderPid;current.status='running';current.preparedAt=c.now();c.store.put('execution_owner',current);c.emit('execution.prepared',current.goalId,current.taskId,{requestId:id,helperPid:current.helperPid,leaderPid:current.leaderPid});return current;});
 // Persist physical ownership before the final authority check. If it rejects,
 // the helper cancels without GO and its exact cleanup receipt remains usable.
 return this.authorizeGo(id);
 }
 authorizeGo(id){const c=this.c,row=c.store.get('execution_owner',id);try{
  if(row.status!=='running'||!positive(row.helperPid)||!positive(row.leaderPid))throw unknown('Native physical execution ownership changed before GO');
  const g=executionApproval(c,row,{ignoreRequestId:id}),t=row.taskId?c.store.get('task',row.taskId):null;
  if(g.hash!==row.goalHash||g.version!==row.goalVersion||t&&(digest(taskAuthority(t))!==digest(row.taskAuthority)||t.status!==row.priorTaskStatus||t.hash!==row.taskHash||t.goalVersion!==g.version||t.attempts!==row.attempt||t.owner!==row.taskOwner||(t.runnerGeneration??null)!==row.runnerGeneration))throw unknown('Native execution approval or task ownership identity changed');
  if(row.resumeBinding)assertResumeProbe(c,g,row,row.binding);
  else if(!['draft','active'].includes(g.status))throw unknown('Native goal control changed before helper GO');
  if(g.status==='active')c.liveGoal(g);if(t)c.liveTask(t);
  const savedLease=c.store.maybe('lease','coordinator');if((c.workerLease?.generation??null)!==row.ownerLease||(savedLease?.generation??null)!==row.ownerLease)throw unknown('Native worker lease ownership changed before GO');
  if(row.ownerLease)c.currentLease(c.workerLease.token);if(row.taskOwner)c.owned(t.id,row.taskOwner);
  if(row.integrationCandidateBinding&&nativeIntegrationBinding(g,t)!==row.integrationCandidateBinding)throw unknown('Native integration candidate identity changed before GO');
  if(row.nativeWriter&&(!t.native||t.executionActor!=='codex'||t.status!=='codex_active'||t.native.writerActive===false||(t.native.generationId??t.id)!==row.nativeWriter.generationId||(t.native.round??null)!==row.nativeWriter.round||(t.native.worktree??null)!==row.nativeWriter.worktree))throw unknown('Native writer ownership changed before GO');
  c.verifyCurrentWorker?.();return row;
 }catch(error){this.uncertain(id,error);throw error;}
 }
 complete(id,receipt){const row=this.c.store.get('execution_owner',id);exactReceipt(row,receipt);const saved=receiptFile(row);exactReceipt(row,saved);if(digest(saved)!==digest(receipt))throw unknown('Durable native receipt differs from supervisor completion');return this.resolve(row,'receipt',saved);}
 resolve(row,resolution,receipt=null){const c=this.c;return c.store.tx(()=>{const current=c.store.get('execution_owner',row.id);if(!held(current))return current;if(resolution==='receipt')adoptStartupIdentity(current,receipt);else if(resolution==='new_boot'&&(!current.bootId||!this.bootId||current.bootId===this.bootId))throw Error('A positively changed boot identity is required');current.status='quiescent';current.resolution=resolution;current.receipt=receipt;current.finishedAt=c.now();c.store.put('execution_owner',current);if(current.operationId&&!executionHolds(c).some(row=>row.operationId===current.operationId)){const operation=c.store.maybe('operation',current.operationId);if(operation?.status==='uncertain'&&(current.operationKey===operation.key||current.operationKey==='effect-'+operation.key)){const {error,finishedAt,...saved}=operation;c.store.put('operation',{...saved,status:'retryable',quiescenceRequestId:current.id});}}if(current.taskId&&!executionHolds(c,{taskId:current.taskId}).length){const t=c.store.get('task',current.taskId),g=c.store.get('goal',current.goalId);if(!t.owner&&!t.native?.writerActive&&t.status==='uncertain'&&['ready_to_integrate','awaiting_review','awaiting_legacy_review','queued','suspended','codex_ready','stopped','paused','blocked'].includes(current.interruptedTaskStatus??current.priorTaskStatus)&&g.hash===current.goalHash&&t.hash===current.taskHash&&t.goalVersion===current.goalVersion){t.status=current.interruptedTaskStatus??current.priorTaskStatus;t.reason='Exact native quiescence proven; fresh protected verification still required';c.store.put('task',t);}}c.emit('execution.quiescent',current.goalId,current.taskId,{requestId:current.id,resolution});return current;});}
 uncertain(id,reason){const c=this.c;return c.store.tx(()=>{const row=c.store.get('execution_owner',id);if(!held(row)||row.status==='uncertain')return row;row.status='uncertain';row.reason=String(reason?.message??reason??'Native execution outcome unknown').slice(0,1000);c.store.put('execution_owner',row);
 if(row.taskId){const t=c.store.get('task',row.taskId);row.interruptedTaskStatus=t.status;c.store.put('execution_owner',row);t.reason=row.reason;if(!t.native?.writerActive)t.status='uncertain';c.store.put('task',t);}c.emit('execution.uncertain',row.goalId,row.taskId,{requestId:id,reason:row.reason});return row;});}
 reconcile({force=false}={}){const at=this.c.now();if(!force&&at-this.lastScan<5000)return [];this.lastScan=at;const resolved=[];for(const row of this.holds()){
 if(row.bootId&&this.bootId&&row.bootId!==this.bootId){resolved.push(this.resolve(row,'new_boot'));continue;}
 try{const receipt=receiptFile(row);resolved.push(this.resolve(row,'receipt',receipt));}catch{/* Neither time, liveness polling nor unreadable/forged receipts release ownership. */}
 }return resolved;}
}
