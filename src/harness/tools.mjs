import {actionContext,ownerInbox} from './owner-inbox.mjs';
import {bindingFields} from './review/contracts.mjs';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {keys,integer,text,digest,goalDispatchInputSchema,taskDispatchInputSchema} from './contracts.mjs';
import {Goals} from './goals.mjs';
import {isOvernightV2} from './overnight.mjs';
import {assertOvernightPreflight,OvernightPreflight} from './overnight-preflight.mjs';
import {Worker} from './worker.mjs';
import {NativeResearch} from './native-research.mjs';
import {Agents} from './agents.mjs';
import {Artifacts} from './artifacts.mjs';
import {Observer} from './observer.mjs';
import {assignmentManifestSchema,prepareAssignment} from './assignment-intake.mjs';
import {registerRoutingTools} from './routing/tools.mjs';
import {registerOutcomeTools} from './outcomes/tools.mjs';
import {registerBacklogTools} from './backlog/tools.mjs';
import {registerWorkflowRecipeTools} from './workflow-recipes/tools.mjs';
import {registerResearchMissionTools} from './research-missions/tools.mjs';

const str={type:'string'},obj={type:'object'},bool={type:'boolean'},number={type:'integer'};
function validate(schema,value,label='input'){
 if(schema.anyOf){if(schema.anyOf.some(s=>{try{validate(s,value,label);return true;}catch{return false;}}))return;throw Error(`Invalid ${label}`);}
 if(schema.type==='null'){if(value!==null)throw Error(`Invalid ${label}`);return;}
 if(schema.type==='array'){if(!Array.isArray(value)||value.length>(schema.maxItems??100))throw Error(`Invalid ${label}`);for(const item of value)validate(schema.items,item,label);return;}
 if(schema.type==='object'){keys(value,schema.properties?Object.keys(schema.properties):Object.keys(value??{}),label);for(const name of schema.required??[])if(value[name]===undefined)throw Error(`Missing ${name}`);if(schema.properties)for(const [name,item]of Object.entries(value))validate(schema.properties[name],item,name);}
 else if(schema.type==='string')text(value,label,schema.maxLength??40000);
 else if(schema.type==='integer')integer(value,label,schema.minimum??0,schema.maximum??Number.MAX_SAFE_INTEGER);
 else if(schema.type==='boolean'&&typeof value!=='boolean')throw Error(`Invalid ${label}`);
 if(schema.enum&&!schema.enum.includes(value))throw Error(`Invalid ${label}`);
}
export class Dispatcher {
 constructor({c,worker=new Worker({c}),config={}}){this.c=c;this.worker=worker;this.goals=new Goals(c);this.nativeResearch=new NativeResearch({c,config});this.artifacts=new Artifacts(c);this.observer=new Observer({c,artifacts:this.artifacts});this.agents=new Agents({c,config});this.definitions=new Map();this.running=new Set();this.promises=new Map();
  const add=(name,description,properties,required,mutating,fn)=>{if(config.beta&&['mode_register','workflow_register'].includes(name))return;const p=mutating?{...properties,idempotencyKey:str}:properties,r=mutating?[...required,'idempotencyKey']:required;this.definitions.set(name,{name,description:config.beta?description.replaceAll('DeepSeek-only','API-worker-only').replaceAll('DeepSeek','API worker'):description,inputSchema:{type:'object',properties:p,required:r,additionalProperties:false},annotations:{readOnlyHint:!mutating,idempotentHint:true},fn,mutating});};
  registerOutcomeTools({add,c});
  add('tools_list','Discover harness tools.',{},[],false,()=>this.tools());
  if(!config.beta)registerResearchMissionTools({add,c,worker,artifacts:this.artifacts});
  add('service_stop','Stop the coordinator process after preserving worker ownership. Does not stop native Codex goal mode.',{},[],true,(_,key)=>c.store.command(key,{op:'service.stop'},()=>{if(!this.onStop)throw Error('Service controls are unavailable');this.onStop();return {stopping:true};}));
  add('registry_list','List pinned-capability and mode definitions.',{},[],false,()=>{
   const registry=c.registry.snapshot();
   if(!config.beta)return registry;
   const modes=registry.modes.filter(mode=>['collaborative','deepseek_only','codex_only','overnight_review'].includes(mode.id)&&(mode.version===1||isOvernightV2({mode})));
   return {...registry,workerProfile:c.workerProfile,capabilities:registry.capabilities.filter(capability=>capability.id!=='research'),
    modes:modes.map(mode=>({...mode,capabilities:mode.capabilities.filter(id=>id!=='research')})),
    workflows:registry.workflows.filter(workflow=>!workflow.tasks.some(task=>task.kind==='research'))};
  });
  add('notifications_list','List at most50 unread actionable local notifications. Unchanged state does not create new notifications.',{goalId:str},[],false,i=>c.notifications(i));
  add('notification_ack','Acknowledge a saved local notification without changing execution state.',{notificationId:str},['notificationId'],true,(i,k)=>c.ackNotification(i,k));
  add('mode_register','Register a versioned policy composed only from reviewed capabilities. Existing goals stay pinned.',{definition:obj},['definition'],true,(i,k)=>c.store.command(k,{op:'mode.register',...i},()=>{const definition=c.registry.registerMode(i.definition);c.store.put('mode',{id:`${definition.id}-${definition.version}`,definition});return definition;}));
  add('workflow_register','Register a validated dependency template using supported capabilities.',{definition:obj},['definition'],true,(i,k)=>c.store.command(k,{op:'workflow.register',...i},()=>{const definition=c.registry.registerWorkflow(i.definition);c.store.put('workflow',{id:`${definition.id}-${definition.version}`,definition});return definition;}));
  add('workflow_submit','Instantiate an exact registered workflow within the approved goal. Dependency mapping and submission are atomic.',{goalId:str,workflowId:str,version:{...number,minimum:1},submissionId:str},['goalId','workflowId','version','submissionId'],true,(i,k)=>c.submitWorkflow(i,k));
  registerWorkflowRecipeTools({add,c});
  const {researchPolicy:parkedGoalPolicy,...codingGoal}=goalDispatchInputSchema.properties;
  const {researchPolicy:parkedTaskPolicy,...codingTask}=taskDispatchInputSchema.properties;
  const goalSchema=config.beta?{...goalDispatchInputSchema,properties:codingGoal}:goalDispatchInputSchema;
  const taskSchema=config.beta?{...taskDispatchInputSchema,properties:{...codingTask,kind:{...codingTask.kind,enum:['coding','consult','learning']}}}:taskDispatchInputSchema;
  registerRoutingTools({add,c,taskSchema});
  add('goal_prepare','Prepare an exact reviewable goal manifest. Does not activate.',{manifest:goalSchema},['manifest'],true,(i,k)=>c.preparePortableGoal(i.manifest,k));
  if(!config.beta)add('legacy_goal_prepare','Explicit compatibility preparation for a historical nonportable workflow.',{manifest:goalSchema},['manifest'],true,(i,k)=>c.prepareLegacyGoal(i.manifest,k));
  add('assignment_prepare','Check explicit coding prerequisites and prepare a reviewable draft without activating or running work.',{manifest:assignmentManifestSchema},[],true,(i,k)=>prepareAssignment(c,i.manifest,k));
  if(!config.beta)add('legacy_assignment_prepare','Explicit compatibility intake for a historical nonportable workflow.',{manifest:assignmentManifestSchema},[],true,(i,k)=>prepareAssignment(c,i.manifest,k,{legacy:true}));
  add('overnight_preflight','Verify the exact approved infrastructure checks in the actual scoped sandbox before activation.',{goalId:str,hash:str},['goalId','hash'],true,(i,k)=>this.launch('overnight_preflight',i,k,()=>new OvernightPreflight({c,checksFactory:worker.checksFactory,config:worker.config}).run(i,k)));
  add('goal_activate','Approve the exact prepared hash and activate within its limits.',{goalId:str,hash:str},['goalId','hash'],true,async(i,k)=>{await c.preflightExecution(i,{config,checksFactory:worker.checksFactory});return c.activateGoal(i,k);});
  add('goal_get','List the latest up to50 bounded goal summaries with total/truncated; goalId inspects one exact goal; explicit view:snapshot returns the legacy full operator snapshot.',{goalId:str,view:{...str,enum:['snapshot']}},[],false,i=>{
   if(i.goalId!==undefined&&i.view!==undefined)throw Error('Cannot combine goalId and view selectors');
   return i.goalId!==undefined?c.getGoal(i.goalId):i.view==='snapshot'?c.snapshot():c.goalSummaries();
  });
  add('goal_revision_prepare','Prepare a changed goal version without resetting spending.',{goalId:str,expectedHash:str,manifest:goalSchema},['goalId','expectedHash','manifest'],true,(i,k)=>this.goals.prepareRevision(i,k));
  add('goal_revision_activate','Activate the exact changed version after quiescence.',{revisionId:str,hash:str},['revisionId','hash'],true,async(i,k)=>{const revision=c.store.get('goal_revision',i.revisionId);await c.preflightExecution({goalId:revision.goalId,hash:i.hash},{config,checksFactory:worker.checksFactory});return this.goals.activateRevision(i,k);});
  add('goal_finalize','Finalize accepted work, or explicitly partial stopped work, with a hashed receipt.',{goalId:str,summary:str,partial:bool},['goalId','summary'],true,(i,k)=>this.goals.finalize(i,k));
  add('task_submit','Submit a narrower assignment within the active approved goal. Collaborative consult/coding candidates wait for supervisor review; DeepSeek-only uses checks without Codex.',{goalId:str,task:taskSchema,expectedGoalHash:str,expectedGoalVersion:{...number,minimum:1}},['goalId','task'],true,(i,k)=>{if(isOvernightV2(c.store.get('goal',i.goalId).manifest))throw Error('Overnight v2 stages require an atomically validated planner graph');return c.submitTask({...i.task,goalId:i.goalId,...(i.expectedGoalHash!==undefined?{expectedGoalHash:i.expectedGoalHash}:{}),...(i.expectedGoalVersion!==undefined?{expectedGoalVersion:i.expectedGoalVersion}:{})},k);});
  add('task_get','Inspect a task, its checkpoint and counters.',{taskId:str},['taskId'],false,i=>({...c.getTask(i.taskId),observerCursor:Number(c.store.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM events').get().n)}));
  add('artifacts_list','List only saved allowlisted artifacts with checksums; no arbitrary paths.',{taskId:str},['taskId'],false,i=>this.artifacts.list(i.taskId));
  if(config.beta)add('owner_inbox','List up to 50 saved owner decisions and handoffs without dispatching work.',{goalId:str,itemId:str},[],false,i=>ownerInbox(c,i));
  if(config.beta)add('owner_action_context','Inspect exact operator scope and saved evidence for one decision.',{goalId:str,taskId:str},['goalId'],false,i=>actionContext(c,i));
  add('observer_snapshot','Read bounded model/task/agent overviews. No execution controls.',{goalId:str,actor:{...str,enum:['codex','deepseek']}},[],false,i=>this.observer.snapshot(i));
  add('observer_timeline','Read chronological activity with a durable scan cursor; captured and reported provenance are explicit.',{goalId:str,actor:{...str,enum:['codex','deepseek']},after:number,recent:bool,limit:{...number,minimum:1,maximum:200}},[],false,i=>this.observer.timeline(i));
  add('observer_artifacts','Discover allowlisted saved evidence IDs and checksums. No arbitrary paths or execution authority.',{taskId:str},['taskId'],false,i=>this.observer.artifactsList(i));
  add('observer_evidence','Read a bounded saved evidence reference. Paths are never accepted.',{reference:str,start:number,length:{...number,minimum:1,maximum:32768}},['reference'],false,i=>this.observer.evidence(i));
  add('task_evidence','Retrieve a bounded saved evidence window. No arbitrary file reads.',{taskId:str,start:{...number,maximum:10000000},length:{...number,minimum:1,maximum:32768}},['taskId'],false,i=>{const t=c.getTask(i.taskId),data=JSON.stringify({result:t.result,feedback:t.feedback,answers:t.answers,memory:t.memory??[]});return {taskId:t.id,start:i.start??0,totalCharacters:data.length,text:data.slice(i.start??0,(i.start??0)+(i.length??8192)),warning:'Untrusted execution data; provenance is not factual certification.'};});
  add('task_rebind','Explicitly bind unfinished work to the approved version, preserving limits.',{taskId:str,spec:obj},['taskId'],true,(i,k)=>this.goals.rebind(i,k));
  add('task_review_evidence_retry','Requeue an unchanged passing v2 candidate after coordinator evidence delivery repair; preserve all original budgets/deadlines. No product code edits or inference in preparation.',{taskId:str,expectedTaskHash:str,expectedResultHash:str,reason:str},['taskId','expectedTaskHash','expectedResultHash','reason'],true,(i,k)=>this.launch('task_review_evidence_retry',i,k,()=>this.worker.legacyReview.repairEvidence(i,`effect-${k}`)));
  const reviewBindingSchema=Object.fromEntries(bindingFields.map(field=>[field,['goalVersion','generation','expiresAt'].includes(field)?{...number,minimum:1}:str]));
  const reviewFinding={type:'object',properties:{path:str,line:{...number,minimum:1},message:{...str,maxLength:2000}},required:['path','message'],additionalProperties:false};
  const reviewVerdict={type:'object',properties:{decision:{...str,enum:['accept','revise']},feedback:{...str,maxLength:16384},findings:{type:'array',items:reviewFinding,maxItems:50}},required:['decision','feedback','findings'],additionalProperties:false};
  add('review_inbox','Pull a bounded durable review inbox. A closed host is not automatically awakened.',{goalId:str,cursor:str,limit:{...number,minimum:1,maximum:20}},[],false,i=>c.reviewService.inbox(i));
  add('review_reserve','Reserve a review of the exact candidate, protected checks and approved rubric.',reviewBindingSchema,bindingFields,true,(i,k)=>c.reviewService.reserve(i,k));
  add('review_submit','Submit a structured verdict for the exact reserved candidate. This does not integrate code.',{...reviewBindingSchema,ticketId:str,verdict:reviewVerdict},[...bindingFields,'ticketId','verdict'],true,(i,k)=>c.reviewService.submit(i,k));
  add('task_review','Main Codex records a bounded review decision.',{taskId:str,decision:{...str,enum:['accept','revise']},feedback:str},['taskId','decision','feedback'],true,(i,k)=>c.review(i,k));
  const modelSchema={type:'object',properties:{requested:{anyOf:[str,{type:'null'}]},resolved:{anyOf:[str,{type:'null'}]}},additionalProperties:false},registrationProperties={version:{...number,enum:[1]},taskId:str,hostAgentId:{anyOf:[str,{type:'null'}]},hostId:{...str,enum:['codex','claude-code','cursor','antigravity']},role:{...str,enum:['implementer','explorer','reviewer','supervisor']},actor:{...str,enum:['codex','deepseek']},model:modelSchema},registrationSchema={type:'object',properties:registrationProperties,required:['version','taskId','role','actor'],additionalProperties:false};
  add('agent_register','Register managed host correlation and model metadata. Roles are cooperative and do not grant execution authority.',registrationProperties,['version','taskId','role','actor'],true,(i,k)=>this.agents.register(i,k));
  add('agent_report','Save host-reported progress; completion and stop reports do not establish quiescence or acceptance.',{version:{...number,enum:[1]},agentId:str,status:{...str,enum:['running','waiting','completed','blocked','stopped']},summary:str,evidenceIds:{type:'array',items:str,maxItems:100}},['version','agentId','status','summary'],true,(i,k)=>this.agents.report(i,k));
  add('agents_list','List managed registrations and last reported progress, not unrelated chats.',{goalId:str},[],false,i=>this.agents.list(i));
  add('help_link','Link an existing ordinary helper assignment to a live supervisor question; helper must be accepted before the answer resumes its parent.',{version:{...number,enum:[1]},taskId:str,questionId:str,helperTaskId:str,reason:str},['version','taskId','questionId','helperTaskId','reason'],true,(i,k)=>this.agents.linkHelp(i,k));
  for(const [name,method,description,extra,required]of [
   ['task_integration_repair','repair','Supervised inverse of a saved failed import; preserve evidence and return the same task to its remaining correction budget.',{reason:str},['reason']],
   ['task_integrate','accept','Main operator integrates a reviewed, checked candidate.',{feedback:str,expectedIntegrationBinding:str},['feedback']],
   ['task_takeover','takeover','Transfer verified quiescent worker edits; candidate_v1 keeps the worker checkout frozen.',{reason:str,layout:{...str,enum:['candidate_v1']},registration:registrationSchema},['reason']],
   ['native_start','startNative','Reserve native ownership. Explicit candidate_v1 isolates this task; omitted layout preserves legacy behavior.',{layout:{...str,enum:['candidate_v1']},registration:registrationSchema},[]],
   ['native_finish','finishNative','Host confirms editing ended; validate/checkpoint candidate_v1 for separate main review.',{summary:str},['summary']],
   ['native_release','releaseNative','Main host confirms native editing stopped and preserves partial files; reported stop alone is insufficient.',{reason:str},['reason']]
  ])add(name,description,{taskId:str,...extra},['taskId',...required],true,(i,k)=>this.launch(name,i,k,()=>this.worker.integration[method](i,`effect-${k}`)));
  if(!config.beta){
  const reviewCommon={taskId:str,candidateHash:str,rubricHash:str},selector={type:'object',properties:{source_id:str,text_sha256:str,start:number,end:number},required:['source_id','text_sha256','start','end'],additionalProperties:false},finding={type:'object',properties:{unit:str,code:{...str,enum:['missing_context','cross_alternative_attribution','unsupported_premise','lost_condition','unsupported_claim','material_omission','contradiction','other']},message:{...str,maxLength:2000},evidence:{type:'array',items:selector,maxItems:10}},required:['unit','code','message','evidence'],additionalProperties:false};
  add('research_review','Reserve independent review before native dispatch, or submit a bound whole-report verdict. Launches no inference.',{...reviewCommon,action:{...str,enum:['reserve','submit']},ticketId:str,decision:{...str,enum:['accept','revise','reject']},findings:{type:'array',items:finding,maxItems:50},coverage:{type:'array',items:str,maxItems:1000}},['taskId','action','candidateHash','rubricHash'],true,(i,k)=>this.launch('research_review',i,k,()=>this.worker.adapters.research.review(i,`effect-${k}`)));
  const reviewedTool=this.definitions.get('research_review'),base=reviewedTool.inputSchema;
  reviewedTool.inputSchema={...base,anyOf:[['reserve',[],['ticketId','decision','findings','coverage']],['submit',['ticketId','decision','findings','coverage'],[]]].map(([action,extra,omit])=>({...base,properties:Object.fromEntries(Object.entries(base.properties).filter(([k])=>!omit.includes(k)).map(([k,v])=>[k,k==='action'?{...v,enum:[action]}:v])),required:[...base.required,...extra]}))};
  add('research_reconcile','Verify uncertain remote research identity, spending and quiescence under the current coordinator lease. No new model request.',{taskId:str},['taskId'],true,(i,k)=>this.launch('research_reconcile',i,k,()=>this.worker.adapters.research.reconcile(i,`effect-${k}`)));
  add('research_start','Start deterministic Codex research with zero DeepSeek dispatch.',{taskId:str},['taskId'],true,(i,k)=>this.launch('research_start',i,k,()=>this.nativeResearch.start(i,`effect-${k}`)));
  add('research_action','Run a bounded search/read/finish action for native research.',{taskId:str,action:obj},['taskId','action'],true,(i,k)=>this.launch('research_action',i,k,()=>this.nativeResearch.action(i,`effect-${k}`)));
  }
  add('native_text_start','Start native Codex consult or maintenance. A DeepSeek handoff requires a reason and verified quiescence.',{taskId:str,reason:str},['taskId'],true,(i,k)=>c.startNativeText(i,k));
  add('native_text_finish','Record a native Codex consult or finalized protected learning result under its original task.',{taskId:str,content:str},['taskId','content'],true,(i,k)=>c.finishNativeText(i,k));
  add('operation_get','Inspect a long operation.',{operationId:str},['operationId'],false,i=>({...c.store.get('operation',i.operationId),observerCursor:Number(c.store.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM events').get().n)}));
  add('questions_list','List unresolved task questions.',{goalId:str},[],false,i=>c.store.all('task').filter(t=>(!i.goalId||t.goalId===i.goalId)&&['awaiting_supervisor','awaiting_user'].includes(t.status)).map(t=>({taskId:t.id,goalId:t.goalId,status:t.status,question:t.questions.at(-1)})));
  add('question_answer','Answer within scope; DeepSeek-only requires a user answer.',{taskId:str,answer:str,expectedQuestionId:str,expectedGoalHash:str,responder:{...str,enum:['user','codex']}},['taskId','answer','responder'],true,(i,k)=>c.answer(i,k));
  add('task_priority','Set scheduling priority with a recorded reason.',{taskId:str,priority:{...str,enum:['blocking','normal','background']},reason:str},['taskId','priority','reason'],true,(i,k)=>c.setPriority(i,k));
  add('queue_get','Inspect execution queue and separate review inbox.',{goalId:str},[],false,i=>{const p=c.effectivePriorities(),tasks=c.store.all('task').filter(t=>!i.goalId||t.goalId===i.goalId);return {execution:tasks.filter(t=>['queued','suspended','running','uncertain','codex_ready','codex_active'].includes(t.status)).sort((a,b)=>p.get(b.id)-p.get(a.id)||a.sequence-b.sequence).map(t=>({...c.getTask(t.id),effectivePriority:p.get(t.id)})),review:tasks.filter(t=>['awaiting_review','awaiting_legacy_review','legacy_reviewing','ready_to_integrate'].includes(t.status))};});
  add('work_control','Pause, stop or resume a goal or task. Limits never refresh.',{goalId:str,taskId:str,expectedControlBinding:str,action:{...str,enum:['pause','stop','resume']}},['action'],true,(i,k)=>{if(!!i.goalId===!!i.taskId)throw Error('Provide exactly one goalId or taskId');return c.control(i,k);});
  registerBacklogTools({add,c,worker,beta:config.beta??c.beta});
  add('reviewer_reserve','Reserve one bounded read-only reviewer assignment.',{taskId:str},['taskId'],true,(i,k)=>c.reserveReviewer(i,k));
  add('reviewer_finish','Save evidence from a reserved native reviewer; main Codex retains acceptance.',{reservationId:str,result:obj,error:str},['reservationId'],true,(i,k)=>c.finishReviewer(i,k));
  add('memory_retrieve','Retrieve at most four applicable lessons and 8 KiB.',{goalId:str,query:str,capability:str},['goalId','query'],false,i=>c.learning.retrieve(i));
  add('learning_get','Inspect recent project outcomes, managed versions and protected evaluations. General lessons contain sanitized procedures.',{goalId:str},[],false,i=>{const project=i.goalId?c.learning.projectKey(i.goalId):null,lesson=c.store.all('lesson').filter(l=>!i.goalId||l.scope==='general'||l.projectKey===project).slice(-100),ids=new Set(lesson.map(l=>l.id));return {outcome:c.store.all('outcome').filter(o=>!i.goalId||o.projectKey===project).slice(-100),lesson,evaluation:c.store.all('evaluation').filter(e=>ids.has(e.lessonId)).slice(-100)};});
  const nativeLearning=id=>{const t=c.getTask(id);if(t.executionActor!=='codex'||t.status!=='codex_active'||t.spec.kind!=='learning')throw Error('An active native learning assignment is required; DeepSeek proposals run through the bounded worker');return t;};
  add('learning_propose','Propose a data-only recipe under a budgeted native learning assignment. Invalid proposals also spend an attempt.',{taskId:str,proposal:obj},['taskId','proposal'],true,(i,k)=>{nativeLearning(i.taskId);return c.learning.propose(i.taskId,i.proposal,k);});
  add('learning_correct','Create a new correction candidate; preserve the prior version and require protected evaluation.',{lessonId:str,taskId:str,parameters:obj,rationale:str},['lessonId','taskId','parameters','rationale'],true,(i,k)=>{nativeLearning(i.taskId);return c.learning.correct(i.lessonId,i.taskId,i.parameters,i.rationale,k);});
  add('learning_archive','Archive a managed lesson while preserving its evidence and history.',{lessonId:str,reason:str},['lessonId','reason'],true,(i,k)=>c.learning.archive(i.lessonId,i.reason,k));
  for(const [name,method,extra]of [['learning_evaluate','evaluate',{}],['learning_promote','promote',{}],['learning_quarantine','quarantine',{reason:str}],['learning_rollback','rollback',{}]])add(name,'Manage a versioned lesson without changing executable authority.',{lessonId:str,...extra},['lessonId',...Object.keys(extra)],true,(i,k)=>method==='quarantine'?c.learning[method](i.lessonId,i.reason,k):c.learning[method](i.lessonId,k));
  add('events_wait','Wait at most30 seconds for durable events.',{after:number,timeoutMs:{...number,maximum:30000}},[],false,async i=>{const end=Date.now()+(i.timeoutMs??0);let events;do{events=c.store.events(i.after??0,200);if(events.length||Date.now()>=end)break;await delay(Math.min(250,end-Date.now()));}while(true);return {events,cursor:events.at(-1)?.seq??i.after??0};});
 }
 tools(){return [...this.definitions.values()].map(({fn,mutating,...tool})=>tool);}
 async recoverOperations(owner){
  const lease=this.c.store.get('lease','coordinator');if(lease.token!==owner||lease.pid!==process.pid)throw Error('Current worker lease required for operation recovery');
  const allowed=new Set(['task_review_evidence_retry','overnight_preflight','task_integration_repair','task_integrate','task_takeover','native_start','native_finish','native_release','research_start','research_action','research_reconcile','research_review']);
  for(const operation of this.c.store.all('operation').filter(o=>['pending','retryable'].includes(o.status))){
   const command=this.c.store.db.prepare('SELECT hash,result FROM commands WHERE key=?').get(operation.key);
   if(!allowed.has(operation.name)||!command||command.hash!==digest({op:'operation.launch',name:operation.name,input:operation.input})||JSON.parse(command.result).id!==operation.id)throw Error('Saved operation authority could not be verified');
   if(operation.name==='overnight_preflight'){
    // A saved successful receipt is replayable. Without it, an orphaned sandbox
    // check may still be running: fail this operation, never retry it on startup.
    const receipt=this.c.store.maybe('overnight_preflight',operation.input.goalId),g=this.c.store.get('goal',operation.input.goalId);let recovered;
    try{if(!receipt?.passed||receipt.approvalHash!==operation.input.hash||g.hash!==operation.input.hash)throw Error('Interrupted preflight requires verified check quiescence and a new exact preflight operation');assertOvernightPreflight(this.c,g);recovered={...operation,status:'completed',result:receipt,finishedAt:this.c.now()};}
    catch{recovered={...operation,status:'failed',error:'Interrupted preflight: inspect check quiescence, then rerun exact preflight; no inference was dispatched',finishedAt:this.c.now()};}
    this.c.store.tx(()=>this.c.store.put('operation',recovered));continue;
   }
   await this.invoke(operation.name,{...operation.input,idempotencyKey:operation.key});
  }
 }
 async whenIdle(){while(this.promises.size)await Promise.allSettled([...this.promises.values()]);}
 async invoke(name,input={}){const definition=this.definitions.get(name);if(!definition)throw Error('Unknown harness tool');validate(definition.inputSchema,input);if(this.quiescing&&definition.mutating)throw Error('Coordinator is shutting down. Reconnect after maintenance.');const {idempotencyKey,...data}=input;return definition.fn(data,idempotencyKey);}
 launch(name,input,key,action){
  const operation=this.c.store.command(key,{op:'operation.launch',name,input},()=>{const record={id:randomUUID(),name,input,key,status:'pending',taskId:input.taskId??null,createdAt:this.c.now()};this.c.store.put('operation',record);return record;});
  const current=this.c.store.get('operation',operation.id);if(!['pending','retryable'].includes(current.status)||this.running.has(current.id))return current;
  this.running.add(current.id);const run=Promise.resolve().then(action).then(result=>this.c.store.tx(()=>{this.c.store.put('operation',{...current,status:'completed',result,finishedAt:this.c.now()});}),error=>this.c.store.tx(()=>{this.c.store.put('operation',{...current,status:error.executionOutcome==='unknown'?'uncertain':error.retryable?'retryable':'failed',error:error.message,finishedAt:this.c.now()});})).finally(()=>{this.running.delete(current.id);this.promises.delete(current.id);});this.promises.set(current.id,run);return current;
 }
}
