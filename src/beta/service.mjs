import {normalizeSettings,readSettings,readSettingsSync,readCredentials,validateSettingsCredentials,validateSettingsCredentialsSync,configuredPolicies,assertMigrationStartupReady} from './settings.mjs';
import {ProviderRegistry} from '../harness/providers/registry.mjs';
import {normalizeExecutionPolicy,assertExecutionPrerequisites} from '../harness/execution.mjs';
import {hostRegistry,normalizeHostSettings} from './hosts/index.mjs';
import {existsSync} from 'node:fs';
import {canonical} from '../harness/contracts.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdir,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {serve} from '../harness/cli.mjs';
import {atomic,entry,fileBytes,hash,jsonFile,label,privateDirectories,readMaintenanceDatabase,withLock} from './files.mjs';
import {client} from './client.mjs';
import {registration,serviceDefinition,serviceRecord,startWindowsService,unregisterWindowsService} from './windows-service.mjs';

const exec=promisify(execFile);
const launchctl=(...args)=>exec('/bin/launchctl',args,{timeout:5000,maxBuffer:65536});
const domain=()=>`gui/${process.getuid()}`;
const serviceId=()=>domain()+'/'+label;
const xml=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&apos;");

export function launchAgent(paths){
 if(process.platform==='win32')return serviceDefinition(paths);
 const args=[paths.launcher,'serve'].map(value=>'<string>'+xml(value)+'</string>').join('');
 return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args}</array>
<key>WorkingDirectory</key><string>${xml(paths.state)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>5</integer>
<key>ExitTimeOut</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(path.join(paths.state,'coordinator.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(paths.state,'coordinator-error.log'))}</string>
</dict></plist>
`;
}

function assertIdle(db,{settingsMigration=false,settingsChange=false,offline=false}={}) {
 if(offline&&db.prepare("SELECT id FROM records WHERE kind='lease' AND id='coordinator' LIMIT 1").get())throw Error('A coordinator lease remains present during offline maintenance. Wait for startup/shutdown or recover and stop its coordinator before retrying.');
 const revision=db.prepare(`SELECT revision.id FROM records AS revision JOIN records AS goal
  ON goal.kind='goal' AND goal.id=json_extract(revision.data,'$.goalId')
  WHERE revision.kind='goal_revision' AND json_extract(revision.data,'$.status')='draft'

   AND json_extract(goal.data,'$.status') NOT IN ('completed','partial')
   AND json_extract(goal.data,'$.hash')=json_extract(revision.data,'$.previousHash')
   AND json_extract(goal.data,'$.deadline')>? LIMIT 1`).get(Date.now());
 if(revision)throw Error('A prepared revision is still current. Stop and finalize its goal as partial in its host, or supersede the revision, before maintenance.');
 if((settingsMigration||settingsChange)&&db.prepare("SELECT id FROM records WHERE kind='goal' AND json_extract(data,'$.status')='stopped' LIMIT 1").get())throw Error('A stopped approval remains resumable. Retain its exact runtime and settings; resume and finish or finalize it as partial before migration or reconfiguration.');
 const guard=db.prepare(`SELECT kind FROM records WHERE
  (kind='goal' AND json_extract(data,'$.status') IN ('draft','active','paused')) OR
  (kind='task' AND (json_extract(data,'$.owner') IS NOT NULL OR json_extract(data,'$.native.writerActive')=1)) OR
  (kind='task' AND json_extract(data,'$.status')='legacy_reviewing') OR
  (kind='reviewer' AND json_extract(data,'$.status')='reserved') OR
  (kind='planning' AND json_extract(data,'$.status') IN ('running','uncertain')) OR
  (kind='execution_owner' AND json_extract(data,'$.status')!='quiescent') OR
  (kind='operation' AND json_extract(data,'$.status') IN ('pending','retryable','uncertain')) LIMIT 1`).get();
 if(guard)throw Error('Mosaic Beta has prepared, active or unresolved work. Resolve it in its host before maintenance.');
}

export async function assertMaintenanceIdle(paths,options={}){
 const file=path.join(paths.state,'harness.sqlite3');
 const info=await entry(file);
 if(!info)return;
 if(!info.isFile())throw Error('Unsafe Mosaic Beta state database');
 readMaintenanceDatabase(file,db=>assertIdle(db,options));
}

async function loaded(paths){
 if(paths.isolated)return false;
 if(process.platform==='win32')return (await registration(paths)).registered;
 try{await launchctl('print',serviceId());return true;}catch{return false;}
}

async function online(paths){
 try{await client(paths,{viewer:true,timeoutMs:800})('tools_list');return true;}catch{return false;}
}

export async function verifyLaunchAgent(paths,{allowUnrecorded=false}={}){
 if(paths.isolated)return false;
 if(process.platform==='win32')return (await registration(paths)).owned;
 const old=await fileBytes(paths.plist,{max:32768});
 const receipt=old&&!allowUnrecorded?await jsonFile(paths.ownership,{privateFile:true,max:8192}):null;
 if(old&&(old.toString()!==launchAgent(paths)||!allowUnrecorded&&receipt?.launchAgentHash!==hash(old))||!old&&await loaded(paths))throw Error('Existing LaunchAgent is foreign or has changed. Preserve it and inspect '+paths.plist);
 return !!old;
}

export async function stopForMaintenance(paths,{allowUnrecorded=false,recovering=false,beforeRegisteredStop}={}){
 const owned=await verifyLaunchAgent(paths,{allowUnrecorded});
 const registered=owned&&await loaded(paths);
 if(await online(paths)){
  if(paths.isolated||!registered)throw Error('Stop the foreground Mosaic Beta coordinator before maintenance.');
  if(beforeRegisteredStop){
   await assertMaintenanceIdle(paths);
   await beforeRegisteredStop();
  }
  await client(paths,{timeoutMs:2500})('service_stop',{idempotencyKey:randomUUID()});
  for(let i=0;i<20&&await online(paths);i++)await delay(150);
  if(await online(paths))throw Error('Mosaic Beta coordinator did not stop safely');
 }else{
  if(registered){
   if(!recovering)throw Error('The registered Mosaic Beta coordinator is unreachable. Run mosaic doctor before maintenance.');
   // Recovery must not start a service while its caller owns maintenance.
   // Only proven offline quiescence permits booting out this owned registration.
   await assertMaintenanceIdle(paths,{offline:true});
  }
  await assertMaintenanceIdle(paths,{offline:true});
  if(registered)await beforeRegisteredStop?.();
 }
 if(registered){if(process.platform==='win32')await unregisterWindowsService(paths);else await launchctl('bootout',serviceId());}
 return registered;
}

export async function startLaunchAgent(paths,{allowUnrecorded=false}={}){
 if(paths.isolated)return false;
 const owned=await verifyLaunchAgent(paths,{allowUnrecorded});
 if(process.platform==='win32'){
  if(await online(paths)){
   if(!owned||!await loaded(paths))throw Error('Stop the foreground Mosaic Beta coordinator before service registration.');
  }else await startWindowsService(paths);
 }else{
 if(!owned){
  await mkdir(path.dirname(paths.plist),{recursive:true,mode:0o700});
  await atomic(paths.plist,launchAgent(paths));
 }
 if(!await loaded(paths)){
  try{await launchctl('bootstrap',domain(),paths.plist);}catch{throw Error('Could not register Mosaic Beta in this macOS login session');}
 }else if(!await online(paths)){
  try{await launchctl('kickstart',serviceId());}catch{throw Error('Could not start the registered Mosaic Beta LaunchAgent');}
 }
 }
 for(let i=0;i<(process.platform==='win32'?100:30);i++){
  if(await online(paths))return true;
  await delay(150);
 }
 throw Error('Mosaic Beta coordinator did not become ready. Run mosaic doctor.');
}

export async function rollbackLaunchAgent(paths,{existed,registered}){
 if(paths.isolated)return;
 if(existed&&registered)return startLaunchAgent(paths);
 if(process.platform==='win32'){
  await unregisterWindowsService(paths);
  if(!existed)await rm(serviceRecord(paths),{force:true});
  return;
 }
 if(await loaded(paths))await launchctl('bootout',serviceId());
 if(!existed&&await verifyLaunchAgent(paths,{allowUnrecorded:true}))await rm(paths.plist);
 if(registered)await startLaunchAgent(paths);
}

export function configuredExecutionIdentity(settings){const policy=normalizeExecutionPolicy(settings.schema===2?{version:1,...settings.execution}:settings.executionPolicy);return canonical({executionPolicy:policy??null,...(settings.nativeCheckRuntime?{nativeCheckRuntime:settings.nativeCheckRuntime}:{}),...((policy?.backend??'codex-sandbox')==='codex-sandbox'?{codexPath:settings.codexPath??'codex'}:{})});}

export async function assertSettingsMaintenanceAllowed(paths,{kind}={}){
 if(await entry(path.join(paths.configDir,'install-transaction.json')))throw Error('An installation transaction is pending; recover it before changing settings.');
 if(kind!=='setup'&&await entry(paths.setupIntent))throw Error('Setup is pending; resume it before migrating settings.');
 if(kind!=='migration'&&await entry(path.join(paths.configDir,'migration-intent.json')))throw Error('Settings migration is pending; resume it before setup.');
}
export async function assertBetaStartupReady(paths,settings){
 if(await entry(path.join(paths.configDir,'install-transaction.json'))){const {assertInstallationStartupReady}=await import('./install.mjs');await assertInstallationStartupReady(paths);}
 const intent=await jsonFile(paths.setupIntent,{privateFile:true,max:131072});
 if(intent){
  if(hash(canonical(intent.settings))!==hash(canonical(settings)))throw Error('Setup is incomplete; resume it before coordinator startup.');
  if(intent.schema===2){const receipt=await jsonFile(path.join(paths.configDir,'portable-binding.json'),{privateFile:true}),credentials=await readCredentials(paths);if(!receipt?.complete||receipt.intentHash!==hash(canonical(intent))||receipt.settingsHash!==hash(canonical(settings))||receipt.hostReceipt!==intent.hostPreview?.receiptFile||hash(canonical(credentials))!==intent.credentialsHash)throw Error('Setup is incomplete; resume it before coordinator startup.');}
  else {const receipt=await jsonFile(paths.ownership,{privateFile:true});if(!receipt?.complete||receipt.intentHash!==hash(canonical(intent))||receipt.settingsHash!==hash(canonical(settings)))throw Error('Legacy setup is incomplete; resume it before coordinator startup.');}
 }
 await assertMigrationStartupReady(paths,settings);
 if(settings.schema===2)await validateSettingsCredentials(paths,settings);
}

export async function serveBeta(paths,settings){
 if(!settings)throw Error('Run mosaic setup before starting Mosaic Beta');
 settings=normalizeSettings(settings);
 const startupSettingsHash=hash(canonical(settings));
 const portablePolicies=settings.schema===2?configuredPolicies(settings):undefined;
 if(settings.schema===2)settings={...settings,executionPolicy:{version:1,...settings.execution}};
 assertExecutionPrerequisites(settings,{codexPath:settings.codexPath,nativeCheckRuntime:settings.nativeCheckRuntime});
 await privateDirectories(paths);
 process.umask(0o077);
 const expectedWorker=canonical(settings.schema===2?{providers:settings.providers,defaults:settings.defaults,capacityGroups:settings.capacityGroups,serviceMaxConcurrentTasks:settings.serviceMaxConcurrentTasks}:settings.worker??null),expectedExecution=configuredExecutionIdentity(settings);
 const selectedHost=value=>value.host?normalizeHostSettings(value.host).id:value.codexPath?'codex':null;
 const expectedHost=selectedHost(settings);
 const verifyCurrentWorker=()=>{
  if(existsSync(paths.disabled))throw Error('Mosaic is off. New dispatch is blocked; running ownership is retained. Run mosaic on to resume.');
  try{
   const current=readSettingsSync(paths);
   if(current?.schema===2)validateSettingsCredentialsSync(paths,current);
   if(canonical(current.schema===2?{providers:current.providers,defaults:current.defaults,capacityGroups:current.capacityGroups,serviceMaxConcurrentTasks:current.serviceMaxConcurrentTasks}:current.worker??null)===expectedWorker&&selectedHost(current)===expectedHost&&configuredExecutionIdentity(current)===expectedExecution)return;
  }catch{}
  throw Error('Configured API worker, credentials, host or execution backend settings changed or are unsafe. Restart Mosaic Beta safely and obtain a new goal approval.');
 };
 const providerRegistry=settings.schema===2&&settings.providers.length?ProviderRegistry({profiles:settings.providers,credentialResolver:async ref=>(await validateSettingsCredentials(paths,settings)).entries[ref]}):undefined;
 return serve({root:paths.state,port:0,headless:true,startupGuard:work=>withLock(paths,async()=>{const current=await readSettings(paths);if(hash(canonical(current))!==startupSettingsHash)throw Error('Settings changed before startup; retry with the current private settings.');await assertBetaStartupReady(paths,current);assertExecutionPrerequisites(settings,{codexPath:settings.codexPath,nativeCheckRuntime:settings.nativeCheckRuntime});return work();}),canStop:c=>assertIdle(c.store.db),verifyCurrentWorker,
  runtimeConfig:{beta:true,...(settings.schema===2?{providerRegistry,serviceMaxConcurrentTasks:settings.serviceMaxConcurrentTasks,configuredPolicies:portablePolicies}:{}),hostId:settings.host?.id??(settings.codexPath?'codex':undefined),hostRegistry,codexPath:settings.codexPath,nativeCheckRuntime:settings.nativeCheckRuntime,executionPolicy:settings.executionPolicy,workerProfile:settings.worker?.profile,workerApiKey:settings.worker?.apiKey}});
}
