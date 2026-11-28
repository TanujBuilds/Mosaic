import {randomUUID} from 'node:crypto';
import {canonical} from '../../../src/harness/contracts.mjs';
import {workerEndpoint,isLoopbackProvider} from '../../../src/harness/worker-profile.mjs';
import {normalizeSettings} from '../../../src/beta/settings.mjs';
import {validateMultiWorkerCredentials} from '../../../src/beta/multi-worker-setup.mjs';
import {getHost} from '../../../src/beta/hosts/index.mjs';

export const openRouter = 'https://openrouter.ai/api/v1';
export const localServer = 'http://127.0.0.1:8080/v1';
const names = {openrouter:'OpenRouter',local:'Local server',custom:'Custom API'};
const editable = ['host','provider','model','baseUrl','reviewTarget','reviewerModel','reviewerBaseUrl','revision','key','reviewerKey'];

// Messages from this class can be displayed by the native bridge.
export class ConnectionError extends Error {}
const fail = message => { throw new ConnectionError(message); };

export function selectedProfiles(settings) {
  if (settings?.schema === 1) return {worker:settings.worker?.profile};
  const worker = settings?.providers.find(p => p.id === settings.defaults.workerId);
  const reviewer = settings?.defaults.review.source === 'api'
    ? settings.providers.find(p => p.id === settings.defaults.review.reviewer.id)
    : settings?.providers.find(p => p.roles.length === 1 && p.roles[0] === 'reviewer');
  return {worker,reviewer};
}

export function editingReason(settings) {
  if (!settings) return '';
  if (settings.schema === 1) return 'Run mosaic migrate in Terminal to review and apply the migration, then reopen Connections.';
  if (!['codex','claude-code'].includes(settings.host.id))
    return 'This setup uses '+getHost(settings.host.id).displayName+'. Use mosaic setup in Terminal to edit it.';
  const {worker,reviewer} = selectedProfiles(settings);
  if ((!worker && settings.defaults.review.source==='api') || settings.defaults.routing || settings.defaults.plannerWorkerId !== settings.defaults.workerId ||
      settings.providers.some(p => (p !== worker && p !== reviewer) || p.roles.length !== 1 || p.transport !== 'openai-chat'))
    return 'This setup has advanced provider or routing settings. Use mosaic setup in Terminal to edit it.';
  return '';
}

function endpoint(value) {
  try { return workerEndpoint(value); }
  catch { fail('Use an HTTPS API base URL, or HTTP on localhost. Remove credentials, query parameters and fragments from the URL.'); }
}

function modelId(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value || value.length > 200 || /[\p{C}\p{Zl}\p{Zp}]/u.test(value))
    fail('Enter the model ID shown by your provider.');
  return value;
}

export function providerOf(worker) {
  if (!worker) return 'local';
  if (workerEndpoint(worker.baseUrl) === openRouter) return 'openrouter';
  if (worker.displayName === names.custom) return 'custom';
  return isLoopbackProvider(worker.baseUrl) || worker.displayName === names.local ? 'local' : 'custom';
}

function buildProfile({id,role,displayName,model,url,group,previous,credentials,suppliedKey,entries,providers}) {
  const oldRef = previous?.credentialRef;
  const oldKey = oldRef ? credentials.entries[oldRef] : undefined;
  const sameRecipient = previous?.baseUrl === url;
  const key = suppliedKey === undefined ? (sameRecipient ? oldKey : undefined) : suppliedKey;
  if (!key && url === openRouter) fail('Enter an OpenRouter API key for this endpoint.');
  if (key !== undefined && key !== '' && (typeof key !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(key)))
    fail('Enter a valid API key without whitespace.');
  let credentialRef = null;
  if (key) {
    const shared = oldRef && providers.some(p => p.id !== id && p.credentialRef === oldRef);
    if (sameRecipient && oldRef && (!shared || key === oldKey)) credentialRef=oldRef;
    else {
      const base=id+'-key';
      credentialRef=base;
      for (let i=2; Object.hasOwn(credentials.entries,credentialRef) || Object.hasOwn(entries,credentialRef); i++)
        credentialRef=base+'-'+i;
    }
    entries[credentialRef]=key;
  }
  const worker = role === 'worker';
  const profile = {...(previous ?? {
    schema:1,id,revision:randomUUID(),roles:[role],transport:'openai-chat',concurrency:1,
    capabilities:{workerProtocol:worker ? 'mosaic-structured-v1' : null,transports:['json'],
      modelDiscovery:'manual',taskKinds:worker ? ['coding','consult'] : []},
    streaming:false,maxOutputTokens:12000,maxContextTokens:null
  }),displayName,model:modelId(model),baseUrl:url,credentialRef,capacityGroup:group};
  if (previous && (canonical(previous) !== canonical(profile) || (key || undefined) !== oldKey))
    profile.revision=randomUUID();
  return profile;
}

export async function prepareConfiguration(input,old,credentials,getNativeRuntime) {
  const reason=editingReason(old);
  if (reason) fail(reason);
  if (Object.keys(input).some(k => !editable.includes(k)) || !['codex','claude-code'].includes(input.host) ||
      !Object.hasOwn(names,input.provider) || !['host','api'].includes(input.reviewTarget) || typeof input.model !== 'string')
    fail('Choose a supported host, worker provider and review target.');
  const {worker,reviewer}=selectedProfiles(old), providers=[], entries={};
  // Preserve the terminal's profile IDs, capabilities, concurrency, capacity
  // limits and private references when editing the selected model.
  if (input.model || input.key || input.reviewTarget === 'api') {
    const url=endpoint(input.baseUrl);
    if (input.provider === 'openrouter' && url !== openRouter)
      fail('Use the OpenRouter API base URL, or choose Custom API for a different endpoint.');
    const id=worker?.id ?? (reviewer?.id==='worker-1' ? 'desktop-worker' : 'worker-1');
    providers.push(buildProfile({id,role:'worker',displayName:worker && providerOf(worker)===input.provider && worker.baseUrl===url
      ? worker.displayName : names[input.provider],model:input.model,url,group:input.reviewTarget==='host' && reviewer?.baseUrl===url ? reviewer.capacityGroup : worker?.capacityGroup??id,
      previous:worker,providers:old?.providers??[],credentials,suppliedKey:input.key,entries}));
  }
  if (worker && !providers.length && (worker.concurrency!==1 || worker.streaming || worker.maxContextTokens!==null ||
      worker.maxOutputTokens!==12000 || worker.capabilities.modelDiscovery!=='manual' || worker.capabilities.taskKinds.length!==2))
    fail('This worker has advanced settings. Use mosaic setup in Terminal to remove its profile.');
  const workerId=providers[0]?.id??null;
  let review={source:'host',hostId:input.host};
  if (input.reviewTarget==='api') {
    const url=endpoint(input.reviewerBaseUrl);
    const id=reviewer?.id??(providers[0].id === 'reviewer' ? 'desktop-reviewer' : 'reviewer');
    const profile=buildProfile({id,role:'reviewer',displayName:reviewer?.displayName??'API reviewer',model:input.reviewerModel,url,
      group:providers[0].baseUrl===url ? providers[0].capacityGroup : reviewer?.capacityGroup??id,
      previous:reviewer,providers:old?.providers??[],credentials,suppliedKey:input.reviewerKey,entries});
    providers.push(profile);
    review={source:'api',reviewer:{id,revision:profile.revision}};
  } else if (reviewer) {
    // Choosing host review changes the default. Keep its API profile and key
    // so returning to API review restores the original terminal configuration.
    providers.push(reviewer);
  }
  if (old) {
    const positions=new Map(old.providers.map((p,i)=>[p.id,i]));
    providers.sort((a,b)=>(positions.get(a.id)??Infinity)-(positions.get(b.id)??Infinity));
  }
  const {key,reviewerKey,...visible}=input;
  try {
    // Check entered URLs as well as their normalized forms. Check retained keys
    // even when the owner just supplied replacements.
    for (const store of [credentials,{schema:1,entries:{...credentials.entries,...entries}}])
      await validateMultiWorkerCredentials({visible,providers},store,{allowMissing:true});
  } catch { fail('Check that API keys appear only in their password fields.'); }

  const verifiedRuntime=await getNativeRuntime();
  const nativeCheckRuntime=old ? old.nativeCheckRuntime : verifiedRuntime;
  const capacityGroups=[...(old?.capacityGroups??[])];
  for(const p of providers) if(!capacityGroups.some(group=>group.id===p.capacityGroup))
    capacityGroups.push({id:p.capacityGroup,limit:1});
  const settings=normalizeSettings({...old,schema:2,host:{id:input.host,options:{}},providers,
    defaults:{workerId,plannerWorkerId:workerId,review},
    execution:old?.execution??{backend:'darwin-seatbelt',backendRevision:2,runtimeFingerprint:nativeCheckRuntime.artifactManifestSha256},
    ...(nativeCheckRuntime?{nativeCheckRuntime}:{}),serviceMaxConcurrentTasks:old?.serviceMaxConcurrentTasks??1,capacityGroups
  });
  return {settings,entries};
}
