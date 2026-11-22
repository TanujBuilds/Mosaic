import {rm} from 'node:fs/promises';
import {createInterface} from 'node:readline/promises';
import {isEntry} from '../harness/entry.mjs';
import path from 'node:path';

const help=`Mosaic Beta

mosaic                   Open setup or the read-only terminal observer
mosaic setup             Configure the selected host, worker profiles and review
mosaic first-task [REPO] Prepare a guided first assignment or try --demo
mosaic act               Open Needs You and review saved decisions
mosaic repair            Diagnose a connection, or repair with --worker ID
mosaic queue [GOAL_ID]   Inspect an approved workload and its dependencies
mosaic morning-report [GOAL_ID]  Inspect saved results and recorded usage
mosaic preset            Show, save or clear project suggestions
mosaic doctor [--providers]  Check setup; optionally GET worker model lists (no inference)
mosaic migrate           Preview lossless schema1 migration; ask before applying
mosaic off               Stop new dispatch; retain running owners and saved work
mosaic on                Allow dispatch with the same approved configuration
mosaic rollback VERSION  Switch to a compatible retained version
mosaic recover           Resume an interrupted installation
mosaic status --once     Print saved status and recent handoffs once
mosaic support-bundle --home ABS [--output ABS]  Preview or save redacted diagnostics
mosaic --source core     Watch the existing frontier-harness installation
mosaic --source beta     Watch only the separate beta installation
mosaic connect [--host ID]  Show how to connect your coding app
mosaic host-preview --host ID  Preview a manual host registration; writes nothing
mosaic mcp               Start the authenticated host MCP stdio bridge
mosaic serve             Run the coordinator in the foreground (fixture or troubleshooting)
mosaic uninstall         Remove owned beta bindings and retain evidence
mosaic --help            Show these commands
`;

export async function main(args=process.argv.slice(2)){
 let home;
 if(args[0]==='--home'){args.shift();home=args.shift();if(!home)throw Error('Provide an absolute fixture home');}
 if(args.includes('--help')||args[0]==='help'){process.stdout.write(help);return;}
 if(args[0]==='support-bundle'){
  args.shift();
  if(home!==undefined){
   const index=args.indexOf('--home');
   // An isolated managed launcher already supplies its explicit home.
   if(index!==-1&&args[index+1]===home&&args.indexOf('--home',index+1)===-1)args.splice(index,2);
   args.unshift('--home',home);
  }
  process.exitCode=await (await import('./support-bundle.mjs')).runSupportBundle(args);
  return;
 }
 let source='auto';
 const sourceIndex=args.indexOf('--source');
 if(sourceIndex!==-1){
  source=args[sourceIndex+1];
  if(!['auto','beta','core'].includes(source))throw Error('Observer source must be auto, beta or core');
  args.splice(sourceIndex,2);
 }
 const {currentHome,locations,jsonFile,saveJson,withLock}=await import('./files.mjs');
 const paths=locations(home??currentHome(),!!home),command=args.shift();
 const runOwnerCommand=async(name,args,options={})=>{
  const commandArgs=[paths,args,options];
  if(name==='act')return (await import('./owner-actions.mjs')).runOwnerAction(...commandArgs);
  if(name==='repair'){
   if(!await (await import('./connection-repair.mjs')).runConnectionRepair(...commandArgs))process.exitCode=1;
   return;
  }
  const result=name==='first-task'
   ?await (await import('./first-task.mjs')).runFirstTask(paths,args,{
    readPreset:async repo=>(await import('./project-presets.mjs')).readProjectPreset(paths,repo)
   })
   :name==='preset'
    ?await (await import('./project-presets.mjs')).runProjectPreset(...commandArgs)
    :await (await import('./queue.mjs'))[name==='queue'?'runQueue':'runMorningReport'](...commandArgs);
  if(typeof result==='number'&&result!==0)process.exitCode=result;
 };

 if(sourceIndex!==-1&&command&&command!=='status')throw Error('--source is only supported by the terminal observer and status');
 if(['act','repair','first-task','preset','queue','morning-report'].includes(command))return runOwnerCommand(command,args);
 if(command==='host-preview'){
  if(args.length!==2||args[0]!=='--host')throw Error('Use mosaic host-preview --host codex|claude-code|cursor|antigravity');
  const {previewHostRegistration}=await import('./setup.mjs');
  process.stdout.write(JSON.stringify(previewHostRegistration(paths,args[1]),null,2)+'\n');return;
 }
 if(command==='connect'){
  if(args.length&&(args.length!==2||args[0]!=='--host'))throw Error('Use mosaic connect [--host codex|claude-code|cursor|antigravity]');
  const [{readSettings,previewHostRegistration,starter},{formatHostRegistrationGuide,formatHostReadiness},{readHostConnection}]=await Promise.all([
   import('./setup.mjs'),import('./hosts/index.mjs'),import('./hosts/connection-evidence.mjs')
  ]);
  const settings=args.length?null:await readSettings(paths);
  if(!args.length&&!settings)throw Error('Run mosaic setup to select a coding app, or use mosaic connect --host ID to see its instructions.');
  const hostId=args[1]??settings?.host?.id??'codex';
  const preview=previewHostRegistration(paths,hostId);
  const connection=settings?await readHostConnection(paths).catch(()=>null):null;
  process.stdout.write(formatHostRegistrationGuide(preview)+'\n'+formatHostReadiness(hostId,{
   configuration:settings?'saved':'selected for this guide',
   instructions:'shown above',
   connection,
   nextAction:'Follow the registration steps in the selected app and check discovery and the registry_list tool result there.'
  })+'\nStart a task in your coding app with:\n'+starter+'\n');
  return;
 }
 if(command==='setup'||!command&&sourceIndex===-1){
  let explicitCodex,settings;
  if(args.length===2&&args[0]==='--config'){
   args.shift();
   const file=args.shift();
   if(!path.isAbsolute(file))throw Error('Setup config must be an absolute private JSON path');
   const {normalizeSettings}=await import('./settings.mjs');
   settings=await jsonFile(file,{privateFile:true});
   if(normalizeSettings(settings).schema!==2)throw Error('Use migrate for schema1 settings');
  }
  if(args.length===2&&args[0]==='--codex'){args.shift();explicitCodex=args.shift();}
  if(args.length)throw Error('Use mosaic setup [--codex /absolute/path/to/codex]');
  const {readSettings,setup,setupComplete}=await import('./setup.mjs');
  if(command==='setup'||!await readSettings(paths)||!await setupComplete(paths)){
   if(!await setup(paths,{explicitCodex,settings}))process.exitCode=1;
   else process.stdout.write('\nPrepare your first task with mosaic first-task, or try mosaic first-task --demo.\n');
   return;
  }
 }
 if(command==='status'||!command){
  if(args.length&&!(args.length===1&&args[0]==='--once'))throw Error('Use mosaic status [--once]');
  const [{runObserver},{observerClient}]=await Promise.all([import('./observer.mjs'),import('./sources.mjs')]);
  const state=await runObserver({invoke:observerClient(paths,{source}),once:args.includes('--once')});
  if(state.handoff) {
   const {command,args,expectedBinding}=state.handoff;
   return runOwnerCommand(command,args,{expectedBinding,...(command==='repair'?{openMenu:true}:{})});
  }
  return state;
 }
 if(command==='rollback'){if(args.length!==1)throw Error('Use mosaic rollback VERSION');return (await import('./install.mjs')).rollbackVersion(paths,args[0]);}
 let providerDiagnostics=false;
 if(command==='doctor'){if(args.length>1||args.length===1&&args[0]!=='--providers')throw Error('Use mosaic doctor [--providers]');providerDiagnostics=args.shift()==='--providers';}
 if(args.length)throw Error('Use mosaic --help for command syntax');
 if(command==='recover')return (await import('./install.mjs')).recoverInstallation(paths);
 if(command==='off'||command==='on'){return withLock(paths,async()=>{if(command==='off'){await saveJson(paths.disabled,{schema:1,disabled:true});process.stdout.write('Mosaic is off. New dispatch is blocked; running owners and saved work are retained.\n');}else{await rm(paths.disabled,{force:true});process.stdout.write('Mosaic is on. Existing approval and execution guards still apply.\n');}});}
 if(command==='migrate'){const {previewSettingsMigration,applySettingsMigration,resumeSettingsMigration}=await import('./settings.mjs');if(await resumeSettingsMigration(paths)){process.stdout.write('Resumed approved settings migration.\n');return;}const preview=await previewSettingsMigration(paths);process.stdout.write(JSON.stringify(preview,null,2)+'\n');const rl=createInterface({input:process.stdin,output:process.stdout});let approved;try{approved=await rl.question('Apply this exact lossless migration? [y/N] ');}finally{rl.close();}if(/^y(es)?$/i.test(approved.trim())){await applySettingsMigration(paths,preview);process.stdout.write('Migration saved; refresh setup to configure portable bindings.\n');}return;}
 if(command==='doctor'){
  const [{installedLauncher,verifyVersion},{doctor}]=await Promise.all([import('./install.mjs'),import('./setup.mjs')]);
  let valid=false;
  try{
   const {receipt,bytes}=await installedLauncher(paths);
   if(bytes){const manifest=await verifyVersion(path.join(paths.versions,receipt.version),receipt.version);valid=manifest.contentHash===receipt.contentHash;}
  }catch{}
  process.stdout.write(valid?'OK  Package integrity · installed version verified.\n':'CHECK  Package integrity · reinstall Mosaic Beta from a verified archive.\n');
  if(!await doctor(paths,process.stdout,{providers:providerDiagnostics})||!valid)process.exitCode=1;
  return;
 }
 if(command==='serve'){
  const [{serveBeta},{readSettings}]=await Promise.all([import('./service.mjs'),import('./settings.mjs')]);
  return serveBeta(paths,await readSettings(paths));
 }
 if(command==='mcp'){
  const [{startMcp},{client},{readSettings},{hostConnectionIdentity,recordHostConnection}]=await Promise.all([
   import('../harness/mcp.mjs'),import('./client.mjs'),import('./settings.mjs'),import('./hosts/connection-evidence.mjs')
  ]);
  const invoke=client(paths),identity=hostConnectionIdentity(await readSettings(paths));
  const tools=(await invoke('tools_list')).filter(tool=>tool.name!=='service_stop');
  return startMcp({name:'mosaic-beta',tools,invoke:async(name,input)=>{
   const result=await invoke(name,input);
   if(name==='registry_list')await recordHostConnection(paths,identity).catch(()=>{});
   return result;
  }});
 }
 if(command==='uninstall')return (await import('./install.mjs')).uninstall(paths);
 throw Error('Unknown Mosaic Beta command. Run mosaic --help.');
}

if(isEntry(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
