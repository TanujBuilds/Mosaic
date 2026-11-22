import path from 'node:path';
import {createHash} from 'node:crypto';
import {accessSync,statSync,realpathSync,readFileSync,constants} from 'node:fs';
import {Pause} from '../project/contracts.mjs';
import {CheckRunner} from '../project/sandbox.mjs';
import {assertDarwinSeatbeltContainment} from '../project/check-backends/darwin-seatbelt.mjs';
import {nativeBackendFactory,validateNativeCheckRuntime} from '../project/check-backends/platform-native-runtime.mjs';

import {WindowsCheckRunner} from '../project/check-backends/windows-check-runner.mjs';
import {WINDOWS_BACKEND} from '../project/check-backends/windows-appcontainer.mjs';

function nativePolicy(raw) {
 return raw?.backend === 'darwin-seatbelt' && raw.backendRevision === 2 ||
   raw?.backend === WINDOWS_BACKEND.id && raw.backendRevision === WINDOWS_BACKEND.revision;
}
export function normalizeExecutionPolicy(raw){
 if(raw===undefined)return undefined;
 const native=nativePolicy(raw);
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||![Object.prototype,null].includes(Object.getPrototypeOf(raw))||Object.keys(raw).some(key=>!['version','backend','backendRevision',...(native?['runtimeFingerprint']:[])].includes(key))||raw.version!==1||(!native&&!['codex-sandbox','darwin-seatbelt'].includes(raw.backend))||(!native&&raw.backendRevision!==1)||native&&!/^[a-f0-9]{64}$/.test(raw.runtimeFingerprint??''))throw Error('Invalid execution policy: exact supported backend revision and native runtime fingerprint required');
 return {version:1,backend:raw.backend,backendRevision:raw.backendRevision,...(native?{runtimeFingerprint:raw.runtimeFingerprint}:{})};
}
export function isNativeExecution(manifest){return nativePolicy(manifest?.executionPolicy);}
export function normalizeNativeCheckRuntime(raw){
 if(raw===undefined)return undefined;
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length!==3||!['schema','artifactManifestPath','artifactManifestSha256'].every(key=>Object.hasOwn(raw,key))||raw.schema!==1||typeof raw.artifactManifestPath!=='string'||!path.isAbsolute(raw.artifactManifestPath)||/[\0\r\n]/.test(raw.artifactManifestPath)||!/^[a-f0-9]{64}$/.test(raw.artifactManifestSha256??''))throw Error('Invalid private native check runtime configuration');
 return {schema:1,artifactManifestPath:raw.artifactManifestPath,artifactManifestSha256:raw.artifactManifestSha256};
}
export function nativeRuntime(config,expected){return validateNativeCheckRuntime(normalizeNativeCheckRuntime(config.nativeCheckRuntime),expected);}
export function executionFields(manifest){return manifest.executionPolicy===undefined?{}:{executionPolicy:normalizeExecutionPolicy(manifest.executionPolicy)};}
export function executionIdentity(manifest){return normalizeExecutionPolicy(manifest.executionPolicy)??{version:1,backend:'codex-sandbox',backendRevision:1};}
export function sameExecutionBackend(a,b){const x=executionIdentity(a),y=executionIdentity(b);return x.backend===y.backend&&x.backendRevision===y.backendRevision&&x.runtimeFingerprint===y.runtimeFingerprint;}
export function assertExecutionAvailable(manifest,config={}){
 if(process.platform==='win32')throw new Pause('Windows protected coding is in development. No execution backend has passed Windows filesystem isolation qualification.','isolation');
 return assertExecutionPrerequisites(manifest,config);
}
export function assertExecutionPrerequisites(manifest,config={}){
 const {codexPath='codex'}=config;
 const policy=normalizeExecutionPolicy(manifest.executionPolicy);
 // Native revision 1 has no safe arbitrary-process containment. This gate is
 // independent of fixtures or executable identity and cannot enable execution.
 if(nativePolicy(policy)) {
  const required = policy.backend === WINDOWS_BACKEND.id ? 'win32' : 'darwin';
  if(process.platform !== required) throw new Pause('Approved native backend requires '+required, 'isolation');
  nativeRuntime(config,policy.runtimeFingerprint);return;
 }
 if(policy?.backend==='darwin-seatbelt')assertDarwinSeatbeltContainment();
 if(policy){if(typeof codexPath!=='string'||!codexPath||/[\0\r\n]/.test(codexPath))throw new Pause('Invalid approved Codex sandbox executable','isolation');const candidates=(path.isAbsolute(codexPath)||codexPath.includes('/'))?[codexPath]:(process.env.PATH??'').split(path.delimiter).map(dir=>path.join(dir,codexPath));if(!candidates.some(file=>{try{const resolved=realpathSync(file);accessSync(resolved,constants.X_OK);return statSync(resolved).isFile();}catch{return false;}}))throw new Pause('Approved codex-sandbox revision 1 prerequisite missing: Codex sandbox executable unavailable','isolation');}
}
export function approvedChecks(workspace,{checksFactory,config={},context={}}={}){
 const policy=executionIdentity(workspace.manifest);
 assertExecutionAvailable(workspace.manifest,config);
 let options={codex:config.codexPath??'codex',backend:policy.backend};
 if(isNativeExecution(workspace.manifest)){const c=context.c;if(!c?.executionOwnership||!context.goalId||!context.operationKey)throw new Pause('Native checks require a durable exact execution context','isolation');const goal=c.store.get('goal',context.goalId);const approved=context.revisionId?c.store.get('goal_revision',context.revisionId):goal;if(context.revisionId&&(approved.goalId!==goal.id||approved.previousHash!==goal.hash||approved.status!=='draft'))throw new Pause('Native preflight revision identity changed','isolation');if(!sameExecutionBackend(approved.manifest,workspace.manifest))throw new Pause('Native workspace policy differs from approved goal','isolation');const proof=c.store.maybe('native_preflight',context.goalId+':'+approved.hash),expectedDependencyHash=context.expectedDependencyHash??(proof?.passed&&proof.goalHash===approved.hash?proof.inputs?.dependenciesHash:undefined);if(!/^[a-f0-9]{64}$/.test(expectedDependencyHash??''))throw new Pause('Exact native dependency preflight identity required','isolation');options={...options,backendRevision:policy.backendRevision,backendFactory:nativeBackendFactory,backendOptions:{expectedDependencyHash,nativeCheckRuntime:config.nativeCheckRuntime,expectedRuntimeFingerprint:policy.runtimeFingerprint,ownership:c.executionOwnership.forContext({...context,expectedDependencyHash,workspaceRoot:workspace.root})}};}
 const Runner=policy.backend===WINDOWS_BACKEND.id?WindowsCheckRunner:CheckRunner;
 const runner=checksFactory?.(workspace,options)??new Runner(workspace,options);
 if(workspace.manifest.executionPolicy){const identity=runner.backendIdentity;if(identity?.id!==policy.backend||identity.revision!==policy.backendRevision)throw new Pause('Check runner identity differs from the approved execution backend','isolation');}
 return runner;
}
function configuredRuntime(codexPath){
 // Historical callers supplied executable configuration only to their runner.
 // Preserve that fallback without guessing a prior executable from a goal pin.
 if(codexPath===undefined)return null;
 if(typeof codexPath!=='string'||!codexPath||/[\0\r\n]/.test(codexPath))throw Error('Invalid trusted execution runtime configuration');
 const candidates=(path.isAbsolute(codexPath)||codexPath.includes('/'))?[codexPath]:(process.env.PATH??'').split(path.delimiter).map(dir=>path.join(dir,codexPath));
 for(const file of candidates){try{const executable=realpathSync(file);accessSync(executable,constants.X_OK);if(statSync(executable).isFile())return {executable,sha256:createHash('sha256').update(readFileSync(executable)).digest('hex')};}catch{}}
 return {unavailable:true,selector:codexPath};
}
function stable(value){return value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(stable).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}';}
function configuredIdentity(c){
 const base={defaultBackend:executionIdentity({executionPolicy:c.executionPolicy}),runtime:configuredRuntime(c.executionConfig.codexPath)};
 return c.executionConfig.nativeCheckRuntime?{...base,nativeRuntime:nativeRuntime(c.executionConfig)}:base;
}
export function assertExecutionRuntime(c){
 const previous=c.store.get('execution_configuration','coordinator');
 if(![1,2].includes(previous.schema)||!previous.identity||!Object.hasOwn(previous.identity,'runtime'))throw Error('Invalid saved execution runtime identity');
 const matches=previous.schema===1?stable(configuredRuntime(c.executionConfig.codexPath))===stable(previous.identity.runtime):stable(configuredIdentity(c))===stable(previous.identity);
 if(!matches)throw Error('Execution sandbox runtime changed; restore the trusted executable before continuing approved work');
}
export function assertExecutionConfiguration(c){
 const identity=configuredIdentity(c),schema=c.executionConfig.nativeCheckRuntime?2:1,hash=createHash('sha256').update(schema===1?JSON.stringify(identity):stable(identity)).digest('hex');
 const previous=c.store.maybe('execution_configuration','coordinator');
 if(previous&&(![1,2].includes(previous.schema)||typeof previous.hash!=='string'))throw Error('Invalid saved execution configuration identity');
 const held=goal=>['draft','active','paused','stopped'].includes(goal.status)||c.store.all('task').some(task=>task.goalId===goal.id&&(task.owner||task.native?.writerActive||['running','uncertain','taking_over','codex_active','legacy_reviewing','awaiting_review','ready_to_integrate'].includes(task.status)))||goal.integrationOwner||goal.integrationPending||['running','uncertain'].includes(c.store.maybe('planning',goal.id)?.status)||c.store.all('goal_revision').some(revision=>revision.goalId===goal.id&&revision.status==='draft'&&revision.previousHash===goal.hash&&!['completed','partial'].includes(goal.status));
 if(previous&&(previous.hash!==hash||previous.schema!==schema)&&(c.store.all('goal').some(held)||c.store.all('execution_owner').some(row=>row.status!=='quiescent')))throw Error('Execution backend settings or runtime changed with prepared, active or unfinished work; retain the trusted configuration until resolved');
 if(!previous||previous.hash!==hash||previous.schema!==schema)c.store.put('execution_configuration',{id:'coordinator',schema,identity,hash});
}
