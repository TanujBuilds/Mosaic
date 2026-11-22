import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, goal, candidate} from './fixtures/mosaic-pb14-integration/fixture.mjs';
import {Goals} from '../src/harness/goals.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';
import {git} from '../src/project/process.mjs';
import {integrationBinding, ownerInbox} from '../src/harness/owner-inbox.mjs';

test('confirmed integration recovers the original commit when effect completion is interrupted', async t => {
 const f = await fixture(t), g = goal(f, 'replay'), a = await candidate(f, g, 'a');
 await a.finish();
 const ready = f.c.getTask(a.task.id), binding = integrationBinding(g, ready);
 assert.ok(binding);
 const input = {taskId: ready.id, feedback: 'Confirmed checked candidate', expectedIntegrationBinding: binding};
 const put = f.c.store.put.bind(f.c.store);
 f.c.store.put = (kind, value) => {
  if (kind === 'effect' && value.id === 'integration' && value.status === 'completed') throw Error('Simulated receipt interruption');
  return put(kind, value);
 };
 try { await assert.rejects(f.i.accept(input, 'integration'), /receipt interruption/); }
 finally { f.c.store.put = put; }
 const committed = f.c.getTask(ready.id);
 assert.equal(committed.status, 'accepted');
 const replay = await f.i.accept(input, 'integration');
 assert.equal(replay.integration.commit, committed.integration.commit);
 assert.equal(f.c.store.get('effect', 'integration').status, 'completed');
 assert.equal(f.c.store.events(0, 1000).filter(e => e.type === 'task.integrated' && e.task_id === ready.id).length, 1);
 await assert.rejects(f.i.accept({...input, expectedIntegrationBinding: 'stale'}, 'changed-confirmation'), /changed|binding/i);
});

test('an approved goal revision retires old acceptance without refreshing review budget', async t => {
 const f = await fixture(t), g = goal(f, 'rebound'), a = await candidate(f, g, 'a');
 await a.finish();
 const ready = f.c.getTask(a.task.id), goals = new Goals(f.c);
 assert.equal(ready.status, 'ready_to_integrate');
 const {submissionId, objective, project, environment, providerPolicy, reviewPolicy} = g.manifest;
 const revision = goals.prepareRevision({goalId: g.id, expectedHash: g.hash, manifest: {
  submissionId, objective, project, environment, providerPolicy, reviewPolicy,
  mode: g.manifest.mode.id, acceptance: ['Protected checks pass', 'Document the reviewed result'],
 }}, 'prepare-revision');
 const approved = goals.activateRevision({revisionId: revision.id, hash: revision.hash}, 'activate-revision');
 const rebound = goals.rebind({taskId: ready.id}, 'rebind');
 assert.equal(rebound.goalVersion, approved.version);
 assert.equal(rebound.reviewAcceptance, undefined);
 assert.equal(rebound.reviewed, false);
 assert.equal(rebound.reviews, ready.reviews);
 assert.equal(rebound.deadline, ready.deadline);
 assert.deepEqual(rebound.spent, ready.spent);
 assert.equal(f.c.store.get('review_ticket', ready.reviewAcceptance.ticketId).status, 'completed');
 assert.equal(integrationBinding(approved, rebound), null);
 const item = ownerInbox(f.c, {goalId: g.id}).items.find(row => row.taskId === ready.id);
 assert.ok(item && (item.kind === 'review' || item.kind === 'blocker'));
 if (item.kind === 'review') {
  const currentReview = (await f.c.reviewService.inbox({goalId: g.id})).items.find(row => row.taskId === ready.id);
  assert.equal(currentReview?.binding?.goalVersion, approved.version);
 } else assert.match(rebound.reason, /review budget exhausted/i);
});

function saveLegacyOperation(c, input, key) {
 const name='task_integrate';
 return c.store.command(key,{op:'operation.launch',name,input},()=>{
  const record={id:'original-'+key, key, name, input, taskId:input.taskId, status:'pending', createdAt:c.now()};
  c.store.put('operation',record);
  return record;
 });
}

test('startup holds an unbound legacy Beta integration until the exact candidate is confirmed', async t=>{
 let runs=0;
 const f=await fixture(t,{onRun:()=>{runs++;}});
 const g=goal(f,'legacy-confirmation'), a=await candidate(f,g,'a');
 await a.finish();
 const ready=f.c.getTask(a.task.id), input={taskId:ready.id,feedback:'Import the reviewed result'};
 const old=saveLegacyOperation(f.c,input,'old-unbound');
 const dispatcher=new Dispatcher({c:f.c,worker:{integration:f.i},config:{beta:true}});
 f.c.acquireWorker('recovery-owner');
 const baseline=runs;
 // A prior generation may have the same stable task ID and command payload.
 f.c.store.put('execution_owner',{id:'previous-generation',status:'quiescent',operationId:old.id,operationKey:'effect-'+old.key,
  taskId:ready.id,goalId:g.id,goalVersion:g.version,goalHash:g.hash,taskHash:ready.hash,integrationCandidateBinding:'0'.repeat(64)});
 try {
  await dispatcher.recoverOperations('recovery-owner');
  await dispatcher.whenIdle();
  const outcome=f.c.store.get('operation',old.id);
  assert.equal(outcome.status,'failed');
  assert.match(outcome.error,/owner_action_context.*new command key/);
  assert.equal(runs,baseline);
  assert.deepEqual(f.c.getTask(ready.id),ready);
  await assert.rejects(dispatcher.invoke('task_integrate',{...input,idempotencyKey:'new-unbound'}),/Exact owner integration binding/);
  const context=await dispatcher.invoke('owner_action_context',{goalId:g.id,taskId:ready.id});
  const confirmed=await dispatcher.invoke('task_integrate',{...input,expectedIntegrationBinding:context.candidate.binding,idempotencyKey:'fresh-confirmation'});
  await dispatcher.whenIdle();
  const result=f.c.store.get('operation',confirmed.id);
  assert.equal(result.status,'completed');
  assert.equal(result.result.integration.ownerActionBinding,context.candidate.binding);
  assert.equal(f.c.store.get('operation',old.id).status,'failed');
 } finally {f.c.releaseWorker('recovery-owner');}
});

for (const originalProof of [true,false]) test('a saved Git checkpoint is reconciled once using '+
 (originalProof?'its original native operation evidence':'fresh owner confirmation'), async t=>{
 const f=await fixture(t), g=goal(f,'original-postcommit'), a=await candidate(f,g,'a');
 await a.finish();
 const ready=f.c.getTask(a.task.id), input={taskId:ready.id,feedback:'Confirm original candidate'};
 const unrelated=saveLegacyOperation(f.c,input,'effect-old-commit');
 const old=saveLegacyOperation(f.c,input,'old-commit'), key='effect-'+old.key;
 const dispatcher=new Dispatcher({c:f.c,worker:{integration:f.i},config:{beta:true}});
 const put=f.c.store.put.bind(f.c.store);
 f.c.store.put=(kind,record)=>{
  if(kind==='task'&&record.id===ready.id&&record.status==='accepted')throw Error('Fixture stopped after Git checkpoint');
  return put(kind,record);
 };
 try {await assert.rejects(f.i.accept(input,key),/Fixture stopped after Git checkpoint/);}
 finally {f.c.store.put=put;}
 const held=f.c.getGoal(g.id);
 const head=await git(held.integration.worktree,'rev-parse','HEAD');
 assert.notEqual(head,g.manifest.project.baseCommit);
 // Recreate the identity fields retained by the native execution owner for this operation.
 const proof={id:'old-check',status:'quiescent',operationId:old.id,operationKey:key,taskId:ready.id,goalId:g.id,
  goalVersion:g.version,goalHash:g.hash,taskHash:ready.hash,integrationCandidateBinding:integrationBinding(g,ready)};
 if(originalProof)f.c.store.put('execution_owner',proof);
 const wrong=saveLegacyOperation(f.c,input,'other-command');
 await dispatcher.invoke('task_integrate',{...input,idempotencyKey:wrong.key});
 await dispatcher.whenIdle();
 assert.equal(f.c.store.get('operation',wrong.id).status,'failed');
 const request=originalProof?{...input,idempotencyKey:old.key}:
  {...input,expectedIntegrationBinding:integrationBinding(g,ready),idempotencyKey:'confirm-after-checkpoint'};
 if(originalProof){
  f.c.store.put=(kind,record)=>{
   if(kind==='effect'&&record.id===key&&record.status==='completed')throw Error('Fixture stopped after SQLite acceptance');
   return put(kind,record);
  };
  try {await assert.rejects(f.i.accept(input,key,{operationId:old.id,legacy:true}),/Fixture stopped after SQLite acceptance/);}
  finally {f.c.store.put=put;}
  assert.equal(f.c.getTask(ready.id).integration.operationId,old.id);
 }
 const op=await dispatcher.invoke('task_integrate',request);
 await dispatcher.whenIdle();
 const result=f.c.store.get('operation',op.id);
 assert.equal(result.status,'completed',result.error);
 assert.equal(result.result.integration.commit,head);
 assert.equal(result.result.integration.operationId,op.id);
 assert.equal(await git(held.integration.worktree,'rev-parse','HEAD'),head);
 assert.equal(f.c.store.events(0,1000).filter(event=>event.type==='task.integrated'&&event.task_id===ready.id).length,1);
 const completed=await dispatcher.invoke('task_integrate',request);
 assert.deepEqual(completed,result);
 const late=await dispatcher.invoke('task_integrate',{...input,idempotencyKey:unrelated.key});
 await dispatcher.whenIdle();
 const lateResult=f.c.store.get('operation',late.id);
 assert.equal(lateResult.status,'failed');
 assert.match(lateResult.error,/already has an integration receipt/);
 assert.deepEqual(f.c.getTask(ready.id).integration,result.result.integration);
});
