import path from 'node:path';
import {rm} from 'node:fs/promises';
import {openSync,closeSync,fstatSync,lstatSync,readSync,realpathSync,constants} from 'node:fs';
import {constants as bufferConstants} from 'node:buffer';
import {canonical,identifier} from '../harness/contracts.mjs';
import {normalizeProfile,normalizeLegacyWorkerProfile,normalizeProviderPolicy,profileIdentity} from '../harness/providers/contracts.mjs';
import {normalizeReviewPolicy} from '../harness/review/contracts.mjs';
import {normalizeRoutingPolicy} from '../harness/routing/contracts.mjs';
import {normalizeExecutionPolicy,normalizeNativeCheckRuntime} from '../harness/execution.mjs';
import {workerProfile} from '../harness/worker-profile.mjs';
import {normalizeHostSettings} from './hosts/index.mjs';
import {entry,hash,jsonFile,saveJson,withLock} from './files.mjs';
const fingerprint=value=>hash(canonical(value));
const credentialsFile=paths=>path.join(paths.configDir,'credentials.json');
const migrationFile=paths=>path.join(paths.configDir,'migration-intent.json');
function object(value,allowed,label,required=allowed){if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(value).some(k=>typeof k!=='string'||!allowed.includes(k))||required.some(k=>!Object.hasOwn(value,k)))throw Error('Invalid '+label);}
function secret(value){if(typeof value!=='string'||!/^[\x21-\x7e]{1,2048}$/.test(value))throw Error('Invalid private credential');return value;}
function absolute(value){if(typeof value!=='string'||!path.isAbsolute(value)||/[\x00-\x1f\x7f]/u.test(value))throw Error('Invalid configured executable path');return value;}
export function normalizeCredentials(raw){object(raw,['schema','entries'],'private credentials');if(raw.schema!==1)throw Error('Invalid private credential schema');object(raw.entries,Object.keys(raw.entries??{}),'private credential entries',[]);const entries={};for(const [ref,value] of Object.entries(raw.entries)){identifier(ref,'credential reference');Object.defineProperty(entries,ref,{value:secret(value),enumerable:true,writable:true,configurable:true});}return {schema:1,entries};}
function rejectSecretIdentity(settings,credentials){const secrets=Object.values(credentials.entries).flatMap(value=>[value,JSON.stringify(value).slice(1,-1)]);for(let encoded=canonical(settings);;){if(secrets.some(key=>encoded.includes(key)))throw Error('Credential values must occur only in the private credential store');const decoded=encoded.replace(/%([a-f0-9]{2})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16)));if(decoded===encoded)return;encoded=decoded;}}
export function normalizeSettings(raw){
 if(raw?.schema===1){
  object(raw,['schema','host','codexPath','worker','executionPolicy','nativeCheckRuntime'],'legacy configuration',['schema']);
  const value=structuredClone(raw);if(value.host!==undefined)value.host=normalizeHostSettings(value.host);if(value.codexPath!==undefined)absolute(value.codexPath);if(!value.codexPath&&(!value.host||value.host.id==='codex'))throw Error('Invalid legacy configuration');
  if(value.worker!==undefined&&value.worker!==null){object(value.worker,['profile','apiKey'],'legacy worker',['profile']);workerProfile(value.worker.profile);if(value.worker.apiKey!==undefined){secret(value.worker.apiKey);rejectSecretIdentity(value.worker.profile,{schema:1,entries:{legacy:value.worker.apiKey}});}}
  if(value.executionPolicy!==undefined)normalizeExecutionPolicy(value.executionPolicy);if(value.nativeCheckRuntime!==undefined)normalizeNativeCheckRuntime(value.nativeCheckRuntime);return value;
 }
 object(raw,['schema','host','providers','defaults','execution','nativeCheckRuntime','codexPath','serviceMaxConcurrentTasks','capacityGroups'],'Mosaic Beta schema2 configuration',['schema','host','providers','defaults','execution','serviceMaxConcurrentTasks','capacityGroups']);
 if(raw.schema!==2)throw Error('Invalid Mosaic Beta configuration schema');
 const host=normalizeHostSettings(raw.host);if(!Array.isArray(raw.providers)||raw.providers.length>16)throw Error('Invalid provider catalog');const providers=raw.providers.map(normalizeProfile),ids=new Set(),endpoints=new Map();
 for(const profile of providers){if(ids.has(profile.id))throw Error('Duplicate provider id');ids.add(profile.id);if(endpoints.has(profile.baseUrl)&&endpoints.get(profile.baseUrl)!==profile.capacityGroup)throw Error('Profiles sharing an endpoint must share a capacity group');endpoints.set(profile.baseUrl,profile.capacityGroup);}
 object(raw.defaults,['workerId','plannerWorkerId','review','routing'],'configuration defaults',['workerId','plannerWorkerId','review']);
 const defaults=structuredClone(raw.defaults),workers=providers.filter(p=>p.roles.includes('worker'));
 if(!Array.isArray(raw.capacityGroups)||raw.capacityGroups.length>16)throw Error('Invalid capacity groups');const groupIds=new Set();const capacityGroups=raw.capacityGroups.map(group=>{object(group,['id','limit'],'capacity group');identifier(group.id,'capacity group');if(groupIds.has(group.id)||!Number.isSafeInteger(group.limit)||group.limit<1||group.limit>4)throw Error('Invalid or duplicate capacity group');groupIds.add(group.id);return {...group};});if(providers.some(p=>!groupIds.has(p.capacityGroup)))throw Error('Provider references an unlisted capacity group');
 if(!Number.isSafeInteger(raw.serviceMaxConcurrentTasks)||raw.serviceMaxConcurrentTasks<1||raw.serviceMaxConcurrentTasks>4)throw Error('Invalid service concurrency');
 let providerPolicy;if(workers.length){providerPolicy=normalizeProviderPolicy({version:1,workers:workers.map(profileIdentity),plannerWorkerId:defaults.plannerWorkerId,defaultWorkerId:defaults.workerId,maxConcurrentTasks:raw.serviceMaxConcurrentTasks,capacityGroups},providers);}else if(defaults.workerId!==null||defaults.plannerWorkerId!==null||defaults.routing!==undefined)throw Error('Host-only setup cannot select worker defaults');
 if(defaults.routing!==undefined)defaults.routing=normalizeRoutingPolicy(defaults.routing,providerPolicy);
 if(!['host','api'].includes(defaults.review?.source))throw Error('Invalid default review source');
 if(defaults.review.source==='host'){object(defaults.review,['source','hostId'],'default host review');if(defaults.review.hostId!==host.id)throw Error('Default review host differs from selected host');normalizeReviewPolicy({version:1,...defaults.review,fallback:'wait'});}
 else {object(defaults.review,['source','reviewer'],'default API review');object(defaults.review.reviewer,['id','revision'],'default reviewer reference');const p=providers.find(p=>p.id===defaults.review.reviewer.id&&p.revision===defaults.review.reviewer.revision);if(!p)throw Error('Configured reviewer unavailable');normalizeReviewPolicy({version:1,source:'api',reviewer:profileIdentity(p),fallback:'wait'});}
 object(raw.execution,['backend','backendRevision','runtimeFingerprint'],'configured execution',['backend','backendRevision']);const executionPolicy=normalizeExecutionPolicy({version:1,...raw.execution});const nativeCheckRuntime=normalizeNativeCheckRuntime(raw.nativeCheckRuntime);
 if(executionPolicy.backend==='darwin-seatbelt'&&executionPolicy.backendRevision===2&&(!nativeCheckRuntime||nativeCheckRuntime.artifactManifestSha256!==executionPolicy.runtimeFingerprint))throw Error('Native execution requires its exact private artifact identity');
 if(executionPolicy.backend==='codex-sandbox'&&!raw.codexPath)throw Error('Codex sandbox executable required');
 return {schema:2,host,providers,defaults,execution:{...raw.execution},...(nativeCheckRuntime?{nativeCheckRuntime}:{}),...(raw.codexPath!==undefined?{codexPath:absolute(raw.codexPath)}:{}),serviceMaxConcurrentTasks:raw.serviceMaxConcurrentTasks,capacityGroups};
}
export function configuredPolicies(raw){const settings=normalizeSettings(raw);if(settings.schema!==2)return {};const workers=settings.providers.filter(p=>p.roles.includes('worker'));const providerPolicy=workers.length?normalizeProviderPolicy({version:1,workers:workers.map(profileIdentity),plannerWorkerId:settings.defaults.plannerWorkerId,defaultWorkerId:settings.defaults.workerId,maxConcurrentTasks:settings.serviceMaxConcurrentTasks,capacityGroups:settings.capacityGroups},settings.providers):undefined;const ref=settings.defaults.review.reviewer;const reviewPolicy=normalizeReviewPolicy({version:1,...(settings.defaults.review.source==='host'?settings.defaults.review:{source:'api',reviewer:profileIdentity(settings.providers.find(p=>p.id===ref.id&&p.revision===ref.revision))}),fallback:'wait'});return {...(providerPolicy?{providerPolicy}:{}),reviewPolicy,...(settings.defaults.routing?{routingPolicy:normalizeRoutingPolicy(settings.defaults.routing,providerPolicy)}:{})};}
async function ownedJson(file,{max=131072}={}){const info=await entry(file);if(info&&(info.uid!==process.getuid()||info.mode&0o077))throw Error('Unsafe private settings or credential ownership');return jsonFile(file,{privateFile:true,max});}
function privateJsonSync(paths,file,{max=131072}={}){
 let fd;
 try{
  if(!Number.isSafeInteger(max)||max<0||max>=bufferConstants.MAX_LENGTH||!Number.isInteger(constants.O_NOFOLLOW)||!constants.O_NOFOLLOW||!Number.isInteger(constants.O_NONBLOCK)||!constants.O_NONBLOCK)throw Error();
  const home=realpathSync(paths.home),expected=path.join(home,path.relative(paths.home,file));
  const directories=()=>{for(const directory of [paths.root,paths.configDir]){const relative=path.relative(paths.home,directory),info=lstatSync(directory);if(relative.startsWith('..'+path.sep)||relative==='..'||path.isAbsolute(relative)||!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid()||info.mode&0o077||realpathSync(directory)!==path.join(home,relative))throw Error();}};
  directories();fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const verify=()=>{const info=fstatSync(fd,{bigint:true}),named=lstatSync(file,{bigint:true});if(!info.isFile()||info.size>BigInt(max)||info.uid!==BigInt(process.getuid())||info.mode&0o077n||!named.isFile()||named.isSymbolicLink()||named.dev!==info.dev||named.ino!==info.ino||named.uid!==BigInt(process.getuid())||named.mode&0o077n||realpathSync(file)!==expected)throw Error();return info;};
  const before=verify(),bytes=Buffer.alloc(Number(before.size)+1);let length=0;
  // At most the admitted size plus one sentinel byte, even if the fd grows.
  while(length<bytes.length){const count=readSync(fd,bytes,length,bytes.length-length,length);if(!count)break;length+=count;}
  const after=verify();directories();
  if(length>max||BigInt(length)!==before.size||['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'].some(key=>before[key]!==after[key]))throw Error();
  return JSON.parse(bytes.subarray(0,length).toString('utf8'));
 }catch(error){if(error.code==='ENOENT'&&fd===undefined)return null;throw Error('Unsafe or invalid private settings or credential file');}
 finally{if(fd!==undefined)closeSync(fd);}
}
export function readSettingsSync(paths){const raw=privateJsonSync(paths,paths.config);return raw?normalizeSettings(raw):null;}
export async function readSettings(paths){return readSettingsSync(paths);}
export function readCredentialsSync(paths){return normalizeCredentials(privateJsonSync(paths,credentialsFile(paths))??{schema:1,entries:{}});}
export async function readCredentials(paths){return readCredentialsSync(paths);}
export function validateSettingsCredentialsSync(paths,settings,proposedCredentials,{allowMissing=false}={}){const credentials=proposedCredentials===undefined?readCredentialsSync(paths):normalizeCredentials(proposedCredentials);const identity=settings.schema===1&&settings.worker?{...settings,worker:{profile:settings.worker.profile}}:settings;rejectSecretIdentity(identity,credentials);for(const p of settings.providers??[])if(!allowMissing&&p.credentialRef!==null&&!Object.hasOwn(credentials.entries,p.credentialRef))throw Error('Configured provider credential is unavailable');return credentials;}
export async function validateSettingsCredentials(paths,settings,proposedCredentials,options){return validateSettingsCredentialsSync(paths,settings,proposedCredentials,options);}
function settingsMigrationPreview(previous,credentials){
 if(!previous||previous.schema!==1)throw Error('Migration requires readable legacy schema1 settings');const providers=[],nextCredentials=structuredClone(credentials);
 if(previous.worker){const ref=previous.worker.apiKey?'legacy-worker-key':null;if(ref&&Object.hasOwn(credentials.entries,ref)&&credentials.entries[ref]!==previous.worker.apiKey)throw Error('Legacy credential reference is already owned by another value');providers.push(normalizeLegacyWorkerProfile(previous,{id:'legacy-worker',capacityGroup:'legacy-service',credentialRef:ref}));if(ref)nextCredentials.entries[ref]=previous.worker.apiKey;}
 const host=previous.host??{id:'codex',options:{}};const settings=normalizeSettings({schema:2,host,providers,defaults:{workerId:providers[0]?.id??null,plannerWorkerId:providers[0]?.id??null,review:{source:'host',hostId:host.id}},execution:(({version,...value})=>value)(previous.executionPolicy??{version:1,backend:'codex-sandbox',backendRevision:1}),...(previous.codexPath?{codexPath:previous.codexPath}:{}),...(previous.nativeCheckRuntime?{nativeCheckRuntime:previous.nativeCheckRuntime}:{}),serviceMaxConcurrentTasks:1,capacityGroups:providers.length?[{id:'legacy-service',limit:1}]:[]});rejectSecretIdentity(settings,nextCredentials);
 const value={schema:1,kind:'settings-migration',settings,previousConfigHash:fingerprint(previous),previousCredentialsHash:fingerprint(credentials),credentialsHash:fingerprint(nextCredentials)};return {...value,previewHash:fingerprint(value)};
}
export async function previewSettingsMigration(paths){return settingsMigrationPreview(await readSettings(paths),await readCredentials(paths));}
const migrationFiles=paths=>({settings:paths.config,credentials:credentialsFile(paths),intent:migrationFile(paths),legacy:path.join(paths.configDir,'migration-legacy.json'),receipt:path.join(paths.configDir,'migration-receipt.json')});
const migrationReceipt=intent=>({schema:1,previewHash:intent.previewHash,settingsHash:fingerprint(intent.settings),credentialsHash:intent.credentialsHash,complete:true});
// Keep one baseline across awaited lifecycle calls. Only our own successful writes
// advance it; rereading after a callback must never adopt a concurrent edit.
function migrationSnapshot(paths){return Object.fromEntries(Object.entries(migrationFiles(paths)).map(([key,file])=>[key,privateJsonSync(paths,file)]));}
function assertMigrationSnapshot(paths,snapshot){
 const current=migrationSnapshot(paths);
 for(const key of Object.keys(snapshot))if(fingerprint(current[key])!==fingerprint(snapshot[key]))throw Error('Migration '+key+' changed; newer state and recovery evidence are preserved');
}
function assertApprovedMigration(intent,snapshot,{create=false}={}){
 const current=normalizeSettings(snapshot.settings),credentials=normalizeCredentials(snapshot.credentials??{schema:1,entries:{}});
 if(!(create?[intent.previousConfigHash]:[intent.previousConfigHash,fingerprint(intent.settings)]).includes(fingerprint(current)))throw Error('Settings changed since migration preview; newer state is preserved');
 if(!(create?[intent.previousCredentialsHash]:[intent.previousCredentialsHash,intent.credentialsHash]).includes(fingerprint(credentials)))throw Error('Credentials changed since migration preview; newer credentials are preserved');
 if(create?snapshot.intent!==null:canonical(snapshot.intent)!==canonical(intent))throw Error('Migration intent changed; newer state is preserved');
 const legacy=create?current:snapshot.legacy&&normalizeSettings(snapshot.legacy);
 if(!legacy||legacy.schema!==1||fingerprint(legacy)!==intent.previousConfigHash||snapshot.legacy!==null&&fingerprint(normalizeSettings(snapshot.legacy))!==intent.previousConfigHash)throw Error('Migration legacy recovery data changed; newer state is preserved');
 // Reconstruct only the two possible original credential stores: the key either
 // already existed or was moved from legacy settings. This verifies the original
 // preview without adopting a rehashed replacement intent after interruption.
 const previousCredentials=[credentials];
 if(legacy.worker?.apiKey&&credentials.entries['legacy-worker-key']===legacy.worker.apiKey){const withoutMovedKey=structuredClone(credentials);delete withoutMovedKey.entries['legacy-worker-key'];previousCredentials.push(withoutMovedKey);}
 if(!previousCredentials.some(previous=>fingerprint(previous)===intent.previousCredentialsHash&&canonical(settingsMigrationPreview(legacy,previous))===canonical(intent)))throw Error('Migration intent changed from the approved legacy transition; newer state is preserved');
 if(snapshot.receipt!==null&&canonical(snapshot.receipt)!==canonical(migrationReceipt(intent)))throw Error('Migration receipt changed; newer state and recovery evidence are preserved');
}
async function saveMigrationStep(paths,snapshot,key,value){
 assertMigrationSnapshot(paths,snapshot);await saveJson(migrationFiles(paths)[key],value);
 snapshot[key]=structuredClone(value);assertMigrationSnapshot(paths,snapshot);
}
async function applyMigration(paths,intent,snapshot,{afterStep=async()=>{}}={}){
 assertMigrationSnapshot(paths,snapshot);assertApprovedMigration(intent,snapshot);
 const current=normalizeSettings(snapshot.settings),credentials=normalizeCredentials(snapshot.credentials??{schema:1,entries:{}}),legacy=current.schema===1?current:snapshot.legacy;
 if(fingerprint(credentials)!==intent.credentialsHash){const next=structuredClone(credentials);if(legacy?.worker?.apiKey)next.entries['legacy-worker-key']=legacy.worker.apiKey;if(fingerprint(next)!==intent.credentialsHash)throw Error('Cannot recover exact approved credential migration');await saveMigrationStep(paths,snapshot,'credentials',next);}
 await afterStep('credentials');assertMigrationSnapshot(paths,snapshot);
 if(current.schema!==2)await saveMigrationStep(paths,snapshot,'settings',intent.settings);
 await afterStep('settings');assertMigrationSnapshot(paths,snapshot);
 await saveMigrationStep(paths,snapshot,'receipt',migrationReceipt(intent));
 await afterStep('complete');assertMigrationSnapshot(paths,snapshot);
 return true;
}
export async function assertMigrationStartupReady(paths,settings){
 if(!privateJsonSync(paths,migrationFile(paths)))return false;
 const snapshot=migrationSnapshot(paths),intent=snapshot.intent;if(!intent)return false;
 const {previewHash,...value}=intent;if(fingerprint(value)!==previewHash)throw Error('Invalid pending migration intent');
 const receipt=snapshot.receipt,credentials=normalizeCredentials(snapshot.credentials??{schema:1,entries:{}}),current=normalizeSettings(snapshot.settings);
 if(fingerprint(current)!==fingerprint(settings))throw Error('Settings changed during migration startup; newer state is preserved');
 assertApprovedMigration(intent,snapshot);
 if(!receipt?.complete||receipt.previewHash!==previewHash||receipt.settingsHash!==fingerprint(settings)||receipt.credentialsHash!==fingerprint(credentials)||receipt.credentialsHash!==intent.credentialsHash||fingerprint(intent.settings)!==fingerprint(settings))throw Error('Settings migration is incomplete; resume it before coordinator startup.');
 return true;
}
async function migrationPhase(paths,intent,{options={},create=false}={}){
 const snapshot=migrationSnapshot(paths);assertApprovedMigration(intent,snapshot,{create});
 const service=await import('./service.mjs'),lifecycle={...service,...options.lifecycle};
 assertMigrationSnapshot(paths,snapshot);
 await service.assertSettingsMaintenanceAllowed(paths,{kind:'migration'});assertMigrationSnapshot(paths,snapshot);
 const hadAgent=await lifecycle.verifyLaunchAgent(paths);assertMigrationSnapshot(paths,snapshot);
 let ready=false;try{ready=await assertMigrationStartupReady(paths,normalizeSettings(snapshot.settings));}catch(error){if(!/incomplete/.test(error.message))throw error;}
 assertMigrationSnapshot(paths,snapshot);
 if(!ready){
  await service.assertMaintenanceIdle(paths,{settingsMigration:true});assertMigrationSnapshot(paths,snapshot);
  await lifecycle.stopForMaintenance(paths,{recovering:true});assertMigrationSnapshot(paths,snapshot);
  await service.assertMaintenanceIdle(paths,{settingsMigration:true,offline:true});assertMigrationSnapshot(paths,snapshot);
  if(create){await saveMigrationStep(paths,snapshot,'legacy',snapshot.settings);await saveMigrationStep(paths,snapshot,'intent',intent);await options.afterStep?.('intent');assertMigrationSnapshot(paths,snapshot);}
  await applyMigration(paths,intent,snapshot,options);assertMigrationSnapshot(paths,snapshot);
 }
 return {intent,hadAgent,snapshot};
}
async function finishMigration(paths,plan,options){
 const service=await import('./service.mjs'),lifecycle={...service,...options.lifecycle};
 assertMigrationSnapshot(paths,plan.snapshot);
 if(plan.hadAgent){await lifecycle.startLaunchAgent(paths);assertMigrationSnapshot(paths,plan.snapshot);}
 return withLock(paths,async()=>{
  assertMigrationSnapshot(paths,plan.snapshot);await service.assertSettingsMaintenanceAllowed(paths,{kind:'migration'});assertMigrationSnapshot(paths,plan.snapshot);
  await assertMigrationStartupReady(paths,normalizeSettings(plan.snapshot.settings));assertMigrationSnapshot(paths,plan.snapshot);
  for(const key of ['intent','legacy']){assertMigrationSnapshot(paths,plan.snapshot);await rm(migrationFiles(paths)[key],{force:true});plan.snapshot[key]=null;assertMigrationSnapshot(paths,plan.snapshot);}
  return true;
 });
}
export async function applySettingsMigration(paths,preview,options={}){
 const plan=await withLock(paths,async()=>{
  const {previewHash,...value}=preview??{};if(fingerprint(value)!==previewHash)throw Error('Migration preview changed');const intent=structuredClone(preview),actual=await previewSettingsMigration(paths);if(actual.previewHash!==previewHash)throw Error('Settings or credentials changed since migration preview');if(await entry(migrationFile(paths)))throw Error('Migration is pending; resume it before another apply');
  return migrationPhase(paths,intent,{options,create:true});
 });
 return finishMigration(paths,plan,options);
}
export async function resumeSettingsMigration(paths,options={}){
 const plan=await withLock(paths,async()=>{const intent=await ownedJson(migrationFile(paths));if(!intent)return null;const {previewHash,...value}=intent;if(fingerprint(value)!==previewHash)throw Error('Invalid migration intent');normalizeSettings(intent.settings);return migrationPhase(paths,intent,{options});});
 return plan?finishMigration(paths,plan,options):false;
}
