import path from 'node:path';
import {rm} from 'node:fs/promises';
import {canonical} from '../harness/contracts.mjs';
import {assertExecutionPrerequisites} from '../harness/execution.mjs';
import {ProviderRegistry} from '../harness/providers/registry.mjs';
import {digest} from '../harness/contracts.mjs';
import {normalizeSettings,readCredentials,readSettings,configuredPolicies,validateSettingsCredentials} from './settings.mjs';
import {getHost,HOST_IDS,formatHostReadiness,formatHostRegistrationGuide} from './hosts/index.mjs';
import {detectCodingApps} from './hosts/detection.mjs';
import {validateMultiWorkerCredentials} from './multi-worker-setup.mjs';
import {collectPortableSetup,formatPortableSetupSummary} from './setup-wizard.mjs';
import {setupSection} from './terminal-setup.mjs';
import {SETUP_PROBE_MESSAGE,createProviderDiagnostic,discoverProvider,probeProvider,formatProviderDiagnostic} from './provider-diagnostics.mjs';
import {atomic,entry,hash,jsonFile,localDirectory,saveJson,shellQuote,withLock} from './files.mjs';
const fingerprint=value=>hash(canonical(value));
const yes=value=>/^y(es)?$/i.test(value);
const credentialFile=paths=>path.join(paths.configDir,'credentials.json');
const receiptFile=paths=>path.join(paths.configDir,'portable-binding.json');
const stagedCredentialsFile=paths=>path.join(paths.configDir,'setup-credentials.json');
const checkExecution=settings=>assertExecutionPrerequisites({executionPolicy:{version:1,...settings.execution}},settings);
async function hostIo(paths,{codexRegistrations,codexPath}={}){
 const cli=codexRegistrations;
 return {async read(target){if(!paths.isolated)throw Error('Real host registration is manual; no conditional host mutation is available');return cli?{registration:await cli.get(codexPath)}:await jsonFile(target)??{};},
  async compareAndSwap(next,target,{expectedHash,remove}={}){if(!paths.isolated)throw Error('Real host registration is manual; no conditional host mutation is available');const current=cli?{registration:await cli.get(codexPath)}:await jsonFile(target)??{};if(fingerprint(current)!==expectedHash)return false;if(cli){if(remove)await cli.remove(codexPath);else await cli.add(codexPath);}else {await localDirectory(paths,path.dirname(target));const info=await entry(target);if(info&&(!info.isFile()||process.platform!=='win32'&&info.uid!==process.getuid()))throw Error('Unsafe or foreign host configuration');await atomic(target,JSON.stringify(next,null,2)+'\n',{mode:info?info.mode&0o777:0o600});}return true;},
  readReceipt:file=>jsonFile(file,{privateFile:true}),writeReceipt:(value,file)=>saveJson(file,value),removeReceipt:file=>rm(file,{force:true})};
}
async function portableBindingMatches(paths,receipt,{codexRegistrations,codexPath}={}){
 if(!receipt?.complete)return false;
 if(receipt.manualHost||!paths.isolated)return true;
 const io=await hostIo(paths,receipt.hostId==='codex'?{codexRegistrations,codexPath}:{}),own=await io.readReceipt(receipt.hostReceipt);
 if(!own||own.state!=='complete')return false;
 const current=await io.read(own.target),selected=receipt.hostId==='codex'?current.registration:current.mcpServers?.['mosaic-beta'];
 return fingerprint(selected??null)===own.entryHash;
}
export async function portableSetupComplete(paths,options={}){
 if(await entry(paths.setupIntent))return false;
 return portableBindingMatches(paths,await jsonFile(receiptFile(paths),{privateFile:true}),options);
}
function portableReceipt(paths,intent){
 const manualHost=!paths.isolated||intent.manualHost;
 return {schema:1,hostId:intent.settings.host.id,...(manualHost?{manualHost:true}:{}),
  hostReceipt:intent.hostPreview.receiptFile,intentHash:fingerprint(intent),settingsHash:fingerprint(intent.settings),complete:true};
}

async function inspectPortableRepairBinding(paths,settings,options){
 const preview=getHost(settings.host.id).previewRegistration({paths,launcher:paths.launcher});
 const binding=await jsonFile(receiptFile(paths),{privateFile:true});
 const own=await jsonFile(preview.receiptFile,{privateFile:true});
 if(binding?.schema!==1||!binding.complete||binding.hostId!==settings.host.id||binding.hostReceipt!==preview.receiptFile||
    own?.schema!==1||own.hostId!==settings.host.id||own.target!==preview.target||
    (!paths.isolated&&!binding.manualHost)||Boolean(binding.manualHost)!==Boolean(own.manualHost)||
    (binding.manualHost?own.state!=='manual'||own.previewHash!==preview.previewHash:own.state!=='complete'||own.entryHash!==fingerprint(preview.ownedEntry))||
    !await portableBindingMatches(paths,binding,{...options,codexPath:settings.codexPath}))
  throw Error('The saved coding app binding needs attention. Run mosaic repair --host to review it and mosaic setup to recover the saved setup.');
 return {preview,binding,hostReceiptHash:fingerprint(own)};
}

export async function readPortableRepairBinding(paths,settings,options){
 const {preview,binding,hostReceiptHash}=await inspectPortableRepairBinding(paths,settings,options);
 if(binding.settingsHash!==fingerprint(settings))throw Error('The saved coding app binding differs from the current settings. Run mosaic setup to review configuration before repairing a worker.');
 return {preview,manualHost:binding.manualHost===true,repair:{previousBindingHash:fingerprint(binding),hostReceiptHash}};
}

async function assertRepairBinding(paths,intent,options){
 if(!intent.repair)return;
 const {preview,binding,hostReceiptHash}=await inspectPortableRepairBinding(paths,intent.settings,options);
 if(fingerprint(preview)!==fingerprint(intent.hostPreview)||hostReceiptHash!==intent.repair.hostReceiptHash||
    ![intent.repair.previousBindingHash,fingerprint(portableReceipt(paths,intent))].includes(fingerprint(binding)))
  throw Error('The saved coding app binding changed during worker repair. Newer state and recovery evidence are preserved.');
}

export async function applyPortableWorkerRepair(paths,change,options={}){
 const {settings,nextCredentials,previousSettings,previousCredentials,preview,manualHost,repair,assertCurrent}=change;
 const plan=await withLock(paths,async()=>{
  const service=await import('./service.mjs'),controls={...service,...options.lifecycle};
  const assertSnapshot=async()=>{
   await assertCurrent();
   if(await entry(paths.setupIntent))throw Error('Another setup or repair is pending.');
  };
  await assertSnapshot();
  await (options.verifyExecution??checkExecution)(settings);
  await assertSnapshot();
  const hadAgent=await controls.verifyLaunchAgent(paths);
  await assertSnapshot();
  await controls.stopForMaintenance(paths,{allowUnrecorded:!hadAgent,recovering:true});
  await service.assertMaintenanceIdle(paths,{settingsChange:true,offline:true});
  await assertSnapshot();
  const intent={schema:2,settings,hostPreview:preview,repair,hadAgent,...(manualHost?{manualHost:true}:{}),
   previousConfigHash:fingerprint(previousSettings),previousCredentialsHash:fingerprint(previousCredentials),credentialsHash:fingerprint(nextCredentials)};
  await saveJson(stagedCredentialsFile(paths),nextCredentials);
  await saveJson(paths.setupIntent,intent);
  await options.afterStep?.('intent');
  return apply(paths,intent,{...options,repairAlreadyStopped:true});
 });
 await finishPortable(paths,plan,options);
 return true;
}

export async function resumePortableSetup(paths,pending,options={}){
 const plan=await withLock(paths,async()=>{
  const service=await import('./service.mjs');
  await service.assertSettingsMaintenanceAllowed(paths,{kind:'setup'});
  if(canonical(await jsonFile(paths.setupIntent,{privateFile:true}))!==canonical(pending))throw Error('Pending setup changed');
  return await portableReady(paths,pending,options)?pending:apply(paths,pending,options);
 });
 await finishPortable(paths,plan,options);
 return plan;
}

export async function removePortableBindings(paths,output,{codexRegistrations:explicitRegistrations,codexPath}={}){let found=false;for(const id of HOST_IDS){const file=path.join(paths.configDir,`host-${id}-binding.json`),receipt=await jsonFile(file,{privateFile:true});if(!receipt)continue;found=true;if(receipt.manualHost||!paths.isolated){output.write('Manual '+id+' configuration was preserved. Remove only the reviewed mosaic-beta entry from '+receipt.target+' if desired; preserve other host settings.\n');continue;}const codexRegistrations=id==='codex'?explicitRegistrations:null;if(id==='codex'&&!codexRegistrations){output.write('Preserved Codex binding for its explicit CLI ownership cleanup.\n');continue;}const io=await hostIo(paths,{codexRegistrations,codexPath}),result=await getHost(id).removeRegistration({io,receiptFile:file});if(!result.removed)output.write('Preserved modified '+id+' Mosaic MCP registration.\n');}if(found){const receipt=await jsonFile(receiptFile(paths),{privateFile:true});if(receipt)await saveJson(receiptFile(paths),{...receipt,complete:false});}return found;}
async function apply(paths,intent,{afterStep=async()=>{},codexRegistrations,verifyExecution,lifecycle,repairAlreadyStopped=false}={}){
 const service=await import('./service.mjs'),{assertMaintenanceIdle}=service,controls={...service,...lifecycle};
 await service.assertSettingsMaintenanceAllowed(paths,{kind:'setup'});
 const manualHost=!paths.isolated||intent.manualHost;
 const settings=normalizeSettings(intent.settings),old=await readSettings(paths),credentials=await readCredentials(paths);if(![intent.previousConfigHash,fingerprint(settings)].includes(fingerprint(old)))throw Error('Setup settings changed; newer configuration is preserved');if(![intent.previousCredentialsHash,intent.credentialsHash].includes(fingerprint(credentials)))throw Error('Setup credentials changed; newer credentials are preserved');
 const staged=await jsonFile(stagedCredentialsFile(paths),{privateFile:true});if(staged&&fingerprint(staged)!==intent.credentialsHash)throw Error('Pending credential identity changed');await validateSettingsCredentials(paths,settings,staged??credentials);
 let currentSettingsHash=fingerprint(old),currentCredentialsHash=fingerprint(credentials);
 const assertApplySnapshot=async()=>{
  if(fingerprint(await readSettings(paths))!==currentSettingsHash||fingerprint(await readCredentials(paths))!==currentCredentialsHash)throw Error('Setup settings or credentials changed during apply; newer state and the pending intent are preserved. Inspect the retained setup before resuming.');
  if(fingerprint(await jsonFile(paths.setupIntent,{privateFile:true}))!==fingerprint(intent))throw Error('Pending setup changed during apply; newer intent is preserved.');
  if(fingerprint(await jsonFile(stagedCredentialsFile(paths),{privateFile:true}))!==fingerprint(staged))throw Error('Pending credentials changed during apply; newer credentials are preserved.');
  await assertRepairBinding(paths,intent,{codexRegistrations});
 };
 const settingsChange=Boolean(intent.repair)||fingerprint(old)!==fingerprint(settings);
 if(!repairAlreadyStopped){
  await assertMaintenanceIdle(paths,{settingsChange});
  await (verifyExecution??checkExecution)(settings);
  await assertApplySnapshot();
  await controls.stopForMaintenance(paths,{allowUnrecorded:!intent.hadAgent,recovering:true});
 }
 await assertMaintenanceIdle(paths,{settingsChange,offline:Boolean(intent.repair)});
 await assertApplySnapshot();
 // Credentials were staged privately before the approval intent. Neither intent
 // nor host receipt ever contains bearer values.
 if(fingerprint(credentials)!==intent.credentialsHash){if(!staged)throw Error('Pending credentials unavailable');await saveJson(credentialFile(paths),staged);currentCredentialsHash=intent.credentialsHash;}await afterStep('credentials');await assertApplySnapshot();
 if(fingerprint(old)!==fingerprint(settings)){await saveJson(paths.config,settings);currentSettingsHash=fingerprint(settings);}await afterStep('settings');await assertApplySnapshot();
 if(!intent.repair){
  const io=await hostIo(paths,{...(settings.host.id==='codex'?{codexRegistrations,codexPath:settings.codexPath}:{})});
  if(manualHost)await saveJson(intent.hostPreview.receiptFile,{schema:1,hostId:settings.host.id,target:intent.hostPreview.target,manualHost:true,state:'manual',previewHash:intent.hostPreview.previewHash});
  else if(intent.reuseHostReceipt){const receipt=await io.readReceipt(intent.hostPreview.receiptFile),current=await io.read(intent.hostPreview.target),selected=settings.host.id==='codex'?current.registration:current.mcpServers?.['mosaic-beta'];if(!receipt||receipt.state!=='complete'||fingerprint(selected??null)!==receipt.entryHash)throw Error('Owned host binding changed during setup');}
  else await getHost(settings.host.id).applyRegistration(intent.hostPreview,{io});
 }
 await afterStep('binding');
 await assertApplySnapshot();await saveJson(receiptFile(paths),portableReceipt(paths,intent));await afterStep('complete');await assertApplySnapshot();return intent;
}
async function assertReadySnapshot(paths,intent){
 if(fingerprint(await readSettings(paths))!==fingerprint(intent.settings)||fingerprint(await readCredentials(paths))!==intent.credentialsHash)throw Error('Setup settings or credentials changed during readiness; newer state and the pending intent are preserved. Inspect the retained setup before resuming.');
 if(fingerprint(await jsonFile(paths.setupIntent,{privateFile:true}))!==fingerprint(intent))throw Error('Pending setup changed during readiness; newer intent is preserved.');
 const staged=await jsonFile(stagedCredentialsFile(paths),{privateFile:true});
 if(staged&&fingerprint(staged)!==intent.credentialsHash)throw Error('Pending credentials changed during readiness; newer credentials are preserved.');
}
async function portableReady(paths,intent,options={}){
 const service=await import('./service.mjs');if(canonical(await readSettings(paths))!==canonical(intent.settings))return false;
 await assertRepairBinding(paths,intent,options);
 try{await service.assertBetaStartupReady(paths,intent.settings);if(!await portableBindingMatches(paths,await jsonFile(receiptFile(paths),{privateFile:true}),{...options,codexPath:intent.settings.codexPath}))throw Error('Owned host binding changed during interrupted setup; preserve it and inspect the selected host entry before resuming.');await assertReadySnapshot(paths,intent);return true;}catch(error){if(/incomplete/.test(error.message))return false;throw error;}
}
async function finishPortable(paths,intent,{lifecycle,codexRegistrations}={}){
 const service=await import('./service.mjs'),controls={...service,...lifecycle};
 if(intent.hadAgent||!paths.isolated&&!intent.repair)await controls.startLaunchAgent(paths,{allowUnrecorded:!intent.hadAgent});
 return withLock(paths,async()=>{await service.assertSettingsMaintenanceAllowed(paths,{kind:'setup'});if(canonical(await jsonFile(paths.setupIntent,{privateFile:true}))!==canonical(intent))throw Error('Setup intent changed during owned restart; preserve newer state.');if(!await portableReady(paths,intent,{codexRegistrations}))throw Error('Setup snapshot changed during owned restart; preserve newer settings.');if(!paths.isolated&&!intent.repair){const previous=await jsonFile(paths.ownership,{privateFile:true});await saveJson(paths.ownership,{...previous,schema:1,launchAgentHash:hash(service.launchAgent(paths)),complete:true});}await assertReadySnapshot(paths,intent);await rm(paths.setupIntent,{force:true});await rm(stagedCredentialsFile(paths),{force:true});return true;});
}
export async function setupPortable(paths,{ask,choose,output,settings:provided,execution,nativeCheckRuntime,afterStep,verifyExecution,codexRegistrations,lifecycle,signal,retryEndpoint=false}={}){
 const assertNotInterrupted=()=>{if(signal?.aborted)throw Error('Setup interrupted. Run mosaic setup to resume.');};
 assertNotInterrupted();
 const pending=await jsonFile(paths.setupIntent,{privateFile:true});if(pending?.schema===2){const plan=await resumePortableSetup(paths,pending,{afterStep,verifyExecution,codexRegistrations,lifecycle});output.write((plan.repair?'Resumed the approved worker repair.\n':'Resumed interrupted setup.\n')+formatHostReadiness(plan.settings.host.id,{configuration:'saved',instructions:!paths.isolated||plan.manualHost?'saved locally for manual registration':'generated and saved for the disposable fixture',registration:!paths.isolated||plan.manualHost?'unverified':'fixture'}));return true;}if(pending)throw Error('Legacy setup is pending; resume it before portable setup');
 const old=await readSettings(paths);if(old?.schema===1)throw Error('Legacy schema1 settings are readable. Run mosaic migrate to preview and explicitly apply a lossless migration first.');
 // Snapshot private credentials before the first awaited configuration prompt.
 // A concurrent rotation is a conflict, never a new baseline to overwrite.
 const credentials=await readCredentials(paths);
 const assertCurrentSetup=async()=>{
  assertNotInterrupted();
  const service=await import('./service.mjs');
  await service.assertSettingsMaintenanceAllowed(paths,{kind:'setup'});
  if(fingerprint(await readSettings(paths))!==fingerprint(old)||fingerprint(await readCredentials(paths))!==fingerprint(credentials))throw Error('Settings or credentials changed while preview was open. Newer state is preserved; run mosaic setup again.');
  assertNotInterrupted();
 };
 const guardedAsk=async(...args)=>{await assertCurrentSetup();const answer=await ask(...args);await assertCurrentSetup();return answer;};
 const guardedChoose=choose?async(...args)=>{
  await assertCurrentSetup();
  const value=await choose(...args);
  await assertCurrentSetup();
  return value;
 }:undefined;
 const detectedHosts=provided?undefined:await detectCodingApps(paths);
 let previousSelection;
 for(;;){
  await assertCurrentSetup();
  const configured=provided?{settings:normalizeSettings(provided),rawSettings:provided,entries:{}}:await collectPortableSetup(guardedAsk,output,{execution:execution??old?.execution,nativeCheckRuntime:nativeCheckRuntime??old?.nativeCheckRuntime,existingSettings:old,existingCredentialRefs:Object.keys(credentials.entries),choose:guardedChoose,previousSelection,detectedHosts,retryEndpoint});
  await assertCurrentSetup();
  const compact=Boolean(guardedChoose&&configured.presentation==='simple');
  const confirm=async (prompt,title,affirmative,negative)=>yes(compact
   ?await guardedChoose(title,[{value:'n',label:negative},{value:'y',label:affirmative}],{stage:3})
   :await guardedAsk(prompt));
  const settings=configured.settings,nextCredentials={schema:1,entries:{...credentials.entries,...configured.entries}};
  // Validate secret-free public identity before publishing any preview or error.
  // URL canonicalization can erase JSON backslashes before retained keys are known.
  // Every setup path checks both entered and normalized identities, transiently.
  const enteredSettings=configured.rawSettings??settings;
  await validateMultiWorkerCredentials(enteredSettings,credentials,{allowMissing:true});
  await validateMultiWorkerCredentials(settings,credentials,{allowMissing:true});
  await validateMultiWorkerCredentials(enteredSettings,nextCredentials);
  if(enteredSettings!==settings)await validateMultiWorkerCredentials(settings,nextCredentials);
  const withCurrentSetup=action=>withLock(paths,async()=>{
   await assertCurrentSetup();
   const result=await action();
   await assertCurrentSetup();
   return result;
  });
  await (verifyExecution??(s=>assertExecutionPrerequisites({executionPolicy:{version:1,...s.execution}},s)))(settings);
  const adapter=getHost(settings.host.id),manualHost=!paths.isolated,io=await hostIo(paths,{...(settings.host.id==='codex'?{codexRegistrations,codexPath:settings.codexPath}:{})}),existing=manualHost?{}:await io.read(adapter.previewRegistration({paths,launcher:paths.launcher}).target);
  let hostPreview;const existingReceipt=await io.readReceipt(path.join(paths.configDir,`host-${settings.host.id}-binding.json`));if(existingReceipt&&!manualHost){const selected=settings.host.id==='codex'?existing.registration:existing.mcpServers?.['mosaic-beta'];if(fingerprint(selected??null)!==existingReceipt.entryHash)throw Error('Owned host entry was customized; preserve it before setup');const clean=structuredClone(existing);if(settings.host.id==='codex')clean.registration=null;else {delete clean.mcpServers['mosaic-beta'];if(!existingReceipt.hadMcpServers&&!Object.keys(clean.mcpServers).length)delete clean.mcpServers;}hostPreview=adapter.previewRegistration({paths,launcher:paths.launcher,existing:clean});hostPreview.resumeOwned=true;delete hostPreview.resumeOwned;}else hostPreview=adapter.previewRegistration({paths,launcher:paths.launcher,existing});
  await withCurrentSetup(()=>output.write('\n'+formatPortableSetupSummary(settings,{manualHost,compact})+'\n'));
  const showPreview=showDetails=>withCurrentSetup(()=>{
   if(showDetails)output.write('Exact private setup preview (provider references only)\n'+JSON.stringify(settings,null,2)+'\n');
   if(manualHost)output.write('Host: '+adapter.displayName+' · manual configuration required. Until you connect the app, host discovery remains unverified.\n'+formatHostRegistrationGuide(hostPreview));
   else output.write('Host target: '+hostPreview.target+'\nReviewed entry: '+JSON.stringify(hostPreview.entry)+'\nHost: '+adapter.displayName+' · fixture-tested registration; actual host compatibility unprobed.\n');
   output.write('No fallback. Existing server only; no model installation.\n');
  });
  const workers=settings.providers.filter(profile=>profile.roles.includes('worker'));
  const save={value:'y',label:'Save setup'},exit={value:'n',label:'Exit without saving'};
  const finishChoice=async({offerChecks})=>{
   const options=[save,
    ...(offerChecks?[{value:'t',label:'Run optional connection checks'}]:[]),
    {value:'d',label:'Show technical details'},exit];
   let choice;
   do{
    choice=await guardedChoose('Finish setup',options,{value:'n',back:true,stage:3});
    if(choice==='d')await showPreview(true);
   }while(choice==='d');
   return choice;
  };
  let decision;
  if(compact){
   if(workers.length)output.write('Connection checks are optional. Saving sends no provider requests.\n\n');
   decision=await finishChoice({offerChecks:workers.length>0});
  }else{
   const showDetails=!['simple','guided'].includes(configured.presentation)||yes(await guardedAsk('Show technical settings details? [y/N] '));
   await showPreview(showDetails);
  }
  const showDiagnostics=!compact||decision==='t';
  if(showDiagnostics){
   const secrets=Object.values(nextCredentials.entries),reports=new Map(workers.map(profile=>[profile.id,createProviderDiagnostic(profile,{secrets})]));
   const registry=workers.length?ProviderRegistry({profiles:settings.providers,credentialResolver:async ref=>{await assertCurrentSetup();return nextCredentials.entries[ref];}}):null;
   const clientFor=profile=>registry.createClient({version:1,providerId:profile.id,revision:profile.revision,profileHash:digest(registry.get(profile.id,profile.revision)),policyHash:digest(configuredPolicies(settings).providerPolicy)});
   const publishReport=profile=>withCurrentSetup(()=>output.write(formatProviderDiagnostic(reports.get(profile.id),{secrets})));
   if(compact)await withCurrentSetup(()=>output.write('Model discovery requests the list using the configured key, if any.\n'+workers.map(profile=>'GET '+profile.baseUrl+'/models').join('\n')+'\n'));
   else await withCurrentSetup(()=>output.write('Optional model discovery sends GET to each configured worker URL below, with configured authentication sent to that supplied endpoint. It sends no project files, task evidence, reviewer request or inference. One request per worker, at most 10 seconds each; no retries or fallback.\n'+workers.map(profile=>'GET '+profile.baseUrl+'/models').join('\n')+(workers.length?'\n':'No worker configured: zero provider requests.\n')));
   const guided=configured.presentation==='guided';
   const runDiscovery=guided?null:await confirm('Run optional model discovery check? [y/N] ','Check the worker model list?','Request model list','Skip model discovery');
   for(const [i,profile] of workers.entries()){
    const selected=guided?yes(await guardedAsk(`Worker ${i+1}: run optional model discovery check? [y/N] `)):runDiscovery;
    await withCurrentSetup(async()=>{
     if(selected){const report=await discoverProvider(clientFor(profile),profile,{previous:reports.get(profile.id),secrets,beforeRequest:assertCurrentSetup,signal});await assertCurrentSetup();reports.set(profile.id,report);}
    });
    if(selected)await publishReport(profile);
   }
   if(compact)await withCurrentSetup(()=>output.write('Optional inference sends the configured key and a setup-only message.\nIt may use credit. Limit: 16 output tokens and 10 seconds.\nMessage: '+SETUP_PROBE_MESSAGE+'\n'+workers.map(profile=>'POST '+profile.baseUrl+'/chat/completions'+(profile.capabilities.modelDiscovery==='advertised'?' (model list checked first)':'')).join('\n')+'\n'));
   else await withCurrentSetup(()=>output.write('Optional inference sends the exact fixed setup message below (setup-only) to each supplied worker endpoint, with configured authentication. It may incur provider cost. No project files, task evidence or reviewer request are sent. Maximum output: 16 tokens; one total 10-second deadline per worker, including any required fresh membership GET. No retries or fallback.\nMessage: '+SETUP_PROBE_MESSAGE+'\n'+workers.map(profile=>'POST '+profile.baseUrl+'/chat/completions'+(profile.capabilities.modelDiscovery==='advertised'?'\nRequired fresh membership GET '+profile.baseUrl+'/models before POST (included in the same total deadline).':'')).join('\n')+(workers.length?'\n':'No worker configured: zero provider requests.\n')));
   const runProbe=guided?null:await confirm('Run optional inference connectivity test with that fixed setup-only message? [y/N] ','Test the worker connection?','Send one test prompt','Skip inference test');
   let anyProbe=false;
   for(const [i,profile] of workers.entries()){
    const selected=guided?yes(await guardedAsk(`Worker ${i+1}: run optional inference connectivity test with that fixed setup-only message? [y/N] `)):runProbe;
    await withCurrentSetup(async()=>{
     if(selected){
      anyProbe=true;
      const report=await probeProvider(clientFor(profile),profile,{previous:reports.get(profile.id),secrets,beforeRequest:assertCurrentSetup,signal});
      // Revalidate before every publication, including failed diagnostic evidence.
      await assertCurrentSetup();reports.set(profile.id,report);output.write(formatProviderDiagnostic(report,{secrets}));
      if(report.failed)throw Error('Setup connectivity probe failed; saved settings remain unchanged');
     }
    });
    if(!selected)await publishReport(profile);
   }
   if(!anyProbe)await withCurrentSetup(()=>output.write('Connectivity/inference: untested; zero setup POSTs.\n'));
   await withCurrentSetup(()=>{
    for(const profile of settings.providers)if(!profile.roles.includes('worker'))output.write('API reviewer '+profile.id+': configured; inference untested (review requires bound task evidence).\n');
    if(!workers.length)output.write('No worker diagnostics: discovery/inference untested; zero provider requests.\n');
   });
  }
  if(compact){
   if(decision==='t')decision=await finishChoice({offerChecks:false});
   if(decision===null){previousSelection={hostId:settings.host.id,workerChoice:configured.workerChoice};continue;}
   if(decision!=='y')return false;
  }else if(!yes(await guardedAsk(manualHost?'Save this local setup and reviewed manual host instructions? [y/N] ':'Apply this exact setup and managed host binding? [y/N] ')))return false;
  const plan=await withLock(paths,async()=>{await assertCurrentSetup();const service=await import('./service.mjs'),controls={...service,...lifecycle};await service.assertSettingsMaintenanceAllowed(paths,{kind:'setup'});await service.assertMaintenanceIdle(paths,{settingsChange:fingerprint(old)!==fingerprint(settings)});if(fingerprint(await readSettings(paths))!==fingerprint(old)||fingerprint(await readCredentials(paths))!==fingerprint(credentials))throw Error('Settings or credentials changed while preview was open');if(await entry(paths.setupIntent))throw Error('Another setup is pending');const hadAgent=await controls.verifyLaunchAgent(paths);await controls.stopForMaintenance(paths,{allowUnrecorded:!hadAgent,recovering:true});await service.assertMaintenanceIdle(paths,{settingsChange:fingerprint(old)!==fingerprint(settings),offline:true});assertNotInterrupted();const intent={schema:2,settings,hostPreview,...(manualHost?{manualHost:true}:existingReceipt?{reuseHostReceipt:true}:{}),hadAgent,previousConfigHash:fingerprint(old),previousCredentialsHash:fingerprint(credentials),credentialsHash:fingerprint(nextCredentials)};await saveJson(path.join(paths.configDir,'setup-credentials.json'),nextCredentials);await saveJson(paths.setupIntent,intent);await afterStep?.('intent');return apply(paths,intent,{afterStep,verifyExecution,codexRegistrations,lifecycle});});await finishPortable(paths,plan,{lifecycle,codexRegistrations});
  if(compact){
   output.write('\n'+setupSection('Setup saved.'));
   if(workers.length&&!showDiagnostics)output.write('  Provider connection untested.\n');
   output.write('  Coding app connection still needs verification.\n\n');
   const nextCommand=manualHost?'connect':'serve';
   output.write(setupSection(manualHost?'Connect '+adapter.displayName:'Start the trial coordinator')+shellQuote(paths.launcher)+' '+nextCommand+'\n');
  }else{
   output.write((manualHost?'Local setup saved. ':'Setup saved. ')+ 'Review delivery is pull; closed hosts wait durably.\n'+formatHostReadiness(settings.host.id,{configuration:'saved',instructions:manualHost?'saved locally for manual registration':'generated and saved for the disposable fixture',registration:manualHost?'unverified':'fixture'}));
  }
  return true;
 }
}
