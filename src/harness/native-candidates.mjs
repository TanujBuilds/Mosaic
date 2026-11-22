import {executionHolds} from './execution-ownership.mjs';
import {executionFields,assertExecutionAvailable} from './execution.mjs';
import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { Agents } from './agents.mjs';
import { Journal } from '../project/journal.mjs';
import { Workspace } from '../project/workspace.mjs';
import { git } from '../project/process.mjs';
import { digest, text } from './contracts.mjs';
import {readBehavioralFileModes,behavioralModeHash} from './behavioral-validation.mjs';
import {capacitySnapshot,writeScopeWait} from './scheduling/capacity.mjs';
import { normalizeNativeCandidate } from './collaboration-contracts.mjs';

// The host confirms finish/release. Reported progress never proves quiescence.
export class NativeCandidates {
 constructor(integration){this.i=integration;this.c=integration.c;this.agents=new Agents({c:this.c,config:integration.config});}
 async open(task){
  if(task.native?.layout!=='candidate_v1')throw Error('Native candidate layout required');
  const journal=await new Journal(path.join(this.c.store.root,'native-candidates'),task.native.generationId??task.id).load();
  const manifest=task.native.manifest;
  if(digest(executionFields(manifest))!==digest(executionFields(this.c.store.get('goal',task.goalId).manifest)))throw Error('Native workspace execution backend differs from approved goal');
  const workspace=new Workspace(manifest,journal);
  // A distinct branch also prevents collision with this task's original coding journal.
  workspace.branch=`orchestrator/native-${task.id}${(task.native.generation??1)>1?`-g${task.native.generation}`:''}`;
  return {journal,workspace,manifest};
 }
 async start(taskId,extra={},registration=null){
  this.i.signal?.throwIfAborted();
  let t=this.c.getTask(taskId),g=this.c.store.get('goal',t.goalId);
  this.c.liveTask(t,{allowStopped:!!extra.takeoverReason});this.c.verifyCurrentWorker?.();assertExecutionAvailable(g.manifest,this.i.config);
  if(!g.manifest.mode.actors.includes('codex')||t.spec.kind!=='coding')throw Error('Mode prohibits native Codex execution');
  if(t.native&&t.native.layout!=='candidate_v1')throw Error('Existing native layout cannot be changed');
  if(t.owner||!['codex_ready','codex_active','stopped','blocked'].includes(t.status))throw Error('Worker must be quiescent before native execution');
  if(t.spec.actor!=='codex'&&!extra.takeoverReason&&!t.native)throw Error('Explicit takeover required for DeepSeek task');
  if(!t.spec.dependsOn.every(id=>this.c.getTask(id).status==='accepted'))throw Error('Dependencies are incomplete');
  if(t.native?.writerActive&&t.status!=='codex_active')throw Error('Existing native writer requires explicit host completion or release');
  if(t.native?.status==='partial'&&!t.native.needsGeneration)throw Error('Preserved partial candidate cannot restart without explicit rebind');
  if(t.native&&t.status==='blocked'&&t.native.status!=='generation_blocked')throw Error('Native revision budget exhausted');
  // The committed base is resolved once, never from a dirty source fallback.
  const fence=digest({status:t.status,goalVersion:t.goalVersion,hash:t.hash,native:t.native??null});
  const base=t.native?.needsGeneration?(t.native.needsGeneration.baseCommit??await this.i.executionBase(g.id)):(t.native?.baseCommit??await this.i.executionBase(g.id));
  const lifecycle=await new Journal(path.join(this.c.store.root,'native-lifecycle'),taskId).load(),unlockLifecycle=await lifecycle.lock();
  try{
  t=this.c.liveTask(t,{allowStopped:!!extra.takeoverReason});g=this.c.store.get('goal',t.goalId);
  this.c.verifyCurrentWorker?.();
  if(digest({status:t.status,goalVersion:t.goalVersion,hash:t.hash,native:t.native??null})!==fence)throw Error('Native start state changed while resolving its execution base');
  if(registration&&(registration.taskId!==t.id||registration.actor!=='codex'))throw Error('Native registration task/actor mismatch');
  const agentId=registration?this.agents.register(registration,`native-agent-${t.id}`).id:t.native?.agentId??this.agents.register({version:1,taskId:t.id,role:'implementer',actor:'codex'},`native-agent-${t.id}`).id;
  this.c.store.tx(()=>{
   this.c.verifyCurrentWorker?.();
   const current=this.c.liveTask(t,{allowStopped:!!extra.takeoverReason});
   const scopeWait=writeScopeWait({task:current,goal:g,snapshot:capacitySnapshot(this.c)});if(scopeWait)throw Error(scopeWait.explanation);
   if(current.owner||digest({status:current.status,goalVersion:current.goalVersion,hash:current.hash,native:current.native??null})!==fence)throw Error('Native start state changed before writer reservation');
   if(!current.native){
    const p=g.manifest.project,manifest={...executionFields(g.manifest),repo:p.repo,baseCommit:base,permissions:{readPaths:current.spec.permissions.readPaths,writePaths:current.spec.permissions.writePaths,checks:p.checks.filter(x=>current.spec.permissions.checks.includes(x.id))}};
    current.native={layout:'candidate_v1',agentId,generation:1,generationId:t.id,baseCommit:base,manifest,round:1,status:'starting',writerActive:true,...extra};
   }else if(current.native.needsGeneration){
    const intent=current.native.needsGeneration;if(intent.goalVersion!==g.version)throw Error('Native generation approval changed');
    current.native={layout:'candidate_v1',agentId,generation:intent.number,generationId:intent.id,baseCommit:base,manifest:{...executionFields(g.manifest),repo:g.manifest.project.repo,baseCommit:base,permissions:intent.permissions},round:current.native.round+1,status:'starting',writerActive:true,transfer:{...intent,baseCommit:base},workerWorktree:current.native.workerWorktree??null,workerSnapshot:current.native.workerSnapshot??null,workerManifest:current.native.workerManifest??null,workerJournalRoot:current.native.workerJournalRoot??null};
   }else if(current.native.status==='generation_blocked'){
    current.native.status='starting';current.native.writerActive=true;
   }else if(current.status==='codex_ready'){
    current.native.round++;current.native.status='starting';current.native.writerActive=true;
   }
   current.status='codex_active';current.executionActor='codex';current.stopRequested=false;current.startedAt??=this.c.now();current.deadline??=Math.min(g.deadline,current.startedAt+current.spec.limits.seconds*1000);
   this.c.store.put('task',current);
  });
  t=this.c.getTask(taskId);const target=await this.open(t),release=await target.journal.lock();
  try{
   if(!target.journal.last('harness.manifest'))await target.journal.append('harness.manifest',target.manifest);
   await target.workspace.initialize();
   // Replayed start cannot discard a writer's unreported edits.
   if(t.native.status==='starting')await target.workspace.recover();
   if(t.native.transfer)await this.transferGeneration(t,target);
   this.i.signal?.throwIfAborted();
   this.c.store.tx(()=>{
    this.c.verifyCurrentWorker?.();
    const current=this.c.liveTask(t);if(current.status!=='codex_active')throw Error('Native ownership changed');
    current.native={...current.native,worktree:target.workspace.root,branch:target.workspace.branch,status:'active'};
    this.c.store.put('task',current);this.c.learning.pin(t.id);this.c.emit('task.native_started',g.id,t.id,{layout:'candidate_v1',baseCommit:base,worktree:target.workspace.root});
   });
   return this.c.getTask(t.id);
  }catch(error){if(t.native.transfer){this.c.store.tx(()=>{const current=this.c.getTask(t.id);if(current.native.generationId===t.native.generationId&&current.native.status==='starting'){current.status='blocked';current.native.status='generation_blocked';current.native.writerActive=false;current.reason=error.message;this.c.store.put('task',current);}});}throw error;}finally{await release();}
  }finally{await unlockLifecycle();}
 }
 async transferGeneration(t,target){
  if(target.journal.last('generation.transferred'))return;
  const archived=t.native.transfer.from,source=await this.open({...t,native:archived.native}),release=await source.journal.lock();
  try{
   if(archived.result?.savedNative){const saved=archived.result.savedNative;if(!saved.initialized&&saved.initialized!==undefined)throw Error('Previous generation has no initialized checkout');if(digest(await source.workspace.snapshot())!==saved.snapshotHash||await git(source.workspace.root,'rev-parse','HEAD')!==saved.head)throw Error('Frozen generation partial changed');}
   else await source.workspace.recover();
   const changes=await this.i.changes(source.workspace,source.manifest.baseCommit,t.spec.permissions.writePaths),snapshot=await source.workspace.snapshot(),head=await git(source.workspace.root,'rev-parse','HEAD');
   const saved=target.journal.last('generation.source');if(saved&&(digest(saved.sourceSnapshot)!==digest(snapshot)||saved.head!==head))throw Error('Frozen generation source changed');
   if(!saved)await target.journal.append('generation.source',{taskId:t.id,sourceGeneration:archived.native.generation??1,head,sourceSnapshot:snapshot,changes});
   await this.i.applyChanges(target.workspace,changes,'generation-transfer',t.spec.permissions.writePaths);
   const sandbox=await this.i.checks(target.workspace,{goalId:t.goalId,taskId:t.id,operationKey:'native-transfer:'+t.id}).verify(this.i.signal);
   this.i.signal?.throwIfAborted();
   await target.journal.append('generation.transferred',{taskId:t.id,fromGeneration:archived.native.generation??1,generation:t.native.generation,baseCommit:t.native.baseCommit,sandbox,permissionsHash:digest(target.manifest.permissions),snapshot:await target.workspace.snapshot()});
  }finally{await release();}
 }
 async frozen(t){
  if(t.native.transfer){const target=await this.open(t),saved=target.journal.last('generation.source'),source=await this.open({...t,native:t.native.transfer.from.native}),release=await source.journal.lock();try{if(!saved||digest(await source.workspace.snapshot())!==digest(saved.sourceSnapshot)||await git(source.workspace.root,'rev-parse','HEAD')!==saved.head)throw Error('Frozen previous native generation changed');}finally{await release();}}
  if(!t.native.workerSnapshot)return;
  const source=t.native.workerManifest?await this.originalWorker(t):await this.i.candidate(t,{original:true}),release=await source.journal.lock();
  try{if(digest(await source.workspace.snapshot())!==digest(t.native.workerSnapshot))throw Error('Frozen worker checkout changed after takeover');}finally{await release();}
 }
 async originalWorker(t){const journal=await new Journal(t.native.workerJournalRoot,t.id).load(),manifest=t.native.workerManifest;return {journal,manifest,workspace:new Workspace(manifest,journal)};}
 assertWriter(t,status='codex_active',live=true){
  const current=live?this.c.liveTask(t):this.c.getTask(t.id);
  if(current.status!==status||!current.native?.writerActive||current.goalVersion!==t.goalVersion||current.hash!==t.hash||(current.native.generationId??current.id)!==(t.native.generationId??t.id)||current.native.round!==t.native.round)throw Error('Native generation or writer ownership changed');
  return current;
 }
 async finish(input){
  let t=this.c.getTask(input.taskId);const g=this.c.store.get('goal',t.goalId);text(input.summary,'summary');
  if(['awaiting_review','ready_to_integrate','accepted'].includes(t.status)&&!t.native.writerActive)return t;
  if(process.platform==='win32')assertExecutionAvailable(g.manifest,this.i.config);
  this.c.liveTask(t);if(t.status!=='codex_active'||!t.native.writerActive)throw Error('Native task ownership mismatch');
  const target=await this.open(t),release=await target.journal.lock();
  try{
   this.assertWriter(t);await this.frozen(t);
   const {workspace,journal}=target;
   // Validate the complete base diff before adopting any manual changes.
   const changes=await this.i.changes(workspace,t.native.baseCommit,t.spec.permissions.writePaths);
   // Also reject unexpected commits: manual file writes are allowed, arbitrary Git history is not.
   const expected=journal.last('stage.accepted')?.commit??t.native.baseCommit,head=await git(workspace.root,'rev-parse','HEAD');
   const stage=`native-${t.native.round}`;
   if(head!==expected){
    const pending=journal.events.some(e=>e.type==='operation.started'&&e.data.key===`${stage}/checkpoint`);
    if(!pending||await git(workspace.root,'log','-1','--format=%s')!==`Orchestrator ${journal.id} stage ${stage}`||await git(workspace.root,'rev-parse','HEAD^')!==expected)throw Error('Native candidate HEAD changed outside recorded checkpoints');
   }
   const snapshot=await workspace.snapshot(),reviewModes=g.manifest.reviewPolicy?await readBehavioralFileModes(workspace,Object.keys(snapshot)):null;await journal.append('native.adopted',{taskId:t.id,snapshot,round:t.native.round});
   if(reviewModes){const pinned=await journal.memo(`${stage}/review-input`,async()=>({snapshotHash:digest(snapshot),executableModesHash:behavioralModeHash(reviewModes)}));if(pinned.snapshotHash!==digest(snapshot)||pinned.executableModesHash!==behavioralModeHash(reviewModes))throw Error('Candidate changed since the protected-check reservation');}
   const runner=this.i.checks(workspace,{goalId:g.id,taskId:t.id,operationKey:'native-finish:'+t.id}),sandbox=await runner.verify(this.i.signal),results=await runner.run(target.manifest.permissions.checks,stage,this.i.signal);
   await workspace.assertSnapshot(snapshot);
   if(reviewModes&&behavioralModeHash(await readBehavioralFileModes(workspace,Object.keys(snapshot)))!==behavioralModeHash(reviewModes))throw Error('Candidate executable mode changed during checks');
   await journal.append('native.checks',{round:t.native.round,checks:results,sandbox});
   if(!results.every(r=>r.passed))throw Error('Native checks failed');
   this.assertWriter(t);
   const checkpoint=await journal.memo(`${stage}/checkpoint`,()=>workspace.checkpoint({id:stage,writePaths:t.spec.permissions.writePaths}));
   if(!journal.events.some(e=>e.type==='stage.accepted'&&e.data.stageId===stage))await journal.append('stage.accepted',{stageId:stage,...checkpoint});
   return this.c.store.tx(()=>{
    const current=this.assertWriter(t);
    const candidate=normalizeNativeCandidate({version:1,taskId:t.id,baseCommit:t.native.baseCommit,worktree:workspace.root,commit:checkpoint.commit,status:'awaiting_review',checks:results});
    current.native={...current.native,...candidate,writerActive:false};current.status='awaiting_review';
    current.result={summary:input.summary,changes,checks:results,...(reviewModes?{reviewCheckBinding:{snapshotHash:digest(snapshot),executableModesHash:behavioralModeHash(reviewModes),checksHash:digest(results)}}:{}),sandbox,baseCommit:t.native.baseCommit,worktree:workspace.root,journalRoot:journal.root,accounting:'Native host usage unavailable'};
    this.c.store.put('task',current);this.c.emit('task.native_finished',t.goalId,t.id,{status:current.status,commit:checkpoint.commit});return this.c.getTask(t.id);
   });
  }finally{await release();}
 }
 async release(input){
  if(executionHolds(this.c,{taskId:input.taskId}).length)throw Error('Native execution quiescence remains held before writer release');
  const t=this.c.getTask(input.taskId);text(input.reason,'release reason');
  if(t.status==='partial'&&t.result?.savedNative)return t;
  if(t.status!=='stopped'||!t.native.writerActive||t.owner)throw Error('Stop native editing before explicit host-confirmed release');
  const target=await this.open(t),release=await target.journal.lock();
  try{
   this.assertWriter(t,'stopped',false);let initialized=true;try{await lstat(target.workspace.root);}catch(error){if(error.code!=='ENOENT')throw error;initialized=false;}
   const snapshot=initialized?await target.workspace.snapshot():null,head=initialized?await git(target.workspace.root,'rev-parse','HEAD'):null;
   const savedNative={worktree:target.workspace.root,initialized,head,snapshot,snapshotHash:initialized?digest(snapshot):null,reason:input.reason};
   await target.journal.append('native.released',{taskId:t.id,...savedNative});
   return this.c.store.tx(()=>{
    const current=this.assertWriter(t,'stopped',false);
    current.status='partial';current.native.status='partial';current.native.writerActive=false;current.result={summary:input.reason,savedNative};
    this.c.store.put('task',current);this.c.emit('task.native_released',t.goalId,t.id,{snapshotHash:savedNative.snapshotHash,reason:input.reason});return this.c.getTask(t.id);
   });
  }finally{await release();}
 }
}
