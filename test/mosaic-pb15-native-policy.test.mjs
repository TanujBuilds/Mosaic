import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeExecutionPolicy,sameExecutionBackend} from '../src/harness/execution.mjs';
import {normalizeGoal,digest,executionPolicyInputSchema,goalInputSchema} from '../src/harness/contracts.mjs';
const native=fp=>({version:1,backend:'darwin-seatbelt',backendRevision:2,runtimeFingerprint:fp});
test('native revision two strictly binds its artifact manifest fingerprint without changing historical hashes',()=>{
 const policy=native('a'.repeat(64));assert.deepEqual(normalizeExecutionPolicy(policy),policy);
 const old={submissionId:'legacy-execution',objective:'Keep legacy execution approval',acceptance:['Checked'],mode:'deepseek_only'};
 assert.equal(digest(normalizeGoal(old)),'5d3cced6c5e0dc23f7ab593224758ade402d4cd50394ea391e39360e651982d8');assert.equal(Object.hasOwn(goalInputSchema.properties,'executionPolicy'),false);
 assert.equal(sameExecutionBackend({executionPolicy:policy},{executionPolicy:native('b'.repeat(64))}),false);
 for(const value of [{...policy,runtimeFingerprint:undefined},{...policy,runtimeFingerprint:'A'.repeat(64)},{...policy,backend:'codex-sandbox'},{...policy,backendRevision:1},{...policy,executable:'/tmp/forged'},{...policy,backendRevision:3}])assert.throws(()=>normalizeExecutionPolicy(value),/execution|runtime|fingerprint/i);
 assert.ok(executionPolicyInputSchema.anyOf,'dispatch schema must discriminate native revision and fingerprint');
});
import {mkdtemp,realpath,mkdir,writeFile,rm,chmod} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Goals} from '../src/harness/goals.mjs';
import {OvernightPreflight} from '../src/harness/overnight-preflight.mjs';
import {Integration} from '../src/harness/integration.mjs';
import {integrationBinding} from '../src/harness/owner-inbox.mjs';
import {git} from '../src/project/process.mjs';
import {buildFixtureArtifact} from './fixtures/mosaic-pb15-v2-composition/artifact.mjs';
const nativeAvailable=process.platform==='darwin'&&process.arch==='arm64'&&Boolean(process.env.MOSAIC_NATIVE_TEST_NODE);
test('actual native draft revision preflight preserves old proof, rejects stale/racing drafts and active writers with zero model POSTs',{skip:!nativeAvailable,timeout:90000},async t=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'pb15-native-revision-')));let c;t.after(async()=>{c?.close();await rm(root,{recursive:true,force:true});});
 const artifact=await buildFixtureArtifact(root),repo=path.join(root,'repo');await mkdir(path.join(repo,'src'),{recursive:true});await writeFile(path.join(repo,'package.json'),'{"type":"module"}');await writeFile(path.join(repo,'src/value.mjs'),'export const value=1;\n');
 await git(repo,'init','-q');await git(repo,'add','.');await git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','base');
 await mkdir(path.join(repo,'.git/info'),{recursive:true});
 await writeFile(path.join(repo,'.git/info/exclude'),'node_modules/\n');await mkdir(path.join(repo,'node_modules'));const dependency=path.join(repo,'node_modules','fixture-tool');await writeFile(dependency,'unused dependency',{mode:0o644});
 c=new Coordinator({root:path.join(root,'state'),selectedHost:'cursor',nativeCheckRuntime:artifact.config});const config={nativeCheckRuntime:artifact.config};
 const raw={submissionId:'native-revision',objective:'Initial native approval',acceptance:['Bounded'],mode:'codex_only',environment:'fixture',executionPolicy:artifact.policy,project:{repo,baseCommit:await git(repo,'rev-parse','HEAD'),readPaths:['package.json','src/'],writePaths:['src/'],checks:[{id:'syntax',argv:[path.join(artifact.root,'node'),'--check','src/value.mjs']}]}};
 const g=c.preparePortableGoal(raw,'prepare');await c.preflightExecution({goalId:g.id,hash:g.hash},{config});c.activateGoal({goalId:g.id,hash:g.hash},'activate');const oldProof=await c.preflightExecution({goalId:g.id,hash:g.hash},{config});
 assert.match(oldProof.inputs.nativeHost?.bootId??'',/^darwin:/,'kernel probe cache must bind current verified boot');assert.equal(typeof oldProof.inputs.nativeHost.kernelRelease,'string');
 const staleInputs={...oldProof.inputs,nativeHost:{...oldProof.inputs.nativeHost,bootId:'darwin:previous-boot'}};c.store.put('native_preflight',{...oldProof,inputs:staleInputs,inputsHash:digest(staleInputs)});assert.throws(()=>c.verifyGoalBinding(c.getGoal(g.id)),/preflight/i);c.store.put('native_preflight',oldProof);
 await chmod(dependency,0o755);assert.throws(()=>c.verifyGoalBinding(c.getGoal(g.id)),/preflight/i,'dependency executable modes must invalidate cached native proof');await chmod(dependency,0o644);
 const goals=new Goals(c),a=goals.prepareRevision({goalId:g.id,expectedHash:g.hash,manifest:{...raw,objective:'Revised native approval'}},'revision-a');
 assert.throws(()=>goals.activateRevision({revisionId:a.id,hash:a.hash},'activate-without-proof'),/preflight/i);
 await c.preflightExecution({goalId:g.id,hash:a.hash},{config});assert.deepEqual(await c.preflightExecution({goalId:g.id,hash:g.hash},{config}),oldProof);goals.activateRevision({revisionId:a.id,hash:a.hash},'activate-revised');assert.equal(c.getGoal(g.id).hash,a.hash);
 await assert.rejects(c.preflightExecution({goalId:g.id,hash:'f'.repeat(64)},{config}),/exact|hash|revision/i);
 const b=goals.prepareRevision({goalId:g.id,expectedHash:a.hash,manifest:{...raw,objective:'Racing native revision'}},'revision-b'),prepared=c.executionOwnership.prepared.bind(c.executionOwnership);
 c.executionOwnership.prepared=(id,event)=>{const row=c.store.get('execution_owner',id);if(row.revisionId===b.id)c.store.put('goal_revision',{...c.store.get('goal_revision',b.id),status:'superseded'});return prepared(id,event);};
 await assert.rejects(c.preflightExecution({goalId:g.id,hash:b.hash},{config}),/changed|stale|revision/i);c.executionOwnership.prepared=prepared;
 assert.equal(c.executionOwnership.holds({goalId:g.id}).length,0,'canceled pre-GO helper cleanup must be exactly reconciled');assert.equal(c.getGoal(g.id).hash,a.hash);
 const d=goals.prepareRevision({goalId:g.id,expectedHash:a.hash,manifest:{...raw,objective:'Revision with active writer'}},'revision-d'),task=c.submitTask({goalId:g.id,submissionId:'edit',kind:'coding',objective:'Native edit',acceptance:['Bounded']},'task'),integration=new Integration({c,config});
 await integration.nativeCandidates.start(task.id);const owners=c.store.all('execution_owner').length;
 await assert.rejects(c.preflightExecution({goalId:g.id,hash:d.hash},{config}),/quiescen|owner/i);assert.equal(c.store.all('execution_owner').length,owners);
 c.control({taskId:task.id,action:'stop'},'stop');await integration.nativeCandidates.release({taskId:task.id,reason:'Fixture host confirms editing stopped'});
 const overnightRaw={...raw,submissionId:'native-overnight',mode:'overnight_review',modeVersion:2,overnightPolicy:{preflightCheckIds:['syntax'],finalOnlyCheckIds:['final']},project:{...raw.project,checks:[...raw.project.checks,{...raw.project.checks[0],id:'final'}]}},og=c.preparePortableGoal(overnightRaw,'overnight');
 await c.preflightExecution({goalId:og.id,hash:og.hash},{config});const preflight=new OvernightPreflight({c,config});await preflight.run({goalId:og.id,hash:og.hash},'overnight-preflight');c.activateGoal({goalId:og.id,hash:og.hash},'overnight-activate');
 const or=goals.prepareRevision({goalId:og.id,expectedHash:og.hash,manifest:{...overnightRaw,objective:'Revised exact overnight preflight'}},'overnight-revision');await c.preflightExecution({goalId:og.id,hash:or.hash},{config});await preflight.run({goalId:og.id,hash:or.hash},'overnight-revision-preflight');
 assert.ok(c.store.all('execution_owner').some(row=>row.operationKey==='overnight-revision-preflight'&&row.revisionId===or.id&&row.goalHash===or.hash&&row.previousHash===og.hash),'overnight proposal execution must bind draft revision rather than original approval');goals.activateRevision({revisionId:or.id,hash:or.hash},'overnight-revision-activate');
 const ug=c.preparePortableGoal({...overnightRaw,submissionId:'unknown-overnight'},'unknown-overnight'),unknown=Object.assign(Error('Unknown native supervisor outcome'),{executionOutcome:'unknown'}),failed=new OvernightPreflight({c,config,checksFactory:()=>({backendIdentity:{id:'darwin-seatbelt',revision:2},verify:async()=>{throw unknown;}})});
 await assert.rejects(failed.run({goalId:ug.id,hash:ug.hash},'unknown-preflight'),error=>error===unknown);assert.equal(c.store.get('overnight_preflight',ug.id).executionOutcome,'unknown');
 assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM requests').get().n,0);assert.ok(c.store.all('execution_owner').some(row=>row.revisionId===a.id&&row.goalHash===a.hash&&row.previousHash===g.hash&&row.status==='quiescent'));
});

test('actual native Codex-only candidate passes protected checks after host review and integrates once',
 {skip:!nativeAvailable,timeout:90000},async t=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'native-first-task-')));
 const repo=path.join(root,'repo'),artifact=await buildFixtureArtifact(root),config={nativeCheckRuntime:artifact.config};
 const c=new Coordinator({root:path.join(root,'state'),selectedHost:'cursor',...config});
 t.after(async()=>{
  const held=c.executionOwnership.holds();c.close();
  if(held.length)t.diagnostic('Retained unresolved native execution in '+root);
  else await rm(root,{recursive:true,force:true});
 });
 await mkdir(repo);await writeFile(path.join(repo,'value.mjs'),'export const value=1;\n');
 await git(repo,'init','-q');await git(repo,'config','--local','user.name','Fixture');
 await git(repo,'config','--local','user.email','fixture@example.invalid');await git(repo,'add','.');await git(repo,'commit','-qm','base');
 const goal=c.preparePortableGoal({submissionId:'first-task',objective:'Update the example',acceptance:['Check the updated file'],
  mode:'codex_only',environment:'fixture',executionPolicy:artifact.policy,reviewPolicy:{version:1,source:'host',hostId:'cursor',fallback:'wait'},
  project:{repo,baseCommit:await git(repo,'rev-parse','HEAD'),readPaths:['value.mjs'],writePaths:['value.mjs'],
   checks:[{id:'syntax',argv:[path.join(artifact.root,'node'),'--check','value.mjs']}]}},'prepare');
 await c.preflightExecution({goalId:goal.id,hash:goal.hash},{config});c.activateGoal({goalId:goal.id,hash:goal.hash},'activate');
 const task=c.submitTask({goalId:goal.id,submissionId:'edit',kind:'coding',actor:'codex',objective:'Set the value',acceptance:['Updated value']},'task');
 const integration=new Integration({c,config}),started=await integration.startNative({taskId:task.id,layout:'candidate_v1'},'start');
 await writeFile(path.join(started.native.worktree,'value.mjs'),'export const value=42;\n');
 const finished=await integration.finishNative({taskId:task.id,summary:'Set the value to 42'},'finish');
 assert.equal(finished.native.writerActive,false);
 const {binding}=(await c.reviewService.inbox({goalId:goal.id})).items[0],ticket=await c.reviewService.reserve(binding,'reserve');
 const ready=await c.reviewService.submit({...binding,ticketId:ticket.ticketId,verdict:{decision:'accept',feedback:'Checked the one-line change',findings:[]}},'review');
 const input={taskId:task.id,feedback:'Integrate the reviewed change',expectedIntegrationBinding:integrationBinding(goal,ready)};
 assert.ok(input.expectedIntegrationBinding);
 const accepted=await integration.accept(input,'integrate');
 assert.equal(accepted.status,'accepted');assert.equal(accepted.integration.candidateCommit,finished.native.commit);
 assert.deepEqual(accepted.integration.checks.map(({id,passed})=>({id,passed})),[{id:'syntax',passed:true}]);
 assert.equal(await git(repo,'show',accepted.integration.commit+':value.mjs'),'export const value=42;');
 assert.equal((await integration.accept(input,'integrate')).integration.commit,accepted.integration.commit);
 assert.equal(c.executionOwnership.holds().length,0);
});
