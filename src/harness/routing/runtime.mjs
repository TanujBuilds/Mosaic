import {canClaim,capacitySnapshot,holdsPlanningSlot,holdsTaskSlot,inferenceWait,serviceCapacity} from '../scheduling/capacity.mjs';
import {digest,normalizeTask,isStartedLegacyTask} from '../contracts.mjs';
import {selectRoute} from './router.mjs';
import {codingModelReplayEligible} from '../coding.mjs';

export const isRoutedTask=(goal,task)=>Boolean(goal.manifest.routingPolicy&&task.spec.routing);
export function assertRoutingApproval(goal){
 if((Object.hasOwn(goal.manifest,'routingPolicy')||Object.hasOwn(goal.manifest,'routingPolicyHash'))&&digest(goal.manifest)!==goal.hash)throw Error('Approved routing goal hash changed');
}
export function routeOrigin(c,goal,task){
 const origin=task.route.goalVersion===goal.version?goal:c.store.maybe('goal_history',`${goal.id}-${task.route.goalVersion}`);
 if(!origin||origin.hash!==task.route.goalHash||digest(origin.manifest)!==task.route.goalHash)throw Error('Original route approval is unavailable');
 return origin;
}
/** Current permissions/mode stay authoritative; a started task keeps its route policy. */
export function taskRoutingManifest(c,goal,task){
 if(!task.startedAt||!task.route)return goal.manifest;
 const original=routeOrigin(c,goal,task).manifest;
 return {...goal.manifest,routingPolicy:original.routingPolicy,routingPolicyHash:original.routingPolicyHash};
}
export function remainingCalls(c,task){return Math.max(0,task.spec.limits.modelCalls-(c.store.spent(task.id).model??0));}
function busy(c,goal,binding){return Boolean(inferenceWait(c,goal,binding));}
/** Occupancy of an established pin is independent of current routing preferences.
 * Exact completed model replies need no inference resource, even at zero budget. */
export function pinnedResourceWait(c,goal,task){
 if(!task.route||!task.providerBinding)return null;
 const cp=task.checkpoint,key=task.spec.kind==='consult'?'consult-1':cp.phase==='model'?`code-${cp.attempt}-${cp.exchange}`:null;
 const saved=key&&c.store.request(task.id,key);
 if(saved?.kind==='model'&&saved.status==='completed'&&saved.routeHash===task.routeHash&&saved.providerBinding&&digest(saved.providerBinding)===digest(task.providerBinding)&&
    (task.spec.kind==='consult'||codingModelReplayEligible(c,task)))return null;
 if(!busy(c,goal,task.providerBinding))return null;
 return {status:'waiting',binding:structuredClone(task.providerBinding),reasonCode:'provider_busy',
  explanation:'Pinned worker '+task.providerBinding.providerId+' has an existing reserved or uncertain request on its selected profile/group; wait without fallback. Original selection: '+task.route.decision.explanation,
  matchedRule:structuredClone(task.route.decision.matchedRule)};
}
export function routeDecision(c,goal,task,observation){
 assertRoutingApproval(goal);
 const availability={providers:[],budget:{remainingModelCalls:remainingCalls(c,task)}};
 const route=selectRoute({goal,task,availability});
 if(!route.binding)return route;
 if(busy(c,goal,route.binding))availability.providers=[{...route.binding,status:'busy',observedAt:new Date(c.now()).toISOString(),provenance:'existing reserved or uncertain request on selected profile/group'}];
 else if(observation)availability.providers=[observation];
 return selectRoute({goal,task,availability});
}
/** Shared synchronous public/composition preview. Never probes, reserves or writes. */
export function previewRoute(c,{goalId,task}){
 const goal=c.store.get('goal',goalId);assertRoutingApproval(goal);
 const saved=c.store.all('task').find(t=>t.goalId===goalId&&t.spec.submissionId===task.submissionId);
 const spec=normalizeTask(task,saved?taskRoutingManifest(c,goal,saved):goal.manifest,c.registry,{checkRoutingEligibility:false,existingTask:saved});
 if(isStartedLegacyTask(saved)){
  // Validate the proposed current scope and exact old provider without updating
  // its saved version. Preview never grants the explicit rebind still required.
  if(!goal.manifest.providerPolicy)throw Error('Persisted legacy provider pin requires its approved pool');
  c.verifyWorkerBinding(goal,{...saved,spec,goalVersion:goal.version});
  const binding=structuredClone(saved.providerBinding),prefix='Persisted legacy binding to '+binding.providerId+'; no historical routing decision was added. ';
  let status='waiting',reasonCode='availability_unknown',explanation='No current availability observation proves this worker ready.';
  if(saved.goalVersion!==goal.version||saved.hash!==digest(spec)){reasonCode='task_rebind_required';explanation='Explicit rebind to the current approved task scope/version is required.';}
  else if(remainingCalls(c,saved)===0){status='ineligible';reasonCode='budget_exhausted';explanation='The original model-call budget is exhausted; the persisted binding is historical identity, not new inference authority.';}
  else if(busy(c,goal,binding)){reasonCode='provider_busy';explanation='An existing reserved or uncertain request occupies this profile/group; wait without fallback.';}
  return {status,binding,reasonCode,explanation:prefix+explanation,matchedRule:null,expectedGoalHash:goal.hash,expectedGoalVersion:goal.version};
 }
 const candidate={id:saved?.id??'preview',spec};
 let selectionGoal=goal;
 if(saved?.route&&saved.hash===digest(spec)){assertRoutePin(c,goal,saved);selectionGoal=routeOrigin(c,goal,saved);}
 const decision=routeDecision(c,selectionGoal,candidate);
 return {...decision,expectedGoalHash:goal.hash,expectedGoalVersion:goal.version};
}
export function assertRoutePin(c,goal,task){
 if(digest(goal.manifest)!==goal.hash)throw Error('Approved routing goal hash changed');
 const route=task.route;
 if(!route||route.version!==1||task.routeHash!==digest(route)||route.decision.status!=='selected'||digest(route.decision.binding)!==digest(task.providerBinding)||digest(task.spec)!==task.hash)throw Error('Task route pin changed');
 const originalGoal=routeOrigin(c,goal,task);
 const original=route.taskHash===task.hash?task:(task.history??[]).find(h=>h.hash===route.taskHash);
 if(!original||digest(original.spec)!==route.taskHash||digest(original.spec.routing)!==digest(task.spec.routing)||original.spec.actor!==task.spec.actor||original.spec.kind!==task.spec.kind)throw Error('Original task routing authority changed');
 const selected=selectRoute({goal:originalGoal,task:original,availability:{budget:{remainingModelCalls:1}}});
 if(!selected.binding||digest(selected.binding)!==digest(task.providerBinding))throw Error('Pinned provider differs from original approved route');
}
function same(c,snapshot){
 const task=c.store.get('task',snapshot.taskId),goal=c.store.get('goal',task.goalId);
 return task.hash===snapshot.taskHash&&digest(task.spec)===snapshot.taskHash&&task.goalVersion===snapshot.goalVersion&&goal.version===snapshot.goalVersion&&goal.hash===snapshot.goalHash&&c.eligible(task)&&!task.providerBinding;
}
export function recordRoutingWait(c,task,goal,decision){
 const retryAt=Math.min(goal.deadline,task.deadline??goal.deadline,task.providerWait?.until??Infinity,c.now()+15000);
 if(task.providerWait)delete task.providerWait.readyOwner;
 task.routingWait={retryAt,goalHash:goal.hash,goalVersion:goal.version,taskHash:task.hash,decision};
 c.store.put('task',task);c.emit('task.routing_wait',goal.id,task.id,{reasonCode:decision.reasonCode,explanation:decision.explanation,binding:decision.binding,retryAt});
}
/** A cached reply may advance a running task to a new exchange. Check again at
 * that safe boundary before fresh work, without releasing unknown own requests. */
export function holdPinnedResource(worker,task){
 const c=worker.c;if(!task.route)return null;
 return c.store.tx(()=>{
  const current=c.owned(task.id,worker.owner),goal=c.store.get('goal',current.goalId),decision=pinnedResourceWait(c,goal,current);
  if(!decision)return null;
  if(c.store.db.prepare("SELECT 1 FROM requests WHERE task_id=? AND kind='model' AND (status='reserved' OR (status='failed' AND json_extract(data,'$.requestOutcome')='unknown'))").get(current.id))return {waiting:true,taskId:current.id};
  current.status='suspended';current.owner=null;
  recordRoutingWait(c,current,goal,decision);return c.getTask(current.id);
 });
}
/** Selected-endpoint readiness is bounded, outside every Store transaction. */
export async function claimAvailable(worker){
 if(worker.shutdown?.signal.aborted)return {waiting:true,reasonCode:'service_stopping'};
 const c=worker.c,claimed=c.claimNext(worker.owner);if(claimed)return claimed;
 const unfinished=c.store.unfinishedTasks(),parallel=serviceCapacity(c)>1;
 if(!parallel&&(c.store.all('planning').some(p=>holdsPlanningSlot(p)&&!c.store.get('goal',p.goalId).manifest.providerPolicy)||unfinished.some(t=>holdsTaskSlot(t)&&!c.store.get('goal',t.goalId).manifest.providerPolicy)))return null;
 const tasks=unfinished.filter(t=>['queued','suspended'].includes(t.status)&&t.spec.actor==='deepseek'&&t.executionActor!=='codex'&&c.eligible(t));
 if(!tasks.length)return null;
 const priorities=c.effectivePriorities(unfinished);
 tasks.sort((a,b)=>priorities.get(b.id)-priorities.get(a.id)||a.sequence-b.sequence);
 let waited=false,probes=0;const observations=new Map(),offlineEndpoints=new Set();
 for(const task of tasks){
  const goal=c.store.get('goal',task.goalId);
  if(!isRoutedTask(goal,task)||task.providerBinding)continue;
  if(!canClaim({task,goal,snapshot:capacitySnapshot(c)}).allowed)continue;
  const snapshot={taskId:task.id,taskHash:task.hash,goalHash:goal.hash,goalVersion:goal.version,lease:c.workerLease?.generation??null};
  let route;
  try{route=routeDecision(c,goal,task);c.verifyWorkerBinding(goal,route.binding);}
  catch(error){return c.store.tx(()=>c.settleTask(task,'blocked',String(error.message).slice(0,500)));}
  if(route.status==='ineligible')return c.store.tx(()=>c.settleTask(task,'blocked',route.explanation));
  if(route.reasonCode==='provider_busy'){c.store.tx(()=>recordRoutingWait(c,task,goal,route));waited=true;if(!parallel)return {waiting:true};continue;}
  const until=Math.min(goal.deadline,task.deadline??goal.deadline,task.providerWait?.until??Infinity);
  const profile=c.providerRegistry.get(route.binding.providerId,route.binding.revision),cacheKey=route.binding.profileHash;
  if(!observations.has(cacheKey)&&!offlineEndpoints.has(profile.baseUrl)&&probes>=1)return {waiting:true,reasonCode:'availability_scan_pending',retryAt:c.now()+250};
  let available=observations.get(cacheKey)??false;
  if(!observations.has(cacheKey)&&!offlineEndpoints.has(profile.baseUrl)){probes++;
  try{const provider=c.providerRegistry.createClient(route.binding);if(until>c.now())available=await provider.availability(AbortSignal.any([AbortSignal.timeout(Math.max(1,Math.min(10000,until-c.now()))),...(worker.shutdown?[worker.shutdown.signal]:[])]))===true;}
  catch{/* Unavailable does not authorize inference or fallback. */}
  observations.set(cacheKey,available);if(!available)offlineEndpoints.add(profile.baseUrl);
  }
  if(worker.shutdown?.signal.aborted)return {waiting:true,reasonCode:'service_stopping'};
  if((c.workerLease?.generation??null)!==snapshot.lease)return null;
  if(!same(c,snapshot))continue;
  const manual=profile.capabilities.modelDiscovery==='manual';
  const observation={providerId:route.binding.providerId,revision:route.binding.revision,profileHash:route.binding.profileHash,status:available?(manual?'eligible':'available'):'offline',observedAt:new Date(c.now()).toISOString(),provenance:manual?'configured manual-model retry eligibility; no network, discovery or health probe':'bounded selected-provider availability probe'};
  const next=c.claimNext(worker.owner,{...snapshot,observation});if(next)return next;
  waited=true;if(!parallel)return {waiting:true};
 }
 return waited?{waiting:true}:null;
}
