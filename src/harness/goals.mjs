import {executionHolds} from './execution-ownership.mjs';
import {assertCapacityConfiguration} from './scheduling/capacity.mjs';
import {isOvernightV2,overnightCompletionReady} from './overnight.mjs';
import {assertOvernightPreflight} from './overnight-preflight.mjs';
import {randomUUID} from 'node:crypto';
import {normalizeTask,digest,text} from './contracts.mjs';
import {taskRoutingManifest} from './routing/runtime.mjs';

function quiescent(c,goalId){return executionHolds(c,{goalId}).length===0&&!c.store.db.prepare("SELECT 1 FROM requests r JOIN records t ON t.kind='task' AND t.id=r.task_id WHERE r.kind='apiReview' AND r.status='reserved' AND json_extract(t.data,'$.goalId')=?").get(goalId)&&!c.store.get('goal',goalId).integrationOwner&&!c.store.get('goal',goalId).integrationPending&&!c.store.all('task').some(t=>t.goalId===goalId&&(t.owner||t.native?.writerActive||t.executionActor==='codex'&&['paused','stopped'].includes(t.status)||['codex_active','legacy_reviewing'].includes(t.status)))&&!['running','uncertain'].includes(c.store.maybe('planning',goalId)?.status);}
function assertWorkerUnchanged(g,manifest){
 if(digest(g.manifest.executionPolicy??null)!==digest(manifest.executionPolicy??null))throw Error('An existing goal retains its execution backend policy. Prepare a new goal to select another backend.');
 if(g.activatedAt!=null&&digest(g.manifest.workerProfile??null)!==digest(manifest.workerProfile??null))
  throw Error('An approved goal retains its worker profile. Prepare and approve a new goal to select a different worker.');
}
export class Goals {
 constructor(c){this.c=c;}
 prepareRevision(input,key){return this.c.store.command(key,{op:'goal.revise.prepare',...input},()=>{
  const g=this.c.store.get('goal',input.goalId);if(['completed','partial'].includes(g.status))throw Error('Goal is terminal');if(g.hash!==input.expectedHash)throw Error('Goal approval changed');
  const manifest=this.c.goalManifest(input.manifest,undefined,{historic:!g.manifest.reviewPolicy&&!input.manifest.reviewPolicy});if(manifest.submissionId!==g.manifest.submissionId)throw Error('Goal submission identity cannot change');
  assertWorkerUnchanged(g,manifest);assertCapacityConfiguration(this.c,manifest);
  if(manifest.environment!==g.manifest.environment)throw Error('Execution environment cannot change after approval');
  if(g.integration||this.c.store.all('task').some(t=>t.goalId===g.id&&t.startedAt)){
   if(manifest.project?.repo!==g.manifest.project?.repo||manifest.project?.baseCommit!==g.manifest.project?.baseCommit)throw Error('Started work requires explicit stale-base handling in a new goal');
  }
  const revision={id:randomUUID(),goalId:g.id,previousHash:g.hash,version:g.version+1,manifest,hash:digest(manifest),status:'draft',createdAt:this.c.now()};this.c.store.put('goal_revision',revision);this.c.emit('goal.revision_prepared',g.id,null,{id:revision.id,version:revision.version,hash:revision.hash});return revision;
 });}
 activateRevision(input,key){return this.c.store.command(key,{op:'goal.revise.activate',...input},()=>{
  const revision=this.c.store.get('goal_revision',input.revisionId),g=this.c.store.get('goal',revision.goalId);
  if(['completed','partial'].includes(g.status))throw Error('Goal is terminal');
  if(input.hash!==revision.hash)throw Error('Exact revision approval hash required');if(g.hash!==revision.previousHash||revision.status!=='draft')throw Error('Revision is stale');
  assertWorkerUnchanged(g,revision.manifest);
  this.c.verifyGoalBinding(revision);assertCapacityConfiguration(this.c,revision.manifest,{excludeGoalId:g.id});
  if(!quiescent(this.c,g.id))throw Error('Verify quiescent owners before changing an approved version');
  if(this.c.now()>=g.deadline)throw Error('Original deadline exceeded');
  if(isOvernightV2(revision.manifest))assertOvernightPreflight(this.c,{...g,hash:revision.hash,manifest:revision.manifest});
  this.c.store.put('goal_history',{...g,id:`${g.id}-${g.version}`,goalId:g.id});
  g.manifest=revision.manifest;g.hash=revision.hash;g.version=revision.version;g.deadline=Math.min(g.deadline,g.activatedAt+g.manifest.limits.hours*3600000);this.c.store.put('goal',g);
  revision.status='approved';this.c.store.put('goal_revision',revision);this.c.emit('goal.revision_activated',g.id,null,{id:revision.id,hash:g.hash,version:g.version,deadline:g.deadline});return this.c.getGoal(g.id);
 });}
 rebind(input,key){return this.c.store.command(key,{op:'task.rebind',...input},()=>{
  const t=this.c.getTask(input.taskId),g=this.c.store.get('goal',t.goalId);this.c.liveGoal(g);
  if(executionHolds(this.c,{goalId:g.id}).some(row=>!row.taskId||row.taskId===t.id))throw Error('Native execution quiescence required before rebind');
  if(t.owner||t.native?.writerActive||g.integrationPending?.taskId===t.id||['codex_active','legacy_reviewing','accepted'].includes(t.status)||(t.status==='partial'&&!(t.native?.layout==='candidate_v1'&&t.goalVersion<g.version)))throw Error('Task must be quiescent and unfinished');
  if(isOvernightV2(g.manifest))throw Error('Overnight v2 stage graph changes require a separately validated plan; preserve original IDs and spending');
  const spec=normalizeTask(input.spec??t.spec,taskRoutingManifest(this.c,g,t),this.c.registry,{existingTask:t});if(spec.submissionId!==t.spec.submissionId||spec.kind!==t.spec.kind)throw Error('Task identity/kind cannot change');
  if(t.workerProfile&&digest(t.workerProfile)!==digest(g.manifest.workerProfile??null))throw Error('Started assignments retain their approved worker profile');
  const providerBinding=spec.actor==='deepseek'?(t.startedAt&&t.providerBinding?t.providerBinding:spec.routing?undefined:this.c.providerBinding(g,g.manifest.providerPolicy?.defaultWorkerId)):undefined;
  if(t.startedAt&&digest(t.providerBinding??null)!==digest(providerBinding??null))throw Error('Started assignments retain their approved provider binding');
  if(providerBinding)this.c.verifyWorkerBinding(g,{goalId:g.id,goalVersion:g.version,spec,providerBinding,...(t.route?{route:t.route,routeHash:t.routeHash,hash:digest(spec),history:[...(t.history??[]),{spec:t.spec,hash:t.hash}]}:{})});
  if(t.startedAt&&spec.actor!==t.spec.actor)throw Error('Started actor changes require explicit takeover');
  let nextNativePermissions=null;if(t.native?.layout==='candidate_v1'){const permissions={readPaths:spec.permissions.readPaths,writePaths:spec.permissions.writePaths,checks:g.manifest.project.checks.filter(x=>spec.permissions.checks.includes(x.id))};if(digest(permissions)!==digest(t.native.manifest.permissions)){if(t.goalVersion>=g.version)throw Error('Changed native scope/checks require an explicitly approved goal version');nextNativePermissions=permissions;}}
  for(const [name,limit] of Object.entries(spec.limits))if(limit>t.spec.limits[name])throw Error('Rebind cannot refresh assignment limits');
  const tasks=this.c.store.all('task').filter(x=>x.goalId===g.id),links=this.c.store.all('help_link').filter(l=>l.goalId===g.id&&l.status==='waiting'),graph=new Map(tasks.map(x=>[x.id,[...(x.id===t.id?spec.dependsOn:x.spec.dependsOn),...links.filter(l=>l.taskId===x.id).map(l=>l.helperTaskId)]]));
  const visited=new Set(),visiting=new Set(),visit=id=>{if(visiting.has(id))throw Error('Dependency cycle');if(visited.has(id))return;if(!graph.has(id))throw Error('Dependency outside goal');visiting.add(id);graph.get(id).forEach(visit);visiting.delete(id);visited.add(id);};visit(t.id);
  if(t.startedAt&&digest(spec)!==t.hash){
   if(t.goalVersion===g.version)throw Error('Started scope changes require an explicitly approved new goal version');
   const unchanged=({permissions,...rest})=>rest;
   if(spec.kind!=='coding')throw Error('Started non-coding scope changes require a separately versioned backend handoff');
   if(digest(unchanged(spec))!==digest(unchanged(t.spec)))throw Error('Started rebind keeps the exact assignment objective and limits; use bounded review feedback for corrections');
  }
  if(nextNativePermissions){
   const frozen={native:structuredClone(t.native),result:t.result,goalVersion:t.goalVersion,hash:t.hash,at:this.c.now()};t.nativeGenerations??=[];t.nativeGenerations.push(frozen);
   t.native={...t.native,status:'generation_pending',writerActive:false,needsGeneration:{id:randomUUID(),number:(t.native.generation??1)+1,goalVersion:g.version,permissions:nextNativePermissions,baseCommit:null,from:frozen,at:this.c.now()}};
   t.result=null;t.reviewed=false;t.feedback.push({kind:'approved_generation',text:'Explicit approved rebind requires a new native candidate generation and fresh checks/review.',goalVersion:g.version,at:this.c.now()});
  }
  const newVersion=t.goalVersion<g.version;
  const priorGoal=newVersion?this.c.store.maybe('goal_history',`${g.id}-${t.goalVersion}`):null;
  const reviewStatus=['paused','stopped'].includes(t.status)?t.controlReturnStatus:t.status;
  const staleReview=newVersion&&(g.manifest.reviewPolicy||priorGoal?.manifest.reviewPolicy)&&['awaiting_review','ready_to_integrate'].includes(reviewStatus);
  if(staleReview&&!!g.manifest.reviewPolicy!==!!priorGoal?.manifest.reviewPolicy)throw Error('A checked candidate requires a new goal to change its review protocol');
  const checkInputs=(project,task)=>project?.checks.filter(check=>task.permissions.checks.includes(check.id))??[];
  const needsNewWorkerChecks=staleReview&&t.spec.kind==='coding'&&t.native?.layout!=='candidate_v1'&&(digest(t.spec.permissions)!==digest(spec.permissions)||digest(checkInputs(priorGoal?.manifest.project,t.spec))!==digest(checkInputs(g.manifest.project,spec)));
  t.history??=[];t.history.push({goalVersion:t.goalVersion,spec:t.spec,hash:t.hash,...(t.providerBinding?{providerBinding:t.providerBinding}:{}),at:this.c.now()});t.spec=spec;t.hash=digest(spec);t.goalVersion=g.version;t.deadline=t.deadline?Math.min(t.deadline,g.deadline):null;
  if(providerBinding)t.providerBinding=providerBinding;else{delete t.providerBinding;delete t.route;delete t.routeHash;}
  delete t.routingWait;
  if(!['awaiting_review','ready_to_integrate','awaiting_supervisor','awaiting_user','awaiting_legacy_review'].includes(t.status))t.status=t.executionActor==='codex'||spec.actor==='codex'?'codex_ready':'queued';t.stopRequested=t.pauseRequested=false;
  const reviewExhausted=()=>t.reviews>=t.spec.limits.reviews||g.manifest.reviewPolicy&&this.c.reviewService.budget(g).remaining===0;
  if(staleReview){
   delete t.reviewAcceptance;if(t.reviewWait?.source!=='api')delete t.reviewWait;t.reviewed=false;
   t.feedback.push({kind:'review_superseded',text:'An approved goal revision superseded the previous review.',goalVersion:g.version,at:this.c.now()});
   for(const ticket of this.c.store.all('review_ticket').filter(ticket=>ticket.taskId===t.id&&ticket.reviewer.source==='host'&&ticket.status==='reserved'&&ticket.binding.goalVersion<g.version)){
    ticket.status='stale';ticket.reasonCode='binding_superseded';ticket.staleAt=this.c.now();this.c.store.put('review_ticket',ticket);
    this.c.emit('review.stale',g.id,t.id,{ticketId:ticket.id,reasonCode:ticket.reasonCode});
   }
   if(reviewExhausted()){t.status='blocked';t.reason='Original review budget exhausted after approval changed';}
   else if(needsNewWorkerChecks){
    const outOfAttempts=t.attempts>=t.spec.limits.attempts||(this.c.store.spent(t.id).model??0)>=t.spec.limits.modelCalls;
    t.status=outOfAttempts?'blocked':'queued';t.checkpoint={...t.checkpoint,phase:'attempt'};
    if(outOfAttempts)t.reason='Original attempt or request budget exhausted before required fresh checks';
   }else t.status='awaiting_review';
  }
  if(nextNativePermissions){const exhausted=reviewExhausted()||t.attempts>=t.spec.limits.attempts||(this.c.store.spent(t.id).model??0)>=t.spec.limits.modelCalls;t.status=exhausted?'blocked':'codex_ready';if(exhausted)t.reason='Approved generation retains exhausted original task limits';}
  this.c.store.put('task',t);this.c.emit('task.rebound',g.id,t.id,{goalVersion:t.goalVersion,hash:t.hash});return this.c.getTask(t.id);
 });}
 finalize(input,key){return this.c.store.command(key,{op:'goal.finalize',...input},()=>{
  const g=this.c.store.get('goal',input.goalId);text(input.summary,'summary',12000);if(g.status==='draft'||['completed','partial'].includes(g.status))throw Error('Goal is not ready for finalization');
  const tasks=this.c.store.all('task').filter(t=>t.goalId===g.id);
  const emptyStopped=this.c.beta&&g.status==='stopped'&&input.partial===true&&!tasks.length;
  if(!tasks.length&&!emptyStopped||!quiescent(this.c,g.id))throw Error('Goal has unfinished owners or no accepted work');
  if(isOvernightV2(g.manifest)&&!input.partial&&!overnightCompletionReady(this.c,g,tasks))throw Error('Overnight v2 requires validated plan, independent reviews, integrations and full final suite');
  const unfinished=tasks.filter(t=>t.status!=='accepted');if(unfinished.length&&!input.partial)throw Error('Goal has unfinished tasks; accepted work is required');
  if(unfinished.some(t=>['queued','suspended','running','codex_ready'].includes(t.status)))throw Error('Stop unfinished work before partial finalization');
  const spending={model:this.c.store.spent(g.id).model??0,search:0,download:0,codexReview:0};for(const t of tasks)for(const [kind,n] of Object.entries(this.c.getTask(t.id).spent))spending[kind]=(spending[kind]??0)+n;
  const receipt={schema:1,goalId:g.id,approvalHash:g.hash,goalVersion:g.version,mode:g.manifest.mode,capabilities:g.manifest.capabilities,environment:g.manifest.environment,deadline:g.deadline,finishedAt:this.c.now(),summary:input.summary,spending,nativeCodexUsage:'host accounting; token totals unavailable',tasks:tasks.map(t=>({id:t.id,hash:t.hash,status:t.status,goalVersion:t.goalVersion,attempts:t.attempts,reviews:t.reviews,deadline:t.deadline,resultHash:digest(t.result),integration:t.integration??null,memory:(t.memory??[]).map(x=>({id:x.id,version:x.version,recipeHash:x.recipeHash}))}))};
  g.status=unfinished.length||emptyStopped?'partial':'completed';g.receipt=receipt;g.receiptHash=digest(receipt);this.c.store.put('goal',g);this.c.emit('goal.finalized',g.id,null,{status:g.status,receiptHash:g.receiptHash});return {goalId:g.id,status:g.status,receipt,receiptHash:g.receiptHash};
 });}
}
