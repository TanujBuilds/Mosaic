import {collectMultiWorkerSetup} from './multi-worker-setup.mjs';
import {normalizeSettings} from './settings.mjs';
import {getHost,HOST_IDS} from './hosts/index.mjs';
import {askWorkerEndpoint,readBearerKey,selectHostedWorkerEndpoint} from './hosted-worker-presets.mjs';

const yes=value=>/^y(es)?$/i.test(value);
const integer=(raw,min,max,label)=>{const n=Number(raw);if(!/^\d+$/.test(String(raw))||!Number.isSafeInteger(n)||n<min||n>max)throw Error('Invalid '+label);return n;};

function profile({id,displayName,baseUrl,model,roles=['worker'],transport='openai-chat',credentialRef=null}){
 return {schema:1,id,revision:'r1',displayName,transport,baseUrl,model,roles,
  capabilities:{workerProtocol:roles.includes('worker')?'mosaic-structured-v1':null,transports:['json'],modelDiscovery:'manual',taskKinds:roles.includes('worker')?['coding','consult']:[]},
  maxContextTokens:null,maxOutputTokens:12000,concurrency:1,capacityGroup:id,credentialRef,streaming:false};
}
async function configureProfile(ask,output,index,roles,existingSettings,reservedRefs){
 const id=await ask(`Profile ${index} identifier: `),name=await ask('Display name: ');
 const worker=roles.includes('worker'),urlPrompt='Already-running server API base URL (local or explicit remote): ';
 const {baseUrl,preset}=worker?await selectHostedWorkerEndpoint(ask,output,urlPrompt):{baseUrl:await askWorkerEndpoint(ask,output,urlPrompt),preset:null};
 const model=await ask('Model ID (manual, no discovery required): ');
 const transport=worker?'openai-chat':['openai-chat','openai-responses','anthropic-messages'][integer(await ask('Reviewer API protocol: 1. OpenAI Chat  2. OpenAI Responses  3. Anthropic Messages [1]: ')||'1',1,3,'reviewer API protocol')-1];
 const previous=existingSettings?.providers.find(p=>p.id===id);
 let sameEndpoint=false;
 try{sameEndpoint=new URL(baseUrl).href.replace(/\/+$/,'')===previous?.baseUrl;}catch{}
 const canKeep=previous?.credentialRef&&sameEndpoint&&previous.transport===transport;
 const keyChoice=preset
  ? (canKeep?await ask('Choose how to provide the API key [Enter for hidden entry, k to keep the saved key]: '):'')
  : await ask('Does this endpoint require an API bearer key? [y/N, k to keep a saved key for the same profile and URL] ');
 const keep=keyChoice.toLowerCase()==='k';
 if(keep&&!canKeep)throw Error('A saved key can only be kept for the same profile and API base URL. Enter a new key for a changed endpoint.');
 const needsKey=!keep&&(preset!==null||yes(keyChoice));
 let credentialRef=keep?previous.credentialRef:null;
 if(needsKey){
  const oldRef=previous?.credentialRef;
  const separateKey=preset&&oldRef&&existingSettings.providers.some(p=>
   p.id!==id&&p.credentialRef===oldRef&&(!canKeep||p.baseUrl!==baseUrl||p.transport!==transport));
  if(oldRef&&!separateKey)credentialRef=oldRef;
  else {
   credentialRef=id+'-key';
   for(let suffix=2;reservedRefs.has(credentialRef);suffix++)credentialRef=id+'-key-'+suffix;
  }
  reservedRefs.add(credentialRef);
 }
 const secret=needsKey?await readBearerKey(ask,'Bearer key (hidden): '):null;
 return {profile:profile({id,displayName:name||preset?.displayName,baseUrl,model,roles,transport,credentialRef}),secret};
}
async function advanced(ask,output,hostId,{execution,nativeCheckRuntime,existingSettings,existingCredentialRefs}){
 const reservedRefs=new Set([...existingCredentialRefs,...(existingSettings?.providers.flatMap(p=>p.credentialRef?[p.credentialRef]:[])??[])]);
 const count=integer(await ask('Number of already-running API worker profiles [0]: ')||'0',0,15,'worker count'),providers=[],entries={};
 for(let i=0;i<count;i++){const configured=await configureProfile(ask,output,i+1,['worker'],existingSettings,reservedRefs);providers.push(configured.profile);if(configured.secret)entries[configured.profile.credentialRef]=configured.secret;}
 let workerId=providers[0]?.id??null,plannerWorkerId=workerId,review={source:'host',hostId},routing;
 // User-entered identifiers may equal a private key. Never echo them in prompts.
 if(count>1){workerId=await ask('Default worker identifier (Enter for first worker): ')||workerId;plannerWorkerId=await ask('Planner worker identifier (Enter for default worker): ')||workerId;const rules=[];while(yes(await ask('Add an explicit specialty route? [y/N] '))){const category=await ask('Category (general/backend/frontend/tests/docs/design): '),providerId=await ask('Worker identifier: ');rules.push({id:'rule-'+(rules.length+1),category,providerId});}routing={version:1,rules,defaultWorkerId:workerId};}
 if(count&&yes(await ask('Use a separately configured API reviewer instead of the selected host? [y/N] '))){const configured=await configureProfile(ask,output,'reviewer',['reviewer'],existingSettings,reservedRefs);providers.push(configured.profile);if(configured.secret)entries[configured.profile.credentialRef]=configured.secret;review={source:'api',reviewer:{id:configured.profile.id,revision:configured.profile.revision}};}
 const concurrency=integer(await ask('Service maximum concurrent tasks [1]: ')||'1',1,4,'service concurrency');for(const p of providers)p.concurrency=concurrency;
 // Existing endpoint aliases share physical capacity, including reviewer aliases.
 const endpointGroups=new Map();for(const p of providers){let endpoint;try{endpoint=new URL(p.baseUrl).href.replace(/\/+$/,'');}catch{throw Error('Invalid API base URL');}p.capacityGroup=endpointGroups.get(endpoint)??p.id;endpointGroups.set(endpoint,p.capacityGroup);}
 const rawSettings={schema:2,host:{id:hostId,options:{}},providers,defaults:{workerId,plannerWorkerId,review,...(routing?{routing}:{})},execution,...(nativeCheckRuntime?{nativeCheckRuntime}:{}),...(existingSettings?.codexPath?{codexPath:existingSettings.codexPath}:{}),serviceMaxConcurrentTasks:concurrency,capacityGroups:[...new Set(providers.map(p=>p.capacityGroup))].map(id=>({id,limit:concurrency}))};
 return {settings:normalizeSettings(rawSettings),rawSettings,entries,presentation:'advanced',workerLocation:null};
}

export async function collectPortableSetup(ask,output,{execution,nativeCheckRuntime,existingSettings=null,existingCredentialRefs=[],choose,previousSelection,detectedHosts,retryEndpoint=false}={}){
 if(!choose)output.write('Mosaic coordinates work. Your coding app is the conversation and default review surface; a worker is an existing compatible local or API model server.\nApproved task context goes to the supplied worker endpoint. Remote and hosted endpoints send it off this Mac. Even a local worker does not make app review local: review may use the app\'s cloud service. Separate reviewer APIs are an advanced choice.\nNo automatic server discovery, model installation or inference. Choosing an app does not prove it is connected.\n');
 if(existingSettings)output.write('Existing settings detected: advanced setup will collect an explicit replacement. Cancelling preserves your current workers and review settings; inspect the exact replacement before applying.\n');
 const detected=new Set(detectedHosts);
 const hosts=HOST_IDS.map((id,i)=>({
  value:String(i+1),
  label:getHost(id).displayName+(detected.has(id)?id==='codex'?' (found, recommended)':' (found)':'')
 }));
 const defaultHost=existingSettings?.host.id??HOST_IDS.find(id=>detected.has(id))??'codex';
 const workers=[
  {value:'4',label:'No worker yet'},
  {value:'1',label:'Model on this Mac'},
  {value:'2',label:'Model on another computer'},
  {value:'3',label:'Hosted model API'},
  {value:'5',label:'Advanced setup'},
  {value:'6',label:'Two or three workers'}
 ];
 let hostId,choice;
 if(choose){
  let hostChoice=String(HOST_IDS.indexOf(previousSelection?.hostId??defaultHost)+1);
  if(previousSelection){
   hostId=previousSelection.hostId;
   choice=await choose('Choose a worker',workers,{value:previousSelection.workerChoice,back:true});
  }
  while(choice==null){
   hostChoice=await choose('Pick your coding app',hosts,{value:hostChoice});
   hostId=HOST_IDS[Number(hostChoice)-1];
   choice=existingSettings?'5':await choose('Choose a worker',workers,{back:true});
  }
  choice=Number(choice);
 }else{
  const defaultChoice=String(HOST_IDS.indexOf(defaultHost)+1);
  const options=hosts.map(({value,label})=>`  ${value}. ${label}`).join('\n');
  const hostChoice=await ask(`Mosaic portable setup\n${options}\nChoose host [${defaultChoice}]: `)||defaultChoice;
  hostId=HOST_IDS[integer(hostChoice,1,4,'host choice')-1];
  choice=existingSettings?5:integer(await ask('Worker setup\n  1. Model on this Mac\n  2. Model on another computer (for example a Spark)\n  3. Hosted API\n  4. No worker yet / use the coding app only\n  5. Advanced setup\n  6. Guided setup for two or three workers\nChoose worker setup [1]: ')||'1',1,6,'worker setup choice');
 }
 if(choice===6)return collectMultiWorkerSetup(ask,output,{hostId,execution,nativeCheckRuntime,createProfile:profile,retryEndpoint});
 if(choice===5)return advanced(ask,output,hostId,{execution,nativeCheckRuntime,existingSettings,existingCredentialRefs});
 const workerLocation=['local','remote','api','none'][choice-1],providers=[],entries={};
 if(choice!==4){
  if(choose)output.write(choice===1?'Use the URL of your running local model server.\n':
   choice===2?'Use the address of your Spark or other model server.\n':'Choose the provider that issued your API key.\n');
  else output.write('Copy the API base URL and exact model ID from your existing server or API provider configuration. Mosaic uses its supported OpenAI-compatible worker transport; it will not contact the endpoint until you explicitly choose optional model discovery or the separate inference test.\n');
  if(choice===2)output.write('For another computer, supply an address reachable from this Mac. localhost means the computer running Mosaic, not the other computer; no particular tunnel is required.\n');
  const urlPrompt='API base URL: ';
  const {baseUrl,preset}=choice===3
   ?await selectHostedWorkerEndpoint(ask,output,urlPrompt,{choose,retry:retryEndpoint})
   :{baseUrl:await askWorkerEndpoint(ask,output,urlPrompt,{retry:retryEndpoint||!!choose}),preset:null};
  const model=await ask(preset?.modelExample?`Model ID (e.g. ${preset.modelExample}): `:'Model ID: ');
  const needsKey=preset!==null||yes(await ask('Does this endpoint require an API bearer key? [y/N] '));
  const credentialRef=needsKey?'worker-1-key':null;
  if(needsKey)entries[credentialRef]=await readBearerKey(ask,preset?.modelExample?`${preset.account} (hidden): `:'Bearer key (hidden): ');
  providers.push(profile({id:'worker-1',displayName:preset?.displayName??'Worker 1',baseUrl,model,credentialRef}));
 }
 const rawSettings={schema:2,host:{id:hostId,options:{}},providers,defaults:{workerId:providers.length?'worker-1':null,plannerWorkerId:providers.length?'worker-1':null,review:{source:'host',hostId}},execution,...(nativeCheckRuntime?{nativeCheckRuntime}:{}),serviceMaxConcurrentTasks:1,capacityGroups:providers.length?[{id:'worker-1',limit:1}]:[]};
 return {settings:normalizeSettings(rawSettings),rawSettings,entries,presentation:'simple',workerLocation,workerChoice:String(choice)};
}

/** Call only after validating settings against the private credential store. */
export function formatPortableSetupSummary(settings,{manualHost,workerLocation=null,compact=false}={}){
 const host=getHost(settings.host.id),workers=settings.providers.filter(p=>p.roles.includes('worker'));
 if(compact){
  const [worker]=workers;
  const fields=['Review your setup',`  Coding app  ${host.displayName}`];
  if(worker)fields.push(`  Worker      ${worker.displayName}`,`  Model       ${worker.model}`,
   `  API URL     ${worker.baseUrl}`,`  API key     ${worker.credentialRef?'Entered privately':'None'}`);
  else fields.push('  Worker      None');
  fields.push('  Review      In your coding app, which may use its cloud service.');
  if(workerLocation==='remote'||workerLocation==='api')fields.push('Approved task context leaves this Mac for the endpoint above.');
  return fields.join('\n')+'\n';
 }
 const lines=['\nMosaic setup summary',`Coding app: ${host.displayName}.`];
 if(workers.length){
  if(workerLocation)lines.push('Worker location: '+({local:'this Mac',remote:'another computer',api:'hosted API'}[workerLocation]??workerLocation)+'.');
  for(const worker of workers){
   const routes=settings.defaults.routing?.rules.filter(r=>r.providerId===worker.id).map(r=>r.category)??[],roles=[...(settings.defaults.workerId===worker.id?['default']:[]),...(settings.defaults.plannerWorkerId===worker.id?['planner']:[])],group=settings.capacityGroups.find(g=>g.id===worker.capacityGroup),members=workers.filter(p=>p.capacityGroup===worker.capacityGroup).map(p=>p.displayName);
   lines.push(`${worker.displayName}: ${worker.model} at ${worker.baseUrl}; private bearer key ${worker.credentialRef?'configured':'not required'}.`);
   lines.push(`  Role: worker${roles.length?', '+roles.join(', '):''}; chosen routes: ${routes.length?routes.join(', '):'none (available in the pool)'}. Worker limit: ${worker.concurrency}; shared service with ${members.join(', ')}: ${group.limit} slot${group.limit===1?'':'s'}.`);
  }
  if(settings.defaults.routing)lines.push('Specialties are chosen routes, not proof of model quality. Unassigned categories use the default worker.');
  lines.push(`Approved task context goes to the supplied worker endpoint${workerLocation==='remote'||workerLocation==='api'?' off this Mac':''}.`);
  lines.push(`Concurrency: ${settings.serviceMaxConcurrentTasks} service slot${settings.serviceMaxConcurrentTasks===1?'':'s'}; worker slots ${workers.map(p=>p.concurrency).join(', ')}; capacity group slots ${settings.capacityGroups.map(g=>g.limit).join(', ')}.`);
 }else lines.push('No worker configured: local model delegation is not ready; use the coding app only.');
 if(settings.defaults.review.source==='host')lines.push(`Reviewer: ${host.displayName} (selected coding app); review may use its cloud service, even with a local worker.`);
 else {const p=settings.providers.find(p=>p.id===settings.defaults.review.reviewer.id);lines.push(`Reviewer: separate API ${p.displayName}, ${p.model} at ${p.baseUrl} (${p.transport}). Approved review evidence goes to that endpoint.`);}
 lines.push('Host connection: '+(manualHost?'manual registration pending; saving settings does not connect the app.':'fixture-tested registration; actual app connection remains unverified.'));
 lines.push('Discovery and inference: untested until their separate optional checks. A check does not prove coding quality or app connection; context capacity remains unverified.');
 lines.push('Review delivery is pull-based; closed apps wait durably. No automatic wakeup or fallback.');
 return lines.join('\n')+'\n';
}
