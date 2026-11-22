import {windowsDependencyInventory,windowsRelativePath,WINDOWS_BACKEND} from '../project/check-backends/windows-appcontainer.mjs';
import {windowsFileSync} from '../beta/windows-files.mjs';
import {nativeDependencyInventory} from '../project/check-backends/darwin-seatbelt-v2.mjs';
import os from 'node:os';
import {executionBootId} from './execution-ownership.mjs';
import path from 'node:path';
import {readFileSync,readdirSync,lstatSync,readlinkSync,existsSync,realpathSync,accessSync,constants} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {gitSync} from '../project/git.mjs';
import {createHash} from 'node:crypto';
import {Journal} from '../project/journal.mjs';
import {Workspace} from '../project/workspace.mjs';
import {approvedChecks,executionFields,assertExecutionAvailable,isNativeExecution,isWindowsJavaScriptPolicy,nativeRuntime} from './execution.mjs';
import {matches,secretPath} from '../project/contracts.mjs';
import {digest} from './contracts.mjs';
import {isOvernightV2} from './overnight.mjs';
const bytesHash=b=>createHash('sha256').update(b).digest('hex');
function nativeHostIdentity(config){const bootId=executionBootId(config);if(!bootId)throw Error('Verified native host boot identity unavailable; real preflight cannot be cached');return {bootId,kernelRelease:os.release(),osVersion:os.version(),platform:process.platform,arch:process.arch};}
function tree(root){if(!existsSync(root))return [];const result=[];const walk=(dir,prefix='')=>{for(const name of readdirSync(dir).sort()){const file=path.join(dir,name),relative=prefix+name,s=lstatSync(file);if(s.isSymbolicLink()){const target=realpathSync(file);if(!target.startsWith(realpathSync(root)+path.sep))throw Error('Dependency symlink escapes approved inventory');result.push([relative,'link',readlinkSync(file)]);}else if(s.isDirectory())walk(file,relative+'/');else if(s.isFile())result.push([relative,bytesHash(readFileSync(file))]);else throw Error('Unsupported preflight input');}};walk(root);return result;}
export function overnightRuntimeIdentity(){const here=path.dirname(fileURLToPath(import.meta.url));return digest([process.versions.node,...[here,path.join(here,'../project')].flatMap(dir=>readdirSync(dir).filter(f=>f.endsWith('.mjs')).sort().map(f=>[path.basename(dir)+'/'+f,bytesHash(readFileSync(path.join(dir,f)))])),...tree(path.join(here,'../project/check-backends')).map(([file,...identity])=>['project/check-backends/'+file,...identity])]);}
export function sandboxIdentity(executable='codex'){const selected=executable.includes('/')?executable:(process.env.PATH??'').split(path.delimiter).map(dir=>path.join(dir,executable)).find(file=>{try{accessSync(file,constants.X_OK);return true;}catch{return false;}});if(!selected)throw Error('Codex sandbox executable unavailable');return {executable:realpathSync(selected),sha256:bytesHash(readFileSync(selected))};}
function windowsPreflightSources(project,git){
 const entries=[];
 for(const record of git('ls-files','--stage','-z').split('\0').filter(Boolean)){
  const tab=record.indexOf('\t');
  if(tab===-1)throw Error('Invalid Windows Git index record');
  const [mode,,stage]=record.slice(0,tab).split(' '), file=record.slice(tab+1);
  if(secretPath(file)||!matches(file,project.readPaths))continue;
  windowsRelativePath(file);
  if(!['100644','100755'].includes(mode)||stage!=='0')throw Error('Windows preflight requires regular, unconflicted Git inputs');
  const data=windowsFileSync('read',path.join(project.repo,file),{max:128*1024*1024});
  entries.push([file,bytesHash(data),mode]);
 }
 return entries.sort(([a],[b])=>a<b?-1:a>b?1:0);
}
export function overnightInputs(manifest,codex='codex'){
 const native=isNativeExecution(manifest),windows=native&&(manifest.executionPolicy.backend===WINDOWS_BACKEND.id||isWindowsJavaScriptPolicy(manifest.executionPolicy));
 const config=typeof codex==='string'?{codexPath:codex}:codex;
 assertExecutionAvailable(manifest,config);
 const p=manifest.project,git=(...args)=>gitSync(p.repo,...args);
 if(git('rev-parse','HEAD')!==p.baseCommit||git('status','--porcelain'))throw Error('Preflight source revision or status changed');
 const inventory=windows?windowsPreflightSources(p,git):git('ls-files','-z').split('\0').filter(f=>f&&!secretPath(f)&&matches(f,p.readPaths)).sort().map(f=>{
  let current=p.repo;for(const part of f.split('/')){current=path.join(current,part);if(lstatSync(current).isSymbolicLink())throw Error('Preflight source symlink rejected');}
  return [f,bytesHash(readFileSync(current)),...(native?[lstatSync(current).mode&0o100?'100755':'100644']:[])];
 });
 const dependencies=path.join(p.repo,'node_modules');
 const dependencyInventory=windows?windowsDependencyInventory:nativeDependencyInventory;
 const sandboxRuntime=native?{id:manifest.executionPolicy.backend,revision:manifest.executionPolicy.backendRevision,...nativeRuntime(config,manifest.executionPolicy.runtimeFingerprint)}:
  {...sandboxIdentity(config.codexPath??'codex'),...(manifest.executionPolicy?{id:manifest.executionPolicy.backend,revision:manifest.executionPolicy.backendRevision}:{})};
 return {...executionFields(manifest),...(native?{nativeHost:nativeHostIdentity(config)}:{}),inventoryHash:digest(inventory),
  dependenciesHash:native?dependencyInventory(dependencies).hash:digest(tree(dependencies)),runtimeIdentity:overnightRuntimeIdentity(),sandboxRuntime};
}
export function assertOvernightPreflight(c,g){if(!isOvernightV2(g.manifest))return;const r=c.store.maybe('overnight_preflight',g.id);if(!r?.passed||r.approvalHash!==g.hash)throw Error('Matching successful exact-policy preflight is required');const current=overnightInputs(g.manifest,isNativeExecution(g.manifest)?c.executionConfig:c.executionConfig?.codexPath??r.sandboxExecutable??'codex');if(digest(current)!==r.inputsHash)throw Error('Preflight inputs or runtime changed; rerun exact preflight before activation');}
export class OvernightPreflight{
 constructor({c,checksFactory,config={}}){this.c=c;this.checksFactory=checksFactory;this.config=config;}
 async run({goalId,hash},key){this.c.verifyCurrentWorker?.();const c=this.c,original=c.store.get('goal',goalId),revision=original.hash===hash?null:c.store.all('goal_revision').find(r=>r.goalId===goalId&&r.hash===hash&&r.status==='draft'),g=revision?{...original,hash:revision.hash,manifest:revision.manifest,status:'draft'}:original;if(revision&&(original.integrationOwner||original.integrationPending||c.store.all('task').some(t=>t.goalId===goalId&&(t.owner||t.native?.writerActive||t.status==='legacy_reviewing'))||['running','uncertain'].includes(c.store.maybe('planning',goalId)?.status)))throw Error('Revised preflight requires verified quiescent owners');if(!isOvernightV2(g.manifest)||g.status!=='draft'||hash!==g.hash)throw Error('Preflight requires prepared Overnight v2 goal and exact approval hash');
  const inputs=overnightInputs(g.manifest,isNativeExecution(g.manifest)?this.config:this.config.codexPath??'codex'),identity=digest({goalId,hash,inputs}),old=c.store.maybe('overnight_preflight',g.id);
  if(old?.passed&&old.identity===identity)return old;
  const journal=await new Journal(path.join(c.store.root,'overnight-preflight'),identity.slice(0,8)+'-'+identity.slice(8,12)+'-'+identity.slice(12,16)+'-'+identity.slice(16,20)+'-'+identity.slice(20,32)).load(),release=await journal.lock();
  let receipt,executionError;
  try{const p=g.manifest.project,manifest={...executionFields(g.manifest),repo:p.repo,baseCommit:p.baseCommit,overnightV2:true,permissions:{readPaths:p.readPaths,writePaths:p.writePaths,checks:p.checks}},workspace=new Workspace(manifest,journal);await workspace.initialize();await workspace.recover();const runner=approvedChecks(workspace,{checksFactory:this.checksFactory,config:this.config,context:{c,goalId,expectedDependencyHash:inputs.dependenciesHash,operationKey:key,operationId:c.store.all('operation').find(row=>row.key===key)?.id,...(revision?{revisionId:revision.id}:{})}});const sandbox=await runner.verify(),checks=p.checks.filter(check=>g.manifest.overnightPolicy.preflightCheckIds.includes(check.id)),results=await runner.run(checks,'preflight');if(digest(overnightInputs(g.manifest,isNativeExecution(g.manifest)?this.config:this.config.codexPath??'codex'))!==digest(inputs))throw Error('Preflight inputs changed during checks');receipt={schema:1,goalId,approvalHash:hash,identity,inputsHash:digest(inputs),...inputs,...(isNativeExecution(g.manifest)?{}:{sandboxExecutable:this.config.codexPath??'codex'}),checks:results,sandbox,staging:runner.stagedInputRoot??null,passed:results.every(r=>r.passed),at:c.now(),workspace:workspace.root};}
  catch(error){receipt={schema:1,goalId,approvalHash:hash,identity,inputsHash:digest(inputs),...inputs,...(isNativeExecution(g.manifest)?{}:{sandboxExecutable:this.config.codexPath??'codex'}),passed:false,reason:String(error.message).slice(0,2000),at:c.now()};if(error.executionOutcome==='unknown'){receipt.executionOutcome='unknown';executionError=error;}}
  finally{await release();}
  receipt.id=goalId;receipt.receiptHash=digest(receipt);const saved=c.store.tx(()=>{const current=c.store.get('goal',goalId);if(current.hash!==original.hash||(revision?c.store.get('goal_revision',revision.id).status!=='draft':current.status!=='draft'))throw Error('Preflight approval changed');if(old)c.store.put('overnight_preflight_history',{...old,id:old.receiptHash});c.store.put('overnight_preflight',receipt);c.emit('overnight.preflight',goalId,null,{passed:receipt.passed,receiptHash:receipt.receiptHash});return receipt;});if(executionError)throw executionError;return saved;
 }
}
