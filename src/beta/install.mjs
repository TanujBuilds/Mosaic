import {cp,rename,rm} from 'node:fs/promises';
import {createInterface} from 'node:readline/promises';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {isEntry} from '../harness/entry.mjs';
import {verifyPackage} from '../harness/package.mjs';
import {canonical} from '../harness/contracts.mjs';
import {readBundledNativeCheckRuntime} from './package-contract.mjs';
import {nativeImplementationSources,validateNativeCheckRuntime} from '../project/check-backends/native-runtime-dispatch.mjs';
import {atomic,currentHome,entry,fileBytes,hash,jsonFile,localDirectory,locations,readMaintenanceDatabase,saveJson,shellQuote,withLock} from './files.mjs';
import {readSetupIntent,removeCodexBindings} from './setup.mjs';
import {assertMaintenanceIdle,rollbackLaunchAgent,startLaunchAgent,stopForMaintenance,verifyLaunchAgent} from './service.mjs';

const versionPattern=/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/;
const header='# BEGIN MOSAIC BETA PATH v1';
const footer='# END MOSAIC BETA PATH v1';
const block=`${header}\nexport PATH="$HOME/.local/bin:$PATH"\n${footer}\n`;

function writeInstallReceipt(output,paths,version){
 const command=`${shellQuote(paths.launcher)} setup`;
 const width=Math.min((output.columns??0)-1,50),status=`│  Installed  ${version}`;
 if(!output.isTTY||width<43||status.length>width||process.env.TERM==='dumb'||Object.hasOwn(process.env,'NO_COLOR')){
  output.write(`Mosaic Beta ${version} installed.\nRun ${command}\n`);
  return;
 }
 const blue='\x1b[1;94m',bold='\x1b[1m',reset='\x1b[0m',title='╭─ Mosaic Beta ';
 output.write([
  '',blue+title+'─'.repeat(width-title.length)+reset,
  `${blue}│${reset}  ${bold}Installed${reset}  ${version}`,
  blue+'╰'+'─'.repeat(width-1)+reset,
  '',`  ${bold}Install location${reset}`,`  ${paths.root}`,
  '',`  ${bold}Run setup${reset}`,`  ${command}`,'',
 ].join('\n'));
}

function launcherFor(paths,version,legacy=false){
 const installed=path.join(paths.versions,version,'runtime');
 const searchPath=shellQuote(path.join(installed,'bin'))+':'+shellQuote(path.dirname(paths.launcher))+(legacy?':/opt/homebrew/bin:/usr/local/bin':'');
 return '#!/bin/sh\n# Mosaic Beta managed launcher v1\nPATH='+searchPath+':"$PATH"\nexport PATH\nexec '+shellQuote(path.join(installed,'bin','node'))+' '+
  shellQuote(path.join(installed,'src','beta','cli.mjs'))+(paths.isolated?' --home '+shellQuote(paths.home):'')+' "$@"\n';
}

export async function installedLauncher(paths){
 await localDirectory(paths,path.dirname(paths.launcher),{create:false});
 const receipt=await jsonFile(paths.installation,{privateFile:true,max:8192});
 const bytes=await fileBytes(paths.launcher,{max:16384}).catch(()=>{throw Error('Existing launcher is foreign. Preserve '+paths.launcher);});
 if(bytes&&(!receipt||!versionPattern.test(receipt.version)||hash(bytes)!==receipt.launcherHash||![launcherFor(paths,receipt.version),launcherFor(paths,receipt.version,true)].includes(bytes.toString())))
  throw Error('Existing launcher is foreign or changed. Preserve '+paths.launcher);
 return {receipt,bytes};
}

async function applyPath(paths,receipt){
 if((process.env.PATH??'').split(path.delimiter).includes(path.dirname(paths.launcher)))return receipt;
 const output=process.stdout;
 output.write(`Add this block to ${paths.zshrc} to find mosaic\n\n${block}\n`);
 if(!process.stdin.isTTY||!output.isTTY){output.write(`Run ${shellQuote(paths.launcher)} until ~/.local/bin is on PATH.\n`);return receipt;}
 const rl=createInterface({input:process.stdin,output});
 let confirm;
 try{confirm=await rl.question('Append the PATH block? [y/N] ');}finally{rl.close();}
 if(!/^y(es)?$/i.test(confirm.trim()))return receipt;
 const info=await entry(paths.zshrc);
 const old=(await fileBytes(paths.zshrc)??Buffer.alloc(0)).toString();
 if(old.includes(header)||old.includes(footer)){
  if(receipt.pathBlock&&old.includes(receipt.pathBlock))return receipt;
  throw Error('An existing Mosaic Beta PATH block has changed. Preserve '+paths.zshrc);
 }
 const added=(old&&!old.endsWith('\n')?'\n':'')+block;
 await atomic(paths.zshrc,old+added,{mode:info?info.mode&0o777:0o600});
 return {...receipt,pathBlock:added,pathFileCreated:!info};
}

export async function verifyVersion(directory,version){
 await verifyPackage(directory);
 const manifest=await jsonFile(path.join(directory,'package-manifest.json'));
 if(!['terminal-beta-v1','terminal-beta-v2'].includes(manifest.layout)||manifest.version!==version||!manifest.dependenciesInstalled)
  throw Error('Invalid Mosaic Beta version manifest');
 if(manifest.layout==='terminal-beta-v2'){
  const fingerprint=manifest.files.find(file=>file.path==='runtime/check-artifact/artifact-manifest.json')?.sha256;
  if(!fingerprint||manifest.nativeCheckArtifact?.fingerprint!==fingerprint||manifest.nativeCheckArtifact?.backend?.id!=='darwin-seatbelt'||manifest.nativeCheckArtifact?.backend?.revision!==2)throw Error('Invalid bundled native artifact binding');
  const bundled=await readBundledNativeCheckRuntime(path.join(directory,'runtime'));
  if(bundled.artifactManifestSha256!==fingerprint)throw Error('Bundled native artifact fingerprint differs from package inventory');
 }
 return manifest;
}

function nativeImplementationHash(manifest,nodeVersion){
 // The configured artifact selects the source closure. Older packages retain
 // the historical hash even when an update bundles a different artifact.
 const sources=nativeImplementationSources(nodeVersion).map(file=>{
  const source=manifest.files.find(entry=>entry.path===path.posix.normalize('runtime/src/project/check-backends/'+file));
  if(!source||!/^[a-f0-9]{64}$/.test(source.sha256))throw Error('Missing native implementation source inventory; retain the trusted installed version.');
  return {file,hash:source.sha256};
 });
 return hash(JSON.stringify(sources));
}

export async function assertStateCompatibility(paths,manifest){
 const compatible=manifest.stateCompatibility??{settings:[1],database:[0,1]};
 if(!compatible||!['settings','database'].every(key=>Array.isArray(compatible[key])&&compatible[key].length&&compatible[key].every(n=>Number.isInteger(n)&&n>=0)))throw Error('Invalid package state compatibility contract');
 const settings=await jsonFile(paths.config,{privateFile:true});
 if(settings&&!compatible.settings.includes(settings.schema))throw Error('Incompatible settings schema '+settings.schema+'. Keep the newer version; rollback does not restore an older state backup.');
 const database=path.join(paths.state,'harness.sqlite3'),info=await entry(database);
 let savedExecution=null,heldNative=false;
 if(info){
  if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||(info.mode&0o077))throw Error('Unsafe Mosaic Beta state database');
  readMaintenanceDatabase(database,db=>{
   const version=db.prepare('PRAGMA user_version').get().user_version;
   if(!compatible.database.includes(version))throw Error('Incompatible database schema '+version+'. Keep the newer version; live state is never replaced by an older backup.');
   if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='records'").get()){
    const saved=db.prepare("SELECT data FROM records WHERE kind='execution_configuration' AND id='coordinator'").get();
    if(saved){try{savedExecution=JSON.parse(saved.data);}catch{throw Error('Invalid saved native execution identity; preserve the installed version for inspection.');}}
    heldNative=!!db.prepare(`SELECT 1 FROM records WHERE
     (kind='goal' AND json_extract(data,'$.manifest.executionPolicy.backend')='darwin-seatbelt' AND json_extract(data,'$.manifest.executionPolicy.backendRevision')=2 AND json_extract(data,'$.status') NOT IN ('completed','partial')) OR
     (kind='execution_owner' AND json_extract(data,'$.status')!='quiescent') LIMIT 1`).get();
   }
  });
 }
 const savedNative=savedExecution?.identity?.nativeRuntime;
 if(savedNative&&!settings?.nativeCheckRuntime)throw Error('Retain the saved native runtime configuration before switching the installed version.');
 if(settings?.nativeCheckRuntime){
  const source=manifest.files.find(file=>file.path==='runtime/src/project/check-backends/native-supervisor.c');
  // Old literal check argv still selects this artifact after a pointer switch.
  // Validate its complete current bytes, modes and canonical ancestry, using
  // the existing backend validator rather than trusting only its manifest.
  const retainedRuntime=validateNativeCheckRuntime(settings.nativeCheckRuntime,savedNative?.fingerprint??settings.nativeCheckRuntime.artifactManifestSha256);
  if(!source||retainedRuntime.manifest.provenance.supervisorSourceSha256!==source.sha256)throw Error('The retained native artifact is incompatible with this package supervisor source. Keep its version and approvals; explicitly migrate the backend only after all resumable work is resolved.');
  const candidateImplementation=nativeImplementationHash(manifest,retainedRuntime.nodeVersion);
  let previousImplementation;
  if(savedNative){
   if(savedExecution.schema!==2||hash(canonical(savedExecution.identity))!==savedExecution.hash||!/^[a-f0-9]{64}$/.test(savedNative.implementationHash??'')||savedNative.fingerprint!==settings.nativeCheckRuntime.artifactManifestSha256||savedNative.manifestPath!==settings.nativeCheckRuntime.artifactManifestPath)throw Error('Saved native execution identity differs from retained settings; preserve the exact approved configuration.');
   if(canonical(retainedRuntime)!==canonical(savedNative))throw Error('The retained native runtime identity changed; restore the exact approved artifact and implementation before switching versions.');
   previousImplementation=savedNative.implementationHash;
  }else{
   // Before the first native coordinator boot there is no saved runtime. Only
   // an unchanged, fully verified owned prior package can supply the baseline,
   // and never when an approval or unresolved native owner needs that identity.
   if(heldNative)throw Error('Saved native implementation identity is missing for resumable work; retain the trusted version and resolve that work before updating.');
   const {receipt}=await installedLauncher(paths);
   if(!receipt)throw Error('Cannot establish prior native implementation compatibility; retain the trusted installed version.');
   const previousDirectory=path.join(paths.versions,receipt.version);await verifyPackage(previousDirectory);
   const previous=await jsonFile(path.join(previousDirectory,'package-manifest.json'));
   if(previous.version!==receipt.version||previous.contentHash!==receipt.contentHash)throw Error('Prior native package inventory differs from its ownership receipt.');
   previousImplementation=nativeImplementationHash(previous,retainedRuntime.nodeVersion);
  }
  if(candidateImplementation!==previousImplementation)throw Error('The package native implementation differs from the saved execution identity. Retain the old version, runtime, approvals and literal check paths; resolve resumable work before explicit backend migration.');
 }
}

const transactionFile=paths=>path.join(paths.configDir,'install-transaction.json');
const defaultLifecycle={verifyLaunchAgent,stopForMaintenance,startLaunchAgent,rollbackLaunchAgent};
function lifecycleFor(paths,lifecycle){
 if(lifecycle===undefined)return defaultLifecycle;
 if(!paths.isolated||!lifecycle||typeof lifecycle!=='object'||Array.isArray(lifecycle)||Object.keys(lifecycle).some(key=>!Object.hasOwn(defaultLifecycle,key)||typeof lifecycle[key]!=='function'))throw Error('Lifecycle injection requires explicit functions in an isolated fixture home');
 return {...defaultLifecycle,...lifecycle};
}
async function settingsSnapshot(paths){const bytes=await fileBytes(paths.config,{privateFile:true});return bytes?hash(bytes):null;}
function validateTransaction(paths,tx){
 if(tx?.schema!==1||!versionPattern.test(tx.version??'')||!['prepared','staged','launcher','receipt','committed','restored'].includes(tx.phase)||typeof tx.oldLauncher!=='string'&&tx.oldLauncher!==null||typeof tx.staged!=='string'||!/^\.install-[a-f0-9-]+$/.test(tx.staged)||typeof tx.registered!=='boolean'||typeof tx.existed!=='boolean'||tx.settingsHash!==undefined&&tx.settingsHash!==null&&!/^[a-f0-9]{64}$/.test(tx.settingsHash))throw Error('Invalid installation recovery transaction; preserve it for inspection.');
 if(tx.oldReceipt&&tx.oldLauncher&&(!versionPattern.test(tx.oldReceipt.version??'')||hash(Buffer.from(tx.oldLauncher??'','base64'))!==tx.oldReceipt.launcherHash||![launcherFor(paths,tx.oldReceipt.version),launcherFor(paths,tx.oldReceipt.version,true)].includes(Buffer.from(tx.oldLauncher??'','base64').toString())))throw Error('Changed installation recovery ownership; preserve it for inspection.');
 if(tx.newReceipt?.version!==tx.version||tx.newReceipt.launcherHash!==hash(launcherFor(paths,tx.version)))throw Error('Changed installation recovery target; preserve it for inspection.');
}
async function assertSettingsSnapshot(paths,tx){
 if(tx.settingsHash===undefined)throw Error('Installation recovery must pin its settings snapshot. Run mosaic recover before starting its coordinator.');
 if(await settingsSnapshot(paths)!==tx.settingsHash)throw Error('Settings changed during installation recovery; preserve the transaction for inspection.');
}
async function assertHandoffPointer(paths,tx){
 const expectedReceipt=tx.phase==='restored'?tx.oldReceipt:tx.newReceipt,expectedLauncher=tx.phase==='restored'?(tx.oldLauncher?Buffer.from(tx.oldLauncher,'base64'):null):Buffer.from(launcherFor(paths,tx.version));
 const current=await fileBytes(paths.launcher,{max:16384}),receipt=await jsonFile(paths.installation,{privateFile:true,max:8192});
 if((current?hash(current):null)!==(expectedLauncher?hash(expectedLauncher):null)||canonical(receipt)!==canonical(expectedReceipt))throw Error('Installation pointer or receipt changed during owned restart; preserve it for inspection.');
 await assertSettingsSnapshot(paths,tx);
}
// Called while the service holds the shared startup/maintenance mutex. Only a
// durable, complete forward switch or restored pointer may admit a coordinator.
export async function assertInstallationStartupReady(paths){
 const tx=await jsonFile(transactionFile(paths),{privateFile:true,max:65536});if(!tx)return false;
 validateTransaction(paths,tx);
 if(!['committed','restored'].includes(tx.phase))throw Error('Installation writes are incomplete. Run mosaic recover before starting its coordinator.');
 await assertHandoffPointer(paths,tx);return true;
}
async function assertNoConfigurationMaintenance(paths){
 if(await entry(paths.setupIntent)||await entry(path.join(paths.configDir,'migration-intent.json')))throw Error('Settings setup or migration is pending. Finish its recovery before installing another version.');
}
async function finishRestart(paths,tx,lifecycle){
 // Startup itself takes the maintenance mutex. All pointer/settings writes are
 // already durable; retain this exact receipt until readiness is restored.
 await withLock(paths,async()=>{
  const current=await jsonFile(transactionFile(paths),{privateFile:true,max:65536});
  if(!current||canonical(current)!==canonical(tx))throw Error('Installation restart handoff changed; preserve it for inspection.');
  await assertHandoffPointer(paths,tx);
 });
 if(tx.phase==='restored')await lifecycle.rollbackLaunchAgent(paths,{existed:tx.existed,registered:tx.registered});else await lifecycle.startLaunchAgent(paths);
 await withLock(paths,async()=>{
  const current=await jsonFile(transactionFile(paths),{privateFile:true,max:65536});
  if(current&&canonical(current)!==canonical(tx))throw Error('Installation restart transaction changed; preserve it for inspection.');
  await assertHandoffPointer(paths,tx);
  if(current)await rm(transactionFile(paths));
 });
}
async function recoverLocked(paths,lifecycle){
 let tx=await jsonFile(transactionFile(paths),{privateFile:true,max:65536});if(!tx)return {recovered:false};
 validateTransaction(paths,tx);
 await assertMaintenanceIdle(paths);
 const current=await fileBytes(paths.launcher,{max:16384}),receipt=await jsonFile(paths.installation,{privateFile:true,max:8192});
 const currentHash=current?hash(current):null,oldHash=tx.oldLauncher?hash(Buffer.from(tx.oldLauncher,'base64')):null;
 if(![null,oldHash,tx.newReceipt.launcherHash].includes(currentHash)||receipt&&![hash(JSON.stringify(tx.oldReceipt)),hash(JSON.stringify(tx.newReceipt))].includes(hash(JSON.stringify(receipt))))throw Error('Installation pointer or receipt was modified after interruption; preserve it for inspection.');
 if(['committed','restored'].includes(tx.phase)){
  const target=tx.phase==='restored'?tx.oldReceipt:tx.newReceipt;
  if(target){const manifest=await verifyVersion(path.join(paths.versions,target.version),target.version);await assertStateCompatibility(paths,manifest);}
  if(tx.settingsHash===undefined){tx={...tx,settingsHash:await settingsSnapshot(paths)};await saveJson(transactionFile(paths),tx);}
  await assertHandoffPointer(paths,tx);
 }else{
  if(tx.oldReceipt&&await entry(path.join(paths.versions,tx.oldReceipt.version))){const previous=await verifyVersion(path.join(paths.versions,tx.oldReceipt.version),tx.oldReceipt.version);await assertStateCompatibility(paths,previous);}
  await lifecycle.stopForMaintenance(paths);
  if(tx.settingsHash!==undefined)await assertSettingsSnapshot(paths,tx);
  if(tx.oldLauncher)await atomic(paths.launcher,Buffer.from(tx.oldLauncher,'base64'),{mode:0o755});else await rm(paths.launcher,{force:true});
  if(tx.oldReceipt){if(JSON.stringify(receipt)!==JSON.stringify(tx.oldReceipt))await saveJson(paths.installation,tx.oldReceipt);}else if(receipt)await rm(paths.installation,{force:true});
  tx={...tx,phase:'restored',settingsHash:tx.settingsHash===undefined?await settingsSnapshot(paths):tx.settingsHash};await saveJson(transactionFile(paths),tx);
 }
 await rm(path.join(paths.versions,tx.staged),{recursive:true,force:true});
 // Old immutable versions/artifacts remain available to saved literal approvals.
 if(tx.registered)return {recovered:true,handoff:tx};
 await rm(transactionFile(paths));return {recovered:true};
}
export async function recoverInstallation(paths,{lifecycle:injected}={}){
 const lifecycle=lifecycleFor(paths,injected),outcome=await withLock(paths,()=>recoverLocked(paths,lifecycle));
 if(outcome.handoff)await finishRestart(paths,outcome.handoff,lifecycle);
 return outcome.recovered;
}

export async function install(paths,payload,{noPath=false,afterStep=()=>{},lifecycle:injected}={}){
 if(typeof afterStep!=='function')throw Error('Installation step observer must be a function');
 const lifecycle=lifecycleFor(paths,injected),manifest=await jsonFile(path.join(payload,'package-manifest.json'));
 if(!versionPattern.test(manifest?.version??''))throw Error('Invalid Mosaic Beta version');
 await verifyVersion(payload,manifest.version);
 const version=manifest.version,installed=path.join(paths.versions,version);
 await recoverInstallation(paths,{lifecycle:injected});
 const outcome=await withLock(paths,async()=>{
  if(await entry(transactionFile(paths)))throw Error('Installation recovery became pending. Run mosaic recover before retrying.');
  await assertNoConfigurationMaintenance(paths);
  const old=await installedLauncher(paths);await assertStateCompatibility(paths,manifest);
  if(old.receipt?.version===version&&old.receipt.contentHash!==manifest.contentHash)throw Error('The installed version receipt has different integrity checksums. Choose a new version.');
  const present=!!await entry(installed);
  if(present){const existing=await verifyVersion(installed,version);if(existing.contentHash!==manifest.contentHash)throw Error('Version already installed with different integrity checksums. Choose a new version.');}
  const launcher=launcherFor(paths,version),receipt={schema:1,version,contentHash:manifest.contentHash,launcherHash:hash(launcher),...(old.receipt?.pathBlock?{pathBlock:old.receipt.pathBlock,pathFileCreated:old.receipt.pathFileCreated}:{})};
  const switched=!present||!old.bytes||old.receipt.version!==version;
  if(!switched)return {receipt};
  const existed=await lifecycle.verifyLaunchAgent(paths),registered=await lifecycle.stopForMaintenance(paths),staged='.install-'+randomUUID();
  let tx={schema:1,version,phase:'prepared',oldLauncher:old.bytes?.toString('base64')??null,oldReceipt:old.receipt,newReceipt:receipt,existed,registered,staged,settingsHash:await settingsSnapshot(paths)};
  // Persist the owned restart handoff before the post-shutdown state read can fail.
  await saveJson(transactionFile(paths),tx);
  const advance=async(phase,event)=>{tx={...tx,phase};await saveJson(transactionFile(paths),tx);await afterStep(event);};let newVersion=false;
  try{
   await assertStateCompatibility(paths,manifest);
   await afterStep('transaction-prepared');
   if(!present){await cp(payload,path.join(paths.versions,staged),{recursive:true,force:false,errorOnExist:true});await verifyVersion(path.join(paths.versions,staged),version);await rename(path.join(paths.versions,staged),installed);newVersion=true;}
   await advance('staged','version-staged');await localDirectory(paths,path.dirname(paths.launcher));await assertStateCompatibility(paths,manifest);await assertSettingsSnapshot(paths,tx);
   await atomic(paths.launcher,launcher,{mode:0o755});await advance('launcher','launcher-switched');
   await saveJson(paths.installation,receipt);await advance('receipt','receipt-switched');await advance('committed','committed');
   if(registered)return {receipt,handoff:tx};
   await rm(transactionFile(paths));return {receipt};
  }catch(error){
   if(tx.phase==='committed')throw error;
   try{const recovered=await recoverLocked(paths,lifecycle);if(newVersion)await rm(installed,{recursive:true,force:true});return {...recovered,error};}
   catch(recovery){throw Error(error.message+' Installation recovery needs inspection: '+recovery.message,{cause:error});}
  }
 });
 if(outcome.handoff)await finishRestart(paths,outcome.handoff,lifecycle);
 if(outcome.error)throw outcome.error;
 if(!noPath)await withLock(paths,async()=>{
  const current=await installedLauncher(paths);
  if(current.receipt?.version!==version||current.receipt.contentHash!==manifest.contentHash)throw Error('Installed version changed before PATH binding; preserve it for inspection.');
  try{await saveJson(paths.installation,await applyPath(paths,current.receipt));}catch(error){process.stderr.write('PATH unchanged or needs inspection. '+error.message+'\n');}
 });
 writeInstallReceipt(process.stdout,paths,version);
}
export async function rollbackVersion(paths,version,options={}){
 if(!versionPattern.test(version??''))throw Error('Choose an installed version for rollback');
 return install(paths,path.join(paths.versions,version),{noPath:true,...options});
}

export async function uninstall(paths){
 await recoverInstallation(paths);
 return withLock(paths,async()=>{
  if(await entry(transactionFile(paths)))throw Error('Installation recovery became pending. Run mosaic recover before uninstalling.');
  const {receipt,bytes}=await installedLauncher(paths).catch(error=>{
   if(!/foreign or changed/.test(error.message))throw error;
   process.stdout.write('Preserved modified mosaic launcher.\n');return {receipt:null,bytes:null};
  });
  const intent=await readSetupIntent(paths);
  const allowUnrecorded=!!intent&&!intent.hadAgent;
  const owned=await verifyLaunchAgent(paths,{allowUnrecorded});
  await stopForMaintenance(paths,{allowUnrecorded});
  const ownership=await jsonFile(paths.ownership,{privateFile:true,max:8192});
  if(ownership)await saveJson(paths.ownership,{...ownership,complete:false});
  if(owned)await rm(paths.plist);
  await removeCodexBindings(paths,process.stdout,intent);
  if(intent)await rm(paths.setupIntent);
  if(receipt?.pathBlock){
   const info=await entry(paths.zshrc);
   let existing;
   try{existing=(await fileBytes(paths.zshrc))?.toString();}catch{}
   if(existing?.includes(receipt.pathBlock)&&existing.indexOf(header)===existing.lastIndexOf(header)&&existing.indexOf(footer)===existing.lastIndexOf(footer)){
    const remaining=existing.replace(receipt.pathBlock,'');
    if(!remaining&&receipt.pathFileCreated)await rm(paths.zshrc);
    else await atomic(paths.zshrc,remaining,{mode:info.mode&0o777});
   }else if(info)process.stdout.write('Preserved modified Mosaic Beta PATH binding.\n');
  }
  if(bytes)await rm(paths.launcher);
  process.stdout.write('Removed owned Mosaic Beta bindings. Installed versions, private settings and evidence are retained at '+paths.root+'\n');
 });
}

async function main(){
 const args=process.argv.slice(2),opts={};
 while(args.length){
  const flag=args.shift();
  if(flag==='--help'){process.stdout.write('Usage: ./install [--no-path] [--home ISOLATED_DIRECTORY]\n');return;}
  if(flag==='--no-path'&&!opts.noPath){opts.noPath=true;continue;}
  if(flag==='--home'&&!opts.home&&args[0]){opts.home=args.shift();continue;}
  throw Error('Use ./install --help for options');
 }
 const paths=locations(opts.home??currentHome(),!!opts.home);
 const payload=fileURLToPath(new URL('../../../',import.meta.url));
 await install(paths,payload,opts);
}

if(isEntry(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
