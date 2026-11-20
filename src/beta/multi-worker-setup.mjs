import {normalizeSettings,validateSettingsCredentials} from './settings.mjs';
import {workerEndpoint} from '../harness/worker-profile.mjs';
import {hostedWorkerChoices,hostedWorkerPresets,readBearerKey} from './hosted-worker-presets.mjs';

const categories=['general','backend','frontend','tests','docs','design'];
const yes=value=>/^y(es)?$/i.test(value);
function integer(raw,min,max,label){const n=Number(raw);if(!/^\d+$/.test(String(raw))||!Number.isSafeInteger(n)||n<min||n>max)throw Error('Invalid '+label);return n;}

/** Also check rendered scalar values: JSON serialization can escape an already escaped key twice. */
export async function validateMultiWorkerCredentials(settings,proposedCredentials,options){
 const credentials=await validateSettingsCredentials(null,settings,proposedCredentials,options),secrets=Object.values(credentials.entries).flatMap(value=>[value,JSON.stringify(value).slice(1,-1)]);
 const visit=value=>{
  if(typeof value==='string'){
   for(let decoded=value;;){
    if(secrets.some(secret=>decoded.includes(secret)))throw Error('Credential values must occur only in the private credential store');
    // Consume JSON escape tokens together: an escaped backslash must survive
    // until the next pass before it can introduce a Unicode escape.
    const next=decoded.replace(/%([a-f0-9]{2})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16)))
     .replace(/\\(?:u([a-f0-9]{4})|(["\\/]))/gi,(_,hex,literal)=>hex?String.fromCharCode(parseInt(hex,16)):literal);
    if(next===decoded)break;decoded=next;
   }
  }else if(value&&typeof value==='object')for(const item of Object.values(value))visit(item);
 };
 visit(settings);
}

/** Collect only static numbered choices: a later key may occur in any earlier identity. */
export async function collectMultiWorkerSetup(ask,output,{hostId,execution,nativeCheckRuntime,createProfile}){
 output.write('Configure two or three existing compatible workers. Each may run on this Mac, another computer, or a hosted API. Copy its API base URL and exact model ID from its configuration. localhost means this Mac. No server discovery, model installation or inference happens here.\nSpecialties are chosen routes, not proof a model is best at that work. Unassigned categories use the default worker.\n');
 const count=integer(await ask('How many workers? 2 or 3 [3]: ')||'3',2,3,'worker count'),providers=[],entries={},routes=new Map();
 for(let i=1;i<=count;i++){
  // Location helps explain the supplied address; it is not a new topology schema.
  const location=integer(await ask(`Worker ${i} location or hosted provider
  1. This Mac
  2. Another computer
  3. Custom hosted API
${hostedWorkerChoices(4)}
Choose for worker ${i} [1]: `)||'1',1,3+hostedWorkerPresets.length,'worker location');
  if(location===2)output.write('Use an address reachable from this Mac. localhost refers to this Mac, not the other computer.\n');
  const preset=hostedWorkerPresets[location-4];
  const baseUrl=preset?.baseUrl??await ask(`Worker ${i} API base URL: `);
  const model=await ask(`Worker ${i} Model ID: `);
  const needsKey=preset!==undefined||yes(await ask(`Worker ${i} does this endpoint require an API bearer key? [y/N] `));
  const id='worker-'+i,credentialRef=needsKey?id+'-key':null;
  if(needsKey)entries[credentialRef]=await readBearerKey(ask,`Worker ${i} Bearer key (hidden): `);
  const displayName=preset?`Worker ${i} (${preset.displayName})`:`Worker ${i}`;
  providers.push(createProfile({id,displayName,baseUrl,model,credentialRef}));
  const selected=await ask(`Worker ${i} specialties: 1. General  2. Backend  3. Frontend  4. Tests  5. Docs  6. Design (comma-separated numbers; Enter for none): `);
  const choices=selected===''?[]:selected.split(',').map(value=>integer(value.trim(),1,6,'specialty'));
  if(new Set(choices).size!==choices.length)throw Error('Duplicate specialty in worker selection');
  for(const choice of choices){const category=categories[choice-1],previous=routes.get(category);
   if(previous!==undefined){const chosen=integer(await ask(`Resolve ${category} specialty: Worker ${previous} or Worker ${i}? Enter ${previous} or ${i}: `),1,count,'specialty worker');if(chosen!==previous&&chosen!==i)throw Error('Choose one of the conflicting specialty workers');routes.set(category,chosen);}
   else routes.set(category,i);
  }
 }
 const workerId='worker-'+integer(await ask(`Default worker number (1-${count}) [1]: `)||'1',1,count,'default worker'),plannerWorkerId='worker-'+integer(await ask(`Planner worker number (1-${count}) [1]: `)||'1',1,count,'planner worker');
 output.write('Concurrency defaults to one total task. Worker slots and shared-service slots also default to one. Endpoint aliases always share physical capacity; distinct URLs may still reach the same physical server. Group those explicitly below. More names or URLs do not add inference slots.\n');
 const endpoints=new Map();
 for(let i=0;i<count;i++){
  const worker=providers[i],endpoint=workerEndpoint(worker.baseUrl),alias=endpoints.get(endpoint);
  if(alias){worker.capacityGroup=alias.capacityGroup;output.write(`Worker ${i+1} is an endpoint alias and shares its existing service capacity.\n`);}
  else if(i){const shared=integer(await ask(`Worker ${i+1} shares physical capacity with: 0. Separate service; ${providers.slice(0,i).map((_,j)=>`${j+1}. Worker ${j+1}`).join('; ')} [0]: `)||'0',0,i,'shared service worker');if(shared)worker.capacityGroup=providers[shared-1].capacityGroup;}
  endpoints.set(endpoint,worker);
 }
 const concurrency=integer(await ask('Total concurrent tasks (1-4) [1]: ')||'1',1,4,'total concurrency');
 for(let i=0;i<count;i++)providers[i].concurrency=integer(await ask(`Worker ${i+1} maximum concurrent tasks (1-4) [1]: `)||'1',1,4,'worker concurrency');
 const groupIds=[...new Set(providers.map(p=>p.capacityGroup))],capacityGroups=[];
 for(const [i,id] of groupIds.entries()){
  const members=providers.flatMap((p,j)=>p.capacityGroup===id?[j+1]:[]);
  capacityGroups.push({id,limit:integer(await ask(`Shared service ${i+1} maximum concurrent tasks for workers ${members.join(', ')} (1-4) [1]: `)||'1',1,4,'shared service concurrency')});
 }
 const candidate={schema:2,host:{id:hostId,options:{}},providers,defaults:{workerId,plannerWorkerId,review:{source:'host',hostId},routing:{version:1,rules:[...routes].map(([category,i],j)=>({id:'rule-'+(j+1),category,providerId:'worker-'+i})),defaultWorkerId:workerId}},execution,nativeCheckRuntime,serviceMaxConcurrentTasks:concurrency,capacityGroups};
 // Check entered identities before URL canonicalization can transform JSON backslashes.
 await validateMultiWorkerCredentials(candidate,{schema:1,entries});
 const settings=normalizeSettings(candidate);
 await validateMultiWorkerCredentials(settings,{schema:1,entries});
 // Transient only: setup must also check entered identities against saved keys.
 return {settings,rawSettings:candidate,entries,presentation:'guided',workerLocation:null};
}
