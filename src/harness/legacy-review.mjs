import {assertInferenceCapacity,CapacityWaitError,holdsPlanningSlot,holdsTaskSlot,inferenceWait,serviceCapacity} from './scheduling/capacity.mjs';
import path from 'node:path';
import {Journal} from '../project/journal.mjs';
import {randomUUID} from 'node:crypto';
import {ProjectFrontier} from '../project/providers.mjs';
import {keys,text,digest,identifier} from './contracts.mjs';
import {isOvernightV2} from './overnight.mjs';
import {git} from '../project/process.mjs';
import {matches,secretPath} from '../project/contracts.mjs';
import {assertBehavioralChecks,behavioralModeHash,deriveBehavioralEvidence,readBehavioralFileModes} from './behavioral-validation.mjs';

async function snapshotModesHash(workspace,snapshot){
 return behavioralModeHash(await readBehavioralFileModes(workspace,Object.keys(snapshot)));
}

async function assertSnapshotModes(workspace,snapshot,expected){
 if(await snapshotModesHash(workspace,snapshot)!==expected)throw Error('Candidate executable mode changed during behavioral review');
}

async function sourceFixture({manifest:{project:{repo,baseCommit:approvedBase}}}){
 const head=await git(repo,'rev-parse','HEAD'),status=await git(repo,'status','--porcelain');
 if(head!==approvedBase||status)throw Error('Source fixture changed from its approved revision/status');
 return {head,status,approvedBase,unchanged:true};
}

function behavioralReviewCandidate(c,g,task,current){
 if(c.store.get('goal',g.id).hash!==g.hash||current.goalVersion!==task.goalVersion||current.hash!==task.hash||
   current.owner||!['awaiting_legacy_review','legacy_reviewing'].includes(current.status)||digest(current.result)!==digest(task.result)){
  throw Error('Candidate state or approval changed during behavioral review');
 }
}

export class LegacyReview {
 constructor(worker){this.worker=worker;this.c=worker.c;this.inflight=new Map();}
 schedulable(task){
  const {c}=this,goal=c.store.get('goal',task.goalId);
  if(this.inflight.has(task.id)||task.status!=='awaiting_review'||goal.manifest.reviewPolicy?.source!=='api'||!c.eligible(task))return false;
  const ticket=c.store.all('review_ticket').find(r=>r.taskId===task.id&&r.status==='reserved');
  if(ticket){
   const request=c.store.db.prepare("SELECT status,data FROM requests WHERE task_id=? AND kind='apiReview' AND CASE WHEN json_valid(data) THEN json_extract(data,'$.ticketId') ELSE NULL END=?").get(task.id,ticket.id);
   if(request?.status!=='completed'||task.reviewWait?.reasonCode!==undefined&&task.reviewWait.reasonCode!=='controls_active')return false;
   try{identifier(JSON.parse(request.data).runKey,'saved API run key');return true;}catch{return false;}
  }
  if(task.reviewWait&&task.reviewWait.reasonCode!=='controls_active')return false;
  const reviewer=goal.manifest.reviewPolicy.reviewer;
  return !inferenceWait(c,goal,{providerId:reviewer.id,revision:reviewer.revision,profileHash:digest(reviewer)});
 }
 async tick({taskId,legacyOnly=false}={}){
  if(taskId?this.inflight.has(taskId):this.inflight.size)return null;
  const parallel=serviceCapacity(this.c)>1;
  this.c.expireQuiescent();
  const requests=[];
  for(const row of this.c.store.db.prepare("SELECT id,task_id,status,data FROM requests WHERE kind='apiReview'").all()){
   // Historical sequential review keeps its global hold. Parallel review uses
   // the shared inference ledger below, retaining unknown group ownership.
   let data;try{data=JSON.parse(row.data);}catch{return null;}
   if(!data)return null;
   if(!parallel&&(row.status==='reserved'||!['completed','failed'].includes(row.status)||
    (row.status==='completed'?data.requestOutcome!=='completed':!['completed','not_dispatched'].includes(data.requestOutcome))))return null;
   requests.push({...data,id:row.id,taskId:row.task_id,status:row.status});
  }
  const tickets=this.c.store.all('review_ticket');
  const unfinished=this.c.store.unfinishedTasks();
  for(const portable of unfinished.filter(t=>!legacyOnly&&(!taskId||t.id===taskId)&&t.status==='awaiting_review'&&this.c.store.get('goal',t.goalId).manifest.reviewPolicy?.source==='api'&&this.c.eligible(t))){
   const ticket=tickets.find(r=>r.taskId===portable.id&&r.status==='reserved');let run;
   if(!ticket){const goal=this.c.store.get('goal',portable.goalId),reviewer=goal.manifest.reviewPolicy.reviewer,wait=inferenceWait(this.c,goal,{providerId:reviewer.id,revision:reviewer.revision,profileHash:digest(reviewer)});if(wait){if(taskId)return wait;continue;}}
   if(ticket){
    const saved=requests.find(r=>r.taskId===portable.id&&r.ticketId===ticket.id);
    // A terminal failed/invalid response holds its own spent reservation, not
    // another goal. Unprocessed/pre-category responses get one validation;
    // thereafter only a supported control wait may retry submission. Invalid
    // data becomes a durable operator wait inside ReviewService.
    if(saved?.status!=='completed'||(portable.reviewWait?.reasonCode!==undefined&&portable.reviewWait.reasonCode!=='controls_active'))continue;
    try{identifier(saved.runKey,'saved API run key');}catch{continue;}
    run=this.c.reviewService.runApi({...ticket.binding,signal:this.worker.shutdown.signal},saved.runKey);
   }else{
    run=(async()=>{const context=await this.c.reviewService.context(portable.id,{includeFiles:false});return this.c.reviewService.runApi({...context.binding,signal:this.worker.shutdown.signal},`auto-review-${portable.id}-${portable.reviews+1}`);})();
   }
   this.inflight.set(portable.id,run);try{return await run;}finally{this.inflight.delete(portable.id);}
  }
  if(taskId)return null;
  if(unfinished.some(holdsTaskSlot)||this.c.store.all('planning').some(holdsPlanningSlot))return {waiting:true,reasonCode:'legacy_global_slot'};
  const task=unfinished.find(t=>!this.c.store.get('goal',t.goalId).manifest.reviewPolicy&&['awaiting_legacy_review','legacy_reviewing'].includes(t.status)&&this.c.eligible(t));if(!task)return null;
  const run=this.run(task);this.inflight.set(task.id,run);try{return await run;}finally{this.inflight.delete(task.id);}
 }
 async referenceFiles(source,task){
  const paths=(await source.workspace.inventory()).map(f=>f.path).filter(file=>task.spec.role==='final'||!matches(file,task.spec.permissions.writePaths));
  if(paths.length>128)throw Error('Review reference context exceeds 128 files; inspect approved stage scope');
  return source.workspace.readFiles(paths);
 }
 async stageEvidence(task,g,checks){
  const c=this.c,accepted=c.store.all('task').filter(t=>t.goalId===g.id&&t.status==='accepted'&&t.integration),acceptedStages=[];
  for(const t of accepted){
   const journal=await new Journal(path.join(c.store.root,'coding'),t.id).load(),firstGate=journal.events.findIndex(e=>e.type==='operation.started'&&/^harness-attempt-\d+\/checks$/.test(e.data.key));
   acceptedStages.push({id:t.id,role:t.spec.role,objective:t.spec.objective,commit:t.integration.commit,checks:t.integration.checks.map(({id,passed})=>({id,passed})),reviewHistory:t.feedback.filter(f=>f.kind==='legacy_review').map(f=>({decision:f.decision,feedbackHash:digest(f.text),at:f.at})),providerModel:t.providerModel??null,spent:c.getTask(t.id).spent,batchesBeforeFirstGate:firstGate<0?null:journal.events.slice(0,firstGate).filter(e=>e.type==='edits.applied').length});
  }
  const target=await this.worker.integration.lockedGoal(g.id,{refuseLegacy:true});let acceptedDiffs;
  try{acceptedDiffs=await target.workspace.acceptedDiffs({readPaths:task.spec.permissions.readPaths});}finally{await target.release();}
  const checkIds=g.manifest.overnightPolicy.launchCheckIds??[],plan=c.store.maybe('overnight_plan',g.id),lease=c.store.maybe('lease','coordinator');
  return {acceptedDiffs,acceptedStages,launchEvidence:{source:'approved_literal_project_checks',checkIds,checks:checks.filter(r=>checkIds.includes(r.id))},overnightLifecycle:{source:'coordinator_records',mode:g.manifest.mode,approvalHash:g.hash,planValidated:plan?.approvalHash===g.hash,plannedTaskIds:plan?.tasks??[],execution:{coordinatorLeaseMatches:lease?.pid===process.pid&&lease?.token===this.worker.owner},nativeChatActivity:'not_observed_by_coordinator',completionReceipt:'pending_after_final_integration',completionAlert:'pending_after_finalization'}};
 }
 async repairEvidence(input,key){return this.worker.integration.effect(key,{op:'review.evidence_repair',...input},async()=>{
  const {c}=this;let task=c.getTask(input.taskId);const g=c.store.get('goal',task.goalId);c.liveTask(task);text(input.reason,'evidence repair reason',2000);
  const old=c.store.maybe('review_evidence_repair',key);if(old){if(old.inputHash!==digest(input))throw Error('Evidence repair key conflict');return c.getTask(task.id);}
  if(!isOvernightV2(g.manifest)||g.integrationPending||task.owner||task.status!=='blocked'||task.legacyDecision?.decision!=='revise')throw Error('Evidence repair requires a quiescent blocked v2 candidate with a saved revise verdict');
  if(task.hash!==input.expectedTaskHash||digest(task.result)!==input.expectedResultHash)throw Error('Approved task or candidate result changed');
  if(task.checkpoint.legacyReviewKey||c.store.db.prepare("SELECT 1 FROM requests WHERE kind='codexReview' AND status='reserved'").get())throw Error('Uncertain review authority must be reconciled');
  if(task.reviews>=task.spec.limits.reviews||(c.store.spent(task.id).codexReview??0)>=task.spec.limits.reviews)throw Error('No remaining original review budget');
  if(!task.result?.checks?.length||!task.result.checks.every(r=>r.passed))throw Error('Saved passing candidate checks are required');
  const source=await this.worker.integration.candidate(task),unlock=await source.journal.lock();
  try{
   await source.workspace.recover();const snapshot=(await source.workspace.evidence()).snapshot;if(digest(snapshot)!==digest(task.result.snapshot))throw Error('Candidate changed after its passing check receipt; evidence-only retry cannot repair code');
   const executableModesHash=g.manifest.project.behavioralChecks?await snapshotModesHash(source.workspace,snapshot):undefined;
   const references=await this.referenceFiles(source,task),runner=this.worker.integration.checks(source.workspace,{goalId:task.goalId,taskId:task.id,operationKey:'legacy-review:'+task.id});await runner.verify(this.worker.shutdown?.signal);
   const declared=source.manifest.permissions.checks,checks=await runner.run(declared,'review-evidence-repair',this.worker.shutdown?.signal);
   if(!checks.every(r=>r.passed))throw Error('Candidate checks failed before evidence re-review');
   assertBehavioralChecks(deriveBehavioralEvidence(g.manifest.project,{checks,checkIds:declared.map(check=>check.id),snapshot,executableModesHash}));
   if(digest((await source.workspace.evidence()).snapshot)!==digest(snapshot))throw Error('Candidate changed during evidence re-review preparation');
   if(executableModesHash)await assertSnapshotModes(source.workspace,snapshot,executableModesHash);
   return c.store.tx(()=>{const current=c.liveTask(task);if(current.status!=='blocked'||current.owner||current.hash!==input.expectedTaskHash||digest(current.result)!==input.expectedResultHash||current.reviews!==task.reviews)throw Error('Candidate or review authority changed during evidence repair');
    c.store.put('review_evidence_repair',{id:key,taskId:task.id,goalId:g.id,inputHash:digest(input),snapshotHash:digest(snapshot),referenceFiles:references.map(({path,hash})=>({path,hash})),checks,at:c.now()});
    current.feedback.push({kind:'review_evidence_repair',text:input.reason,at:c.now(),snapshotHash:digest(snapshot)});current.status='awaiting_legacy_review';current.reason=null;c.store.put('task',current);c.emit('task.review_evidence_repaired',g.id,task.id,{key,snapshotHash:digest(snapshot),remainingReviews:current.spec.limits.reviews-current.reviews});return c.getTask(task.id);
   });
  }finally{await unlock();}
 });}
 async run(task){
  const {c}=this,g=c.store.get('goal',task.goalId);c.liveGoal(g);
  if(g.manifest.reviewPolicy)throw Error('Use the common bound review service for this policy');
  if(g.manifest.mode.review!=='legacy')throw Error('Mode prohibits background Codex review');
  const {project}=g.manifest,v2=isOvernightV2(g.manifest),mapped=!!project.behavioralChecks;
  const source=await this.worker.integration.candidate(task),unlock=await source.journal.lock();
  try{
   await source.workspace.recover();
   const checkedSnapshot=mapped?await source.workspace.snapshot():null;
   const scopedSnapshot=mapped?Object.fromEntries(Object.entries(checkedSnapshot).filter(([file])=>!secretPath(file)&&matches(file,task.spec.permissions.readPaths))):null;
   if(mapped&&(!task.result?.snapshot||digest(scopedSnapshot)!==digest(task.result.snapshot)))throw Error('Candidate changed after its passing check receipt');
   const executableModesHash=mapped?await snapshotModesHash(source.workspace,scopedSnapshot):undefined;
   const assertReviewedWorkspace=async()=>{
    await source.workspace.recover();await source.workspace.assertSnapshot(checkedSnapshot);
    await assertSnapshotModes(source.workspace,scopedSnapshot,executableModesHash);
   };
   const runner=this.worker.integration.checks(source.workspace,{goalId:task.goalId,taskId:task.id,operationKey:'legacy-review:'+task.id}),sandbox=await runner.verify(this.worker.shutdown?.signal);
   const declared=source.manifest.permissions.checks,checks=await runner.run(declared,`legacy-${task.id}-${task.reviews}`,this.worker.shutdown?.signal);
   if(!checks.every(r=>r.passed))throw Error('Legacy review requires passing protected checks');
   const behavioralEvidence=deriveBehavioralEvidence(project,{checks,checkIds:declared.map(check=>check.id),snapshot:scopedSnapshot,executableModesHash});
   assertBehavioralChecks(behavioralEvidence);
   const v2Evidence=v2?{
    referenceFiles:await this.referenceFiles(source,task),
    ...await this.stageEvidence(task,g,checks),
    reviewHistory:task.feedback.filter(f=>f.kind==='legacy_review').map(f=>({decision:f.decision,text:f.text.slice(0,4000),at:f.at})),
   }:null;
   const modelContext=()=>source.journal.events.filter(e=>e.type==='harness.context'&&c.store.request(task.id,e.data.key)?.status==='completed').map(e=>e.data);
   const preparedEvidence=v2||mapped?{...await source.workspace.evidence(),checks,sandbox,...v2Evidence,modelContext:modelContext()}:null;
   const reviewBinding=mapped?{approvalHash:g.hash,taskHash:task.hash,baseCommit:source.manifest.baseCommit,snapshotHash:behavioralEvidence.snapshotHash,executableModesHash}:null;
   if(mapped){
    if(digest(preparedEvidence.snapshot)!==reviewBinding.snapshotHash)throw Error('Candidate changed during behavioral checks');
    preparedEvidence.behavioralEvidence=behavioralEvidence;
    preparedEvidence.sourceFixture=await sourceFixture(g);
    await assertReviewedWorkspace();
   }
   if(preparedEvidence&&Buffer.byteLength(JSON.stringify(preparedEvidence))>1024*1024)throw Error('Review evidence exceeds 1 MiB; narrow the approved context before further review');
   const reservation=c.store.tx(()=>{
    const current=c.liveTask(task);if(c.now()>=current.deadline)throw Error('Task deadline reached');
    if(mapped)behavioralReviewCandidate(c,g,task,current);
    if(current.checkpoint.legacyReviewKey){
     const saved=c.store.request(task.id,current.checkpoint.legacyReviewKey);
     if(mapped&&(!saved?.reviewBinding||digest(saved.reviewBinding)!==digest(reviewBinding)))throw Error('Saved review does not match the checked behavioral candidate');
     return saved;
    }
    assertInferenceCapacity(c,g,null);
    if((c.store.spent(task.id).codexReview??0)>=current.spec.limits.reviews)throw Error('Legacy review budget exhausted');
    const id=randomUUID(),key=`legacy-review-${current.reviews+1}`;current.reviews++;current.status='legacy_reviewing';current.checkpoint.legacyReviewKey=key;c.store.put('task',current);
    c.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?)').run(id,task.id,key,'codexReview','reserved',JSON.stringify({reservedAt:c.now(),...(mapped?{reviewBinding}:{})}));c.emit('legacy_review.reserved',g.id,task.id,{id,round:current.reviews});return {id,key,status:'reserved',fresh:true};
   });
   let result=reservation.result;
   if(reservation.status!=='completed'){
    if(!reservation.fresh)throw Error('Interrupted Codex review remains spent; operator reconciliation required');
    this.worker.reviewer??=new ProjectFrontier({command:this.worker.config.codexPath??'codex',timeoutMs:Math.min(300000,task.deadline-c.now())});
    let evidence=preparedEvidence;
    if(!mapped){
     const fixture=await sourceFixture(g);
     evidence=preparedEvidence?{...preparedEvidence,sourceFixture:fixture}:{...await source.workspace.evidence(),checks,sandbox,sourceFixture:fixture,modelContext:modelContext()};
    }
    try{result=await this.worker.reviewer.reviewCode({brief:g.manifest.objective,approvedPlan:g.manifest.acceptance,stage:task.spec,assignment:task.spec,evidence},AbortSignal.any([AbortSignal.timeout(Math.max(1,Math.min(300000,task.deadline-c.now()))),this.worker.shutdown.signal]));c.saveRequest(reservation.id,result);}
    catch(error){c.store.tx(()=>{const t=c.store.get('task',task.id);t.status='blocked';t.reason=error.message;c.store.put('task',t);c.store.db.prepare("UPDATE requests SET status='failed' WHERE id=?").run(reservation.id);c.emit('legacy_review.failed',g.id,t.id,{id:reservation.id,reason:t.reason});});return c.getTask(task.id);}
   }
   keys(result,['decision','feedback','unverified'],'legacy review');text(result.feedback,'review feedback',12000);if(!['accept','revise','blocked'].includes(result.decision)||!Array.isArray(result.unverified))throw Error('Malformed legacy review');
   if(mapped)await assertReviewedWorkspace();
   return c.store.tx(()=>{
    const t=c.store.get('task',task.id);
    if(mapped){
     behavioralReviewCandidate(c,g,task,t);
     if(t.checkpoint.legacyReviewKey!==reservation.key)throw Error('Behavioral review reservation changed');
     if(result.decision==='accept')t.legacyBehavioralReview=reviewBinding;
     else delete t.legacyBehavioralReview;
    }
    t.legacyDecision=result;t.feedback.push({kind:'legacy_review',text:result.feedback,decision:result.decision,at:c.now()});t.checkpoint.legacyReviewKey=null;
    t.status=c.now()>=t.deadline?'partial':result.decision==='accept'?'ready_to_integrate':result.decision==='revise'&&t.reviews<t.spec.limits.reviews?'queued':'blocked';
    if(isOvernightV2(g.manifest)&&t.status==='blocked')t.reason=(result.decision==='blocked'?'Reviewer blocked stage: ':'Review revision budget exhausted: ')+result.feedback;
    if(t.status==='queued')t.checkpoint.phase='attempt';c.store.put('task',t);c.emit('task.legacy_reviewed',g.id,t.id,{decision:result.decision,unverified:result.unverified});return c.getTask(t.id);
   });
  }catch(error){
   if(error instanceof CapacityWaitError)return {waiting:true,reasonCode:error.reasonCode};
   if(!v2&&!mapped)throw error;
   return c.store.tx(()=>{
    const t=c.store.get('task',task.id);
    if(['paused','stopped'].includes(t.status)&&t.controlReturnStatus==='awaiting_legacy_review'&&!t.checkpoint?.legacyReviewKey)return c.getTask(t.id);
    if(mapped&&!['awaiting_legacy_review','legacy_reviewing'].includes(t.status))return c.getTask(t.id);
    t.status='blocked';t.reason=String(error.message).slice(0,2000);c.store.put('task',t);c.emit('task.blocked',g.id,t.id,{reason:t.reason});return c.getTask(t.id);
   });
  }finally{await unlock();}
 }
}
