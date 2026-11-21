import {executionHolds} from '../execution-ownership.mjs';
import {realpathSync,lstatSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {digest} from '../contracts.mjs';
import {repositoryGitCommonDirectory} from '../../project/git.mjs';

const slots=new Set(['running','uncertain','taking_over']);
const terminalGoals=new Set(['completed','partial']);
// A local failure is not proof the remote request ended. Historical reviews may
// omit outcome entirely; only positively certified completion/non-dispatch frees
// a slot. Use the same predicate for capacity and configuration quiescence.
const heldRequest="status='reserved' OR (status='failed' AND COALESCE(CASE WHEN json_valid(data) THEN json_extract(data,'$.requestOutcome') ELSE NULL END,'unknown') NOT IN ('completed','not_dispatched'))";
export function canonicalRepository(repo){
 try{return repositoryGitCommonDirectory(repo);}
 catch{try{return realpathSync.native(repo);}catch{return path.resolve(repo);}}
}
const uuidHash=value=>{const hash=digest(value);return `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`;};
export const repositoryLockId=goal=>uuidHash(canonicalRepository(goal.manifest.project.repo));
export const sharedBaseJournalId=(goal,generation)=>uuidHash({layout:'repository-base-v1',repository:canonicalRepository(goal.manifest.project.repo),baseCommit:goal.manifest.project.baseCommit,...(generation?{generation}:{})});

// This proves absence of executable/project ownership, never releases a request
// or changes the old approval. Drafts may lack physical baseline ownership, but
// remain prepared capacity policy unless the caller explicitly opts in here.
export function inertUnstartedGoal(c,goal,{allowDraft=false}={}){
 if(executionHolds(c,{goalId:goal?.id}).length)return false;
 if(!goal||terminalGoals.has(goal.status)||digest(goal.manifest)!==goal.hash)return false;
 const draft=allowDraft&&goal.status==='draft'&&goal.activatedAt==null,expired=goal.activatedAt!=null&&Number.isFinite(goal.deadline)&&goal.deadline<=c.now();
 if(!draft&&!expired||goal.integration||goal.integrationSealed||goal.integrationOwner||goal.integrationPending)return false;
 const tasks=c.store.all('task'),goals=c.store.all('goal');
 if(tasks.some(t=>t.goalId===goal.id)||c.store.db.prepare("SELECT 1 FROM submissions WHERE kind='task' AND scope=?").get(goal.id))return false;
 const planning=c.store.maybe('planning',goal.id);
 if(planning&&(!expired||planning.owner||!['queued','completed','blocked','partial'].includes(planning.status)))return false;
 if(c.store.all('reviewer').some(r=>r.goalId===goal.id)||c.store.all('review_ticket').some(r=>r.goalId===goal.id)||c.store.all('agent').some(r=>r.goalId===goal.id)||c.store.all('overnight_preflight').some(r=>r.goalId===goal.id)||c.store.all('overnight_preflight_history').some(r=>r.goalId===goal.id))return false;
 const ownerOf=input=>input?.goalId??tasks.find(t=>t.id===input?.taskId)?.goalId;
 for(const kind of ['operation','effect'])for(const record of c.store.all(kind)){
  const owner=record.goalId??ownerOf(record.input)??tasks.find(t=>t.id===record.taskId)?.goalId,unknown=!owner||!goals.some(g=>g.id===owner);
  if(owner===goal.id&&record.name==='overnight_preflight'||(owner===goal.id||unknown)&&!['completed','failed'].includes(record.status))return false;
 }
 for(const row of c.store.db.prepare('SELECT task_id,kind,status,data FROM requests').all()){
  const own=row.task_id===goal.id,foreign=goals.some(g=>g.id===row.task_id)||tasks.some(t=>t.id===row.task_id);
  if(!own&&foreign)continue;
  const data=requestData(row.data),known=data&&(row.status==='completed'&&data.result&&typeof data.result==='object'&&!Array.isArray(data.result)&&Number.isFinite(data.savedAt)||row.status==='failed'&&['completed','not_dispatched'].includes(data.requestOutcome));
  if(!known||own&&(!expired||!planning||planning.owner||!['queued','completed','blocked','partial'].includes(planning.status)||row.kind!=='model'))return false;
 }
 try{
  const exists=file=>{try{lstatSync(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
  const populated=dir=>{try{const stat=lstatSync(dir);return !stat.isDirectory()||stat.isSymbolicLink()||readdirSync(dir).length>0;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
  const ids=new Set([goal.id]);if(goal.manifest.project)for(const id of [repositoryLockId(goal),sharedBaseJournalId(goal),sharedBaseJournalId(goal,goal.id)])ids.add(id);
  for(const id of ids){
   if(id!==goal.id&&goals.some(other=>other.id!==goal.id&&other.integration?.journalId===id))continue;
   if(exists(path.join(c.store.root,'integration','jobs',id+'.jsonl'))||populated(path.join(c.store.root,'integration','artifacts',id)))return false;
  }
 }catch{return false;}
 return true;
}

function scopeRoot(scope){
 if(typeof scope!=='string'||!scope||scope.includes('..'))return null;
 const prefix=scope.split(/[?*[{]/,1)[0];
 const root=(prefix===scope?prefix:prefix.slice(0,prefix.lastIndexOf('/')+1)).replace(/\/$/,'');return root||null;
}
export function scopesOverlap(a,b){
 if(!Array.isArray(a)||!Array.isArray(b)||!a.length||!b.length)return true;
 return a.some(left=>b.some(right=>{const x=scopeRoot(left),y=scopeRoot(right);return !x||!y||x===y||x.startsWith(y+'/')||y.startsWith(x+'/');}));
}
function profiles(goal){return [...(goal.manifest.providerPolicy?.workers??[]),...(goal.manifest.reviewPolicy?.reviewer?[goal.manifest.reviewPolicy.reviewer]:[])];}
const executableRevision=(c,r)=>r.status==='draft'&&!terminalGoals.has(c.store.maybe('goal',r.goalId)?.status)&&!inertUnstartedGoal(c,c.store.maybe('goal',r.goalId));
export function hasPreparedWork(c){return executionHolds(c).length>0||c.store.all('goal_revision').some(r=>executableRevision(c,r))||c.store.all('goal').some(g=>!terminalGoals.has(g.status)&&!inertUnstartedGoal(c,g))||c.store.db.prepare('SELECT 1 FROM requests WHERE '+heldRequest).get()!==undefined;}
export function configureServiceCapacity(c,requested){
 if(requested!==undefined&&(!Number.isSafeInteger(requested)||requested<1||requested>4))throw Error('Invalid service maximum concurrent tasks');
 const saved=c.store.maybe('capacity_config','service'),limit=requested??saved?.limit??1;
 if((saved?.limit??1)!==limit&&hasPreparedWork(c))throw Error('Capacity changes require quiescence of active/prepared work');
 if(requested!==undefined)c.store.put('capacity_config',{id:'service',limit});
 return limit;
}
export function assertCapacityConfiguration(c,manifest,{excludeGoalId}={}){
 if(!manifest.providerPolicy&&!manifest.reviewPolicy?.reviewer)return;
 const held=new Set(c.store.db.prepare('SELECT task_id FROM requests WHERE '+heldRequest).all().map(r=>c.store.maybe('task',r.task_id)?.goalId??r.task_id));
 const goals=c.store.all('goal').filter(g=>g.id!==excludeGoalId&&(!terminalGoals.has(g.status)&&!inertUnstartedGoal(c,g)||held.has(g.id))),items=[...goals.map(g=>g.manifest),...c.store.all('goal_revision').filter(r=>executableRevision(c,r)).map(r=>r.manifest),manifest];
 const groups=new Map(),endpoints=new Map(),identities=new Map();
 for(const m of items){
  for(const group of m.providerPolicy?.capacityGroups??[]){if(groups.has(group.id)&&groups.get(group.id)!==group.limit)throw Error('Contradictory active/prepared capacity group limit configuration');groups.set(group.id,group.limit);}
  for(const p of profiles({manifest:m})){
   if(!(m.providerPolicy?.capacityGroups??[]).some(g=>g.id===p.capacityGroup)){if(groups.has(p.capacityGroup)&&groups.get(p.capacityGroup)!==1)throw Error('Contradictory active/prepared reviewer capacity group limit configuration');groups.set(p.capacityGroup,1);}
   if(endpoints.has(p.baseUrl)&&endpoints.get(p.baseUrl)!==p.capacityGroup)throw Error('Endpoint aliases require the same capacity group across active/prepared work');endpoints.set(p.baseUrl,p.capacityGroup);
   const key=p.id+'@'+p.revision,identity={hash:digest(p),group:p.capacityGroup,limit:p.concurrency};
   if(identities.has(key)&&digest(identities.get(key))!==digest(identity))throw Error('Provider capacity identity changed while active/prepared work exists');identities.set(key,identity);
  }
 }
}
function requestData(raw){
 try{const value=JSON.parse(raw);return value&&typeof value==='object'&&!Array.isArray(value)?value:null;}catch{return null;}
}
function requestResource(data,row,approvals,tasks){
 if(!data)return null;
 const binding=data.providerBinding??data.reviewerBinding,hasBinding=Object.hasOwn(data,'providerBinding')||Object.hasOwn(data,'reviewerBinding');
 if(Object.hasOwn(data,'providerBinding')&&Object.hasOwn(data,'reviewerBinding'))return null;
 if(hasBinding&&(!binding||typeof binding!=='object'||Array.isArray(binding)||binding.version!==1||
    Object.keys(binding).length!==5||!['version','providerId','revision','profileHash','policyHash'].every(key=>Object.hasOwn(binding,key))))return null;
 // A profile may survive many approvals with different group ceilings. Resolve
 // its exact policy within the request owner's current/history records first;
 // another goal containing that profile is not evidence of this receipt's limit.
 const goalId=tasks.find(t=>t.id===row.task_id)?.goalId??(approvals.some(g=>(g.goalId??g.id)===row.task_id)?row.task_id:null);
 const sources=goalId?approvals.filter(g=>(g.goalId??g.id)===goalId):approvals;
 const matches=p=>hasBinding?binding&&p.id===binding.providerId&&p.revision===binding.revision&&digest(p)===binding.profileHash:digest(p)===data.capacityResource?.profileHash;
 const resources=new Map();
 for(const source of sources){
  if(digest(source.manifest)!==source.hash)continue;
  const manifest=source.manifest,policyMatches=(policy,hash)=>policy&&hash===binding.policyHash&&digest(policy)===hash;
  const candidates=hasBinding?[
   ...(policyMatches(manifest.providerPolicy,manifest.providerPolicyHash)?manifest.providerPolicy.workers:[]),
   ...(policyMatches(manifest.reviewPolicy,manifest.reviewPolicyHash)&&manifest.reviewPolicy.reviewer?[manifest.reviewPolicy.reviewer]:[]),
  ]:profiles(source);
  for(const profile of candidates.filter(matches)){
   const expected={profileHash:digest(profile),capacityGroup:profile.capacityGroup,baseUrl:profile.baseUrl,profileLimit:profile.concurrency,
    groupLimit:manifest.providerPolicy?.capacityGroups.find(g=>g.id===profile.capacityGroup)?.limit??1};
   resources.set(digest(expected),expected);
  }
 }
 // Legacy orphan receipts can still resolve an exact immutable binding, but
 // missing/conflicting policy provenance must retain the global uncertain hold.
 if(resources.size!==1)return null;
 const expected=resources.values().next().value;
 // Old receipts without resource metadata can use their exact immutable binding.
 // Present but incomplete/inconsistent metadata is uncertainty, not a new group.
 if(!Object.hasOwn(data,'capacityResource'))return expected;
 const resource=data.capacityResource;
 if(!resource||typeof resource!=='object'||Array.isArray(resource)||Object.keys(resource).length!==Object.keys(expected).length||
    !Object.keys(expected).every(key=>Object.hasOwn(resource,key))||
    ['profileHash','capacityGroup','baseUrl','profileLimit'].some(key=>resource[key]!==expected[key])||
    !Number.isSafeInteger(resource.groupLimit)||resource.groupLimit<1||resource.groupLimit>expected.groupLimit)return null;
 return resource;
}
export function capacitySnapshot(c){
 const goals=c.store.all('goal'),tasks=c.store.all('task'),approvals=[...goals,...c.store.all('goal_history')];
 const requests=c.store.db.prepare("SELECT * FROM requests WHERE kind IN ('model','apiReview','codexReview') AND ("+heldRequest+")").all().map(row=>{
  const data=requestData(row.data);
  return {...data,...row,resource:requestResource(data,row,approvals,tasks)};
 });
 return {executionOwners:executionHolds(c),serviceLimit:c.store.maybe('capacity_config','service')?.limit??c.serviceMaxConcurrentTasks??1,autonomousParallelBusy:c.autonomousParallelBusy===true,activeTasks:tasks.filter(t=>slots.has(t.status)&&t.spec.actor==='deepseek'&&t.executionActor!=='codex'),tasks,goals,planning:c.store.all('planning').filter(p=>['running','uncertain'].includes(p.status)),requests};
}
export function canClaim({task,goal,route,snapshot}){
 const active=snapshot.activeTasks,policy=goal.manifest.providerPolicy,extra=(snapshot.executionOwners??[]).filter(owner=>!active.some(t=>t.id===owner.taskId));
 if(extra.some(owner=>owner.goalId===goal.id&&(!owner.taskId||owner.taskId===task.id)))return {allowed:false,reasonCode:'execution_ownership_held',explanation:'Native execution requires exact quiescence before reuse'};
 if(!policy&&snapshot.autonomousParallelBusy)return {allowed:false,reasonCode:'legacy_global_slot',explanation:'Historical work waits for parallel process lanes to settle'};
 if(!policy||active.some(t=>!snapshot.goals.find(g=>g.id===t.goalId)?.manifest.providerPolicy)||snapshot.planning.some(p=>!snapshot.goals.find(g=>g.id===p.goalId)?.manifest.providerPolicy)){
  if(active.length||snapshot.planning.length)return {allowed:false,reasonCode:'legacy_global_slot',explanation:'Historical work retains its single global autonomous slot'};
 }
 if(active.length+extra.length>=snapshot.serviceLimit)return {allowed:false,reasonCode:'service_task_capacity',explanation:'Private service task capacity is occupied'};
 if(active.filter(t=>t.goalId===goal.id).length+extra.filter(owner=>owner.goalId===goal.id).length>=(policy?.maxConcurrentTasks??1))return {allowed:false,reasonCode:'goal_task_capacity',explanation:'Approved goal task capacity is occupied'};
 const scopeWait=writeScopeWait({task,goal,snapshot});if(scopeWait)return scopeWait;
 return {allowed:true,reasonCode:'capacity_available',explanation:'Task runner capacity available'};
}
export function writeScopeWait({task,goal,snapshot}){
 if(task.spec.kind==='coding'&&goal.manifest.project){
  const repo=canonicalRepository(goal.manifest.project.repo);
  for(const owner of snapshot.executionOwners??[])if(owner.repository&&canonicalRepository(owner.repository)===repo&&scopesOverlap(task.spec.permissions?.writePaths,owner.writePaths))return {allowed:false,reasonCode:'execution_scope_held',explanation:'Native execution retains overlapping or ambiguous write scope until quiescence'};
  for(const other of snapshot.tasks){
   const otherGoal=snapshot.goals.find(g=>g.id===other.goalId),writer=other.native?.writerActive||other.status==='codex_active'||otherGoal?.integrationOwner===other.id;
   if(other.id===task.id||other.spec.kind!=='coding'||(!other.startedAt&&!other.owner&&!writer)||!writer&&['accepted','cancelled','failed','partial'].includes(other.status))continue;
   if(otherGoal?.manifest.project&&canonicalRepository(otherGoal.manifest.project.repo)===repo&&scopesOverlap(task.spec.permissions?.writePaths,other.spec.permissions?.writePaths))return {allowed:false,reasonCode:'write_scope_busy',explanation:'An unresolved candidate owns overlapping or ambiguous write scope'};
  }
 }
 return null;
}
export function inferenceResource(c,goal,binding){
 const p=profiles(goal).find(p=>p.id===binding?.providerId&&p.revision===binding.revision&&digest(p)===binding.profileHash);
 if(!p)return null;
 const group=goal.manifest.providerPolicy?.capacityGroups.find(g=>g.id===p.capacityGroup);
 return {profileHash:binding.profileHash,capacityGroup:p.capacityGroup,baseUrl:p.baseUrl,profileLimit:p.concurrency,groupLimit:group?.limit??1};
}
export function inferenceWait(c,goal,binding,snapshot=capacitySnapshot(c)){
 const resource=inferenceResource(c,goal,binding);
 if(!resource){if(snapshot.requests.length)return {waiting:true,reasonCode:'legacy_inference_busy',explanation:'Historical inference has a single global slot'};return null;}
 if(snapshot.requests.some(r=>!r.resource))return {waiting:true,reasonCode:'legacy_inference_busy',explanation:'Unidentified historical request retains global inference capacity'};
 const sameGroup=snapshot.requests.filter(r=>r.resource.capacityGroup===resource.capacityGroup||r.resource.baseUrl===resource.baseUrl);
 const limit=Math.min(resource.groupLimit,...sameGroup.map(r=>r.resource.groupLimit??1));
 if(sameGroup.length>=limit)return {waiting:true,reasonCode:'capacity_group_busy',explanation:'Shared inference capacity group is occupied'};
 const sameProfile=snapshot.requests.filter(r=>r.resource.profileHash===resource.profileHash);
 if(sameProfile.length>=Math.min(resource.profileLimit,...sameProfile.map(r=>r.resource.profileLimit)))return {waiting:true,reasonCode:'profile_capacity_busy',explanation:'Profile inference capacity is occupied'};
 return null;
}
export class CapacityWaitError extends Error{constructor(wait){super(wait.explanation);this.name='CapacityWaitError';this.waiting=true;this.reasonCode=wait.reasonCode;}}
export function assertInferenceCapacity(c,goal,binding){const wait=inferenceWait(c,goal,binding);if(wait)throw new CapacityWaitError(wait);return inferenceResource(c,goal,binding);}

// A denied fresh reservation is an idle state, not permission to repeatedly
// reclaim the task. Re-evaluate the actual ledger so unrelated commits do not
// spend or wake it, while a completed exact reply can advance without inference.
export function capacityWaitHeld(c,task,goal){
 if(!task.capacityWait||!['queued','suspended'].includes(task.status)||task.spec.actor!=='deepseek'||task.executionActor==='codex')return false;
 const requestKey=task.capacityWait.requestKey??(task.spec.kind==='consult'?'consult-1':task.spec.kind==='coding'&&task.checkpoint.phase==='model'?`code-${task.checkpoint.attempt}-${task.checkpoint.exchange}`:null);
 if(requestKey){
  let saved;try{saved=c.store.request(task.id,requestKey);}catch{return true;}
  if(saved?.kind==='model'&&saved.status==='completed'&&saved.routeHash===task.routeHash&&digest(saved.providerBinding??null)===digest(task.providerBinding??null))return false;
 }
 return Boolean(inferenceWait(c,goal,task.providerBinding));
}
