import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';import path from 'node:path';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {digest as bindingDigest} from '../src/project/contracts.mjs';
import {digest} from '../src/harness/contracts.mjs';
import {Goals} from '../src/harness/goals.mjs';
import {capacitySnapshot,canClaim} from '../src/harness/scheduling/capacity.mjs';
async function fixture(t){
 const api=await import('../src/harness/execution-ownership.mjs').catch(()=>({}));assert.equal(typeof api.ExecutionOwnership,'function','durable native execution ownership manager is required');
 const root=mkdtempSync(path.join(os.tmpdir(),'pb15-owner-')),c=new Coordinator({root:path.join(root,'state')});t.after(()=>{c.close();rmSync(root,{recursive:true,force:true});});
 let g=c.prepareLegacyGoal({submissionId:'g',objective:'Retain ownership',acceptance:['Quiescence'],mode:'deepseek_only'},'prepare');c.activateGoal({goalId:g.id,hash:g.hash},'activate');
 const task=c.submitTask({goalId:g.id,submissionId:'t',kind:'consult',objective:'Owner fixture',acceptance:['Bounded']},'task');c.claimNext('worker');
 g=c.store.get('goal',g.id);g.manifest.executionPolicy={version:1,backend:'darwin-seatbelt',backendRevision:2,runtimeFingerprint:'a'.repeat(64)};g.hash=digest(g.manifest);c.store.put('goal',g);
 const manager=new api.ExecutionOwnership(c,{bootId:'boot-a'});c.executionOwnership=manager;
 const raw={schema:1,backend:{id:'darwin-seatbelt',revision:2},argv:['/fixture/node','check.mjs'],cwd:root,profileHash:'b'.repeat(64),inputInventoryHash:'c'.repeat(64),runtimeFingerprint:'a'.repeat(64),runtimeHash:'d'.repeat(64),supervisorHash:'e'.repeat(64),dependencyInventoryHash:'f'.repeat(64)};
 const binding={...raw,bindingHash:bindingDigest(raw)},context={goalId:g.id,taskId:task.id,operationKey:'checks-1',workspaceRoot:root,expectedDependencyHash:'f'.repeat(64)};
 return {api,root,c,g,task,manager,binding,context};
}
function prepared(h,b){return {schema:1,type:'prepared',requestId:h.requestId,bindingHash:b.bindingHash,helperPid:10001,leaderPid:10002};}
function receipt(h,b){return {...prepared(h,b),type:'complete',reason:'exit',code:0,termSignal:0,groupESRCH:true,leaderReaped:true,nonzeroSignalsAfterReap:0};}
test('unknown native execution retains task ownership, scoped capacity, finalization and restart holds without repeated writes',async t=>{
 const f=await fixture(t),h=f.manager.forContext(f.context).begin(f.binding);h.prepared(prepared(h,f.binding));h.uncertain('helper receipt missing');
 const record=f.c.store.get('execution_owner',h.requestId);assert.equal(record.status,'uncertain');assert.equal(f.c.getTask(f.task.id).status,'uncertain');assert.equal(f.c.getTask(f.task.id).owner,'worker');
 f.c.failTaskStep(f.task.id,'worker','ordinary failure must not clear native ownership');assert.equal(f.c.getTask(f.task.id).owner,'worker');assert.equal(f.c.getTask(f.task.id).status,'uncertain');
 assert.throws(()=>f.manager.forContext(f.context).begin(f.binding),/execution|quiescen|held/i);
 f.c.store.put('task',{...f.c.store.get('task',f.task.id),status:'blocked',owner:null});
 assert.ok(capacitySnapshot(f.c).executionOwners.length);const revision=f.c.store.revision();f.manager.reconcile({force:true});f.manager.reconcile({force:true});assert.equal(f.c.store.revision(),revision);
 assert.throws(()=>new Goals(f.c).finalize({goalId:f.g.id,summary:'Cannot finalize uncertain',partial:true},'finalize'),/unfinished|quiescen|execution/i);
 f.c.store.put('goal',{...f.c.store.get('goal',f.g.id),status:'stopped'});assert.throws(()=>f.c.control({goalId:f.g.id,action:'resume'},'resume'),/execution|quiescen|held/i);
});
test('only an exact owned durable receipt or verified new boot reconciles native execution; time and forged receipts do not',async t=>{
 const f=await fixture(t),h=f.manager.forContext(f.context).begin(f.binding);h.prepared(prepared(h,f.binding));h.uncertain('interrupted');
 writeFileSync(h.receiptPath,JSON.stringify({...receipt(h,f.binding),bindingHash:'f'.repeat(64)}),{mode:0o600});f.manager.reconcile({force:true});assert.equal(f.c.store.get('execution_owner',h.requestId).status,'uncertain');
 writeFileSync(h.receiptPath,JSON.stringify(receipt(h,f.binding)),{mode:0o600});f.manager.reconcile({force:true});assert.equal(f.c.store.get('execution_owner',h.requestId).status,'quiescent');const rev=f.c.store.revision();f.manager.reconcile({force:true});assert.equal(f.c.store.revision(),rev);
 const h2=f.manager.forContext({...f.context,operationKey:'checks-2'}).begin(f.binding);h2.prepared(prepared(h2,f.binding));h2.uncertain('lost');
 new f.api.ExecutionOwnership(f.c,{bootId:'boot-b'}).reconcile({force:true});const old=f.c.store.get('execution_owner',h2.requestId);assert.equal(old.status,'quiescent');assert.equal(old.resolution,'new_boot');
});
test('completion verifies private receipt identity and cannot release another execution or accept signal permission errors',async t=>{
 const f=await fixture(t),h=f.manager.forContext(f.context).begin(f.binding);h.prepared(prepared(h,f.binding));
 const bad={...receipt(h,f.binding),groupESRCH:false};writeFileSync(h.receiptPath,JSON.stringify(bad),{mode:0o600});assert.throws(()=>h.complete(bad),/receipt|quiescen/i);assert.notEqual(f.c.store.get('execution_owner',h.requestId).status,'quiescent');
 const good=receipt(h,f.binding);writeFileSync(h.receiptPath,JSON.stringify(good),{mode:0o600});h.complete(good);assert.equal(f.c.store.get('execution_owner',h.requestId).status,'quiescent');
});
for(const drift of ['runtime','approval'])test(`prepared ${drift} drift refuses GO but persists physical identity for exact cleanup recovery`,async t=>{
 const f=await fixture(t),h=f.manager.forContext(f.context).begin(f.binding);
 if(drift==='runtime')f.c.verifyCurrentWorker=()=>{throw Error('Runtime changed during preparation');};
 else f.c.store.put('goal',{...f.c.store.get('goal',f.g.id),version:f.g.version+1});
 assert.throws(()=>h.prepared(prepared(h,f.binding)),/changed|identity|runtime/i);
 const held=f.c.store.get('execution_owner',h.requestId);assert.equal(held.helperPid,10001);assert.equal(held.leaderPid,10002);assert.notEqual(held.status,'quiescent');
 writeFileSync(h.receiptPath,JSON.stringify(receipt(h,f.binding)),{mode:0o600});f.manager.reconcile({force:true});assert.equal(f.c.store.get('execution_owner',h.requestId).status,'quiescent');
});
test('a lost native owner consumes one runner lane while unrelated parallel scope remains available',()=>{
 const owner={id:'owned',status:'uncertain',goalId:'old-goal',taskId:'old-task',repository:'/owned/repo-a',writePaths:['src/']};
 const goal={id:'new-goal',manifest:{providerPolicy:{maxConcurrentTasks:2},project:{repo:'/owned/repo-b'}}},task={id:'new-task',goalId:goal.id,spec:{kind:'coding',permissions:{writePaths:['src/']}}};
 const snapshot={serviceLimit:2,executionOwners:[owner],activeTasks:[],tasks:[],goals:[goal],planning:[],requests:[]};
 assert.equal(canClaim({task,goal,snapshot}).allowed,true);assert.equal(canClaim({task,goal,snapshot:{...snapshot,serviceLimit:1}}).reasonCode,'service_task_capacity');
 assert.equal(canClaim({task,goal:{...goal,manifest:{...goal.manifest,project:{repo:owner.repository}}},snapshot}).reasonCode,'execution_scope_held');
});
test('exact quiescence restores pending integration state without inventing acceptance or changing spending',async t=>{
 const f=await fixture(t);f.c.store.put('task',{...f.c.store.get('task',f.task.id),status:'ready_to_integrate',owner:null});
 const before=f.c.getTask(f.task.id),h=f.manager.forContext(f.context).begin(f.binding);h.prepared(prepared(h,f.binding));h.uncertain('integration verifier interrupted');
 assert.equal(f.c.getTask(f.task.id).status,'uncertain');writeFileSync(h.receiptPath,JSON.stringify(receipt(h,f.binding)),{mode:0o600});f.manager.reconcile({force:true});
 const after=f.c.getTask(f.task.id);assert.equal(after.status,'ready_to_integrate');assert.deepEqual(after.spent,before.spent);assert.equal(after.deadline,before.deadline);assert.equal(after.integration,undefined);
});
function reviewedNativeCandidate(f) {
 const spec={...f.task.spec,kind:'coding'};
 const candidate = {...f.c.getTask(f.task.id),spec,hash:digest(spec), executionActor: 'codex', status: 'ready_to_integrate', owner: null,
  native: {layout: 'candidate_v1', generationId: f.task.id, round: 2, status: 'awaiting_review', writerActive: false,
   worktree: f.root, baseCommit: '1'.repeat(40), commit: '2'.repeat(40)},
  reviewed: true, reviewAcceptance: {ticketId: 'reviewed-round-2'}, result: {summary: 'Checked round two'}};
 f.c.store.put('task',candidate);
 return candidate;
}
test('integration rechecks a finished native candidate after the writer releases it',async t=>{
 const f=await fixture(t),candidate=reviewedNativeCandidate(f);
 const h=f.manager.forContext({...f.context,integrationCandidate:candidate}).begin(f.binding);
 h.prepared(prepared(h,f.binding));h.authorizeGo();
 const good=receipt(h,f.binding);writeFileSync(h.receiptPath,JSON.stringify(good),{mode:0o600});h.complete(good);
 assert.equal(f.c.store.get('execution_owner',h.requestId).status,'quiescent');
 assert.equal(f.c.getTask(candidate.id).status,'ready_to_integrate');
});
for(const drift of ['generation','round','commit','result','review','writer'])test(`native integration refuses ${drift} drift before helper GO`,async t=>{
 const f=await fixture(t),candidate=reviewedNativeCandidate(f);
 const h=f.manager.forContext({...f.context,integrationCandidate:candidate}).begin(f.binding);
 const changed=f.c.store.get('task',candidate.id);
 if(drift==='generation')changed.native.generationId='other';
 if(drift==='round')changed.native.round++;
 if(drift==='commit')changed.native.commit='3'.repeat(40);
 if(drift==='result')changed.result.summary='Different candidate';
 if(drift==='review')changed.reviewAcceptance.ticketId='replacement';
 if(drift==='writer'){changed.native.writerActive=true;changed.status='codex_active';}
 f.c.store.put('task',changed);
 assert.throws(()=>h.prepared(prepared(h,f.binding)),/identity|ownership|candidate/i);
 assert.equal(f.c.store.get('execution_owner',h.requestId).status,'uncertain');
});
test('released candidate cannot authorize writer checks or a stale integration request',async t=>{
 const f=await fixture(t),candidate=reviewedNativeCandidate(f);
 const stale={...candidate,native:{...candidate.native,round:1}};
 assert.throws(()=>f.manager.forContext({...f.context,integrationCandidate:stale}).begin(f.binding),/candidate|ownership|identity/i);
 const h=f.manager.forContext(f.context).begin(f.binding);
 assert.throws(()=>h.prepared(prepared(h,f.binding)),/writer|ownership/i);
});
test('current coordinator can explicitly resume a proven native check interruption without resetting its deadline',async t=>{
 const f=await fixture(t);f.c.acquireWorker('worker');const before=f.c.getTask(f.task.id),h=f.manager.forContext(f.context).begin(f.binding);h.prepared(prepared(h,f.binding));h.uncertain('lost callback');writeFileSync(h.receiptPath,JSON.stringify(receipt(h,f.binding)),{mode:0o600});f.manager.reconcile({force:true});
 const resumed=f.c.control({taskId:f.task.id,action:'resume'},'resume-proven');assert.equal(resumed.status,'queued');assert.equal(resumed.owner,null);assert.equal(resumed.deadline,before.deadline);assert.deepEqual(resumed.spent,before.spent);
});
test('a never-prepared owner adopts physical IDs only from its private pre-GO EOF cleanup receipt',async t=>{
 const f=await fixture(t),h=f.manager.forContext(f.context).begin(f.binding);h.uncertain('coordinator died before prepared');const good={...receipt(h,f.binding),reason:'control-eof'};
 writeFileSync(h.receiptPath,JSON.stringify({...good,reason:'exit'}),{mode:0o600});f.manager.reconcile({force:true});assert.equal(f.c.store.get('execution_owner',h.requestId).status,'uncertain');
 writeFileSync(h.receiptPath,JSON.stringify(good),{mode:0o600});f.manager.reconcile({force:true});const resolved=f.c.store.get('execution_owner',h.requestId);assert.equal(resolved.status,'quiescent');assert.equal(resolved.helperPid,10001);assert.equal(resolved.leaderPid,10002);assert.equal(resolved.physicalIdentitySource,'private-startup-receipt');
 writeFileSync(h.receiptPath,JSON.stringify({...good,helperPid:20001,leaderPid:20002}),{mode:0o600});const rev=f.c.store.revision();f.manager.reconcile({force:true});assert.equal(f.c.store.revision(),rev);assert.equal(f.c.store.get('execution_owner',h.requestId).helperPid,10001);
});
test('restart validates the complete supervisor receipt schema before releasing ownership',async t=>{
 const f=await fixture(t),h=f.manager.forContext(f.context).begin(f.binding);h.prepared(prepared(h,f.binding));h.uncertain('lost parent');
 for(const bad of [{...receipt(h,f.binding),termSignal:999},{...receipt(h,f.binding),code:256},{...receipt(h,f.binding),untrustedExtra:'ignored'}]){writeFileSync(h.receiptPath,JSON.stringify(bad),{mode:0o600});f.manager.reconcile({force:true});assert.equal(f.c.store.get('execution_owner',h.requestId).status,'uncertain');}
});
test('startup cleanup cannot adopt nonnumeric or identical physical process IDs',async t=>{
 const f=await fixture(t),h=f.manager.forContext(f.context).begin(f.binding);h.uncertain('unprepared');
 for(const ids of [{helperPid:'bad',leaderPid:'other'},{helperPid:10001,leaderPid:10001},{helperPid:-1,leaderPid:10002}]){writeFileSync(h.receiptPath,JSON.stringify({...receipt(h,f.binding),reason:'control-eof',...ids}),{mode:0o600});f.manager.reconcile({force:true});assert.equal(f.c.store.get('execution_owner',h.requestId).status,'uncertain');}
});
test('exact quiescence makes only its bound interrupted operation retryable without fabricating a check result',async t=>{
 const f=await fixture(t);f.c.store.put('operation',{id:'operation-a',key:'mutation-a',status:'uncertain',name:'native_finish',input:{taskId:f.task.id}});f.c.store.put('operation',{id:'operation-b',key:'mutation-b',status:'uncertain',name:'native_finish',input:{taskId:f.task.id}});
 const h=f.manager.forContext({...f.context,operationKey:'effect-mutation-a',operationId:'operation-a'}).begin(f.binding);h.prepared(prepared(h,f.binding));h.uncertain('lost operation callback');
 assert.equal(f.c.store.get('execution_owner',h.requestId).operationId,'operation-a');writeFileSync(h.receiptPath,JSON.stringify(receipt(h,f.binding)),{mode:0o600});f.manager.reconcile({force:true});assert.equal(f.c.store.get('operation','operation-a').status,'retryable');assert.equal(f.c.store.get('operation','operation-b').status,'uncertain');assert.equal(f.c.store.get('operation','operation-a').result,undefined);
});
for(const drift of ['stop','pause','expiry','lease'])test(`final synchronous GO authorization rejects ${drift} after prepared and remains cleanup-reconcilable`,async t=>{
 const f=await fixture(t);if(drift==='lease')f.c.acquireWorker('worker');const h=f.manager.forContext(f.context).begin(f.binding);h.prepared(prepared(h,f.binding));assert.equal(typeof h.authorizeGo,'function');assert.equal(h.authorizeGo()?.then,undefined,'GO authority must be synchronous');
 if(drift==='stop'||drift==='pause')f.c.control({taskId:f.task.id,action:drift},'late-control');
 else if(drift==='expiry')f.c.now=()=>f.c.getTask(f.task.id).deadline+1;
 else f.c.store.put('lease',{...f.c.store.get('lease','coordinator'),generation:'replacement-lease'});
 assert.throws(()=>h.authorizeGo(),/paused|stopped|deadline|lease|control|ownership/i);writeFileSync(h.receiptPath,JSON.stringify(receipt(h,f.binding)),{mode:0o600});f.manager.reconcile({force:true});assert.equal(f.c.store.get('execution_owner',h.requestId).status,'quiescent');
});
test('native check admission reserves existing runner capacity rather than launching beyond an unknown hold',async t=>{
 const f=await fixture(t);f.c.store.put('execution_owner',{id:'foreign-execution',schema:1,status:'uncertain',goalId:'foreign-goal',taskId:null,workspaceRoot:'/foreign/worktree'});
 assert.throws(()=>f.manager.forContext(f.context).begin(f.binding),/capacity|slot|occupied/i);assert.equal(f.c.store.all('execution_owner').length,1);
 f.c.store.put('capacity_config',{id:'service',limit:2});const h=f.manager.forContext(f.context).begin(f.binding);assert.equal(f.c.store.get('execution_owner',h.requestId).status,'starting');
});
test('deadline expiry cannot relabel an ownerless unknown integration check or repeatedly write its ledger',async t=>{
 const f=await fixture(t);f.c.store.put('task',{...f.c.store.get('task',f.task.id),status:'ready_to_integrate',owner:null});const h=f.manager.forContext(f.context).begin(f.binding);h.prepared(prepared(h,f.binding));h.uncertain('native integration helper disappeared');f.c.now=()=>f.c.getTask(f.task.id).deadline+1;
 const revision=f.c.store.revision();f.c.expireQuiescent();f.c.expireQuiescent();assert.equal(f.c.getTask(f.task.id).status,'uncertain');assert.equal(f.c.store.revision(),revision);assert.match(f.c.getTask(f.task.id).reason,/helper disappeared/);
});
test('GO authorization rejects a task that became uncertain or left its protected-check phase',async t=>{
 const f=await fixture(t),h=f.manager.forContext(f.context).begin(f.binding);h.prepared(prepared(h,f.binding));f.c.failTaskStep(f.task.id,'worker','failure while helper pending');assert.equal(f.c.getTask(f.task.id).status,'uncertain');assert.throws(()=>h.authorizeGo(),/phase|state|ownership|identity/i);
});
test('ownerless review transition cannot authorize stale GO and exact cleanup preserves the new review decision',async t=>{
 const f=await fixture(t);f.c.store.put('task',{...f.c.store.get('task',f.task.id),status:'awaiting_review',owner:null});const h=f.manager.forContext(f.context).begin(f.binding);h.prepared(prepared(h,f.binding));
 f.c.store.put('task',{...f.c.store.get('task',f.task.id),status:'queued',reviews:1});assert.throws(()=>h.authorizeGo(),/phase|state|ownership|identity/i);writeFileSync(h.receiptPath,JSON.stringify(receipt(h,f.binding)),{mode:0o600});f.manager.reconcile({force:true});assert.equal(f.c.getTask(f.task.id).status,'queued');assert.equal(f.c.getTask(f.task.id).reviews,1);
});
test('GO authority binds restricted check state while allowing progress-only metadata',async t=>{
 const f=await fixture(t),h=f.manager.forContext(f.context).begin(f.binding);h.prepared(prepared(h,f.binding));f.c.store.put('task',{...f.c.store.get('task',f.task.id),lastProgress:{message:'Still preparing',at:1}});assert.doesNotThrow(()=>h.authorizeGo());
 f.c.store.put('task',{...f.c.store.get('task',f.task.id),checkpoint:{...f.c.getTask(f.task.id).checkpoint,phase:'different-protected-phase'}});assert.throws(()=>h.authorizeGo(),/state|phase|identity|authority/i);
});
test('native ownership requires the exact approved copied dependency inventory hash',async t=>{
 const f=await fixture(t);for(const hash of [undefined,'bad','a'.repeat(64)]){const {bindingHash,...raw}=f.binding;if(hash===undefined)delete raw.dependencyInventoryHash;else raw.dependencyInventoryHash=hash;const binding={...raw,bindingHash:bindingDigest(raw)};assert.throws(()=>f.manager.forContext(f.context).begin(binding),/dependency|binding|identity/i);}
 assert.equal(f.c.store.all('execution_owner').length,0);
});
