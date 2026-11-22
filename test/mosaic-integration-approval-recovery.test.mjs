import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, goal, candidate} from './fixtures/mosaic-pb14-integration/fixture.mjs';
import {Goals} from '../src/harness/goals.mjs';
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
