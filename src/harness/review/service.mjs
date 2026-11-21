import {assertInferenceCapacity,inferenceWait,CapacityWaitError,capacitySnapshot} from '../scheduling/capacity.mjs';
import {randomUUID} from 'node:crypto';
import {digest,keys,identifier,integer} from '../contracts.mjs';
import {normalizeReviewPolicy,normalizeVerdict,assertReviewMode,assertBinding,bindingFields,reviewerIdentity} from './contracts.mjs';
import {candidateEvidence,reviewRubric,savedCandidateIdentity} from './evidence.mjs';

const apiAuthority=Symbol('API review submission');
function apiError(reasonCode,message){const error=Error(message);error.reviewReasonCode=reasonCode;return error;}
function reviewDisclosure(policy,evidence){
 const recipient=policy.source==='host'
  ?{source:'host',hostId:policy.hostId,mayUseCloudService:true}
  :{source:'api',baseUrl:policy.reviewer.baseUrl,model:policy.reviewer.model,transport:policy.reviewer.transport};
 return {
  recipient,
  files:Object.keys(evidence.snapshot??{}),
  checks:evidence.checks.map(({id,stdout,stderr})=>({id,stdoutCharacters:stdout.length,stderrCharacters:stderr.length})),
  includesTaskSummary:Object.hasOwn(evidence,'summary'),
 };
}
const commandReplay=(c,key,input)=>{
 identifier(key,'idempotencyKey');const saved=c.store.db.prepare('SELECT hash,result FROM commands WHERE key=?').get(key);
 if(!saved)return null;if(saved.hash!==digest(input))throw Error('Idempotency key conflict');return {result:JSON.parse(saved.result)};
};
function policyFor(c,t){
 const g=c.store.get('goal',t.goalId);c.liveGoal(g);c.liveTask(t);
 if(!g.manifest.reviewPolicy)throw Error('A versioned review policy is required');
 if(g.hash!==digest(g.manifest)||t.hash!==digest(t.spec))throw Error('Approved goal or task hash changed');
 const policy=normalizeReviewPolicy(g.manifest.reviewPolicy);assertReviewMode(g.manifest.mode,policy);
 if(digest(policy)!==g.manifest.reviewPolicyHash)throw Error('Approved review policy hash changed');
 if(policy.source==='host'&&c.selectedHost!==policy.hostId)throw Error('Selected host differs from approved reviewer host');
 if(t.owner||t.native?.writerActive||!['awaiting_review','ready_to_integrate'].includes(t.status))throw Error('Candidate is not awaiting bound review');
 if(t.goalVersion!==g.version)throw Error('Review candidate has stale goal version');
 return {g,policy};
}
export class ReviewService {
 #runs=new Map();
 constructor({c,providers,hostRegistry}={}){this.c=c;this.providers=providers??c.providerRegistry;this.hostRegistry=hostRegistry??null;}
 async context(taskId,options={}){
  const t=this.c.getTask(taskId),{g,policy}=policyFor(this.c,t),candidate=await candidateEvidence(this.c,t,options);
  // Filesystem/network awaits never extend an approval or a task generation.
  const current=this.c.getTask(taskId),fresh=policyFor(this.c,current);
  if(g.hash!==fresh.g.hash||g.version!==fresh.g.version||digest(savedCandidateIdentity(current))!==digest(savedCandidateIdentity(t)))throw Error('Candidate or approval changed while collecting evidence');
  const binding={goalId:g.id,goalVersion:g.version,goalHash:g.hash,taskId:t.id,candidateHash:candidate.candidateHash,checksHash:candidate.checksHash,rubricHash:digest(reviewRubric(g,t)),reviewPolicyHash:g.manifest.reviewPolicyHash,generation:t.native?.generation??t.checkpoint?.attempt??1,expiresAt:Math.min(g.deadline,t.deadline??g.deadline)};
  return {t,g,policy,binding,candidate,disclosure:reviewDisclosure(policy,candidate.evidence)};
 }
 async inbox({goalId,cursor,limit=20}={}){
  if(goalId!==undefined)identifier(goalId,'goalId');integer(limit,'review inbox limit',1,20);
  if(cursor!==undefined&&(typeof cursor!=='string'||!/^\d{1,10}$/.test(cursor)))throw Error('Invalid review inbox cursor');
  const after=Number(cursor??0),tasks=this.c.store.all('task').filter(t=>t.sequence>after&&(!goalId||t.goalId===goalId)&&t.status==='awaiting_review'&&this.c.store.get('goal',t.goalId).manifest.reviewPolicy).sort((a,b)=>a.sequence-b.sequence);
  const items=[];let scanned=after;
  for(const task of tasks){
   if(items.length>=limit)break;scanned=task.sequence;
   try{const context=await this.context(task.id,{includeFiles:false});items.push({taskId:task.id,binding:context.binding,disclosure:context.disclosure,reviewer:reviewerIdentity(context.policy),delivery:context.policy.source==='host'?'pull':'api',waitingForHost:context.policy.source==='host',ticketId:this.c.store.all('review_ticket').findLast(r=>r.taskId===task.id&&r.status==='reserved')?.id??null});}
   catch(error){items.push({taskId:task.id,status:'unavailable',reason:String(error.message).slice(0,500)});}
  }
  return {items,cursor:tasks.some(t=>t.sequence>scanned)?String(scanned):null};
 }
 budget(goal){
  const history=this.c.store.all('goal_history').filter(row=>row.goalId===goal.id);
  const limit=Math.min(goal.manifest.limits.reviewAgentRuns,...history.map(row=>row.manifest.limits.reviewAgentRuns));
  const count=kind=>Number(this.c.store.db.prepare("SELECT COUNT(*) AS n FROM records WHERE kind=? AND json_extract(data,'$.goalId')=?").get(kind,goal.id).n);
  const spent=count('review_ticket')+count('reviewer');
  return {limit,spent,remaining:Math.max(0,limit-spent)};
 }
 async reserve(input,key){
  keys(input,[...bindingFields],'review reservation');
  const command={op:'review.reserve',...input},old=commandReplay(this.c,key,command);
  const hostOnly=source=>{if(source==='api')throw Error('API review evidence is reserved for the approved API reviewer');};
  if(old){hostOnly(old.result.reviewer?.source);return old.result;}
  hostOnly(policyFor(this.c,this.c.getTask(input.taskId)).policy.source);
  const context=await this.context(input.taskId);hostOnly(context.policy.source);assertBinding(input,context.binding);
  return this.#reserveContext(input,key,context);
 }
 #reserveContext(input,key,context){
  const command={op:'review.reserve',...input},{binding,policy}=context;
  if(policy.source==='host'&&this.c.selectedHost&&this.c.selectedHost!==policy.hostId)throw Error('Selected host differs from approved reviewer host');
  if(policy.source==='host'&&this.hostRegistry)this.hostRegistry.get(policy.hostId);
  return this.c.store.command(key,command,()=>{
   const t=this.c.getTask(input.taskId),{g}=policyFor(this.c,t);
   if(digest(savedCandidateIdentity(t))!==digest(savedCandidateIdentity(context.t))||g.hash!==context.g.hash)throw Error('Candidate changed before review reservation');
   for(const existing of this.c.store.all('review_ticket').filter(r=>r.taskId===t.id&&r.status==='reserved')){
    if(existing.reviewer.source!=='host'||!bindingFields.some(field=>existing.binding[field]!==binding[field]))throw Error('Review ticket already reserved; reconnect to the saved ticket');
    // Only a host ticket with a definitively superseded binding can retire.
    // Retain the original count, reviewer, request identity and expiry; API
    // reservations never use this recovery, regardless of remote outcome.
    existing.status='stale';existing.reasonCode='binding_superseded';existing.staleAt=this.c.now();this.c.store.put('review_ticket',existing);
    this.c.emit('review.stale',g.id,t.id,{ticketId:existing.id,reasonCode:existing.reasonCode});
   }
   if(t.reviews>=t.spec.limits.reviews||this.budget(g).remaining===0)throw Error('Original review budget exhausted');
   const ticket={id:randomUUID(),goalId:g.id,taskId:t.id,binding,reviewer:reviewerIdentity(policy),requestId:randomUUID(),savedCandidateIdentity:savedCandidateIdentity(t),snapshotHash:context.candidate.snapshotHash,executableModesHash:context.candidate.executableModesHash,status:'reserved',createdAt:this.c.now(),expiresAt:binding.expiresAt,verdictHash:null,result:null};
   t.reviews++;this.c.store.put('task',t);this.c.store.put('review_ticket',ticket);this.c.emit('review.reserved',g.id,t.id,{ticketId:ticket.id,source:policy.source});
   return {ticketId:ticket.id,binding,disclosure:context.disclosure,evidence:context.candidate.evidence,reviewer:ticket.reviewer,expiresAt:ticket.expiresAt};
  });
 }
 async submit(input,key,authority){
  keys(input,['ticketId','verdict',...bindingFields],'review submission');
  const ticket=this.c.store.get('review_ticket',input.ticketId),task=this.c.getTask(ticket.taskId),verdict=normalizeVerdict(input.verdict,task.spec.permissions),verdictHash=digest(verdict);
  const command={op:'review.submit',...input,verdict},old=commandReplay(this.c,key,command);if(old)return old.result;
  if(ticket.reviewer.source==='api'&&authority!==apiAuthority)throw Error('API review verdict requires its persisted provider response');
  assertBinding(input,ticket.binding);
  if(ticket.status==='completed'){if(ticket.verdictHash!==verdictHash)throw Error('Conflicting review submission replay');return ticket.result;}
  if(ticket.status==='stale')throw Error('Review ticket has a stale binding; original reservation remains spent');
  if(ticket.status!=='reserved')throw Error('Review ticket is not available; original reservation remains spent');
  if(this.c.now()>=ticket.expiresAt)throw Error('Original review ticket expiry reached');
  const context=await this.context(ticket.taskId,{includeFiles:false});assertBinding(context.binding,ticket.binding);
  return this.c.store.command(key,command,()=>{
   const current=this.c.store.get('review_ticket',ticket.id);if(current.status==='completed'){if(current.verdictHash!==verdictHash)throw Error('Conflicting review submission replay');return current.result;}
   if(current.status!=='reserved')throw Error('Review ticket is not available; original reservation remains spent');
   const t=this.c.getTask(ticket.taskId),{g,policy}=policyFor(this.c,t);
   if(g.hash!==ticket.binding.goalHash||g.version!==ticket.binding.goalVersion||digest(savedCandidateIdentity(t))!==digest(ticket.savedCandidateIdentity))throw Error('Candidate or approval changed before verdict');
   if(this.c.now()>=ticket.expiresAt)throw Error('Original review ticket expiry reached');
   t.reviewed=true;t.feedback.push({kind:'review',decision:verdict.decision,text:verdict.feedback,findings:verdict.findings,ticketId:ticket.id,source:policy.source,at:this.c.now()});
   if(verdict.decision==='accept'){
    t.reviewAcceptance={ticketId:ticket.id,binding:ticket.binding,source:policy.source,reviewer:current.reviewer,verdictHash,acceptedAt:this.c.now()};
    t.status=t.spec.kind==='coding'?'ready_to_integrate':'accepted';
   }else{
    delete t.reviewAcceptance;const exhausted=t.reviews>=t.spec.limits.reviews||t.attempts>=t.spec.limits.attempts||(this.c.store.spent(t.id).model??0)>=t.spec.limits.modelCalls;
    t.status=exhausted?'blocked':t.native?.layout==='candidate_v1'||t.executionActor==='codex'||t.spec.actor==='codex'?'codex_ready':'queued';t.checkpoint={...t.checkpoint,phase:'attempt'};
    if(t.native?.layout==='candidate_v1')t.native.status='revision_requested';if(exhausted)t.reason='Original review, attempt or request budget exhausted';
   }
   if(t.reviewWait?.ticketId===ticket.id)delete t.reviewWait;
   this.c.store.put('task',t);current.status='completed';current.verdictHash=verdictHash;current.verdict=verdict;current.completedAt=this.c.now();current.result=this.c.getTask(t.id);this.c.store.put('review_ticket',current);
   this.c.emit('task.reviewed',g.id,t.id,{decision:verdict.decision,source:policy.source,ticketId:ticket.id});this.c.requestUrgentYield();return current.result;
  });
 }
 assertAccepted(task){
  const current=this.c.getTask(task.id),{g}=policyFor(this.c,current),accept=current.reviewAcceptance;
  if(current.status!=='ready_to_integrate'||!accept)throw Error('Passing bound review is required before integration');
  const ticket=this.c.store.get('review_ticket',accept.ticketId);
  if(ticket.status!=='completed'||ticket.verdict?.decision!=='accept'||ticket.verdictHash!==accept.verdictHash||digest(ticket.binding)!==digest(accept.binding)||ticket.binding.goalHash!==g.hash||ticket.binding.goalVersion!==g.version||digest(savedCandidateIdentity(current))!==digest(ticket.savedCandidateIdentity))throw Error('Accepted review binding changed before integration');
  return accept;
 }
 async assertCandidate(task,options={}){
  const accept=this.assertAccepted(task),context=await this.context(task.id,{includeFiles:false,...options});assertBinding(context.binding,accept.binding);return accept;
 }
 async runApi(input,key){
  const {signal,...data}=input;identifier(key,'idempotencyKey');
  if(!this.#runs.has(key)&&this.#runs.size>=capacitySnapshot(this.c).serviceLimit)return {waiting:true,reasonCode:'review_runner_capacity'};
  if(this.#runs.has(key)){const running=this.#runs.get(key);if(running.hash!==digest(data))throw Error('Idempotency key conflict');return running.promise;}
  const promise=this.#runApi(data,key,signal);this.#runs.set(key,{hash:digest(data),promise});try{return await promise;}catch(error){const request=this.c.store.request(data.taskId,`api-review-${digest(key)}`);if(request)this.c.store.tx(()=>{
   const t=this.c.getTask(data.taskId),reasonCode=request.status==='reserved'?'request_uncertain':request.status==='failed'?'request_failed':error.reviewReasonCode??'response_rejected';
   t.reviewWait={source:'api',ticketId:request.ticketId,requestId:request.id,requestOutcome:request.requestOutcome,reasonCode,recovery:reasonCode==='controls_active'?'after_resume':'operator',reason:reasonCode==='controls_active'?'Saved API response awaits supported resume; original request remains spent':'API review needs operator attention; saved requests remain spent and no fallback is dispatched'};
   this.c.store.put('task',t);this.c.emit('review.waiting',t.goalId,t.id,t.reviewWait);
  });throw error;}finally{this.#runs.delete(key);}
 }
 async #submitApiResponse(input,key,request){
  const c=this.c,ticket=c.store.get('review_ticket',request.ticketId),t=c.getTask(input.taskId),g=c.store.get('goal',t.goalId);
  if(request.status!=='completed'||request.requestOutcome!=='completed'||request.runKey!==key||request.inputHash!==digest(input)||request.task_id!==t.id||request.kind!=='apiReview'||request.id!==ticket.requestId||ticket.taskId!==t.id||ticket.reviewer.source!=='api')throw apiError('response_mismatch','Saved API review request/ticket binding changed; original request remains spent');
  assertBinding(input,ticket.binding);
  let verdict;try{if(typeof request.result?.content!=='string')throw Error('Missing response');verdict=normalizeVerdict(JSON.parse(request.result.content),t.spec.permissions);}catch{throw apiError('invalid_response','Invalid API review JSON or verdict; completed request remains spent');}
  // An already submitted verdict is immutable history. Preserve its receipt
  // replay without using it to submit under a later approval or task version.
  if(ticket.status==='completed')return this.submit({...input,ticketId:ticket.id,verdict},`api-submit-${digest(key)}`,apiAuthority);
  const policy=normalizeReviewPolicy(g.manifest.reviewPolicy);assertReviewMode(g.manifest.mode,policy);
  if(policy?.source!=='api'||g.hash!==digest(g.manifest)||t.hash!==digest(t.spec)||g.hash!==input.goalHash||g.version!==input.goalVersion||t.goalVersion!==g.version||digest(policy)!==input.reviewPolicyHash||g.manifest.reviewPolicyHash!==input.reviewPolicyHash||digest(savedCandidateIdentity(t))!==digest(ticket.savedCandidateIdentity))throw apiError('response_rejected','Saved API review has stale candidate or approval bindings');
  const binding={version:1,providerId:policy.reviewer.id,revision:policy.reviewer.revision,profileHash:digest(policy.reviewer),policyHash:input.reviewPolicyHash};
  if(digest(binding)!==digest(request.reviewerBinding)||ticket.reviewer.providerId!==binding.providerId||ticket.reviewer.revision!==binding.revision||ticket.reviewer.profileHash!==binding.profileHash||input.goalId!==g.id||input.generation!==(t.native?.generation??t.checkpoint?.attempt??1)||input.rubricHash!==digest(reviewRubric(g,t))||input.expiresAt!==Math.min(g.deadline,t.deadline??g.deadline))throw apiError('response_mismatch','Saved API review has stale reviewer or task bindings');
  try{return await this.submit({...input,ticketId:ticket.id,verdict},`api-submit-${digest(key)}`,apiAuthority);}
  catch(error){
   // Controls may interrupt submission after the billed response is durable.
   // Classify only an unchanged, unexpired reservation under supported controls;
   // all other failures are terminal automatic waits. Replay rechecks evidence.
   const current=c.getTask(t.id),goal=c.store.get('goal',g.id),waiting=current.status==='awaiting_review'||['paused','stopped'].includes(current.status)&&current.controlReturnStatus==='awaiting_review';
   if(ticket.status==='reserved'&&c.now()<ticket.expiresAt&&goal.hash===g.hash&&goal.version===g.version&&digest(savedCandidateIdentity(current))===digest(ticket.savedCandidateIdentity)&&waiting&&(['paused','stopped'].includes(goal.status)||current.pauseRequested||current.stopRequested))error.reviewReasonCode='controls_active';
   throw error;
  }
 }
 async #runApi(input,key,signal){
  keys(input,bindingFields,'API review');
  const c=this.c,requestKey=`api-review-${digest(key)}`,old=c.store.request(input.taskId,requestKey);
  if(old&&old.inputHash!==digest(input))throw Error('API review idempotency key conflict');
  if(old?.status==='completed')return this.#submitApiResponse(input,key,old);
  if(old)throw Error('Interrupted or failed API review remains spent; no blind retry');
  if(signal?.aborted)throw Error('API review cancelled before dispatch');
  const context=await this.context(input.taskId);assertBinding(input,context.binding);
  if(context.policy.source!=='api')throw Error('Approved review source is host; API fallback is prohibited');
  const profile=context.policy.reviewer,binding={version:1,providerId:profile.id,revision:profile.revision,profileHash:digest(profile),policyHash:context.g.manifest.reviewPolicyHash};
  if(!this.providers||digest(this.providers.get(profile.id,profile.revision))!==digest(profile)||typeof this.providers.createReviewer!=='function')throw Error('Configured reviewer identity unavailable');
  c.verifyGoalBinding(context.g,{taskId:input.taskId});
  const client=this.providers.createReviewer(binding);
  if(c.store.db.prepare("SELECT 1 FROM requests WHERE task_id=? AND kind='apiReview' AND status='reserved'").get(input.taskId))throw Error('An API review has uncertain ownership; no fallback dispatch');
  const capacityWait=inferenceWait(c,context.g,binding);if(capacityWait)return {waiting:true,...capacityWait};
  let reservation;
  const request=c.store.tx(()=>{
   const capacityResource=assertInferenceCapacity(c,context.g,binding);
   reservation=this.#reserveContext(input,`api-ticket-${digest(key)}`,context);
   const t=c.getTask(input.taskId),{g,policy}=policyFor(c,t);
   if(policy.source!=='api'||g.hash!==context.g.hash)throw Error('API review approval changed');
   c.verifyGoalBinding(g,{taskId:input.taskId});
   const row={id:c.store.get('review_ticket',reservation.ticketId).requestId,taskId:t.id,key:requestKey,kind:'apiReview',status:'reserved',inputHash:digest(input),ticketId:reservation.ticketId,reviewerBinding:binding,reservedAt:c.now(),capacityResource,requestOutcome:'unknown'};
   c.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?)').run(row.id,t.id,row.key,row.kind,row.status,JSON.stringify({runKey:key,inputHash:row.inputHash,ticketId:row.ticketId,reviewerBinding:binding,reservedAt:row.reservedAt,capacityResource,requestOutcome:'unknown'}));return row;
  });
  c.emit('model.request.started',context.g.id,input.taskId,{requestId:request.id,kind:'apiReview',role:'reviewer',providerBinding:binding});
  const timeout=AbortSignal.timeout(Math.max(1,Math.min(300000,input.expiresAt-c.now()))),combined=signal?AbortSignal.any([signal,timeout]):timeout;
  let result;
  try{
   if(combined.aborted){const error=Error('Cancelled before dispatch');error.requestOutcome='not_dispatched';throw error;}
   result=await client.review({evidence:reservation.evidence,signal:combined,maxOutputTokens:profile.maxOutputTokens,beforeDispatch:()=>{
    const current=c.getTask(input.taskId),{g,policy}=policyFor(c,current);
    c.verifyGoalBinding(g,{taskId:input.taskId});
    const saved=c.store.request(input.taskId,requestKey),ticket=c.store.get('review_ticket',reservation.ticketId);
    if(g.hash!==input.goalHash||g.version!==input.goalVersion||digest(policy)!==input.reviewPolicyHash||
       digest(savedCandidateIdentity(current))!==digest(ticket.savedCandidateIdentity)||
       digest(reviewRubric(g,current))!==input.rubricHash||c.now()>=ticket.expiresAt||
       ticket.status!=='reserved'||saved?.status!=='reserved'||saved.id!==ticket.requestId||
       digest(saved.reviewerBinding)!==digest(binding)||
       digest((c.providerRegistry??this.providers).get(profile.id,profile.revision))!==digest(profile))throw Error('Review authority changed');
    assertBinding(input,ticket.binding);
   }});
   c.store.tx(()=>{const saved=c.store.request(input.taskId,requestKey);c.store.db.prepare("UPDATE requests SET status='completed',data=? WHERE id=?").run(JSON.stringify({runKey:key,inputHash:request.inputHash,ticketId:request.ticketId,reviewerBinding:binding,reservedAt:request.reservedAt,capacityResource:request.capacityResource,requestOutcome:'completed',savedAt:c.now(),result}),saved.id);const savedTicket=c.store.get('review_ticket',reservation.ticketId);savedTicket.reviewer={...savedTicket.reviewer,reportedModel:result.reportedModel??null,provenance:result.reportedModel?'reported':'unknown',usage:result.usage??null};c.store.put('review_ticket',savedTicket);});
  }catch(error){
   const outcome=['not_dispatched','completed'].includes(error.requestOutcome)?error.requestOutcome:'unknown';
   c.store.tx(()=>{const saved=c.store.request(input.taskId,requestKey);c.store.db.prepare('UPDATE requests SET status=?,data=? WHERE id=?').run(outcome==='unknown'?'reserved':'failed',JSON.stringify({runKey:key,inputHash:request.inputHash,ticketId:request.ticketId,reviewerBinding:binding,reservedAt:request.reservedAt,capacityResource:request.capacityResource,requestOutcome:outcome==='unknown'?'unknown':outcome,error:'API review failed; explicit operator recovery required'}),saved.id);});
   throw Error(outcome==='unknown'?'API review outcome uncertain and may be billed; request remains spent, no retry':'API review failed; reservation remains spent, no fallback');
  }
  c.emit('model.request.completed',context.g.id,input.taskId,{requestId:request.id,kind:'apiReview',role:'reviewer',providerBinding:binding,requestedModel:result.requestedModel,reportedModel:result.reportedModel??null,usage:result.usage??null});
  // Preserve the response before validating it or checking whether approval was
  // revoked during the await. A late result never revives a stale candidate.

  return this.#submitApiResponse(input,key,c.store.request(input.taskId,requestKey));
 }
}
