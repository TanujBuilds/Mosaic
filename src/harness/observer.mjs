import {controlBinding,ownerInbox} from './owner-inbox.mjs';
import {createHash} from 'node:crypto';
import {keys,identifier,integer,canonical,digest} from './contracts.mjs';
import {normalizeObserverQuery,normalizeActivityEvent,OBSERVER_LIMITS} from './collaboration-contracts.mjs';
import {storedWorkerAttribution} from './outcomes/attribution.mjs';
import {normalizeReviewPolicy,assertReviewMode,reviewerIdentity} from './review/contracts.mjs';
import {savedCandidateIdentity,reviewRubric} from './review/evidence.mjs';
import {taskGoalId} from './store.mjs';

export const OBSERVER_TOOLS=new Set(['tools_list','observer_snapshot','observer_timeline','observer_current_activity','observer_evidence','observer_artifacts','owner_inbox']);
const terminal=new Set(['accepted','failed','partial','cancelled']);
const queueStates=new Set(['queued','codex_ready','suspended','running','uncertain','codex_active']);
const attentionStates=new Set(['awaiting_supervisor','awaiting_user','awaiting_review','awaiting_legacy_review','blocked','uncertain']);
const label=type=>({
 'goal.prepared':'Goal prepared','goal.activated':'Goal activated','goal.finalized':'Goal finalized',
 'task.submitted':'Assignment queued','task.claimed':'DeepSeek picked up an assignment','task.result':'Candidate saved',
 'task.question':'An answer is needed','task.answered':'Question answered; assignment requeued','task.reviewed':'Candidate reviewed','task.integrated':'Accepted changes integrated',
 'task.native_started':'Native Codex assignment started','task.native_finished':'Native candidate saved','task.native_released':'Native partial preserved','task.taken_over':'Codex took over saved work',
 'agent.registered':'Agent registered','agent.reported':'Native progress reported','help.linked':'Helper assignment linked',
 'model.request.started':'DeepSeek request started','model.request.resolved':'Model identity verified','model.request.completed':'DeepSeek response saved','model.request.failed':'DeepSeek request failed',
 'coding.edit.proposed':'Scoped edits proposed','coding.edit.applied':'Scoped edits applied','coding.checks.started':'Running protected checks','coding.checks.passed':'Protected checks passed','coding.checks.failed':'Protected checks failed','coding.candidate.saved':'Candidate evidence saved',
 'coding.files.read':'Read approved files','coding.context.refreshed':'Working context refreshed','coding.context.evicted':'Older context evicted',
 'coding.question':'DeepSeek asked a question','execution.yield':'Saved progress and yielded','task.blocked':'Assignment blocked','task.uncertain':'Execution status uncertain','work.control':'Execution control recorded',
 'request.reserved':'Request budget reserved','request.saved':'Request result saved'
 })[type]??type.replaceAll('.',' ');
const trim=value=>String(value).slice(0,2000);
const snapshotCacheLimit=8;
const timelineScanLimit=1000;
const hostNames={codex:'Codex','claude-code':'Claude Code',cursor:'Cursor',antigravity:'Antigravity'};
// Project only approved identities, never provider endpoints, credentials or
// candidate source. The legacy reviewPolicy string remains a separate field.
function reviewSelection(goal){
 if(!goal.manifest.reviewPolicy)return null;
 try{
  const policy=normalizeReviewPolicy(goal.manifest.reviewPolicy);assertReviewMode(goal.manifest.mode,policy);
  if(goal.hash!==digest(goal.manifest)||goal.manifest.reviewPolicyHash!==digest(policy))throw Error('Changed approval');
  return policy.source==='host'?{source:'host',hostId:policy.hostId}:{source:'api',providerId:policy.reviewer.id,revision:policy.reviewer.revision,requestedModel:trim(policy.reviewer.model)};
 }catch{return {source:'unknown'};}
}
function tokenTotal(values){
 let sum=0,known=0,overflow=false;
 for(const value of values)if(Number.isSafeInteger(value)&&value>=0){known++;if(value>Number.MAX_SAFE_INTEGER-sum)overflow=true;else sum+=value;}
 return {reportedTokens:known&&!overflow?sum:null,completedModelRequests:values.length,usageUnavailable:values.length-known,...(overflow?{aggregateOverflow:true}:{})};
}
function commonReview(store,task,goal,selection){
 const base={...selection,status:'waiting',ticketId:null,at:null,expiresAt:null,provenance:'coordinator',identityProvenance:'unknown',reportedModel:null,usage:null};
 if(selection.source==='unknown')return {...base,status:'unavailable'};
 const tickets=store.db.prepare("SELECT data FROM records WHERE kind='review_ticket' AND json_extract(data,'$.taskId')=? ORDER BY rowid DESC").all(task.id).map(row=>JSON.parse(row.data));
 const identity=savedCandidateIdentity(task),checks=task.spec.kind==='coding'?task.result?.checks??[]:[];
 const expectedReviewer=reviewerIdentity(goal.manifest.reviewPolicy);
 const current=tickets.find(ticket=>{
  const b=ticket.binding;
  return ticket.goalId===goal.id&&b?.goalId===goal.id&&b.taskId===task.id&&b.goalHash===goal.hash&&b.goalVersion===goal.version&&task.goalVersion===goal.version&&
   task.hash===digest(task.spec)&&b.reviewPolicyHash===goal.manifest.reviewPolicyHash&&b.generation===(task.native?.generation??task.checkpoint?.attempt??1)&&
   b.expiresAt===Math.min(goal.deadline,task.deadline??goal.deadline)&&b.rubricHash===digest(reviewRubric(goal,task))&&b.checksHash===digest(checks)&&
   digest(ticket.savedCandidateIdentity)===digest(identity)&&
   b.candidateHash===digest(task.spec.kind==='coding'?{...identity,snapshotHash:ticket.snapshotHash,executableModesHash:ticket.executableModesHash}:identity)&&
   (selection.source==='host'?ticket.reviewer?.source==='host'&&ticket.reviewer.hostId===selection.hostId:ticket.reviewer?.source==='api'&&ticket.reviewer.providerId===selection.providerId&&ticket.reviewer.revision===selection.revision&&ticket.reviewer.profileHash===expectedReviewer.profileHash);
 });
 if(!current)return {...base,status:tickets.length?'stale':task.status==='blocked'?'blocked':task.status==='running'&&task.checkpoint?.phase==='checks'?'checks':task.status==='awaiting_review'?'waiting':'inactive'};
 const view={...base,ticketId:current.id,at:current.completedAt??current.createdAt,expiresAt:current.expiresAt};
 if(!['reserved','completed'].includes(current.status))return {...view,status:'stale'};
 if(selection.source==='api'){
  const row=store.db.prepare("SELECT status,data FROM requests WHERE id=? AND task_id=? AND kind='apiReview'").get(current.requestId,task.id),request=row?JSON.parse(row.data):null;
  const bound=request?.ticketId===current.id&&request.inputHash===digest(current.binding)&&request.reviewerBinding?.providerId===selection.providerId&&request.reviewerBinding?.revision===selection.revision&&request.reviewerBinding?.profileHash===expectedReviewer.profileHash&&request.reviewerBinding?.policyHash===goal.manifest.reviewPolicyHash;
  const captured=bound&&row.status==='completed'&&request.requestOutcome==='completed'&&typeof request.result?.content==='string';
  if(captured){
   view.provenance='captured';
   view.reportedModel=typeof request.result?.reportedModel==='string'?trim(request.result.reportedModel):null;
   view.identityProvenance=view.reportedModel?'reported':'unknown';
   view.usage=tokenTotal([request.result?.usage?.totalTokens]);
  }
  if(current.status==='completed'&&!captured)return {...view,status:'unavailable'};
  if(current.status==='reserved'&&(row?.status==='failed'||task.reviewWait))return {...view,status:'blocked'};
 }
 if(current.status==='reserved')return {...view,status:'reserved'};
 if(current.verdictHash!==digest(current.verdict))return {...view,status:'unavailable'};
 if(current.verdict?.decision==='revise')return {...view,status:task.status==='blocked'?'blocked':'revision',decision:'revise'};
 const accept=task.reviewAcceptance;
 const accepted=current.verdict?.decision==='accept'&&task.reviewed===true&&accept?.ticketId===current.id&&accept.verdictHash===current.verdictHash&&digest(accept.binding)===digest(current.binding)&&['ready_to_integrate','accepted'].includes(task.status);
 if(!accepted)return {...view,status:'stale'};
 const integrated=task.status==='accepted'&&/^[a-f0-9]{40}$/.test(task.integration?.commit??'')&&task.integration?.review===(selection.source==='host'?'host_review':'api_review')&&digest(task.integration?.reviewAcceptance??null)===digest(accept);
 return {...view,status:integrated?'integrated':'accepted',decision:'accept'};
}
function reviewLabel(review){
 const name=review.source==='host'?hostNames[review.hostId]:'API';
 return review.decision==='accept'?name+' review accepted':review.decision==='revise'?name+' requested changes':'No recorded review';
}
function eventReviewer(store,event){
 if(['agent.registered','agent.reported'].includes(event.type)){
  const agent=event.data?.agentId?store.maybe('agent',event.data.agentId):null;
  if(agent?.role==='reviewer'&&agent.taskId===event.task_id&&agent.goalId===event.goal_id&&hostNames[agent.hostId])return {source:'host',hostId:agent.hostId,name:hostNames[agent.hostId]+' reviewer',kind:'agent'};
 }
 if(event.type.startsWith('model.request.')&&event.data?.kind==='apiReview'){
  const row=store.db.prepare("SELECT task_id,status,data FROM requests WHERE id=? AND kind='apiReview'").get(event.data.requestId??'');
  const request=row?JSON.parse(row.data):null,ticket=request?.ticketId?store.maybe('review_ticket',request.ticketId):null;
  const bound=row?.task_id===event.task_id&&ticket?.taskId===event.task_id&&ticket.goalId===event.goal_id&&ticket.requestId===event.data.requestId&&ticket.reviewer?.source==='api'&&request.inputHash===digest(ticket.binding)&&
   request.reviewerBinding?.providerId===ticket.reviewer.providerId&&request.reviewerBinding?.revision===ticket.reviewer.revision&&request.reviewerBinding?.profileHash===ticket.reviewer.profileHash&&digest(event.data.providerBinding??null)===digest(request.reviewerBinding);
  return {source:'api',name:'API review · '+(bound?trim(ticket.reviewer.providerId):'identity unknown'),kind:'request',captured:bound&&event.type==='model.request.completed'&&row.status==='completed'&&request.requestOutcome==='completed'};
 }
 if(!['review.reserved','review.stale','task.reviewed','task.integrated'].includes(event.type))return null;
 const id=event.data?.ticketId??event.data?.reviewAcceptance?.ticketId;
 const ticket=id?store.maybe('review_ticket',id):null;
 if(ticket?.taskId!==event.task_id||ticket.goalId!==event.goal_id)return null;
 const reviewer=ticket.reviewer;
 return reviewer?.source==='api'?{source:'api',name:'API review'}:reviewer?.source==='host'&&hostNames[reviewer.hostId]?{source:'host',hostId:reviewer.hostId,name:hostNames[reviewer.hostId]+' review'}:null;
}
function taskProfile(store,task) {
 if(task.providerBinding){
  const worker=storedWorkerAttribution(store,task);
  return worker?.bindingProvenance==='pinned'?{displayName:worker.displayName,model:worker.requestedModel,revision:worker.revision}:null;
 }
 if(task.workerProfile)return task.workerProfile;
 const goal=store.get('goal',task.goalId);
 return (task.goalVersion===goal.version?goal:store.maybe('goal_history',`${goal.id}-${task.goalVersion}`))?.manifest.workerProfile;
}
function connections(c){
 const policy=c.configuredPolicies?.providerPolicy;
 const selected=policy?.workers.find(p=>p.id===policy.defaultWorkerId)??c.workerProfile;
 const host=c.selectedHost?{id:c.selectedHost,lastConnection:null}:null;
 if(!selected)return {host,worker:null};
 // A saved response from the exact selected profile is historical evidence.
 // Fixture responses and responses from a previous profile cannot prove it.
 const binding=selected.id?"json_extract(r.data,'$.providerBinding.profileHash')":"json_extract(r.data,'$.workerProfile')";
 const match=selected.id?digest(selected):canonical(selected);
 const previous=c.store.db.prepare(`
  SELECT MAX(json_extract(r.data,'$.savedAt')) AS at
  FROM requests r
  JOIN records t ON t.kind='task' AND t.id=r.task_id
  JOIN records g ON g.kind='goal' AND g.id=json_extract(t.data,'$.goalId')
  WHERE r.kind='model' AND r.status='completed'
    AND json_extract(g.data,'$.manifest.environment')='live'
    AND json_type(r.data,'$.savedAt')='integer'
    AND json_type(r.data,'$.result.content')='text' AND ${binding}=?
 `).get(match);
 const lastConnection=Number.isSafeInteger(previous.at)?{kind:'worker_response',at:previous.at}:null;
 return {host,worker:{displayName:selected.displayName,lastConnection}};
}
function outcome(t,common){
 const result=t.result??{},integration=t.integration,checks=integration?.checks??result.checks;
 const files=[...new Set([...(Array.isArray(result.changes)?result.changes:[]),...(Array.isArray(result.newFiles)?result.newFiles:[])].map(x=>x?.path).filter(x=>typeof x==='string'))].slice(0,50).map(x=>x.slice(0,200));
 const integrated=t.status==='accepted'&&/^[a-f0-9]{40}$/.test(integration?.commit??'');
 const currentReview=result&&t.result&&['ready_to_integrate','accepted','blocked'].includes(t.status);
 const feedback=currentReview&&t.reviewed===true?t.feedback?.findLast(x=>['accept','revise'].includes(x.decision)):null;
 const legacy=currentReview?t.legacyDecision:null;
 const review=common?reviewLabel(common):(integrated?({none:'Checks only; no Codex review',codex_operator:'Codex review accepted',codex_legacy:'Codex automatic review accepted',codex_native:'Native completion; no separate review recorded'})[integration.review]:null)??(legacy?legacy.decision==='accept'?'Codex automatic review accepted':'Codex requested changes':feedback?feedback.decision==='accept'?'Codex review accepted':'Codex requested changes':'No recorded review');
 const summary=result.summary??result.workerSummary;
 return {summary:typeof summary==='string'?trim(summary):null,files,checks:Array.isArray(checks)&&checks.length&&checks.every(x=>typeof x?.passed==='boolean')?{passed:checks.filter(x=>x.passed).length,total:checks.length}:null,review,integrated,commit:/^[a-f0-9]{40}$/.test(integration?.commit??'')?integration.commit:null};
}
function window(bytes,start,length){
 const begin=Math.min(start,bytes.length);if(begin<bytes.length&&(bytes[begin]&0xc0)===0x80)throw Error('Evidence start must be a UTF-8 character boundary');
 let end=Math.min(bytes.length,begin+length);while(end>begin&&end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;
 if(end===begin&&begin<bytes.length)throw Error('Evidence window is too small for the next UTF-8 character');
 return {start:begin,nextStart:end,totalBytes:bytes.length,text:bytes.subarray(begin,end).toString('utf8'),truncated:begin>0||end<bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
}
export class Observer {
 constructor({c,artifacts}){this.c=c;this.artifacts=artifacts;this.snapshots=new Map();}
 actor(event){
  const d=event.data??{},t=event.task_id?this.c.store.maybe('task',event.task_id):null;
  const reviewer=eventReviewer(this.c.store,event);
  if(reviewer)return reviewer.source==='host'&&reviewer.hostId==='codex'?'codex':null;
  if(['codex','deepseek'].includes(d.actor))return d.actor;
  if(d.agentId){const agent=this.c.store.maybe('agent',d.agentId);if(agent)return agent.actor;}
  if(event.type==='agent.reported')return 'codex';
  if(event.type.startsWith('task.native_')||event.type==='task.taken_over'||event.type.startsWith('reviewer.')||['task.reviewed','help.linked'].includes(event.type))return 'codex';
  if(event.type.startsWith('model.')||event.type.startsWith('coding.')||event.type.startsWith('request.')||event.type.startsWith('attempt.'))return 'deepseek';
  if(event.type==='task.integrated'){const g=this.c.store.maybe('goal',event.goal_id);return g?.manifest.mode.review==='checks'?null:'codex';}
  if(['task.claimed','task.question','task.answered','task.result','task.blocked','task.uncertain'].includes(event.type))return t?.spec.actor??null;
  return null;
 }
 normalized(event){
  const d=event.data??{},actor=this.actor(event),requestId=d.requestId??(event.type.startsWith('request.')?d.id:null)??null;
  let summary=typeof d.summary==='string'?d.summary:label(event.type);
  const reviewer=eventReviewer(this.c.store,event);
  if(reviewer)summary=reviewer.name+(reviewer.kind==='agent'?(event.type==='agent.reported'?' · '+summary:' registered'):reviewer.kind==='request'?(event.type==='model.request.started'?' request started':event.type==='model.request.completed'?' response saved':' request failed'):event.type==='task.reviewed'?(d.decision==='accept'?' accepted':' requested changes'):event.type==='review.reserved'?' reserved':event.type==='review.stale'?' became stale':': accepted changes integrated');
  if(['task.question','task.answered'].includes(event.type)&&typeof d.text==='string')summary=d.text;
  if(event.type==='coding.files.read'&&Array.isArray(d.files))summary='Read '+d.files.map(f=>f.path).filter(x=>typeof x==='string').join(', ');
  if(d.reason&&typeof d.reason==='string')summary+=': '+d.reason;
  const artifactIds=[...(event.task_id?['task-'+event.task_id]:[]),...(requestId?['request-'+requestId]:[])];
  const normalized=normalizeActivityEvent({version:1,seq:event.seq,at:event.at,goalId:event.goal_id,taskId:event.task_id,agentId:d.agentId??null,requestId,type:event.type,actor,provenance:reviewer?.kind==='request'?(reviewer.captured?'captured':'coordinator'):['captured','reported','coordinator'].includes(d.provenance)?d.provenance:event.type==='agent.reported'?'reported':'coordinator',summary:trim(summary),artifactIds});
  if(!this.c.beta||actor!=='deepseek')return normalized;
  const task=event.task_id?this.c.store.maybe('task',event.task_id):null,goal=event.goal_id?this.c.store.maybe('goal',event.goal_id):null;
  const row=requestId?this.c.store.db.prepare('SELECT data FROM requests WHERE id=?').get(requestId):null;
  const profile=(row?JSON.parse(row.data).workerProfile:null)??(task?taskProfile(this.c.store,task):goal?.manifest.workerProfile);
  return profile?{...normalized,displayName:profile.displayName}:normalized;
 }
 timeline(raw={}){
  const {recent,...query}=raw,q=normalizeObserverQuery(query);if(q.goalId)this.c.store.get('goal',q.goalId);
  if(recent){
   if(q.after||q.actor)throw Error('Recent history accepts goalId and limit');
   const events=this.c.store.db.prepare("SELECT * FROM events WHERE (? IS NULL OR goal_id=?) AND type NOT IN ('model.output','execution.checkpoint') AND NOT (type='task.checkpoint' AND json_extract(data,'$.status')='running') ORDER BY seq DESC LIMIT ?").all(q.goalId,q.goalId,q.limit).reverse().map(row=>this.normalized({...row,data:JSON.parse(row.data)}));
   const cursor=Number(this.c.store.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM events').get().n);
   return {events,cursor,scanned:events.length,hasMore:false};
  }
  const events=[];let cursor=q.after,scanned=0;
  for(const event of this.c.store.events(q.after,timelineScanLimit)){
   cursor=event.seq;scanned++;
   if(q.goalId&&event.goal_id!==q.goalId)continue;
   if(event.type==='model.output'||event.type==='execution.checkpoint'||event.type==='task.checkpoint'&&event.data.status==='running')continue;
   const normalized=this.normalized(event);if(q.actor&&normalized.actor!==q.actor)continue;
   events.push(normalized);if(events.length>=q.limit)break;
  }
  const hasMore=!!this.c.store.db.prepare('SELECT 1 FROM events WHERE seq>? LIMIT 1').get(cursor);
  return {events,cursor,scanned,hasMore};
 }
 currentActivity(raw={}){
  keys(raw,['after'],'current activity query');
  let cursor=integer(raw.after??0,'after',0,Number.MAX_SAFE_INTEGER);
  const db=this.c.store.db,activity=new Map();
  const scan=db.prepare(`SELECT seq,goal_id,at,type,
   CASE
    WHEN type IN ('model.output','execution.checkpoint') THEN 0
    WHEN type='task.checkpoint' THEN json_extract(data,'$.status') IS NOT 'running'
    ELSE 1
   END AS visible
   FROM events WHERE seq>? ORDER BY seq LIMIT ?`);
  // Match the older terminal's 32 chronological pages. Suppressed rows
  // consume scan slots, and visible housekeeping consumes visible slots.
  for(let page=0;page<32;page++){
   let scanned=0,visible=0;
   for(const event of scan.iterate(cursor,timelineScanLimit)){
    cursor=event.seq;scanned++;
    if(!event.visible)continue;
    if(event.goal_id&&event.type!=='task.expired'&&event.type!=='goal.expired'){
     const id=identifier(event.goal_id,'goalId'),at=integer(event.at,'timestamp',0,Number.MAX_SAFE_INTEGER);
     activity.set(id,Math.max(activity.get(id)??0,at));
    }
    if(++visible>=OBSERVER_LIMITS.pageMax)break;
   }
   if(scanned<timelineScanLimit&&visible<OBSERVER_LIMITS.pageMax)break;
  }
  const hasMore=!!db.prepare('SELECT 1 FROM events WHERE seq>? LIMIT 1').get(cursor);
  return {cursor,hasMore,activity:[...activity].map(([goalId,at])=>({goalId,at}))};
 }
 usage(taskId){
  return tokenTotal(this.c.store.db.prepare("SELECT data FROM requests WHERE task_id=? AND kind='model' AND status='completed'").all(taskId).map(row=>JSON.parse(row.data).result?.usage?.total_tokens));
 }
 snapshot(raw={}){
  keys(raw,['goalId','actor'],'snapshot query');
  const q=normalizeObserverQuery(raw),store=this.c.store;
  const key=JSON.stringify([q.goalId,q.actor]);
  let snapshot;
  if(store.depth){
   snapshot=this.readSnapshot(q);
  }else{
   const revision=store.revision();
   if(revision!==this.snapshotRevision){
    this.snapshots.clear();
    this.snapshotRevision=revision;
   }
   snapshot=this.snapshots.get(key);
   if(!snapshot){
    snapshot=this.readSnapshot(q);
    if(this.snapshots.size>=snapshotCacheLimit)this.snapshots.delete(this.snapshots.keys().next().value);
    this.snapshots.set(key,snapshot);
   }
  }
  // Keep time-derived fields current without rereading saved records.
  const now=this.c.now(),result=structuredClone(snapshot);
  result.generatedAt=now;
  for(const agent of result.agents)agent.stale=!agent.lastReport||now-agent.lastReport.at>120000;
  for(const task of result.tasks)if(task.review?.status==='reserved'&&now>=task.review.expiresAt)task.review.status='expired';
  return result;
 }
 readSnapshot(q){
  if(q.goalId)this.c.store.get('goal',q.goalId);
  const db=this.c.store.db,readRecord=db.prepare('SELECT data FROM records WHERE rowid=?');
  const goalFilter=q.goalId?` AND ${taskGoalId}=?`:'',goalArgs=q.goalId?[q.goalId]:[];
  // Sort row IDs, then fetch payloads in the requested order. Saved checks
  // and model output can make each payload larger than SQLite's sort buffer.
  const tasks=Array.from(db.prepare(`SELECT rowid FROM records WHERE kind='task'${goalFilter} AND (? IS NULL OR COALESCE(json_extract(data,'$.executionActor'),json_extract(data,'$.spec.actor'))=?) ORDER BY json_extract(data,'$.status') NOT IN ('accepted','failed','partial','cancelled') DESC,rowid DESC LIMIT 501`).iterate(...goalArgs,q.actor,q.actor),row=>JSON.parse(readRecord.get(row.rowid).data));
  const selected=tasks.slice(0,500);
  const agents=this.c.store.db.prepare("SELECT data FROM records WHERE kind='agent' AND (? IS NULL OR json_extract(data,'$.goalId')=?) ORDER BY rowid DESC LIMIT 500").all(q.goalId,q.goalId).map(r=>JSON.parse(r.data)).filter(a=>!q.actor||a.actor===q.actor).map(a=>({id:a.id,taskId:a.taskId,goalId:a.goalId,actor:a.actor,role:a.role,...(a.hostId?{hostId:a.hostId}:{}),hostAgentId:a.hostAgentId??null,model:a.model??{requested:null,resolved:null},modelSource:a.modelSource??'unknown',lastReport:a.lastReport??null,provenance:'reported',accounting:{tokens:null,source:'native host accounting unavailable'}}));
  const rows=selected.map(t=>{
   const actor=t.executionActor??t.spec.actor,event=this.c.store.db.prepare("SELECT seq,at,type,data FROM events WHERE task_id=? AND type!='model.output' AND (?!='deepseek' OR json_extract(data,'$.provenance')='captured') ORDER BY seq DESC LIMIT 1").get(t.id,actor),last=event?{...event,data:JSON.parse(event.data)}:null,registered=agents.find(a=>a.taskId===t.id&&a.actor===actor);
   return {id:t.id,goalId:t.goalId,objective:trim(t.spec.objective),objectiveTruncated:t.spec.objective.length>2000,kind:t.spec.kind,actor,status:t.status,phase:last?.data.phase??t.checkpoint?.phase??null,priority:t.priority??t.spec.priority,provenance:actor==='codex'?'reported':'captured',lastActivityAt:actor==='codex'?registered?.lastReport?.at??null:last?.at??null,lastActivity:actor==='codex'?registered?.lastReport?.summary??null:last?label(last.type):null,model:actor==='codex'?registered?.model??{requested:null,resolved:null}:{requested:null,resolved:typeof (t.providerModel??t.result?.model)==='string'?trim(t.providerModel??t.result.model):null},spent:this.c.getTask(t.id).spent,usage:actor==='codex'?{reportedTokens:null,completedModelRequests:0,usageUnavailable:null}:this.usage(t.id),deadline:t.deadline,question:t.questions?.length?{...t.questions.at(-1),text:trim(t.questions.at(-1).text??'')}:null,candidate:t.native?{layout:t.native.layout??'legacy',writerActive:t.native.writerActive??null,baseCommit:t.native.baseCommit??null,commit:t.native.commit??null}:null,evidenceRef:'task-'+t.id};
  });
  // The latest event includes model output, so the partial activity index
  // cannot answer this field. Read the scoped tasks' last sequences together.
  const latestByTask=this.c.beta&&q.goalId&&selected.length?new Map(db.prepare(`
   SELECT events.task_id,events.at FROM events JOIN (
    SELECT MAX(seq) AS seq FROM events
    WHERE task_id IN (SELECT value FROM json_each(?))
    GROUP BY task_id
   ) latest USING (seq)`).all(JSON.stringify(selected.map(task=>task.id))).map(row=>[row.task_id,row.at])):null;
  for(let index=0;index<rows.length;index++){
   const task=selected[index],row=rows[index],goal=this.c.store.get('goal',task.goalId),selection=reviewSelection(goal);
   const review=selection?commonReview(this.c.store,task,goal,selection):null;
   if(this.c.beta&&review)row.review=review;
   row.outcome=outcome(task,review);
   if(this.c.beta){
    row.updatedAt=(latestByTask?latestByTask.get(task.id):db.prepare('SELECT at FROM events WHERE task_id=? ORDER BY seq DESC LIMIT 1').get(task.id)?.at)??null;
    if(task.spec.kind==='coding'){
     const check=this.c.store.db.prepare("SELECT at,type,json_extract(data,'$.attempt') AS attempt FROM events WHERE task_id=? AND type IN ('coding.checks.passed','coding.checks.failed','checks.failed') ORDER BY seq DESC LIMIT 1").get(task.id);
     row.lastCheck=check?{status:check.type==='coding.checks.passed'?'passed':'failed',at:check.at,attempt:check.attempt}:null;
    }
    if(row.actor==='deepseek'){
     row.workerProfile=taskProfile(this.c.store,task)??null;
     if(task.providerBinding||task.spec.routing){
      row.worker=storedWorkerAttribution(this.c.store,task);
      row.routing=task.spec.routing??null;
      row.routingWait=task.routingWait??null;
      if(row.worker?.bindingProvenance==='pinned')row.model.requested=row.worker.requestedModel;
     }
     if(!row.lastActivityAt)row.provenance='coordinator';
    }
   }
  }
  const counts=new Map();
  if(q.goalId){
   const {count}=db.prepare(`SELECT COUNT(*) AS count FROM records WHERE kind='task'${goalFilter}`).get(...goalArgs);
   counts.set(q.goalId,count);
  }else{
   for(const {goal_id} of db.prepare("SELECT json_extract(data,'$.goalId') AS goal_id FROM records WHERE kind='task'").iterate()){
    counts.set(goal_id,(counts.get(goal_id)??0)+1);
   }
  }
  const goals=Array.from(db.prepare("SELECT rowid FROM records WHERE kind='goal' AND (? IS NULL OR id=?) ORDER BY json_extract(data,'$.status')='active' DESC,rowid DESC LIMIT 100").iterate(q.goalId,q.goalId),row=>{
   const g=JSON.parse(readRecord.get(row.rowid).data);
   const selection=reviewSelection(g);
   return {id:g.id,objective:trim(g.manifest.objective),status:g.status,mode:g.manifest.mode.id,...(this.c.selectedHost?{hostId:this.c.selectedHost}:{}),...(this.c.beta?{reviewPolicy:g.manifest.mode.review,controlBinding:controlBinding(this.c.store,g),...(selection?{reviewSelection:selection}:{}),workerProfile:g.manifest.workerProfile??null}:{}),environment:g.manifest.environment,deadline:g.deadline,maxTasks:g.manifest.limits.maxTasks,taskCount:counts.get(g.id)??0};
  });
  const cursor=Number(this.c.store.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM events').get().n);
  const reviewers=this.c.beta?this.c.store.db.prepare("SELECT data FROM records WHERE kind='reviewer' AND (? IS NULL OR json_extract(data,'$.goalId')=?) ORDER BY rowid DESC LIMIT 100").all(q.goalId,q.goalId).map(r=>{const {id,taskId,goalId,status,at,finishedAt}=JSON.parse(r.data);return {id,taskId,goalId,status,at:finishedAt??at};}):undefined;
  const planning=this.c.beta?this.c.store.db.prepare("SELECT data FROM records WHERE kind='planning' AND (? IS NULL OR json_extract(data,'$.goalId')=?) ORDER BY rowid DESC LIMIT 100").all(q.goalId,q.goalId).map(r=>{const {goalId,status,reason}=JSON.parse(r.data);const event=this.c.store.db.prepare("SELECT at FROM events WHERE goal_id=? AND type LIKE 'planning.%' ORDER BY seq DESC LIMIT 1").get(goalId);return {goalId,status,reason,at:event?.at??null};}):undefined;
  return {version:1,...(this.c.beta?{reviewers,planning,connections:connections(this.c),needsYou:ownerInbox(this.c,q)}:{}),cursor,goals,tasks:rows,agents,queue:rows.filter(t=>queueStates.has(t.status)),attention:rows.filter(t=>attentionStates.has(t.status)).map(t=>({taskId:t.id,goalId:t.goalId,status:t.status,objective:t.objective,instruction:'Continue in Codex to inspect and decide.'})),overflow:{tasks:tasks.length>500},limits:{goals:100,tasks:500,agents:500},nativeAccounting:'unavailable unless supplied by the native host'};
 }
 async artifactsList(raw){keys(raw,['taskId'],'artifact query');identifier(raw.taskId,'task ID');return (await this.artifacts.list(raw.taskId,{limit:100})).map(a=>({...a,reference:'artifact-'+a.id}));}
 async evidence(raw){
  keys(raw,['reference','start','length'],'evidence query');identifier(raw.reference,'evidence reference');const start=integer(raw.start??0,'start',0,Number.MAX_SAFE_INTEGER),length=integer(raw.length??8192,'length',1,OBSERVER_LIMITS.evidenceBytes);
  let bytes,partial=false,provenance='coordinator';
  if(raw.reference.startsWith('task-')){const t=this.c.getTask(raw.reference.slice(5));bytes=Buffer.from(JSON.stringify({id:t.id,objective:t.spec.objective,status:t.status,checkpoint:t.checkpoint,feedback:t.feedback,answers:t.answers,result:t.result,integration:t.integration??null,spent:t.spent},null,2));partial=!terminal.has(t.status);}
  else if(raw.reference.startsWith('request-')){
   const id=raw.reference.slice(8);identifier(id,'request ID');const row=this.c.store.db.prepare('SELECT * FROM requests WHERE id=?').get(id);if(!row)throw Error('Unknown saved request');this.c.store.get('task',row.task_id);const data=JSON.parse(row.data);partial=row.status!=='completed';provenance='captured';
   const chunks=partial?this.c.store.db.prepare("SELECT json_extract(data,'$.content') AS content FROM events WHERE task_id=? AND type='model.output' AND json_extract(data,'$.requestId')=? ORDER BY seq").all(row.task_id,id).map(r=>typeof r.content==='string'?r.content:'').join(''):null;
   bytes=Buffer.from(JSON.stringify({status:row.status,partial,result:data.result??null,error:data.error??null,...(data.workerProfile?{workerProfile:data.workerProfile}:{}),...(partial?{visiblePartial:chunks.slice(0,128*1024),warning:'Incomplete visible output; not a validated action or completed result.'}:{})},null,2));
  }else if(raw.reference.startsWith('artifact-')){const id=raw.reference.slice(9),record=this.c.store.get('artifact',id);this.c.store.get('task',record.taskId);bytes=(await this.artifacts.read(id)).data;}
  else throw Error('Unknown evidence reference kind');
  return {reference:raw.reference,partial,provenance,...window(bytes,start,length)};
 }
}
