import {executionApproval} from './execution-ownership.mjs';
import path from 'node:path';
import {Journal} from '../project/journal.mjs';
import {Workspace} from '../project/workspace.mjs';
import {Pause} from '../project/contracts.mjs';
import {digest} from './contracts.mjs';
import {assertWindowsJavaScriptChecks} from '../project/check-backends/windows-isolated-js-runner.mjs';
import {approvedChecks,isNativeExecution,isWindowsJavaScriptPolicy,executionFields,windowsHostConsult} from './execution.mjs';
import {overnightInputs} from './overnight-preflight.mjs';

function assertNativeCheckLaunchers(manifest, inputs) {
 const executable = inputs.sandboxRuntime.runtime.executable;
 if(isWindowsJavaScriptPolicy(manifest.executionPolicy))return assertWindowsJavaScriptChecks(manifest.project,executable);
 const invalid = manifest.project.checks.find(check => check.argv[0] !== executable);
 if (invalid) throw new Pause(`Protected check ${invalid.id} must use the bundled Node launcher at ${executable}. Prepare a draft with the exact check command.`, 'isolation');
}

export function assertNativePreflight(c,g){
 if(!isNativeExecution(g.manifest))return;
 if(!g.manifest.project)throw new Pause('Native revision 2 requires an approved coding project and real execution preflight','isolation');
 const saved=c.store.maybe('native_preflight',(g.goalId??g.id)+':'+g.hash);
 const inputs=saved?.passed&&saved.goalHash===g.hash?overnightInputs(g.manifest,c.executionConfig):null;
 if(!inputs||saved.inputsHash!==digest(inputs))throw new Pause('Matching successful native execution preflight required before approval or model dispatch','isolation');
 assertNativeCheckLaunchers(g.manifest,inputs);
}
export async function preflightNativeExecution(c,input,{config=c.executionConfig,checksFactory,resumeBinding}={}){
 const parent=c.store.get('goal',input.goalId),revision=parent.hash===input.hash?null:c.store.all('goal_revision').find(row=>row.goalId===parent.id&&row.hash===input.hash&&row.status==='draft');if(!isNativeExecution(revision?.manifest??parent.manifest))return {required:false};if(parent.hash!==input.hash&&!revision)throw Error('Exact goal or draft revision approval hash required for native preflight');const original=executionApproval(c,{goalId:parent.id,revisionId:revision?.id});
 if(windowsHostConsult(c,original.manifest))return {required:false};
 if(!original.manifest.project)throw new Pause('Native revision 2 requires an approved coding project and real execution preflight','isolation');
 if(!['draft','active','paused','stopped'].includes(original.status))throw Error('Native preflight goal is terminal');c.verifyCurrentWorker?.();
 const inputs=overnightInputs(original.manifest,config),inputsHash=digest(inputs),identity=digest({goalId:original.id,goalHash:original.hash,inputsHash}),receiptId=original.id+':'+original.hash,saved=c.store.maybe('native_preflight',receiptId);
 assertNativeCheckLaunchers(original.manifest,inputs);
 if(saved?.passed&&saved.goalHash===original.hash&&saved.inputsHash===inputsHash)return saved;
 c.executionOwnership.assertClear({goalId:original.id});c.nativePreflightRuns??=new Map();if(c.nativePreflightRuns.has(identity))return c.nativePreflightRuns.get(identity);
 const run=(async()=>{
 const id=[identity.slice(0,8),identity.slice(8,12),identity.slice(12,16),identity.slice(16,20),identity.slice(20,32)].join('-'),journal=await new Journal(path.join(c.store.root,'native-preflight'),id).load(),release=await journal.lock();let receipt;
 try{const p=original.manifest.project,workspace=new Workspace({...executionFields(original.manifest),repo:p.repo,baseCommit:p.baseCommit,permissions:p,overnightV2:true},journal);await workspace.initialize();await workspace.recover();
 const runner=approvedChecks(workspace,{checksFactory,config,context:{c,goalId:original.id,expectedDependencyHash:inputs.dependenciesHash,operationKey:'native-preflight:'+identity,...(revision?{revisionId:revision.id}:{}),...(resumeBinding?{resumeBinding}:{})}}),sandbox=await runner.verify();
 if(digest(overnightInputs(original.manifest,config))!==inputsHash)throw Error('Native execution preflight inputs changed during verification');
 receipt={id:receiptId,goalId:original.id,...(revision?{revisionId:revision.id}:{}),schema:1,goalHash:original.hash,inputsHash,inputs,passed:true,sandbox,at:c.now()};
 }catch(error){receipt={id:receiptId,goalId:original.id,...(revision?{revisionId:revision.id}:{}),schema:1,goalHash:original.hash,inputsHash,passed:false,reason:String(error.message).slice(0,2000),at:c.now()};if(error.executionOutcome==='unknown')receipt.executionOutcome='unknown';c.store.tx(()=>c.store.put('native_preflight',receipt));throw error;}
 finally{await release();}
 return c.store.tx(()=>{const current=executionApproval(c,{goalId:original.id,revisionId:revision?.id});if(current.hash!==original.hash||current.version!==original.version)throw Error('Goal changed during native preflight');c.store.put('native_preflight',receipt);c.emit('execution.preflight',original.id,null,{passed:true,inputsHash});return receipt;});
 })();c.nativePreflightRuns.set(identity,run);try{return await run;}finally{c.nativePreflightRuns.delete(identity);}
}
