import {normalizeExecutionPolicy} from './execution.mjs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {isOvernightV2,normalizeOvernightPolicy} from './overnight.mjs';
import {behavioralChecksSchema,normalizeBehavioralChecks} from './behavioral-validation.mjs';
import { matches, relativePath, validatePermissions } from '../project/contracts.mjs';
import {normalizeProviderPolicy,profileIdentity} from './providers/contracts.mjs';
import {normalizeReviewPolicy,assertReviewMode} from './review/contracts.mjs';
import {normalizeRoutingPolicy,normalizeTaskRouting} from './routing/contracts.mjs';
import {selectRoute} from './routing/router.mjs';

export function canonical(value) {
 if (value===null||typeof value!=='object') {
  if(typeof value==='number'&&!Number.isFinite(value)) throw Error('Non-finite JSON value');
  if(value===undefined) throw Error('Undefined JSON value');
  return JSON.stringify(value);
 }
 return Array.isArray(value)?`[${value.map(canonical).join(',')}]`:`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
export const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
export function keys(value,allowed,label='object') {
 if(!value||typeof value!=='object'||Array.isArray(value)) throw Error(`${label} must be an object`);
 for(const k of Object.keys(value)) if(!allowed.includes(k)) throw Error(`${label}: unknown field ${k}`);
}
export function text(value,label,max=20000) {if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(`Invalid ${label}`);return value;}
export function identifier(value,label='id') {text(value,label,120);if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value))throw Error(`Invalid ${label}`);return value;}
export function integer(value,label,min,max) {if(!Number.isInteger(value)||value<min||value>max)throw Error(`Invalid ${label}: expected ${min}..${max}`);return value;}
function strings(v,label,{empty=false,max=100}={}) {if(!Array.isArray(v)||(!empty&&!v.length)||v.length>max)throw Error(`Invalid ${label}`);v.forEach(x=>text(x,label));if(new Set(v).size!==v.length)throw Error(`Duplicate ${label}`);return [...v];}
const clone=x=>structuredClone(x);
const stringSchema={type:'string'},stringsSchema={type:'array',items:stringSchema};
const objectSchema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const TASK_LIMITS={coding:{seconds:28800,attempts:5,modelCalls:50,reviews:2,questions:3},research:{seconds:7200,attempts:20,modelCalls:20,reviews:2,questions:3,searches:30,downloads:50},consult:{seconds:600,attempts:1,modelCalls:1,reviews:2,questions:0},learning:{seconds:600,attempts:2,modelCalls:6,reviews:0,questions:0}};
const taskCeilingsInputSchema=objectSchema(Object.fromEntries(Object.entries(TASK_LIMITS).map(([kind,limits])=>[
 kind,objectSchema(Object.fromEntries(Object.entries(limits).map(([name,max])=>[name,{type:'integer',minimum:name==='questions'||name==='reviews'?0:1,maximum:max}]))),
])));
export const researchPolicySchema=objectSchema({version:{type:'integer',enum:[1,2]},finish:{type:'string',enum:['selectors_only']},discovery:{type:'string',enum:['search_required']}},['version','finish','discovery']);
export const reviewedResearchPolicySchema=objectSchema({version:{const:3,type:'integer'},finish:{const:'selectors_only',type:'string'},discovery:{const:'search_required',type:'string'},review:objectSchema({version:{const:1,type:'integer'},role:{const:'independent_operator',type:'string'},maxRounds:{const:2,type:'integer'},maxRevisions:{const:1,type:'integer'},maxCorrectionModelCalls:{const:2,type:'integer'},rubricSha256:{type:'string',pattern:'^[a-f0-9]{64}$'}},['version','role','maxRounds','maxRevisions','maxCorrectionModelCalls','rubricSha256'])},['version','finish','discovery','review']);
export const repairResearchPolicySchema={...reviewedResearchPolicySchema,properties:{...reviewedResearchPolicySchema.properties,repairContextVersion:{const:1,type:'integer'}},required:[...reviewedResearchPolicySchema.required,'repairContextVersion']};
export const targetedResearchPolicySchema={...repairResearchPolicySchema,properties:{...repairResearchPolicySchema.properties,correctionStrategy:{const:'targeted_v1',type:'string'}},required:[...repairResearchPolicySchema.required,'correctionStrategy']};
const researchPolicyInputSchema={anyOf:[researchPolicySchema,reviewedResearchPolicySchema,repairResearchPolicySchema,targetedResearchPolicySchema]};
export const scopeInputSchema=objectSchema({seedUrls:stringsSchema,includeDomains:stringsSchema,excludeDomains:stringsSchema});
export const goalInputSchema=objectSchema({
 submissionId:stringSchema,objective:stringSchema,acceptance:stringsSchema,mode:{...stringSchema,description:'Registered mode id; collaborative is the default.'},modeVersion:{type:'integer',minimum:1},environment:{type:'string',enum:['live','fixture']},scope:scopeInputSchema,researchPolicy:researchPolicySchema,
 limits:objectSchema({hours:{type:'integer',minimum:1,maximum:24},maxTasks:{type:'integer',minimum:1,maximum:100},reviewAgentRuns:{type:'integer',minimum:0,maximum:10},taskLimits:{...taskCeilingsInputSchema,description:'Optional per-kind assignment ceilings. Omitted task limits inherit these values; explicit task limits may only narrow them.'}}),
 project:{anyOf:[{type:'null'},objectSchema({repo:{...stringSchema,description:'Absolute clean committed repository root.'},baseCommit:{...stringSchema,description:'Exact40-character Git base revision.'},readPaths:stringsSchema,writePaths:stringsSchema,checks:{type:'array',items:objectSchema({id:stringSchema,argv:stringsSchema,timeoutMs:{type:'integer',minimum:100,maximum:600000},screenshots:stringsSchema,env:{type:'object'}},['id','argv'])}},['repo','baseCommit','readPaths','writePaths','checks'])]},
},['submissionId','objective','acceptance']);
export const taskInputSchema=objectSchema({submissionId:stringSchema,kind:{type:'string',enum:['coding','research','consult','learning']},actor:{type:'string',enum:['codex','deepseek']},objective:stringSchema,context:stringSchema,acceptance:stringsSchema,dependsOn:stringsSchema,priority:{type:'string',enum:['blocking','normal','background']},permissions:objectSchema({readPaths:stringsSchema,writePaths:stringsSchema,checks:stringsSchema},['readPaths','writePaths','checks']),scope:scopeInputSchema,researchPolicy:researchPolicySchema,limits:{type:'object'}},['submissionId','kind','objective','acceptance']);
// Historical schema exports remain stable; public dispatch adds the explicit opt-in union.
const [nullProject,projectInput]=goalInputSchema.properties.project.anyOf;
const projectDispatchInputSchema={anyOf:[nullProject,{...projectInput,properties:{...projectInput.properties,behavioralChecks:behavioralChecksSchema}}]};
export const providerSnapshotSchema=objectSchema({
 schema:{type:'integer',enum:[1]},id:stringSchema,revision:stringSchema,displayName:stringSchema,
 transport:{type:'string',enum:['openai-chat','openai-responses','anthropic-messages']},baseUrl:stringSchema,model:stringSchema,
 roles:{type:'array',items:{type:'string',enum:['worker','reviewer']}},
 capabilities:objectSchema({workerProtocol:{anyOf:[{type:'null'},stringSchema]},transports:{type:'array',items:{type:'string',enum:['json','sse']}},modelDiscovery:{type:'string',enum:['manual','advertised']},taskKinds:{type:'array',items:{type:'string',enum:['coding','consult']}}},['workerProtocol','transports','modelDiscovery','taskKinds']),
 maxContextTokens:{anyOf:[{type:'null'},{type:'integer',minimum:1}]},maxOutputTokens:{type:'integer',minimum:1},
 concurrency:{type:'integer',minimum:1,maximum:4},capacityGroup:stringSchema,streaming:{type:'boolean'},
},['schema','id','revision','displayName','transport','baseUrl','model','roles','capabilities','maxContextTokens','maxOutputTokens','concurrency','capacityGroup','streaming']);
export const providerPolicyInputSchema=objectSchema({version:{type:'integer',enum:[1]},workers:{type:'array',maxItems:16,items:providerSnapshotSchema},plannerWorkerId:stringSchema,defaultWorkerId:stringSchema,maxConcurrentTasks:{type:'integer',minimum:1,maximum:4},capacityGroups:{type:'array',maxItems:16,items:objectSchema({id:stringSchema,limit:{type:'integer',minimum:1,maximum:4}},['id','limit'])}},['version','workers','plannerWorkerId','defaultWorkerId','capacityGroups']);
export const reviewPolicyInputSchema=objectSchema({version:{type:'integer',enum:[1]},source:{type:'string',enum:['host','api']},hostId:{type:'string',enum:['codex','claude-code','cursor','antigravity']},reviewer:providerSnapshotSchema,fallback:{type:'string',enum:['wait']}},['version','source','fallback']);
export const routingPolicyInputSchema=objectSchema({version:{type:'integer',enum:[1]},rules:{type:'array',maxItems:32,items:objectSchema({id:stringSchema,category:{type:'string',enum:['general','backend','frontend','tests','docs','design']},providerId:stringSchema},['id','category','providerId'])},defaultWorkerId:stringSchema},['version','rules','defaultWorkerId']);
export const taskRoutingInputSchema=objectSchema({version:{type:'integer',enum:[1]},category:{type:'string',enum:['general','backend','frontend','tests','docs','design']},requiredCapabilities:{type:'array',maxItems:2,items:{type:'string',enum:['coding','consult']}},minContextTokens:{anyOf:[{type:'null'},{type:'integer',minimum:1}]},maxOutputTokens:{anyOf:[{type:'null'},{type:'integer',minimum:1}]},preferredProviderId:stringSchema},['version']);
const nativePolicySchema = (backend, revision) => objectSchema({
 version:{type:'integer',enum:[1]},backend:{type:'string',enum:[backend]},backendRevision:{type:'integer',enum:[revision]},runtimeFingerprint:{type:'string'}
},['version','backend','backendRevision','runtimeFingerprint']);
export const executionPolicyInputSchema={anyOf:[
 objectSchema({version:{type:'integer',enum:[1]},backend:{type:'string',enum:['codex-sandbox','darwin-seatbelt']},backendRevision:{type:'integer',enum:[1]}},['version','backend','backendRevision']),
 nativePolicySchema('darwin-seatbelt',2), nativePolicySchema('windows-appcontainer',1), nativePolicySchema('windows-isolated-js',1)
]};
export const goalDispatchInputSchema={...goalInputSchema,properties:{...goalInputSchema.properties,project:projectDispatchInputSchema,executionPolicy:executionPolicyInputSchema,researchPolicy:researchPolicyInputSchema,providerPolicy:providerPolicyInputSchema,reviewPolicy:reviewPolicyInputSchema,routingPolicy:routingPolicyInputSchema,overnightPolicy:objectSchema({preflightCheckIds:stringsSchema,finalOnlyCheckIds:stringsSchema,launchCheckIds:stringsSchema,maxBatches:{type:'integer',minimum:1,maximum:20},maxExchanges:{type:'integer',minimum:1,maximum:40},maxCorrections:{type:'integer',minimum:0,maximum:2},reconnectMs:{type:'integer',minimum:1,maximum:1800000}},['preflightCheckIds','finalOnlyCheckIds'])}};
export const taskDispatchInputSchema={...taskInputSchema,properties:{...taskInputSchema.properties,researchPolicy:researchPolicyInputSchema,routing:taskRoutingInputSchema,role:{type:'string',enum:['implementation','final']}}};
const baseModes=[
 {id:'collaborative',version:1,planner:'codex',actors:['codex','deepseek'],review:'operator',capabilities:['coding','research','consult','learning']},
 {id:'deepseek_only',version:1,planner:'deepseek',actors:['deepseek'],review:'checks',capabilities:['coding','research','consult','learning']},
 {id:'codex_only',version:1,planner:'codex',actors:['codex'],review:'operator',capabilities:['coding','research','consult','learning']},
 {id:'overnight_review',version:1,planner:'deepseek',actors:['deepseek'],review:'legacy',capabilities:['coding']},
];
export class Registry {
 constructor(){
  this.capabilities=new Map();this.modes=new Map();this.workflows=new Map();
  for(const id of ['coding','research','consult','learning'])this.capabilities.set(`${id}@1`,{
   id,version:1,actors:['deepseek','codex'],handler:id,
   inputSchema:{type:'object',required:['submissionId','kind','objective','acceptance'],additionalProperties:false,properties:{submissionId:{type:'string'},kind:{const:id},actor:{enum:['deepseek','codex']},objective:{type:'string'},context:{type:'string'},acceptance:{type:'array',items:{type:'string'}},dependsOn:{type:'array',items:{type:'string'}},priority:{enum:['blocking','normal','background']},permissions:{type:'object'},scope:{type:'object'},limits:{type:'object'}}},
   outputSchema:{type:'object',description:'Saved bounded evidence; model text never grants authority'},
   permissions:{filesystem:id==='coding'?'approved-subset':'none',network:id==='research'?'approved-public-scope':'configured-model-only',acceptance:id==='coding'?'protected-checks-and-pinned-mode':'pinned-mode',executableAuthority:'reviewed-adapter-only'},limits:clone(TASK_LIMITS[id]),
  });
  // Preserve research@1 verbatim: its full schema participates in legacy goal hashes.
  const research=clone(this.capabilities.get('research@1'));
  research.version=2;research.actors=['deepseek'];
  research.inputSchema.properties.actor={enum:['deepseek']};
  research.inputSchema.properties.researchPolicy=clone(researchPolicySchema);
  research.inputSchema.properties.researchPolicy.properties.version.enum=[1];
  this.capabilities.set('research@2',research);
  const supportResearch=clone(research);supportResearch.version=3;
  supportResearch.inputSchema.properties.researchPolicy.properties.version.enum=[2];
  this.capabilities.set('research@3',supportResearch);
  const reviewedResearch=clone(supportResearch);reviewedResearch.version=4;reviewedResearch.inputSchema.properties.researchPolicy=clone(reviewedResearchPolicySchema);this.capabilities.set('research@4',reviewedResearch);
  const repairResearch=clone(reviewedResearch);repairResearch.version=5;repairResearch.inputSchema.properties.researchPolicy=clone(repairResearchPolicySchema);this.capabilities.set('research@5',repairResearch);
  const targetedResearch=clone(repairResearch);targetedResearch.version=6;targetedResearch.inputSchema.properties.researchPolicy=clone(targetedResearchPolicySchema);this.capabilities.set('research@6',targetedResearch);
  for(const m of baseModes)this.registerMode(m);
  this.registerMode({...baseModes.find(m=>m.id==='overnight_review'),version:2});
 }
 registerMode(raw){
  keys(raw,['id','version','planner','actors','review','capabilities'],'mode');
  const m=clone(raw);identifier(m.id);integer(m.version,'version',1,10000);
  strings(m.actors,'actors');if(m.actors.some(x=>!['codex','deepseek'].includes(x))||!m.actors.includes(m.planner))throw Error('Invalid planner/actor');
  if(!['operator','checks','legacy'].includes(m.review))throw Error('Invalid review policy');
  if(m.review==='operator'&&!m.actors.includes('codex'))throw Error('Operator review requires the Codex actor');
  strings(m.capabilities,'capabilities');for(const id of m.capabilities)if(!this.capabilities.has(`${id}@1`))throw Error(`Unknown capability ${id}`);
  if(m.review==='legacy'&&(m.actors.join()!=='deepseek'||m.capabilities.join()!=='coding'))throw Error('Legacy capability policy is coding-only');
  const key=`${m.id}@${m.version}`;if(this.modes.has(key))throw Error('Mode version already exists');this.modes.set(key,m);return clone(m);
 }
 mode(id='collaborative',version){const choices=[...this.modes.values()].filter(m=>m.id===id&&(!version||m.version===version)).sort((a,b)=>b.version-a.version);if(!choices.length)throw Error('Unknown mode');return clone(choices[0]);}
 snapshot(){return {capabilities:clone([...this.capabilities.values()]),modes:clone([...this.modes.values()]),workflows:clone([...this.workflows.values()])};}
 registerWorkflow(raw){
  keys(raw,['id','version','mode','tasks'],'workflow');identifier(raw.id);integer(raw.version,'version',1,10000);const mode=this.mode(raw.mode);
  if(!Array.isArray(raw.tasks)||!raw.tasks.length||raw.tasks.length>10)throw Error('Invalid workflow tasks');const tasks=new Map(),routes=new Map();
  for(const t of raw.tasks){
   keys(t,['key','kind','dependsOn','objective','acceptance','context','permissions','routing'],'workflow task');
   identifier(t.key);if(tasks.has(t.key))throw Error('Duplicate workflow task');if(!mode.capabilities.includes(t.kind))throw Error('Mode prohibits workflow capability');
   text(t.objective,'objective');strings(t.acceptance,'acceptance');strings(t.dependsOn??[],'dependencies',{empty:true});
   if(Object.hasOwn(t,'context')&&t.context!=='')text(t.context,'context',40000);
   if(Object.hasOwn(t,'routing')){const routing=normalizeTaskRouting(t.routing);if(!routing)throw Error('Workflow routing requires a versioned object');routes.set(t.key,routing);}
   if(Object.hasOwn(t,'permissions')){
    keys(t.permissions,['readPaths','writePaths','checks'],'workflow task permissions');
    for(const name of ['readPaths','writePaths']){
     for(const scope of strings(t.permissions[name],name,{empty:true}))relativePath(scope.endsWith('/')?scope.slice(0,-1):scope);
    }
    strings(t.permissions.checks,'checks',{empty:true});
   }
   tasks.set(t.key,t);
  }
  const visited=new Set(),visiting=new Set(),visit=key=>{if(visiting.has(key))throw Error('Workflow dependency cycle');if(visited.has(key))return;const task=tasks.get(key);if(!task)throw Error('Unknown workflow dependency');visiting.add(key);for(const dep of task.dependsOn??[])visit(dep);visiting.delete(key);visited.add(key);};for(const key of tasks.keys())visit(key);
  const key=`${raw.id}@${raw.version}`;if(this.workflows.has(key))throw Error('Workflow already exists');const workflow=clone(raw);for(const t of workflow.tasks)if(routes.has(t.key))t.routing=routes.get(t.key);this.workflows.set(key,workflow);return clone(workflow);
 }
}
export function sourceScope(raw={}) {
 keys(raw,['seedUrls','includeDomains','excludeDomains'],'source scope');
 const scope={seedUrls:[],includeDomains:[],excludeDomains:[],...raw};
 for(const k of Object.keys(scope))strings(scope[k],k,{empty:true,max:100});
 for(const url of scope.seedUrls){let u;try{u=new URL(url);}catch{throw Error('Invalid source URL');}if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443'))throw Error('Public HTTPS source URL required');}
 for(const d of [...scope.includeDomains,...scope.excludeDomains])if(!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(d))throw Error('Invalid source domain');
 return clone(scope);
}
export function normalizeResearchPolicy(raw){
 if(raw?.version===3){
  keys(raw,['version','finish','discovery','review','repairContextVersion','correctionStrategy'],'research policy');const r=raw.review;
  if(Object.hasOwn(raw,'correctionStrategy')&&(raw.correctionStrategy!=='targeted_v1'||raw.repairContextVersion!==1))throw Error('Targeted correction requires context v1');
  if(Object.hasOwn(raw,'repairContextVersion')&&raw.repairContextVersion!==1)throw Error('Unsupported repair context version');
  keys(r,['version','role','maxRounds','maxRevisions','maxCorrectionModelCalls','rubricSha256'],'review policy');
  if(raw.finish!=='selectors_only'||raw.discovery!=='search_required'||r.version!==1||r.role!=='independent_operator'||r.maxRounds!==2||r.maxRevisions!==1||r.maxCorrectionModelCalls!==2||typeof r.rubricSha256!=='string'||!/^[a-f0-9]{64}$/.test(r.rubricSha256))throw Error('Unsupported independent review contract');
  return clone(raw);
 }
 keys(raw,['version','finish','discovery'],'research policy');
 if(![1,2].includes(raw.version)||raw.finish!=='selectors_only'||raw.discovery!=='search_required')throw Error('Unsupported research policy');
 return clone(raw);
}
export function providerBinding(manifest,providerId){
 const policy=manifest.providerPolicy;
 if(!policy)return undefined;
 if(digest(policy)!==manifest.providerPolicyHash)throw Error('Approved provider policy hash differs');
 const profile=policy.workers.find(worker=>worker.id===providerId);
 if(!profile||!profile.roles.includes('worker'))throw Error('Provider does not belong to the approved worker pool');
 return {version:1,providerId:profile.id,revision:profile.revision,profileHash:digest(profileIdentity(profile)),policyHash:manifest.providerPolicyHash};
}
export function normalizeGoal(raw,registry=new Registry(),providerRegistry){
 keys(raw,['submissionId','objective','acceptance','project','mode','modeVersion','scope','limits','environment','researchPolicy','overnightPolicy','providerPolicy','reviewPolicy','routingPolicy','executionPolicy'],'goal');
 if(raw.providerPolicy!==undefined&&!providerRegistry)throw Error('Configured provider registry required for a provider policy');
 const providerPolicy=normalizeProviderPolicy(raw.providerPolicy,providerRegistry);
 const environment=raw.environment??'live';if(!['live','fixture'].includes(environment))throw Error('Invalid execution environment');
 const reviewPolicy=normalizeReviewPolicy(raw.reviewPolicy);
 const mode=registry.mode(raw.mode,raw.modeVersion),policy=Object.hasOwn(raw,'researchPolicy')?normalizeResearchPolicy(raw.researchPolicy):undefined;
 assertReviewMode(mode,reviewPolicy);
 const routingPolicy=normalizeRoutingPolicy(raw.routingPolicy,providerPolicy);
 if(routingPolicy&&!mode.actors.includes('deepseek'))throw Error('Routing policy requires API worker authority');
 if(reviewPolicy?.source==='api'){if(!providerRegistry||digest(providerRegistry.get(reviewPolicy.reviewer.id,reviewPolicy.reviewer.revision))!==digest(reviewPolicy.reviewer))throw Error('Reviewer identity differs from configured registry');}
 if(policy?.version===3&&mode.id!=='collaborative')throw Error('Reviewed research requires collaborative mode');
 if(policy&&(!mode.capabilities.includes('research')||!mode.actors.includes('deepseek')))throw Error('Research policy requires autonomous research capability');
 const limits={hours:8,maxTasks:10,reviewAgentRuns:reviewPolicy?2:mode.review==='operator'?2:0,...raw.limits};
 if(raw.limits)keys(raw.limits,['hours','maxTasks','reviewAgentRuns','taskLimits'],'goal limits');
 if(Object.hasOwn(limits,'taskLimits')){
  keys(limits.taskLimits,Object.keys(TASK_LIMITS),'goal task limits');const ceilings={};
  for(const [kind,partial]of Object.entries(limits.taskLimits)){
   keys(partial,Object.keys(TASK_LIMITS[kind]),`${kind} task ceilings`);
   for(const [name,value]of Object.entries(partial))integer(value,name,name==='questions'||name==='reviews'?0:1,TASK_LIMITS[kind][name]);
   ceilings[kind]=clone(partial);
  }
  limits.taskLimits=ceilings;
 }
 if(isOvernightV2({mode})){limits.taskLimits={...limits.taskLimits,coding:{seconds:7200,...limits.taskLimits?.coding}};if(limits.maxTasks>10)throw Error('Overnight v2 stage cap is ten');}
 integer(limits.hours,'hours',1,24);integer(limits.maxTasks,'maxTasks',1,100);integer(limits.reviewAgentRuns,'reviewAgentRuns',0,10);
 if(!reviewPolicy&&mode.review!=='operator'&&limits.reviewAgentRuns)throw Error('Mode prohibits Codex review agents');
 let project=null;
 if(raw.project){
  keys(raw.project,['repo','baseCommit','readPaths','writePaths','checks','behavioralChecks'],'project');
  const {behavioralChecks,...permissionFields}=raw.project;
  project=clone(permissionFields);text(project.repo,'repository');
  if(!path.isAbsolute(project.repo))throw Error('Repository must be absolute');
  if(!/^[a-f0-9]{40}$/.test(project.baseCommit??''))throw Error('Invalid base commit');
  validatePermissions(project);
  if(Object.hasOwn(raw.project,'behavioralChecks'))project.behavioralChecks=normalizeBehavioralChecks(behavioralChecks,project.checks);
 }
 const executionPolicy=normalizeExecutionPolicy(raw.executionPolicy);
 const overnightPolicy=isOvernightV2({mode})?normalizeOvernightPolicy(raw.overnightPolicy,project):undefined;
 if(!overnightPolicy&&Object.hasOwn(raw,'overnightPolicy'))throw Error('Overnight policy requires pinned v2');
 const manifest={schema:1,environment,submissionId:identifier(raw.submissionId,'submissionId'),objective:text(raw.objective,'objective'),acceptance:strings(raw.acceptance,'acceptance'),project,mode,capabilities:registry.snapshot().capabilities.filter(c=>mode.capabilities.includes(c.id)&&c.version===(policy&&c.id==='research'?(policy.correctionStrategy==='targeted_v1'?6:policy.repairContextVersion===1?5:policy.version+1):1)),scope:sourceScope(raw.scope),limits,...(executionPolicy?{executionPolicy}:{}),...(overnightPolicy?{overnightPolicy}:{}),...(policy?{researchPolicy:policy}:{}),...(reviewPolicy?{reviewPolicy,reviewPolicyHash:digest(reviewPolicy)}:{})};
 if(providerPolicy){
  manifest.providerPolicy=providerPolicy;manifest.providerPolicyHash=digest(providerPolicy);
  if(mode.planner==='deepseek')manifest.plannerBinding=providerBinding(manifest,providerPolicy.plannerWorkerId);
 }
 if(routingPolicy){manifest.routingPolicy=routingPolicy;manifest.routingPolicyHash=digest(routingPolicy);}
 return manifest;
}
export function isStartedLegacyTask(task){
 return Boolean(task&&task.startedAt!=null&&task.providerBinding&&task.spec?.actor==='deepseek'&&!Object.hasOwn(task.spec,'routing')&&!Object.hasOwn(task,'route')&&!Object.hasOwn(task,'routeHash'));
}
export function normalizeTask(raw,goal,registry=new Registry(),{checkRoutingEligibility=true,existingTask}={}) {
 keys(raw,['submissionId','kind','actor','objective','context','acceptance','dependsOn','priority','permissions','scope','limits','researchPolicy','role','routing'],'task');
 // Only internal rebind/preview callers supply a saved record. Caller omission
 // on a fresh routing-enabled task still receives the new versioned defaults.
 const legacy=isStartedLegacyTask(existingTask);
 if(legacy){
  if(digest(existingTask.spec)!==existingTask.hash)throw Error('Persisted legacy task hash changed');
  if(raw.submissionId!==existingTask.spec.submissionId||raw.kind!==existingTask.spec.kind)throw Error('Started legacy task identity/kind cannot change');
  if(Object.hasOwn(raw,'routing'))throw Error('Started legacy task retains absent routing; do not replace its original provider provenance');
 }
 if(!goal.mode.capabilities.includes(raw.kind)||!TASK_LIMITS[raw.kind])throw Error('Mode prohibits capability');
 const actor=raw.actor??(legacy?existingTask.spec.actor:goal.mode.actors.includes('deepseek')?'deepseek':'codex');if(!goal.mode.actors.includes(actor))throw Error('Mode prohibits actor');
 if(legacy&&actor!==existingTask.spec.actor)throw Error('Started legacy task retains its execution actor');
 if(Object.hasOwn(raw,'routing')&&(!goal.routingPolicy||actor!=='deepseek'||!['coding','consult'].includes(raw.kind)))throw Error('Task routing requires an approved routed worker task');
 const routing=!legacy&&goal.routingPolicy&&actor==='deepseek'&&['coding','consult'].includes(raw.kind)?normalizeTaskRouting(Object.hasOwn(raw,'routing')?raw.routing:{version:1}):undefined;
 if(Object.hasOwn(raw,'routing')&&!routing)throw Error('Explicit task routing requires a versioned object');
 if(actor==='deepseek'&&goal.providerPolicy&&!routing){
  const worker=goal.providerPolicy.workers.find(profile=>profile.id===goal.providerPolicy.defaultWorkerId);
  if(!worker?.capabilities.taskKinds.includes(raw.kind))throw Error('Approved default provider lacks task kind capability');
 }
 const policy=Object.hasOwn(goal,'researchPolicy')&&raw.kind==='research'?normalizeResearchPolicy(goal.researchPolicy):undefined;
 if(Object.hasOwn(raw,'researchPolicy')){
  const explicit=normalizeResearchPolicy(raw.researchPolicy);
  if(!policy||canonical(explicit)!==canonical(policy))throw Error('Task research policy must equal the approved goal policy');
 }
 if(policy&&actor!=='deepseek')throw Error('Research policy requires an autonomous research actor');
 if(!goal.capabilities.find(c=>c.id===raw.kind&&c.actors.includes(actor)))throw Error('Pinned capability prohibits actor');
 const max={...TASK_LIMITS[raw.kind],...goal.limits?.taskLimits?.[raw.kind]},limits={...max,...raw.limits};if(raw.limits)keys(raw.limits,Object.keys(max),'task limits');for(const [k,v]of Object.entries(limits))integer(v,k,k==='questions'||k==='reviews'?0:1,max[k]);
 const priority=raw.priority??(raw.kind==='learning'?'background':'normal');if(!['blocking','normal','background'].includes(priority))throw Error('Invalid priority');
 if(raw.kind==='learning'&&priority!=='background')throw Error('Learning priority must remain background');
 let permissions={readPaths:[],writePaths:[],checks:[]};
 if(raw.kind==='coding'){
  if(!goal.project)throw Error('Coding needs an approved project');
  if(isOvernightV2(goal)&&!raw.permissions)throw Error('Overnight v2 requires explicit scoped permissions and checks');
  permissions=clone(raw.permissions??{readPaths:goal.project.readPaths,writePaths:goal.project.writePaths,checks:goal.project.checks.map(c=>c.id)});
  keys(permissions,['readPaths','writePaths','checks'],'permissions');
  for(const k of ['readPaths','writePaths']){strings(permissions[k],k);for(const s of permissions[k]){relativePath(s.endsWith('/')?s.slice(0,-1):s);const f=s.endsWith('/')?s+'placeholder':s;if(!matches(f,goal.project[k]))throw Error('Task expands scope');}}
  strings(permissions.checks,'checks');if(permissions.checks.some(id=>!goal.project.checks.find(c=>c.id===id)))throw Error('Unknown check');
  if(!isOvernightV2(goal)){
   for(const criterion of goal.project.behavioralChecks??[]){
    const missing=criterion.checkIds.find(id=>!permissions.checks.includes(id));
    if(missing)throw Error('Task omits required behavioral check '+missing);
   }
  }
 }else if(raw.permissions&&canonical(raw.permissions)!==canonical(permissions))throw Error('Non-coding task cannot grant file write scope');
 if(isOvernightV2(goal)){if(!['implementation','final'].includes(raw.role))throw Error('Overnight v2 requires implementation/final role');if(raw.role==='final'&&goal.project.checks.some(c=>!permissions.checks.includes(c.id)))throw Error('Final stage must run every project check');if(raw.role!=='final'&&permissions.checks.some(id=>goal.overnightPolicy.finalOnlyCheckIds.includes(id)))throw Error('Intermediate stage requests final-only gate');}
 else if(Object.hasOwn(raw,'role'))throw Error('Stage role requires overnight v2');
 const scope=sourceScope(raw.scope??goal.scope);
 if(goal.scope.includeDomains.length&&(!scope.includeDomains.length||scope.includeDomains.some(d=>!goal.scope.includeDomains.includes(d))))throw Error('Task expands source scope');
 if(goal.scope.excludeDomains.some(d=>!scope.excludeDomains.includes(d)))throw Error('Task removes source exclusion');
 const spec={submissionId:identifier(raw.submissionId,'submissionId'),kind:raw.kind,actor,objective:text(raw.objective,'objective'),context:raw.context===undefined||raw.context===''?'':text(raw.context,'context',40000),acceptance:strings(raw.acceptance,'acceptance'),dependsOn:strings(raw.dependsOn??[],'dependencies',{empty:true,max:100}),priority,permissions,scope,limits,...(isOvernightV2(goal)?{role:raw.role}:{}),...(policy?{researchPolicy:policy}:{}),...(routing?{routing}:{})};
 // Preview still validates task authority/scope, but returns unmet worker
 // requirements as a route result. Every submission uses the strict default.
 if(routing&&checkRoutingEligibility){const route=selectRoute({task:spec,goal,availability:{budget:{remainingModelCalls:limits.modelCalls}}});if(route.status==='ineligible')throw Error('Task routing '+route.reasonCode+': '+route.explanation);}
 return spec;
}
