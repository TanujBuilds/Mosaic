import {controlBinding} from './owner-inbox.mjs';
import {ExecutionOwnership,executionHolds} from './execution-ownership.mjs';
import {assertNativePreflight,preflightNativeExecution} from './native-preflight.mjs';
import {windowsHostConsult,normalizeExecutionPolicy,assertExecutionAvailable,assertExecutionConfiguration,assertExecutionRuntime,isNativeExecution,normalizeNativeCheckRuntime} from './execution.mjs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {isOvernightV2,effectiveIntegrationChecks} from './overnight.mjs';
import {assertOvernightPreflight} from './overnight-preflight.mjs';
import {Store,terminalTaskStatuses} from './store.mjs';
import { Registry, normalizeGoal, normalizeTask, providerBinding as manifestProviderBinding, digest, text, identifier, keys } from './contracts.mjs';
import {ReviewService} from './review/service.mjs';
import {HOST_IDS,normalizeReviewPolicy} from './review/contracts.mjs';
import {normalizeRoutingPolicy} from './routing/contracts.mjs';
import {normalizeProviderPolicy} from './providers/contracts.mjs';
import {verifyLocalAcceptance} from './research-review.mjs';
import { Learning } from './learning.mjs';
import {workerProfile as normalizeWorkerProfile} from './worker-profile.mjs';
import {recordFailedGate} from './repair-progress.mjs';
import {matches} from '../project/contracts.mjs';
import {assertRoutingApproval,assertRoutePin,isRoutedTask,routeDecision,recordRoutingWait,pinnedResourceWait,taskRoutingManifest} from './routing/runtime.mjs';

import {capacitySnapshot,canClaim,configureServiceCapacity,assertCapacityConfiguration,assertInferenceCapacity,capacityWaitHeld} from './scheduling/capacity.mjs';
import {orderedCandidates} from './scheduling/scheduler.mjs';
import {reconnectRetryAt} from '../adapters/retry-after.mjs';

const TERMINAL=new Set(terminalTaskStatuses);
const SLOT=new Set(['running','uncertain','taking_over']);
const rank={background:0,normal:1,blocking:2};
const RECONNECT_DELAY_MS=15000;

function controlledStatus(t,g,now){
 if(now>=Math.min(g.deadline,t.deadline??g.deadline))return 'partial';
 if(t.stopRequested||g.status==='stopped')return 'stopped';
 if(t.pauseRequested||g.status==='paused')return 'paused';
 return null;
}

function savedStageChecks(root,t){
 // Journal appends fsync'd, newline-terminated entries. A partial tail is not a receipt.
 let raw;
 try{raw=readFileSync(path.join(root,'coding','jobs',t.id+'.jsonl'),'utf8');}catch(error){if(error.code==='ENOENT')return false;throw error;}
 const lines=raw.slice(0,raw.lastIndexOf('\n')+1).split('\n').slice(0,-1);
 let completed=false;
 for(const [index,line] of lines.entries()){
  const event=JSON.parse(line);
  if(event.jobId!==t.id||event.sequence!==index+1)return false;
  if(event.type==='operation.completed'&&event.data.key===`harness-attempt-${t.checkpoint.attempt}/checks`)completed=Array.isArray(event.data.value);
 }
 return completed;
}

function savedFailedGate(c,t,g){
 const cp=t.checkpoint,gate=cp.failedGate,key=`harness-attempt-${cp.attempt}/checks`;
 if(cp.repairFailure?.category!=='functional_check'||cp.repairFailure.attempt!==cp.attempt||
    !gate||gate.attempt!==cp.attempt||cp.attempt!==t.attempts||cp.repairEvidence?.key!==key)return false;
 let raw;
 try{raw=readFileSync(path.join(c.store.root,'coding','jobs',t.id+'.jsonl'),'utf8');}
 catch(error){if(error.code==='ENOENT')return false;throw error;}
 const events=raw.slice(0,raw.lastIndexOf('\n')+1).split('\n').filter(Boolean).map(line=>JSON.parse(line));
 if(!events.length||events.some((e,i)=>e.jobId!==t.id||e.sequence!==i+1))return false;
 const completed=new Set(events.filter(e=>e.type==='operation.completed').map(e=>e.data.key));
 const applied=new Set(events.filter(e=>e.type==='edits.applied').map(e=>e.data.key));
 if(events.some(e=>e.type==='operation.started'&&!completed.has(e.data.key)||e.type==='edits.intent'&&!applied.has(e.data.key)))return false;
 const manifest=events.findLast(e=>e.type==='harness.manifest');
 const permissions={readPaths:t.spec.permissions.readPaths,writePaths:t.spec.permissions.writePaths,
  checks:isOvernightV2(g.manifest)?effectiveIntegrationChecks(c,t,g.manifest):g.manifest.project.checks.filter(check=>t.spec.permissions.checks.includes(check.id))};
 const permissionsHash=digest(permissions);
 if(!manifest||digest(manifest.data.permissions)!==permissionsHash||cp.repairPermissionsHash!==permissionsHash||gate.permissionsHash!==permissionsHash)return false;
 const receipt=events.findLast(e=>e.type==='operation.completed'&&e.data.key===key);
 const snapshot=events.findLast(e=>e.data.snapshot);
 if(!receipt||!snapshot||snapshot.sequence!==gate.snapshotSequence||receipt.sequence<snapshot.sequence||receipt.sequence<manifest.sequence||
    !Array.isArray(receipt.data.value)||!receipt.data.value.some(check=>check.passed===false))return false;
 const verified=recordFailedGate({attempt:cp.attempt,snapshot:snapshot.data.snapshot,results:receipt.data.value}).gate;
 return verified.candidateId===gate.candidateId&&verified.failureId===gate.failureId&&verified.signature===gate.signature;
}
export class Coordinator {
 constructor({root,now=Date.now,registry=new Registry(),beta=false,workerProfile,verifyCurrentWorker,providerRegistry,selectedHost,hostRegistry,serviceMaxConcurrentTasks,executionPolicy,codexPath,defaultCodexPath,nativeCheckRuntime,configuredPolicies}={}){
  if(providerRegistry&&!['get','snapshot','createClient'].every(method=>typeof providerRegistry[method]==='function'))throw Error('A normalized provider registry is required');
  this.providerRegistry=providerRegistry??null;
  if(configuredPolicies!==undefined){keys(configuredPolicies,['providerPolicy','reviewPolicy','routingPolicy'],'trusted configured policies');this.configuredPolicies={...(configuredPolicies.providerPolicy?{providerPolicy:normalizeProviderPolicy(configuredPolicies.providerPolicy,this.providerRegistry)}:{}),...(configuredPolicies.reviewPolicy?{reviewPolicy:normalizeReviewPolicy(configuredPolicies.reviewPolicy)}:{})};if(configuredPolicies.routingPolicy)this.configuredPolicies.routingPolicy=normalizeRoutingPolicy(configuredPolicies.routingPolicy,this.configuredPolicies.providerPolicy);}
  this.selectedHost=typeof selectedHost==='string'?selectedHost:selectedHost?.id??null;if(this.selectedHost&&!HOST_IDS.includes(this.selectedHost))throw Error('Unsupported selected host');this.hostRegistry=hostRegistry??null;
  this.beta=beta;this.verifyCurrentWorker=()=>{verifyCurrentWorker?.();assertExecutionRuntime(this);};this.workerProfile=workerProfile?normalizeWorkerProfile(workerProfile):null;
  this.executionPolicy=normalizeExecutionPolicy(executionPolicy);this.executionConfig={codexPath,...(nativeCheckRuntime?{nativeCheckRuntime:normalizeNativeCheckRuntime(nativeCheckRuntime)}:{})};
  this.store=new Store(root);this.now=now;this.registry=registry;
  // Existing runner-only callers have no trusted selector to reconstruct.
  // Pin a new configured default without rebinding those historical records.
  if(!isNativeExecution({executionPolicy:this.executionPolicy})&&codexPath===undefined&&(defaultCodexPath!==undefined||this.executionPolicy?.backend==='codex-sandbox')&&this.store.maybe('execution_configuration','coordinator')?.identity?.runtime!==null)this.executionConfig.codexPath=defaultCodexPath??'codex';
  try{this.serviceMaxConcurrentTasks=this.store.tx(()=>{assertExecutionConfiguration(this);return configureServiceCapacity(this,serviceMaxConcurrentTasks);});}catch(error){this.store.close();throw error;}
  for(const record of this.store.all('mode')){const m=record.definition??record;if(!this.registry.modes.has(`${m.id}@${m.version}`))this.registry.registerMode(m);}
  for(const record of this.store.all('workflow')){const w=record.definition??record;if(!this.registry.workflows.has(`${w.id}@${w.version}`))this.registry.registerWorkflow(w);}
  this.executionOwnership=new ExecutionOwnership(this);this.executionOwnership.reconcile({force:true});
  this.learning=new Learning({c:this});this.reviewService=new ReviewService({c:this,providers:this.providerRegistry,hostRegistry:this.hostRegistry});
 }
 close(){this.store.close();}
 preflightExecution(input,options){return preflightNativeExecution(this,input,options);}
 acquireWorker(token){identifier(token,'worker token');const lease=this.store.tx(()=>{
  const existing=this.store.maybe('lease','coordinator');
  if(existing){
   if(existing.host!==os.hostname())throw Error('Worker host ownership is uncertain');
   if(existing.token===token&&existing.generation===this.workerLease?.generation&&existing.pid===process.pid)return existing;
   if(!Number.isInteger(existing.pid)||existing.pid<=0)throw Error('Worker process ownership is uncertain');
   try{process.kill(existing.pid,0);throw Error('Another worker owns this coordinator');}catch(e){if(e.code!=='ESRCH')throw e;}
   if(existing.token===token)throw Error('A replacement worker needs a fresh ownership token');
   this.interruptWorker();
  }
  const next={id:'coordinator',token,generation:randomUUID(),pid:process.pid,host:os.hostname(),at:this.now()};this.store.put('lease',next);return next;
 });this.workerLease=lease;return lease;}
 currentLease(owner){
  const lease=this.store.maybe('lease','coordinator');
  if(!lease||lease.token!==owner||lease.pid!==process.pid||lease.host!==os.hostname()||!this.workerLease||lease.generation!==this.workerLease.generation)throw Error('Current worker lease required');
  return lease;
 }
 interruptWorker(){
  for(const t of this.store.all('task').filter(t=>t.owner&&SLOT.has(t.status)&&t.interruptedOwner!==t.owner)){
   t.interruptedOwner=t.owner;delete t.ownerLease;
   if(t.status==='uncertain'){this.store.put('task',t);continue;}
   t.status='uncertain';t.reason='Previous coordinator relinquished ownership; reconcile saved operations before reuse';
   const goal=this.store.get('goal',t.goalId);
   // Startup tries saved recovery before the Overnight monitor sees a held task.
   // Record the interruption without treating safe replay as a historical blocker.
   const event=isOvernightV2(goal.manifest)?'task.interrupted':'task.uncertain';
   this.store.put('task',t);this.emit(event,t.goalId,t.id,{reason:t.reason,requestId:t.checkpoint.requestId??null});
  }
  for(const p of this.store.all('planning').filter(p=>p.status==='running')){p.status='uncertain';p.reason='Previous planner owner relinquished ownership; reconcile its saved request';this.store.put('planning',p);}
 }
 releaseWorker(token){
  const result=this.store.tx(()=>{
   const lease=this.store.maybe('lease','coordinator');
   if(lease){this.currentLease(token);this.interruptWorker();this.store.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run('lease','coordinator');}
   return {released:true};
  });this.workerLease=null;return result;
 }
 recoverSaved(taskId,owner){return this.store.tx(()=>{
  this.currentLease(owner);
  const t=this.store.get('task',taskId),g=this.store.get('goal',t.goalId);
  if(executionHolds(this,{goalId:g.id}).some(row=>!row.taskId||row.taskId===taskId))throw Error('Native execution quiescence remains held');
  const nativeProof=isNativeExecution(g.manifest)&&this.store.all('execution_owner').some(row=>row.taskId===t.id&&row.status==='quiescent'&&row.goalHash===g.hash&&row.taskHash===t.hash);
  if(t.status!=='uncertain'||t.owner===owner&&!nativeProof)throw Error('Task does not need ownership recovery');
  const cp=t.checkpoint,requests=this.store.requestOutcomes(taskId);
  const modelKey=t.spec.kind==='consult'?'consult-1':t.spec.kind==='learning'?`learning-${cp.attempt}`:`code-${cp.attempt}-${cp.exchange}`;
  // An old non-dispatch row is reusable only as spent history after its
  // exchange advanced. A current failed or pending key is still held.
  const safeHistory=requests.every(r=>r.status==='completed'||(r.status==='failed'&&r.outcome==='not_dispatched'&&r.kind==='model'&&r.key!==modelKey&&isOvernightV2(g.manifest)));
  if(!safeHistory)throw Error('Pending or ambiguous request prevents safe recovery');
  const coding=t.spec.kind==='coding',consult=t.spec.kind==='consult';
  const savedModel=requests.some(r=>r.key===modelKey&&r.status==='completed');
  const learning=t.spec.kind==='learning'&&(cp.phase==='model'||(requests.length>0&&['proposal','evaluate','finalize'].includes(cp.phase)));
  const safePhase=consult||learning||(isNativeExecution(g.manifest)&&coding&&cp.phase==='checks')||
   (coding&&(cp.phase==='model'||cp.phase==='attempt'&&savedFailedGate(this,t,g)||(savedModel&&(cp.phase==='apply'||cp.phase==='checks'&&savedStageChecks(this.store.root,t)))));
  if(!safePhase)throw Error('Backend/check quiescence requires separate verification');
  const status=controlledStatus(t,g,this.now());
  if(!status&&t.goalVersion!==g.version)throw Error('Saved task requires explicit rebind to the approved goal version');
  t.owner=null;t.status=status??(t.providerWait?'suspended':'queued');
  if(t.status==='partial')t.reason='Original deadline reached; saved evidence retained';
  else if(t.providerWait)t.reason='Known provider unavailability; original request remains spent';
  else t.reason=cp.phase==='checks'?'Recovered from the saved protected-check receipt':'Recovered from saved operations';
  this.store.put('task',t);this.emit('task.recovered',t.goalId,t.id,{status:t.status,requestId:cp.requestId??null,spending:this.store.spent(t.id)});return this.getTask(t.id);
 });}
 recoverPlanning(goalId,owner){return this.store.tx(()=>{
  this.currentLease(owner);
  const p=this.store.get('planning',goalId),g=this.store.get('goal',goalId);if(p.status!=='uncertain'&&!p.recoveryPending)throw Error('Planner does not need ownership recovery');
  const requests=this.store.requestOutcomes(goalId),saved=this.store.request(goalId,`plan-${p.attempt}`);
  if(requests.some(r=>r.status!=='completed'&&!(isOvernightV2(g.manifest)&&r.status==='failed'&&r.outcome==='not_dispatched'))||saved?.status!=='completed')throw Error('Pending or ambiguous planning request prevents safe recovery');
  if(this.now()>=g.deadline||['completed','partial'].includes(g.status)){
   p.status='partial';p.owner=null;delete p.recoveryPending;
  }else if(g.status==='active'){
   p.status='running';p.owner=owner;delete p.recoveryPending;
  }else{
   if(p.recoveryPending&&p.status===g.status)return p;
   p.status=g.status;p.owner=null;p.recoveryPending=true;p.reason='Saved planning response retained while the goal is '+g.status;
  }
  this.store.put('planning',p);this.emit('planning.recovered',goalId,null,{attempt:p.attempt,status:p.status,spent:this.store.spent(goalId)});return p;
 });}
 emit(type,goalId,taskId,data={}){return this.store.tx(()=>{const seq=this.store.event(type,{goalId,taskId,data,at:this.now()});if(taskId&&this.learning?.captures(type))this.learning.capture(taskId,seq);
  if(taskId&&['task.result','task.reviewed','task.integrated','task.native_finished'].includes(type)&&this.store.get('task',taskId).status==='accepted'){
   for(const link of this.store.all('help_link').filter(l=>l.helperTaskId===taskId&&l.status==='waiting')){
    link.status='ready';link.resultHash=digest(this.store.get('task',taskId).result);link.acceptedAt=this.now();this.store.put('help_link',link);
    const parent=this.store.get('task',link.taskId);parent.feedback.push({kind:'helper',helperTaskId:taskId,questionId:link.questionId,resultHash:link.resultHash,text:'Linked helper accepted; main supervisor must answer the original question',at:this.now()});this.store.put('task',parent);
    this.emit('help.ready',link.goalId,link.taskId,{helperTaskId:taskId,questionId:link.questionId,resultHash:link.resultHash});
   }
  }
  if(type==='task.answered')for(const n of this.store.all('notification').filter(n=>n.taskId===taskId&&n.kind==='decision'&&!n.resolved)){n.resolved=true;n.resolvedAt=this.now();this.store.put('notification',n);}
  const kind=type==='overnight.attention'?(data.phase==='waiting-answer'?'decision':'blocker'):type==='task.question'?'decision':['task.blocked','task.uncertain','legacy_review.failed','review.waiting'].includes(type)?'blocker':type==='goal.finalized'?'completion':['task.result','task.integrated','task.native_finished','learning.promoted'].includes(type)?'result':null;
  if(kind&&!(kind==='result'&&isOvernightV2(this.store.maybe('goal',goalId)?.manifest))){const task=taskId?this.store.get('task',taskId):null,title=type==='task.question'?'An answer is needed':type==='goal.finalized'?'Goal '+data.status:type==='learning.promoted'?'Tested procedure available':kind==='blocker'?'Work needs attention':'Saved work is ready';this.store.put('notification',{id:`notice-${seq}`,sequence:seq,goalId,taskId,kind,title,objective:task?.spec.objective??this.store.maybe('goal',goalId)?.manifest.objective??'',at:this.now(),acknowledged:false,resolved:false});}
  return seq;
 });}
 notifications({goalId}={}){return this.store.all('notification').filter(n=>!n.acknowledged&&!n.resolved&&(!goalId||n.goalId===goalId)).sort((a,b)=>b.sequence-a.sequence).slice(0,50);}
 ackNotification(input,key){return this.store.command(key,{op:'notification.ack',...input},()=>{const n=this.store.get('notification',input.notificationId);n.acknowledged=true;n.acknowledgedAt=this.now();this.store.put('notification',n);return n;});}
 reviewPreparation(raw,{portable=false}={}){
  if(portable){raw=this.configuredPreparation(raw);if(raw.executionPolicy===undefined&&this.executionPolicy)raw={...raw,executionPolicy:this.executionPolicy};}
  if(raw.reviewPolicy?.source==='host'&&(!this.selectedHost||raw.reviewPolicy.hostId!==this.selectedHost))throw Error('Host review requires matching trusted selected host context');
  const mode=this.registry.mode(raw.mode??(this.beta?(this.workerProfile||raw.providerPolicy?'collaborative':'codex_only'):undefined),raw.modeVersion);
  if(!raw.reviewPolicy&&(portable||this.beta||raw.providerPolicy||this.selectedHost)&&mode.review!=='checks'){
   if(!this.selectedHost)throw Error('Select a trusted host in setup or supply an explicitly permitted API review policy');
   return {...raw,reviewPolicy:{version:1,source:'host',hostId:this.selectedHost,fallback:'wait'}};
  }
  return raw;
 }
 configuredPreparation(raw){
  const defaults=this.configuredPolicies;if(!defaults)return raw;
  const mode=this.registry.mode(raw.mode??(defaults.providerPolicy?'collaborative':'codex_only'),raw.modeVersion),next={...raw};
  if(raw.mode===undefined)next.mode=mode.id;
  if(mode.actors.includes('deepseek')&&!raw.providerPolicy&&defaults.providerPolicy){next.providerPolicy=defaults.providerPolicy;if(!raw.routingPolicy&&defaults.routingPolicy)next.routingPolicy=defaults.routingPolicy;}
  if(mode.review!=='checks'&&!raw.reviewPolicy&&defaults.reviewPolicy){next.reviewPolicy=mode.id==='codex_only'?{version:1,source:'host',hostId:this.selectedHost,fallback:'wait'}:defaults.reviewPolicy;}
  return next;
 }
 preparePortableGoal(raw,key){return this.prepareGoal(raw,key,{portable:true});}
 prepareLegacyGoal(raw,key){if(this.beta||raw.providerPolicy||raw.reviewPolicy||raw.routingPolicy||raw.executionPolicy)throw Error('Legacy preparation cannot select portable policy');return this.prepareGoal(raw,key,{legacy:true});}
 goalManifest(raw,providerRegistry=this.providerRegistry,{historic=false,cachedApproval}={}){
  if(!historic)raw=this.reviewPreparation(raw);
  if(!this.beta)return normalizeGoal(raw,this.registry,providerRegistry);
  if(raw.researchPolicy)throw Error('Research is parked in Mosaic Beta');
  const manifest=normalizeGoal({...raw,mode:raw.mode??(this.workerProfile||raw.providerPolicy?'collaborative':'codex_only'),modeVersion:raw.modeVersion??1},this.registry,providerRegistry);
  if(!['collaborative','deepseek_only','codex_only','overnight_review'].includes(manifest.mode.id)||(manifest.mode.version!==1&&!isOvernightV2(manifest)))throw Error('Select a built-in Mosaic Beta workflow');
  manifest.mode={...manifest.mode,capabilities:manifest.mode.capabilities.filter(id=>id!=='research')};
  manifest.capabilities=manifest.capabilities.filter(capability=>capability.id!=='research');
  if(process.platform==='win32' && manifest.project===null && manifest.mode.id==='codex_only' &&
     manifest.reviewPolicy?.source==='host'){
   // Older drafts remain held under their original hash, including retries with
   // a new command key but the same submission identity.
   const originalHash=cachedApproval ? digest(cachedApproval) :
    this.store.db.prepare("SELECT hash FROM submissions WHERE kind='goal' AND scope='' AND key=?").get(manifest.submissionId)?.hash;
   if(originalHash!==digest(manifest)){
    manifest.mode={...manifest.mode,capabilities:['consult']};
    manifest.capabilities=manifest.capabilities.filter(capability=>capability.id==='consult');
   }
  }
  if(manifest.mode.actors.includes('deepseek')&&!manifest.providerPolicy){
   if(cachedApproval){
    // Cached comparison is not new execution authority. Its command/manifest
    // digests were verified before this exact credential-free snapshot is used.
    normalizeWorkerProfile(cachedApproval.workerProfile);
    manifest.workerProfile=structuredClone(cachedApproval.workerProfile);
   }else{
    this.verifyCurrentWorker?.();
    if(!this.workerProfile)throw Error('Configure an API worker in mosaic setup or use codex_only');
    manifest.workerProfile=this.workerProfile;
   }
  }
  return manifest;
 }
 providerBinding(goal,providerId){return manifestProviderBinding(goal.manifest,providerId);}
 verifyWorkerBinding(goal,taskOrBinding,{executionTaskId}={}){
  const executionTaskIdBound=taskOrBinding?.goalId?taskOrBinding.id:executionTaskId;if(executionHolds(this,{goalId:goal.id}).some(row=>!executionTaskIdBound||!row.taskId||row.taskId===executionTaskIdBound))throw Error('Native execution ownership requires exact quiescence before model dispatch');
  this.verifyCurrentWorker?.();
  assertExecutionAvailable(goal.manifest,this.executionConfig);assertNativePreflight(this,goal);
  assertRoutingApproval(goal);
  const task=taskOrBinding&&Object.hasOwn(taskOrBinding,'spec')?taskOrBinding:null;
  // A routed task cannot fall through to legacy transport if approval fields
  // disappear. Its original route remains authoritative on every call path.
  if(task&&(task.route||task.spec?.routing))assertRoutePin(this,goal,task);
  if(goal.manifest.providerPolicy){
   const manifest=goal.manifest,policy=manifest.providerPolicy;
   if(!manifest.mode.actors.includes('deepseek'))throw Error('Mode prohibits API worker dispatch');
   if(!this.providerRegistry)throw Error('Approved provider registry is unavailable');
   if(digest(policy)!==manifest.providerPolicyHash)throw Error('Approved provider policy hash differs');
   // Validate the entire approved pool, including members not selected for this
   // request. A changed catalog never silently narrows the original approval.
   if(digest(normalizeProviderPolicy(policy,this.providerRegistry))!==manifest.providerPolicyHash)throw Error('Approved provider policy changed');
   if(task&&(task.goalId!==goal.id||task.goalVersion!==goal.version||task.spec.actor!=='deepseek'))throw Error('Task provider binding has stale goal version or prohibited actor');
   const binding=task?task.providerBinding:taskOrBinding??this.providerBinding(goal,policy.defaultWorkerId);
   keys(binding,['version','providerId','revision','profileHash','policyHash'],'provider binding');
   const expected=this.providerBinding(goal,binding.providerId);
   if(binding.version!==1||digest(binding)!==digest(expected)||task&&!task.route&&binding.providerId!==policy.defaultWorkerId)throw Error('Task or planner provider binding differs from approved identity');
   const profile=policy.workers.find(worker=>worker.id===binding.providerId);
   if(task&&!profile.capabilities.taskKinds.includes(task.spec.kind))throw Error('Approved provider lacks task kind capability');
   return structuredClone(profile);
  }
  const approved=goal.manifest.workerProfile;
  if(!approved&&!this.beta)return;
  if(!approved||!this.workerProfile||digest(approved)!==digest(this.workerProfile))
   throw Error('Approved API worker profile changed. Prepare and approve a goal with the current worker profile.');
 }
 verifyGoalBinding(goal,{taskId}={}){
  if(executionHolds(this,{goalId:goal.id}).some(row=>!taskId||!row.taskId||row.taskId===taskId))throw Error('Native execution ownership remains held; exact quiescence required');
  this.verifyCurrentWorker?.();
  if(!windowsHostConsult(this,goal.manifest)){
   assertExecutionAvailable(goal.manifest,this.executionConfig);assertNativePreflight(this,goal);
  }
  if(goal.manifest.mode.actors.includes('deepseek'))this.verifyWorkerBinding(goal,undefined,{executionTaskId:taskId});
  if(goal.manifest.reviewPolicy){const policy=normalizeReviewPolicy(goal.manifest.reviewPolicy);if(digest(policy)!==goal.manifest.reviewPolicyHash)throw Error('Approved review policy changed');if(policy.source==='api'&&(!this.providerRegistry||digest(this.providerRegistry.get(policy.reviewer.id,policy.reviewer.revision))!==digest(policy.reviewer)))throw Error('Approved reviewer identity changed');}
 }
 prepareGoal(raw,key,{legacy=false,portable=false}={}){
  const saved=typeof key==='string'?this.store.db.prepare('SELECT hash,result FROM commands WHERE key=?').get(key):null;
  const previous=saved?JSON.parse(saved.result):null;
  if(saved){
   const approved=previous?.manifest;
   if(!approved||previous.hash!==digest(approved)||saved.hash!==digest({op:'goal.prepare',manifest:approved}))throw Error('Idempotency key conflict');
   const catalog=Object.freeze({get(id,revision){
    const profile=approved.providerPolicy?.workers.find(worker=>worker.id===id&&worker.revision===revision)??(approved.reviewPolicy?.reviewer?.id===id&&approved.reviewPolicy.reviewer.revision===revision?approved.reviewPolicy.reviewer:null);
    if(!profile)throw Error('Saved provider revision differs');return structuredClone(profile);
   }});
   let replayRaw=raw;
   // Only a trusted setup context supplying this default type can inherit
   // its approved snapshot. A plain catalog still requires explicit policies.
   for(const field of ['providerPolicy','routingPolicy'])if(this.configuredPolicies?.[field]!==undefined&&raw[field]===undefined&&approved[field]!==undefined)replayRaw={...replayRaw,[field]:approved[field]};
   if(raw.mode===undefined)replayRaw={...replayRaw,mode:approved.mode.id};
   if(raw.modeVersion===undefined)replayRaw={...replayRaw,modeVersion:approved.mode.version};
   replayRaw=raw.reviewPolicy===undefined&&approved.reviewPolicy?{...replayRaw,reviewPolicy:approved.reviewPolicy}:replayRaw;
   if(raw.executionPolicy===undefined&&approved.executionPolicy)replayRaw={...replayRaw,executionPolicy:approved.executionPolicy};
   let manifest;try{manifest=this.goalManifest(replayRaw,catalog,{historic:true,cachedApproval:approved});}catch{throw Error('Idempotency key conflict');}
   return this.store.command(key,{op:'goal.prepare',manifest},()=>{throw Error('Saved preparation command is unavailable');});
  }
  if(this.beta&&!(typeof raw?.submissionId==='string'&&this.store.db.prepare("SELECT 1 FROM submissions WHERE kind='goal' AND scope='' AND key=?").get(raw.submissionId)))this.verifyCurrentWorker?.();
  if(!legacy){raw=this.configuredPreparation(raw);raw=this.reviewPreparation(raw,{portable});if(raw.executionPolicy===undefined&&this.executionPolicy)raw={...raw,executionPolicy:this.executionPolicy};}
  const manifest=legacy?normalizeGoal(raw,this.registry,this.providerRegistry):this.goalManifest(raw);return this.store.command(key,{op:'goal.prepare',manifest},()=>{
  assertCapacityConfiguration(this,manifest);
  const g=this.store.submission('goal','',manifest.submissionId,digest(manifest),id=>({id,manifest,hash:digest(manifest),version:1,status:'draft',createdAt:this.now(),activatedAt:null,deadline:null}));
  this.emit('goal.prepared',g.id,null,{hash:g.hash});return g;
 });}
 activateGoal(input,key){return this.store.command(key,{op:'goal.activate',...input},()=>{
  const g=this.store.get('goal',input.goalId);if(input.hash!==g.hash)throw Error('Exact goal approval hash required');
  if(g.status==='draft'){
   this.verifyGoalBinding(g);assertCapacityConfiguration(this,g.manifest,{excludeGoalId:g.id});
   assertOvernightPreflight(this,g);
   g.status='active';g.activatedAt??=this.now();g.deadline??=g.activatedAt+g.manifest.limits.hours*3600000;
   this.store.put('goal',g);this.emit('goal.activated',g.id,null,{hash:g.hash,version:g.version});
  }
  return g;
 });}
 goalSummaries(){
  const limit=50,maxBytes=65536;
  const total=Number(this.store.db.prepare("SELECT COUNT(*) AS n FROM records WHERE kind='goal'").get().n);
  // Project only saved goal scalars. JSON fragments retain escaped Unicode,
  // including lone surrogates, without hydrating manifests or child records.
  const rows=this.store.db.prepare(`SELECT
   data -> '$.id' AS id, data -> '$.status' AS status,
   data -> '$.hash' AS hash, data -> '$.version' AS version,
   data -> '$.manifest.objective' AS objective,
   data -> '$.manifest.mode.id' AS modeId, data -> '$.manifest.mode.version' AS modeVersion,
   data -> '$.activatedAt' AS activatedAt, data -> '$.deadline' AS deadline
   FROM records INDEXED BY records_kind WHERE kind='goal' ORDER BY rowid DESC LIMIT ?`).all(limit);
  const result={goals:[],total,limit,truncated:total>0};
  for(const row of rows){
   const saved=Object.fromEntries(Object.entries(row).map(([key,value])=>[key,JSON.parse(value??'null')]));
   let objective='',bytes=2;
   for(const point of saved.objective){
    const size=Buffer.byteLength(JSON.stringify(point))-2;
    if(bytes+size>256)break;
    objective+=point;bytes+=size;
   }
   const summary={id:saved.id,status:saved.status,hash:saved.hash,version:saved.version,
    objective,objectiveTruncated:objective!==saved.objective,
    mode:{id:saved.modeId,version:saved.modeVersion},activatedAt:saved.activatedAt,deadline:saved.deadline};
   result.goals.push(summary);result.truncated=result.goals.length<total;
   // Include envelope metadata and actual JSON escaping in the hard byte cap.
   // Keep stable IDs/hashes exact; an oversized row ends this latest-row prefix.
   if(Buffer.byteLength(JSON.stringify(result))>maxBytes){result.goals.pop();break;}
  }
  result.truncated=result.goals.length<total;return result;
 }
 getGoal(id){const g=this.store.get('goal',id),planning=this.store.maybe('planning',id);return {...g,...(isOvernightV2(g.manifest)?{overnightRun:this.store.maybe('overnight_run',id)??null}:{}),planning:planning?{...planning,spent:this.store.spent(id).model??0}:null,tasks:this.store.all('task').filter(t=>t.goalId===id).map(t=>this.getTask(t.id)),reviewerRuns:this.store.all('reviewer').filter(r=>r.goalId===id)};}
 getTask(id){const t=this.store.get('task',id),local=this.store.spent(id),spent={model:0,search:0,download:0,codexReview:0,...(this.store.get('goal',t.goalId).manifest.reviewPolicy?.source==='api'||local.apiReview?{apiReview:0}:{})};for(const k of Object.keys(spent))spent[k]=Math.max(local[k]??0,t.remoteSpent?.[k]??0);return {...t,spent};}
 snapshot(){return {goals:this.store.all('goal').map(g=>this.getGoal(g.id)),notifications:this.notifications(),events:this.store.events(Math.max(0,Number(this.store.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM events').get().n)-1000),1000),operations:this.store.all('operation').slice(-30).map(({result,...r})=>r),registry:this.registry.snapshot()};}
 liveGoal(g){if(g.status!=='active')throw Error('Goal is not active');if(this.now()>=g.deadline)throw Error('Goal deadline exceeded');}
 liveTask(t,{allowStopped=false}={}){const current=this.store.get('task',t.id),g=this.store.get('goal',current.goalId);this.liveGoal(g);if(current.goalVersion!==g.version)throw Error('Task needs explicit rebind to the approved goal version');if(current.deadline&&this.now()>=current.deadline)throw Error('Original task deadline exceeded');if(current.pauseRequested||(current.stopRequested&&!(allowStopped&&current.status==='stopped'&&!current.owner)))throw Error('Task is paused or stopped');return current;}
 startNativeText(input,key){return this.store.command(key,{op:'native.text.start',...input},()=>{
  if(this.beta)this.verifyCurrentWorker?.();
  const t=this.getTask(input.taskId),g=this.store.get('goal',t.goalId);this.liveTask(t);
  if(process.platform==='win32' && this.beta)this.verifyGoalBinding(g,{taskId:t.id});
  if(!g.manifest.mode.actors.includes('codex')||!['consult','learning'].includes(t.spec.kind))throw Error('Mode/capability prohibits native text execution');
  if(t.spec.actor!=='codex')text(input.reason,'takeover reason');
  if(t.owner||!['codex_ready','blocked','stopped','awaiting_review'].includes(t.status))throw Error('Verify quiescence before native execution');
  if(!t.spec.dependsOn.every(id=>this.getTask(id).status==='accepted'))throw Error('Dependencies are incomplete');
  t.status='codex_active';t.executionActor='codex';t.startedAt??=this.now();t.deadline??=Math.min(g.deadline,t.startedAt+t.spec.limits.seconds*1000);this.store.put('task',t);this.learning.pin(t.id);this.emit('task.native_started',g.id,t.id,{kind:t.spec.kind,reason:input.reason??null});return this.getTask(t.id);
 });}
 finishNativeText(input,key){return this.store.command(key,{op:'native.text.finish',...input},()=>{
  const t=this.getTask(input.taskId);this.liveTask(t);if(t.status!=='codex_active'||t.executionActor!=='codex'||!['consult','learning'].includes(t.spec.kind))throw Error('Native text ownership required');
  if(process.platform==='win32' && this.beta)this.verifyGoalBinding(this.store.get('goal',t.goalId),{taskId:t.id});
  const lessons=t.spec.kind==='learning'?this.store.all('lesson').filter(l=>l.maintenanceId===t.id):[];
  if(t.spec.kind==='learning'&&(!lessons.length||lessons.some(l=>l.status==='candidate')||!this.store.all('evaluation').some(e=>lessons.some(l=>l.id===e.lessonId))))throw Error('Native learning needs a protected evaluation and finalized procedure decision');
  text(input.content,'native result',20000);t.result={content:input.content,actor:'codex',accounting:'native host; token totals unavailable',...(lessons.length?{lessons:lessons.map(l=>({id:l.id,status:l.status,recipeHash:l.recipeHash}))}:{})};t.status=this.store.get('goal',t.goalId).manifest.reviewPolicy&&t.spec.kind==='consult'?'awaiting_review':'accepted';this.store.put('task',t);this.emit('task.native_finished',t.goalId,t.id,{status:t.status,actor:'codex'});return this.getTask(t.id);
 });}
 submitTask(input,key){const {goalId,expectedGoalHash,expectedGoalVersion,...raw}=input;return this.store.command(key,{op:'task.submit',...input},()=>{
  const g=this.store.get('goal',goalId);this.liveGoal(g);assertRoutingApproval(g);
  if(expectedGoalHash!==undefined&&expectedGoalHash!==g.hash||expectedGoalVersion!==undefined&&expectedGoalVersion!==g.version)throw Error('Goal approval hash/version changed');
  const duplicate=typeof raw.submissionId==='string'?this.store.db.prepare('SELECT * FROM submissions WHERE kind=? AND scope=? AND key=?').get('task',goalId,raw.submissionId):null;
  const existingTask=duplicate?this.store.get('task',duplicate.id):undefined;
  // Exact retries retain a started task's original routing policy, while
  // current mode/scope and submission identity remain authoritative.
  const manifest=existingTask?taskRoutingManifest(this,g,existingTask):g.manifest;
  const spec=normalizeTask(raw,manifest,this.registry,{existingTask}),hash=digest(spec);
  if(duplicate){if(duplicate.hash!==hash)throw Error('Submission conflict');return this.getTask(duplicate.id);}
  const existing=this.store.all('task').filter(t=>t.goalId===goalId);
  if(existing.length>=g.manifest.limits.maxTasks)throw Error('Goal task cap reached');
  if(spec.kind==='learning'&&existing.some(t=>t.spec.kind==='learning'))throw Error('Learning assignment limit reached');
  for(const id of spec.dependsOn){const dep=this.store.get('task',id);if(dep.goalId!==goalId)throw Error('Dependency outside goal');}
  const providerBinding=spec.actor==='deepseek'&&!spec.routing?this.providerBinding(g,g.manifest.providerPolicy?.defaultWorkerId):undefined;
  if(providerBinding)this.verifyWorkerBinding(g,{goalId,goalVersion:g.version,spec,providerBinding});
  const t=this.store.submission('task',goalId,spec.submissionId,hash,id=>({id,goalId,goalVersion:g.version,spec,hash,...(providerBinding?{providerBinding}:{}),status:spec.actor==='codex'?'codex_ready':'queued',sequence:this.store.all('task').length+1,createdAt:this.now(),startedAt:null,deadline:null,owner:null,checkpoint:{},attempts:0,reviews:0,questions:[],answers:[],feedback:[],yieldRequested:false,pauseRequested:false,stopRequested:false,reviewed:false,result:null}));
  this.emit('task.submitted',goalId,t.id,{actor:spec.actor,kind:spec.kind,hash});this.requestUrgentYield();return this.getTask(t.id);
 });}
 submitWorkflow(input,key){return this.store.command(key,{op:'workflow.submit',...input},()=>{
  identifier(input.submissionId,'submissionId');const g=this.store.get('goal',input.goalId);this.liveGoal(g);
  const definition=this.registry.workflows.get(`${input.workflowId}@${input.version}`);if(!definition)throw Error('Unknown workflow version');if(definition.mode!==g.manifest.mode.id)throw Error('Workflow mode differs from approved policy');
  const definitionHash=digest(definition),hash=digest({goalId:g.id,definitionHash,submissionId:input.submissionId});
  const existing=this.store.db.prepare('SELECT * FROM submissions WHERE kind=? AND scope=? AND key=?').get('workflow_run',g.id,input.submissionId);if(existing){if(existing.hash!==hash)throw Error('Workflow submission conflict');return this.store.get('workflow_run',existing.id);}
  const byKey=new Map(definition.tasks.map(t=>[t.key,t])),ids=new Map();
  const submit=stage=>{if(ids.has(stage.key))return ids.get(stage.key);const dependsOn=(stage.dependsOn??[]).map(k=>submit(byKey.get(k))),{key:stageKey,...spec}=stage;
   // Match newly forwarded scopes themselves. An approved file named
   // "placeholder" does not authorize its whole parent directory.
   if(spec.kind==='coding'&&spec.permissions&&g.manifest.project&&
      ['readPaths','writePaths'].some(name=>spec.permissions[name].some(scope=>!matches(scope,g.manifest.project[name]))))
    throw Error('Workflow task expands scope');
   const task=this.submitTask({goalId:g.id,...spec,dependsOn,submissionId:`${input.submissionId}-${stageKey}`},`wf-${digest({goal:g.id,run:input.submissionId,stageKey})}`);ids.set(stage.key,task.id);return task.id;};
  for(const stage of definition.tasks)submit(stage);
  const run=this.store.submission('workflow_run',g.id,input.submissionId,hash,id=>({id,goalId:g.id,workflowId:input.workflowId,version:input.version,definitionHash,goalVersion:g.version,tasks:[...ids.values()],at:this.now()}));this.emit('workflow.submitted',g.id,null,{id:run.id,definitionHash,tasks:run.tasks});return run;
 });}
 effectivePriorities(tasks=this.store.all('task')){const p=new Map(tasks.map(t=>[t.id,rank[t.priority??t.spec.priority]]));let changed=true;
  while(changed){changed=false;for(const t of tasks)if(!TERMINAL.has(t.status))for(const id of t.spec.dependsOn)if(p.get(id)<p.get(t.id)){p.set(id,p.get(t.id));changed=true;}}
  return p;
 }
 eligible(t){const g=this.store.get('goal',t.goalId),now=this.now();return !(t.routingWait&&t.routingWait.retryAt>now)&&!(isOvernightV2(g.manifest)&&t.providerWait&&(t.providerWait.retryAt>now||t.providerWait.until<=now))&&g.status==='active'&&g.deadline>now&&(!t.deadline||t.deadline>now)&&!(g.integrationSealed&&t.spec.kind==='coding')&&!t.pauseRequested&&!t.stopRequested&&t.goalVersion===g.version&&t.spec.dependsOn.every(id=>this.store.get('task',id).status==='accepted')&&!capacityWaitHeld(this,t,g);}
 settleTask(t,status,reason,event='task.'+status,data={}){
  if(executionHolds(this,{goalId:t.goalId}).some(row=>!row.taskId||row.taskId===t.id)){if(t.native?.writerActive||t.status==='uncertain')return this.getTask(t.id);t.status='uncertain';t.reason='Native execution outcome unknown; exact quiescence required';this.store.put('task',t);return this.getTask(t.id);}
  const overnight=isOvernightV2(this.store.get('goal',t.goalId).manifest);
  if(status==='blocked'&&overnight)t.firstBlocker??={reason,at:this.now()};
  if(status==='partial'&&t.status==='blocked'&&t.reason&&overnight)t.firstBlocker??={reason:t.reason,at:this.now()};
  t.status=status;t.reason=reason;t.owner=null;this.store.put('task',t);
  this.emit(event,t.goalId,t.id,{reason,...data});return this.getTask(t.id);
 }
 expireQuiescent(){return this.store.tx(()=>{
  for(const t of this.store.unfinishedTasks()){
   const g=this.store.get('goal',t.goalId),now=this.now();
   if(executionHolds(this,{goalId:g.id}).some(row=>!row.taskId||row.taskId===t.id)||t.owner||t.status==='legacy_reviewing'||t.executionActor==='codex'||g.integrationOwner===t.id)continue;
   if(now>=Math.min(g.deadline,t.deadline??g.deadline)){
    this.settleTask(t,'partial','Original deadline reached; saved evidence retained','task.expired');
   }else if(t.providerWait&&['queued','suspended'].includes(t.status)&&now>=t.providerWait.until){
    this.settleTask(t,'blocked','Original provider reconnect window exhausted','task.blocked',{requestId:t.providerWait.requestId??null});
   }
  }
 });}
 requestUrgentYield(){const tasks=this.store.unfinishedTasks(),p=this.effectivePriorities(tasks);for(const active of tasks.filter(t=>t.status==='running'&&t.spec.actor==='deepseek'))if(tasks.some(t=>['queued','suspended'].includes(t.status)&&this.eligible(t)&&p.get(t.id)>p.get(active.id))){active.yieldRequested=true;this.store.put('task',active);this.emit('task.yield_requested',active.goalId,active.id);}}
 claimNext(owner,readiness){identifier(owner,'owner');return this.store.tx(()=>{
  const lease=this.store.maybe('lease','coordinator');
  if(lease)this.currentLease(lease.token);
  const tasks=this.store.unfinishedTasks();
  const existing=tasks.find(t=>t.status==='running'&&t.owner===owner&&t.interruptedOwner!==owner&&this.store.get('goal',t.goalId).manifest.providerPolicy);if(existing){this.owned(existing.id,owner);return this.getTask(existing.id);}
  if(readiness){const target=this.store.get('task',readiness.taskId),goal=this.store.get('goal',target.goalId);if(target.hash!==readiness.taskHash||digest(target.spec)!==readiness.taskHash||goal.hash!==readiness.goalHash||goal.version!==readiness.goalVersion||target.goalVersion!==goal.version||(this.workerLease?.generation??null)!==readiness.lease||!this.eligible(target))return null;}
  const candidates=orderedCandidates(this,tasks);
  if(!candidates.length)return null;
  const snapshot=capacitySnapshot(this);
  for(const t of candidates){
   const g=this.store.get('goal',t.goalId);
   const admission=canClaim({task:t,goal:g,snapshot});if(!admission.allowed){this.lastCapacityWait={taskId:t.id,...admission};continue;}
   let routed=false;
   if(isRoutedTask(g,t)&&!t.providerBinding){
    let decision;try{decision=routeDecision(this,g,t,readiness?.taskId===t.id?readiness.observation:undefined);}
    catch(error){this.settleTask(t,'blocked',String(error.message).slice(0,500));continue;}
    if(decision.status==='ineligible'){this.settleTask(t,'blocked',decision.explanation);continue;}
    if(decision.status!=='selected'){if(readiness?.taskId===t.id)recordRoutingWait(this,t,g,decision);continue;}
    const route={version:1,goalHash:g.hash,goalVersion:g.version,taskHash:t.hash,decision},pin={providerBinding:decision.binding,route,routeHash:digest(route)};
    try{this.verifyWorkerBinding(g,{...t,...pin});}
    catch(error){this.settleTask(t,'blocked','Approved API worker binding cannot be used: '+String(error.message).slice(0,500));continue;}
    Object.assign(t,pin);delete t.routingWait;routed=true;
   }
   if(g.manifest.providerPolicy){
    try{this.verifyWorkerBinding(g,t);}catch(error){
     this.settleTask(t,'blocked','Approved API worker binding cannot be used: '+String(error?.message??error).slice(0,500)+'. Restore the approved provider configuration, or prepare and approve a new goal with the current catalog.');
     continue;
    }
   }
   const wait=pinnedResourceWait(this,g,t);
   if(wait){recordRoutingWait(this,t,g,wait);continue;}
   delete t.routingWait;
   t.startedAt??=this.now();t.deadline??=Math.min(g.deadline,t.startedAt+t.spec.limits.seconds*1000);t.owner=owner;t.status='running';t.yieldRequested=false;
   if(g.manifest.providerPolicy)t.runnerGeneration=(t.runnerGeneration??0)+1;
   delete t.interruptedOwner;delete t.capacityWait;
   if(lease)t.ownerLease=lease.generation;else delete t.ownerLease;
   this.store.put('task',t);if(routed)this.emit('task.routed',t.goalId,t.id,{routeHash:t.routeHash,route:t.route});this.learning.pin(t.id);this.emit('task.claimed',t.goalId,t.id,{owner});return this.getTask(t.id);
  }
  return null;
 });}
 owned(id,owner){
  const t=this.store.get('task',id);
  if(t.owner!==owner||t.interruptedOwner===owner||!SLOT.has(t.status))throw Error('Worker ownership conflict');
  // Older records and direct fixture workers may not carry a lease generation.
  if(t.ownerLease){
   const lease=this.currentLease(this.workerLease?.token);
   if(lease.generation!==t.ownerLease)throw Error('Worker lease ownership conflict');
  }
  return t;
 }
 reserve(taskId,{key,kind},owner){identifier(key,'request key');return this.store.tx(()=>{
  const saved=this.store.request(taskId,key);
  if(saved&&saved.kind!==kind)throw Error('Request key conflict');
  if(saved&&saved.status!=='completed')throw Error('Request is ambiguous and remains spent');
  const t=this.owned(taskId,owner),g=this.store.get('goal',t.goalId);this.liveGoal(g);if(t.status!=='running'||this.now()>=t.deadline||t.stopRequested||t.pauseRequested)throw Error('Task deadline/control prevents request');
  if(t.spec.actor!=='deepseek'||!g.manifest.mode.actors.includes('deepseek'))throw Error('Mode prohibits model actor');
  if(kind==='model'&&g.manifest.providerPolicy){
   this.verifyWorkerBinding(g,t);
   if(saved&&(digest(saved.providerBinding??null)!==digest(t.providerBinding)||saved.routeHash!==t.routeHash))throw Error('Saved request provider binding differs from the task');
  }
  if(saved)return {...saved,cached:true};
  let capacityResource=null;try{if(kind==='model')capacityResource=assertInferenceCapacity(this,g,t.providerBinding);}catch(error){if(error.waiting)error.requestKey=key;throw error;}
  const wait=kind==='model'?t.providerWait:null;
  if(wait){
   if(wait.readyOwner!==owner||this.now()>=wait.until)throw Error('Original provider reconnect window exhausted or readiness no longer verified');
   delete t.providerWait;this.store.put('task',t);
  }
  const budget={model:'modelCalls',search:'searches',download:'downloads'}[kind];if(!budget||!t.spec.limits[budget])throw Error('Unsupported request kind');
  if((this.store.spent(taskId)[kind]??0)>=t.spec.limits[budget])throw Error('Request budget limit reached');
  if(kind==='model'&&!g.manifest.providerPolicy)this.verifyWorkerBinding(g);
  const profile=kind==='model'?g.manifest.workerProfile:null;
  if(profile&&!t.workerProfile){t.workerProfile=profile;this.store.put('task',t);}
  const id=randomUUID(),data={owner,reservedAt:this.now(),...(t.runnerGeneration?{taskGeneration:t.runnerGeneration}:{}),...(capacityResource?{capacityResource}:{}),...(profile?{workerProfile:profile}:{}),...(kind==='model'&&t.providerBinding?{providerBinding:t.providerBinding}:{}),...(kind==='model'&&t.routeHash?{routeHash:t.routeHash}:{}),...(wait?{reconnectUntil:wait.until}:{})};this.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?)').run(id,taskId,key,kind,'reserved',JSON.stringify(data));
  this.emit('request.reserved',t.goalId,taskId,{id,key,kind});return {id,task_id:taskId,key,kind,status:'reserved',...data,cached:false};
 });}
 ownedRequest(id,owner){
  const row=this.store.db.prepare('SELECT * FROM requests WHERE id=?').get(id);
  if(!row)throw Error('Unknown request');
  const data=JSON.parse(row.data);
  // Legacy review uses its separate reserved-review lifecycle.
  if(data.owner===undefined&&row.kind==='codexReview')return {row,data,t:this.store.get('task',row.task_id)};
  const t=this.owned(row.task_id,owner??data.owner);
  if(t.status!=='running'||t.owner!==data.owner)throw Error('Worker request ownership conflict');
  if(data.taskGeneration!==undefined&&data.taskGeneration!==t.runnerGeneration)throw Error('Worker request generation conflict');
  return {row,data,t};
 }
 saveRequest(id,result,owner){return this.store.tx(()=>{
  const {row,data,t}=this.ownedRequest(id,owner);
  if(row.status==='completed'){if(digest(data.result)!==digest(result))throw Error('Saved response conflict');return data.result;}
  if(row.status!=='reserved')throw Error('Request is no longer reserved');
  data.result=result;data.savedAt=this.now();this.store.db.prepare('UPDATE requests SET status=?,data=? WHERE id=?').run('completed',JSON.stringify(data),id);this.emit('request.saved',t.goalId,t.id,{id});return result;
 });}
 failModelRequest(id,owner,{reason,outcome,reconnect,retryHint}){return this.store.tx(()=>{
  const {row,data,t}=this.ownedRequest(id,owner),g=this.store.get('goal',t.goalId),at=this.now();
  if(row.kind!=='model'||row.status!=='reserved')throw Error('Model request is no longer reserved');
  this.store.db.prepare('UPDATE requests SET status=?,data=? WHERE id=?').run('failed',JSON.stringify({...data,error:reason,requestOutcome:outcome}),id);
  if(outcome==='unknown'){
   t.status='uncertain';t.reason=reason;t.firstBlocker??={reason,at};
   this.store.put('task',t);this.emit('task.uncertain',t.goalId,t.id,{reason,requestId:id});return this.getTask(t.id);
  }
  const controlled=controlledStatus(t,g,at);
  // A control arriving during initial discovery spends the reservation but
  // sends no request. Resume coding under a new exchange, never replay that
  // failed key or classify the deliberate hold as a provider outage.
  if(!reconnect&&outcome==='not_dispatched'&&controlled&&t.spec.kind==='coding'&&t.checkpoint.phase==='model'){
   t.checkpoint={...t.checkpoint,exchange:t.checkpoint.exchange+1};
  }
  if(reconnect&&isOvernightV2(g.manifest)&&t.spec.kind==='coding'&&t.checkpoint.phase==='model'){
   t.providerReconnectStartedAt??=at;
   const until=Math.min(t.deadline,g.deadline,t.providerReconnectStartedAt+g.manifest.overnightPolicy.reconnectMs);
   t.providerWait={startedAt:t.providerReconnectStartedAt,until,retryAt:reconnectRetryAt(at,until,retryHint),requestId:id};
   t.checkpoint={...t.checkpoint,exchange:t.checkpoint.exchange+1};
   t.reason='Known provider unavailability; original request remains spent';
   t.firstBlocker??={reason:t.reason,at};
   if(controlled)return this.settleTask(t,controlled,controlled==='partial'?'Original deadline reached; saved evidence retained':t.reason,controlled==='partial'?'task.expired':'task.'+controlled,{requestId:id});
   if(at>=until)return this.settleTask(t,'blocked','Original provider reconnect window exhausted','task.blocked',{requestId:id});
   if(t.providerWait.retryAt>=until)return this.settleTask(t,'blocked','No eligible provider retry remains in original reconnect window','task.blocked',{requestId:id});
   t.status='suspended';t.owner=null;this.store.put('task',t);
   this.emit('task.provider_wait',t.goalId,t.id,{until,requestId:id});return this.getTask(t.id);
  }
  return this.settleTask(t,controlled??'blocked',controlled==='partial'?'Original deadline reached; saved evidence retained':reason,controlled==='partial'?'task.expired':undefined,{requestId:id});
 });}
 finishProviderProbe(taskId,owner,available,{retryHint}={}){return this.store.tx(()=>{
  const t=this.owned(taskId,owner),g=this.store.get('goal',t.goalId),wait=t.providerWait,at=this.now();
  if(t.status!=='running'||!wait)throw Error('Worker provider probe ownership conflict');
  const controlled=controlledStatus(t,g,at),data={requestId:wait.requestId??null};
  if(controlled)return this.settleTask(t,controlled,controlled==='partial'?'Original deadline reached; saved evidence retained':t.reason,controlled==='partial'?'task.expired':'task.'+controlled,data);
  if(at>=wait.until)return this.settleTask(t,'blocked','Original provider reconnect window exhausted','task.blocked',data);
  if(available)wait.readyOwner=owner;
  else{
   delete wait.readyOwner;wait.retryAt=reconnectRetryAt(at,wait.until,retryHint);
   if(wait.retryAt>=wait.until)return this.settleTask(t,'blocked','No eligible provider retry remains in original reconnect window','task.blocked',data);
   t.status='suspended';t.owner=null;
  }
  this.store.put('task',t);return this.getTask(t.id);
 });}
 failTaskStep(taskId,owner,reason){return this.store.tx(()=>{
  const t=this.owned(taskId,owner),g=this.store.get('goal',t.goalId),at=this.now(),controlled=controlledStatus(t,g,at);
  if(executionHolds(this,{goalId:g.id}).some(row=>!row.taskId||row.taskId===taskId)){t.status='uncertain';t.reason='Native execution outcome unknown; exact quiescence required';this.store.put('task',t);return this.getTask(t.id);}
  if(controlled)return this.settleTask(t,controlled,controlled==='partial'?'Original deadline reached; saved evidence retained':reason,controlled==='partial'?'task.expired':undefined);
  if(t.providerWait&&at>=t.providerWait.until)reason='Original provider reconnect window exhausted';
  return this.settleTask(t,'blocked',reason);
 });}
 beginAttempt(taskId,owner){return this.store.tx(()=>{const t=this.owned(taskId,owner);if(t.attempts>=t.spec.limits.attempts)throw Error('Attempt limit reached');t.attempts++;this.store.put('task',t);this.emit('attempt.started',t.goalId,t.id,{attempt:t.attempts});return t.attempts;});}
 boundary(taskId,checkpoint,owner,{quiescent=true}={}){return this.store.tx(()=>{const t=this.owned(taskId,owner),g=this.store.get('goal',t.goalId);t.checkpoint=checkpoint;
  if(quiescent&&executionHolds(this,{goalId:g.id}).some(row=>!row.taskId||row.taskId===taskId)){t.status='uncertain';t.reason='Native execution quiescence remains unknown';this.store.put('task',t);return this.getTask(t.id);}
  if(!quiescent){this.store.put('task',t);this.emit('task.checkpoint',t.goalId,t.id,{status:t.status,quiescent:false});return this.getTask(t.id);}
  if(this.now()>=Math.min(g.deadline,t.deadline)){t.status='partial';t.reason='Deadline reached';}
  else if(t.stopRequested||g.status==='stopped')t.status='stopped';
  else if(t.pauseRequested||g.status==='paused')t.status='paused';
  else if(t.yieldRequested)t.status='suspended';
  if(t.status!=='running')t.owner=null;this.store.put('task',t);this.emit('task.checkpoint',t.goalId,t.id,{status:t.status});return this.getTask(t.id);
 });}
 ask(taskId,question,checkpoint,owner){text(question,'question',8000);return this.store.tx(()=>{const t=this.owned(taskId,owner),g=this.store.get('goal',t.goalId);
  if(t.questions.length>=t.spec.limits.questions)throw Error('Clarification limit reached');
  const q={id:randomUUID(),text:question,at:this.now()};t.questions.push(q);t.status=g.manifest.mode.actors.includes('codex')?'awaiting_supervisor':'awaiting_user';t.checkpoint=checkpoint;t.owner=null;
  this.store.put('task',t);this.emit('task.question',t.goalId,t.id,q);return this.getTask(t.id);
 });}
 answer(input,key){return this.store.command(key,{op:'task.answer',...input},()=>{const t=this.store.get('task',input.taskId),g=this.store.get('goal',t.goalId);this.liveGoal(g);
  if(!['awaiting_supervisor','awaiting_user'].includes(t.status))throw Error('Task is not waiting for an answer');
  if(input.expectedGoalHash!==undefined&&g.hash!==input.expectedGoalHash)throw Error('The approved goal changed. Refresh the inbox.');
  if(input.expectedQuestionId!==undefined&&input.expectedQuestionId!==t.questions.at(-1)?.id)throw Error('The saved question changed. Refresh the inbox.');
  if(t.status==='awaiting_user'&&input.responder!=='user')throw Error('This mode requires a user answer');
  this.liveTask(t);const help=this.store.all('help_link').find(l=>l.taskId===t.id&&l.questionId===t.questions.at(-1)?.id);if(help&&this.getTask(help.helperTaskId).status!=='accepted')throw Error('Linked helper must be accepted before answering');
  text(input.answer,'answer',8000);const answer={questionId:t.questions.at(-1).id,text:input.answer,responder:input.responder,at:this.now()};if(help){answer.helperTaskId=help.helperTaskId;answer.helperResultHash=digest(this.getTask(help.helperTaskId).result);help.status='answered';help.answeredAt=this.now();help.resultHash=answer.helperResultHash;this.store.put('help_link',help);}t.answers.push(answer);t.status=t.spec.actor==='codex'?'codex_ready':'queued';this.store.put('task',t);this.emit('task.answered',t.goalId,t.id,answer);this.requestUrgentYield();return this.getTask(t.id);
 });}
 completeTask(taskId,result,owner,{reviewRequired=false}={}){return this.store.tx(()=>{const t=this.owned(taskId,owner),g=this.store.get('goal',t.goalId);if(t.spec.kind==='research'&&t.spec.researchPolicy?.version===3&&result.receiptStatus!=='partial'&&(!result.reviewBinding||result.independentReview!=='accepted'))throw Error('Reviewed research requires accepted bound receipt');if(t.spec.kind==='research'&&t.spec.researchPolicy?.version===3&&result.receiptStatus!=='partial'){const accepted=verifyLocalAcceptance(t,id=>this.store.maybe('reviewer',id));if(result.remoteJobId!==accepted.jobId||digest(result.reviewBinding)!==digest(accepted.descriptor))throw Error('Result differs from authoritative local research acceptance');}t.result=result;t.owner=null;t.yieldRequested=false;
  t.status=(t.spec.kind==='research'&&result.receiptStatus==='partial')||this.now()>=Math.min(g.deadline,t.deadline)?'partial':t.spec.kind==='coding'?(g.manifest.mode.review==='checks'?'ready_to_integrate':g.manifest.reviewPolicy?'awaiting_review':g.manifest.mode.review==='legacy'?'awaiting_legacy_review':'awaiting_review'):reviewRequired&&(g.manifest.reviewPolicy||g.manifest.mode.review==='operator')?'awaiting_review':'accepted';
  if(t.status!=='partial'&&(t.stopRequested||g.status==='stopped')){t.controlReturnStatus=t.status;t.status='stopped';}
  else if(t.status!=='partial'&&(t.pauseRequested||g.status==='paused')){t.controlReturnStatus=t.status;t.status='paused';}
  this.store.put('task',t);this.emit('task.result',t.goalId,t.id,{status:t.status,result});return this.getTask(t.id);
 });}
 review(input,key){return this.store.command(key,{op:'task.review',...input},()=>{const t=this.store.get('task',input.taskId),g=this.store.get('goal',t.goalId);this.liveTask(t);if(g.manifest.reviewPolicy)throw Error('Use bound review_submit for this policy');if(t.spec.kind==='research'&&t.spec.researchPolicy?.version===3)throw Error('Use hash-bound research_review for this research contract');if(g.manifest.mode.review!=='operator')throw Error('Mode prohibits Codex operator review');if(t.status!=='awaiting_review')throw Error('Task is not awaiting review');if(t.reviews>=t.spec.limits.reviews)throw Error('Review limit reached');if(!['accept','revise'].includes(input.decision))throw Error('Invalid review decision');text(input.feedback,'feedback',12000);t.reviews++;t.feedback.push({decision:input.decision,text:input.feedback,at:this.now()});t.reviewed=true;
  if(g.integrationPending?.taskId===t.id)throw Error('Pending integration must finish before revision');
  const exhausted=t.reviews>=t.spec.limits.reviews||t.attempts>=t.spec.limits.attempts||(this.store.spent(t.id).model??0)>=t.spec.limits.modelCalls;
  t.status=input.decision==='accept'?(t.spec.kind==='coding'?'ready_to_integrate':'accepted'):exhausted?'blocked':t.native?.layout==='candidate_v1'?'codex_ready':'queued';if(input.decision==='revise'){if(t.native?.layout==='candidate_v1')t.native.status='revision_requested';t.checkpoint={...t.checkpoint,phase:'attempt'};if(exhausted)t.reason='Revision cannot proceed: original review, attempt or request budget exhausted';}
  this.store.put('task',t);this.emit('task.reviewed',t.goalId,t.id,{decision:input.decision});this.requestUrgentYield();return this.getTask(t.id);});}
 setPriority(input,key){return this.store.command(key,{op:'task.priority',...input},()=>{const t=this.store.get('task',input.taskId);if(!(input.priority in rank))throw Error('Invalid priority');if(t.spec.kind==='learning'&&input.priority!=='background')throw Error('Learning priority must remain background');text(input.reason,'priority reason',2000);t.priority=input.priority;this.store.put('task',t);this.emit('task.priority',t.goalId,t.id,{priority:input.priority,reason:input.reason});this.requestUrgentYield();return this.getTask(t.id);});}
 control(input,key){return this.store.command(key,{op:'control',...input},()=>{
  if(!['pause','stop','resume'].includes(input.action))throw Error('Invalid control');
  const g=input.goalId?this.store.get('goal',input.goalId):this.store.get('goal',this.store.get('task',input.taskId).goalId);
  if(input.expectedControlBinding!==undefined&&input.expectedControlBinding!==controlBinding(this.store,g,input.taskId?this.store.get('task',input.taskId):null))throw Error('Control state changed. Refresh the inbox.');
  if(input.action==='resume'&&executionHolds(this,{goalId:g.id}).some(row=>!input.taskId||!row.taskId||row.taskId===input.taskId))throw Error('Native execution remains held; exact quiescence required before resume');
  if(input.action==='resume'&&g.status==='draft'&&isOvernightV2(g.manifest))throw Error('Use exact goal_activate after successful preflight');
  if(input.action==='resume'&&this.now()>=g.deadline)throw Error('Original deadline exceeded');
  const targets=this.store.all('task').filter(t=>input.goalId?t.goalId===g.id:t.id===input.taskId);
  if(input.goalId){if(['completed','partial'].includes(g.status))throw Error('Goal is terminal');g.status=input.action==='resume'?'active':input.action==='stop'?'stopped':'paused';this.store.put('goal',g);}
  for(const t of targets){
   if(TERMINAL.has(t.status))continue;if(t.status==='uncertain'){if(input.action==='resume'&&isNativeExecution(g.manifest)&&this.workerLease){this.recoverSaved(t.id,this.workerLease.token);Object.assign(t,this.store.get('task',t.id));}else throw Error('Uncertain ownership must be reconciled');}
   if(input.action==='resume'){
    if(t.deadline&&this.now()>=t.deadline)continue;t.stopRequested=t.pauseRequested=false;
    if(['paused','stopped'].includes(t.status)){t.status=t.controlReturnStatus??(t.executionActor==='codex'?'codex_active':t.spec.actor==='codex'?'codex_ready':'queued');delete t.controlReturnStatus;}
   }else if(['running','legacy_reviewing'].includes(t.status)){t.pauseRequested=input.action==='pause';t.stopRequested=input.action==='stop';}
   else if(!t.owner&&!['paused','stopped'].includes(t.status)){t.controlReturnStatus=t.status;t.status=input.action==='stop'?'stopped':'paused';t.pauseRequested=input.action==='pause';t.stopRequested=input.action==='stop';}
   this.store.put('task',t);
  }
  if(input.goalId&&input.action==='resume'){
   const planning=this.store.maybe('planning',g.id);
   if(planning?.recoveryPending){
    if(this.workerLease)this.recoverPlanning(g.id,this.workerLease.token);
    else{planning.status='uncertain';this.store.put('planning',planning);}
   }
  }
  this.emit('work.control',g.id,input.taskId??null,{action:input.action});return input.goalId?this.getGoal(g.id):this.getTask(input.taskId);
 });}
 markUncertain(taskId,reason,owner){return this.store.tx(()=>{const t=this.owned(taskId,owner);t.status='uncertain';t.reason=reason;this.store.put('task',t);this.emit('task.uncertain',t.goalId,t.id,{reason});return this.getTask(t.id);});}
 reserveReviewer(input,key){return this.store.command(key,{op:'reviewer.reserve',...input},()=>{const t=this.store.get('task',input.taskId),g=this.store.get('goal',t.goalId);this.liveGoal(g);if(g.manifest.reviewPolicy)throw Error('Use bound review_reserve for this policy');if(g.manifest.mode.review!=='operator')throw Error('Mode prohibits reviewer');if(this.beta&&t.spec.kind==='coding'&&!['awaiting_review','ready_to_integrate'].includes(t.status))throw Error('Wait for the protected checks before reserving a reviewer');const runs=this.store.all('reviewer').filter(r=>r.goalId===g.id);if(runs.some(r=>r.status==='reserved'))throw Error('A reviewer is already active');if(runs.length>=g.manifest.limits.reviewAgentRuns)throw Error('Reviewer budget limit reached');const run={id:randomUUID(),goalId:g.id,taskId:t.id,status:'reserved',at:this.now()};this.store.put('reviewer',run);this.emit('reviewer.reserved',g.id,t.id,{id:run.id});return run;});}
 finishReviewer(input,key){return this.store.command(key,{op:'reviewer.finish',...input},()=>{const r=this.store.get('reviewer',input.reservationId);if(this.store.get('goal',r.goalId).manifest.reviewPolicy)throw Error('Use bound review_submit for this policy');if(r.status!=='reserved')throw Error('Reviewer is already finalized');r.status=input.error?'failed':'completed';r.result=input.result??null;r.error=input.error??null;this.store.put('reviewer',r);this.emit('reviewer.finished',r.goalId,r.taskId,{id:r.id,status:r.status});return r;});}
}
