import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {ProviderRegistry} from '../src/harness/providers/registry.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {Goals} from '../src/harness/goals.mjs';
import {profileIdentity} from '../src/harness/providers/contracts.mjs';
import {profile,endpoint} from './fixtures/mosaic-pb13/public-fixture.mjs';
import {capacitySnapshot,inferenceWait,scopesOverlap} from '../src/harness/scheduling/capacity.mjs';

function fixture(t,{service=4,limit=4,profileLimit=limit,baseUrl='http://127.0.0.1:1/v1'}={}){
 const root=mkdtempSync(path.join(os.tmpdir(),'pb14-capacity-')),a={...profile('a',baseUrl),roles:['worker','reviewer'],concurrency:profileLimit},b={...profile('b','http://127.0.0.1:2/v1'),concurrency:limit};
 let now=Date.UTC(2026,10,11);const c=new Coordinator({root,now:()=>now,selectedHost:'codex',serviceMaxConcurrentTasks:service,providerRegistry:ProviderRegistry({profiles:[a,b],credentialResolver:()=> 'dummy-capacity-fixture'})});
 t.after(()=>{c.close();rmSync(root,{recursive:true,force:true});});
 const publicProfiles=[a,b].map(({credentialRef,...p})=>p);
 function goal(id,max=4,groupLimit=limit,extra={}){const raw={submissionId:id,objective:'Bound independent work',acceptance:['Capacity preserved'],environment:'fixture',mode:'collaborative',providerPolicy:{version:1,workers:publicProfiles,plannerWorkerId:a.id,defaultWorkerId:a.id,maxConcurrentTasks:max,capacityGroups:[{id:a.capacityGroup,limit:groupLimit},{id:b.capacityGroup,limit:groupLimit}]},...extra};const g=c.prepareGoal(raw,'prepare-'+id);return c.activateGoal({goalId:g.id,hash:g.hash},'activate-'+id);}
 function task(g,id){return c.submitTask({goalId:g.id,submissionId:id,kind:'consult',objective:'Explain',acceptance:['Bound answer']},'task-'+id);}
 return {c,root,a,b,goal,task,advance:n=>{now+=n;}};
}
test('independent goal and private service ceilings hold atomically across coordinators',t=>{
 const f=fixture(t,{service:2}),a=f.goal('a',1),b=f.goal('b',4);const a1=f.task(a,'a1'),a2=f.task(a,'a2'),b1=f.task(b,'b1'),b2=f.task(b,'b2');
 assert.equal(f.c.claimNext('owner').id,a1.id);assert.equal(f.c.claimNext('owner-b').id,b1.id);assert.equal(f.c.claimNext('third-owner'),null);
 const other=new Coordinator({root:f.root,now:f.c.now,providerRegistry:f.c.providerRegistry,serviceMaxConcurrentTasks:2});t.after(()=>other.close());assert.equal(other.claimNext('other'),null);
 assert.equal(f.c.getTask(a2.id).status,'queued');assert.equal(f.c.getTask(b2.id).status,'queued');assert.equal(capacitySnapshot(f.c).activeTasks.length,2);
});
test('reserved and ambiguous requests hold group capacity while known failure and completed release it',t=>{
 const f=fixture(t,{limit:1}),g=f.goal('requests'),a=f.task(g,'r1'),b=f.task(g,'r2');const first=f.c.claimNext('owner');assert.equal(first.id,a.id);
 const r=f.c.reserve(a.id,{key:'consult-1',kind:'model'},'owner');const next=f.c.claimNext('owner-b');assert.equal(next.id,b.id);
 assert.throws(()=>f.c.reserve(b.id,{key:'consult-1',kind:'model'},'owner-b'),e=>e.waiting&&e.reasonCode==='capacity_group_busy');assert.equal(f.c.getTask(b.id).spent.model,0);
 f.c.failModelRequest(r.id,'owner',{reason:'remote outcome unknown',outcome:'unknown',reconnect:false});assert.throws(()=>f.c.reserve(b.id,{key:'consult-1',kind:'model'},'owner-b'),/capacity/i);
 f.c.store.db.prepare("UPDATE requests SET status=\'completed\' WHERE id=?").run(r.id);const second=f.c.reserve(b.id,{key:'consult-1',kind:'model'},'owner-b');assert.equal(second.taskGeneration,f.c.getTask(b.id).runnerGeneration);
 f.c.saveRequest(second.id,{content:'known response'},'owner-b');assert.equal(capacitySnapshot(f.c).requests.length,0);
});
test('worker planner and reviewer aliases share group capacity across goals',t=>{
 const f=fixture(t,{limit:1}),g=f.goal('roles'),a=f.task(g,'role-task');f.c.claimNext('owner');const binding=f.c.getTask(a.id).providerBinding;
 for(const kind of ['model','apiReview']){
  const id='fixture-'+kind,data=kind==='apiReview'?{reviewerBinding:binding}:{providerBinding:binding};f.c.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?)').run(id,g.id,id,kind,'reserved',JSON.stringify(data));
  assert.equal(inferenceWait(f.c,g,binding).reasonCode,'capacity_group_busy');f.c.store.db.prepare('DELETE FROM requests WHERE id=?').run(id);
 }
 assert.equal(inferenceWait(f.c,g,binding),null);
});
test('generation fences obsolete request saves and preserves original deadline',t=>{
 const f=fixture(t),g=f.goal('generation'),a=f.task(g,'generation-task');const claimed=f.c.claimNext('owner'),r=f.c.reserve(a.id,{key:'consult-1',kind:'model'},'owner');assert.ok(claimed.runnerGeneration);
 const changed=f.c.store.get('task',a.id);changed.runnerGeneration++;f.c.store.put('task',changed);assert.throws(()=>f.c.saveRequest(r.id,{content:'late'},'owner'),/generation/i);assert.equal(f.c.store.request(a.id,'consult-1').status,'reserved');
 f.advance(4000000);assert.equal(f.c.claimNext('third-owner'),null);assert.equal(f.c.getTask(a.id).deadline,claimed.deadline);
});
test('contradictory active or prepared group limits and service changes reject before mutation',t=>{
 const f=fixture(t,{limit:2});f.goal('stable',2,2);assert.throws(()=>f.goal('contradiction',2,3),/capacity.*(config|limit)|contradict/i);assert.equal(f.c.store.all('goal').length,1);
 assert.throws(()=>new Coordinator({root:f.root,now:f.c.now,serviceMaxConcurrentTasks:3}),/capacity.*(active|prepared|quiescen)/i);
});
test('historical goals remain one global autonomous slot even with private opt-in ceiling',t=>{
 const f=fixture(t);const g=f.c.prepareGoal({submissionId:'legacy',objective:'Historical work',acceptance:['Sequential'],environment:'fixture',mode:'collaborative'},'legacy');f.c.activateGoal({goalId:g.id,hash:g.hash},'legacy-active');f.task(g,'legacy-one');f.task(g,'legacy-two');assert.ok(f.c.claimNext('owner'));assert.equal(f.c.claimNext('third-owner'),null);
});
test('glob scopes conservatively conflict with exact and glob file names',()=>{
 assert.equal(scopesOverlap(['src/foo*.mjs'],['src/fooX.mjs']),true);
 assert.equal(scopesOverlap(['src/foo*.mjs'],['src/bar*.mjs']),true);
 assert.equal(scopesOverlap(['src/a/'],['src/b/']),false);
 assert.equal(scopesOverlap(['**/*.mjs'],['docs/guide.md']),true);
});
test('known non-dispatch failures release inference capacity without refunding spent history',t=>{
 const f=fixture(t,{limit:1}),g=f.goal('known'),a=f.task(g,'known-a'),b=f.task(g,'known-b');f.c.claimNext('first');f.c.claimNext('second');
 const r=f.c.reserve(a.id,{key:'consult-1',kind:'model'},'first');f.c.failModelRequest(r.id,'first',{reason:'No request sent',outcome:'not_dispatched',reconnect:false});
 assert.equal(inferenceWait(f.c,g,f.c.getTask(b.id).providerBinding),null);
 assert.equal(f.c.getTask(a.id).spent.model,1);
 assert.ok(f.c.reserve(b.id,{key:'consult-1',kind:'model'},'second'));
});
test('completed reservation replay is idempotent while pending duplicate cannot spend twice',t=>{
 const f=fixture(t),g=f.goal('replay'),a=f.task(g,'replay-a');const claimed=f.c.claimNext('first');assert.equal(f.c.claimNext('first').id,claimed.id);const r=f.c.reserve(a.id,{key:'consult-1',kind:'model'},'first');
 assert.throws(()=>f.c.reserve(a.id,{key:'consult-1',kind:'model'},'first'),/ambiguous/);assert.equal(f.c.getTask(a.id).spent.model,1);
 f.c.saveRequest(r.id,{content:'Answer'},'first');assert.equal(f.c.reserve(a.id,{key:'consult-1',kind:'model'},'first').cached,true);assert.equal(f.c.getTask(a.id).spent.model,1);
});
test('actual planner reservation waits behind worker group occupancy without a request',async t=>{
 const server=await endpoint(t,'a'),f=fixture(t,{limit:1,baseUrl:server.baseUrl}),work=f.goal('work'),plan=f.goal('plan',4,1,{mode:'deepseek_only'}),a=f.task(work,'worker');
 f.c.claimNext('owner');const r=f.c.reserve(a.id,{key:'consult-1',kind:'model'},'owner');
 const worker=new Worker({c:f.c,owner:'owner',config:{environment:'fixture'}});
 const held=await worker.planner.tick();assert.equal(held.waiting,true);assert.equal(held.reasonCode,'capacity_group_busy');assert.equal(f.c.store.spent(plan.id).model??0,0);assert.equal(server.posts().length,0);
 f.c.saveRequest(r.id,{content:'Done'},'owner');f.c.completeTask(a.id,{content:'Done'},'owner');
 const result=await worker.planner.tick();assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(server.posts().length,1);assert.equal(f.c.store.spent(plan.id).model,1);
});
test('actual API reviewer and worker share aliases with no review spend while capacity waits',async t=>{
 const server=await reviewEndpoint(t),f=fixture(t,{limit:1,baseUrl:server.baseUrl}),review=f.goal('review',4,1,{reviewPolicy:{version:1,source:'api',reviewer:profileIdentity(f.a),fallback:'wait'}}),a=f.task(review,'review-a');
 f.c.claimNext('owner');f.c.completeTask(a.id,{content:'Review this'},'owner',{reviewRequired:true});
 const work=f.goal('api-worker'),b=f.task(work,'api-worker-b');f.c.claimNext('owner-b');const r=f.c.reserve(b.id,{key:'consult-1',kind:'model'},'owner-b');
 const input=(await f.c.reviewService.inbox({goalId:review.id})).items[0].binding;
 const held=await f.c.reviewService.runApi(input,'review-run');assert.equal(held.waiting,true);assert.equal(held.reasonCode,'capacity_group_busy');assert.equal(f.c.getTask(a.id).reviews,0);assert.equal(f.c.store.spent(a.id).apiReview??0,0);assert.equal(server.posts().length,0);
 f.c.saveRequest(r.id,{content:'Done'},'owner-b');f.c.completeTask(b.id,{content:'Done'},'owner-b');
 server.state.plan={decision:'accept',feedback:'Reviewed fixture',findings:[]};server.state.reply=JSON.stringify(server.state.plan);
 const result=await f.c.reviewService.runApi(input,'review-run');assert.equal(result.status,'accepted');assert.equal(server.posts().length,1);assert.equal(f.c.store.spent(a.id).apiReview,1);
});
test('draft revisions reject contradictory group configuration and preserve prepared work',t=>{
 const f=fixture(t,{limit:2}),g=f.goal('revision',2),goals=new Goals(f.c),raw={submissionId:g.manifest.submissionId,objective:g.manifest.objective,acceptance:g.manifest.acceptance,environment:'fixture',mode:'collaborative',modeVersion:1,providerPolicy:{...g.manifest.providerPolicy,capacityGroups:g.manifest.providerPolicy.capacityGroups.map(x=>({...x,limit:3}))}};
 delete raw.capabilities;delete raw.providerPolicyHash;delete raw.reviewPolicyHash;
 assert.throws(()=>goals.prepareRevision({goalId:g.id,expectedHash:g.hash,manifest:raw},'contradictory-revision'),/capacity|Unknown/);
 assert.equal(f.c.store.all('goal_revision').length,0);
});

async function reviewEndpoint(t){
 const posts=[],state={};const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;posts.push(JSON.parse(raw));res.end(JSON.stringify({model:'reported-a',choices:[{message:{role:'assistant',content:state.reply},finish_reason:'stop'}]}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 return {state,posts:()=>posts,baseUrl:'http://127.0.0.1:'+server.address().port+'/v1'};
}
test('alias profile IDs share one endpoint group and cannot multiply inference capacity',t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'pb14-alias-')),a=profile('a','http://127.0.0.1:1/v1'),b={...profile('b','http://127.0.0.1:1/v1/'),capacityGroup:a.capacityGroup};
 const registry=ProviderRegistry({profiles:[a,b]}),c=new Coordinator({root,selectedHost:'codex',providerRegistry:registry,serviceMaxConcurrentTasks:4});t.after(()=>{c.close();rmSync(root,{recursive:true,force:true});});
 const workers=registry.snapshot([{id:a.id,revision:a.revision},{id:b.id,revision:b.revision}]),policy={version:1,workers,plannerWorkerId:a.id,defaultWorkerId:a.id,maxConcurrentTasks:4,capacityGroups:[{id:a.capacityGroup,limit:1}]};
 const g=c.prepareGoal({submissionId:'aliases',objective:'Share physical endpoint',acceptance:['One slot'],environment:'fixture',mode:'collaborative',providerPolicy:policy},'aliases');c.activateGoal({goalId:g.id,hash:g.hash},'aliases-active');
 const task=c.submitTask({goalId:g.id,submissionId:'first',kind:'consult',objective:'Explain',acceptance:['Answer']},'first');c.claimNext('owner');c.reserve(task.id,{key:'consult-1',kind:'model'},'owner');
 assert.equal(inferenceWait(c,g,c.providerBinding(g,b.id)).reasonCode,'capacity_group_busy');
});
test('terminal goal unknown requests still prohibit contradictory capacity group changes',t=>{
 const f=fixture(t,{limit:1}),g=f.goal('terminal'),a=f.task(g,'terminal-a');f.c.claimNext('owner');const r=f.c.reserve(a.id,{key:'consult-1',kind:'model'},'owner');
 f.c.failModelRequest(r.id,'owner',{reason:'Unknown remote state',outcome:'unknown',reconnect:false});const saved=f.c.store.get('goal',g.id);saved.status='partial';f.c.store.put('goal',saved);
 assert.throws(()=>f.goal('terminal-conflict',4,2),/capacity.*config|contradict/i);assert.equal(capacitySnapshot(f.c).requests.length,1);
});
test('unrecorded historical default ceiling cannot widen while prepared work exists',t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'pb14-old-config-')),c=new Coordinator({root});t.after(()=>{c.close();rmSync(root,{recursive:true,force:true});});
 c.prepareGoal({submissionId:'historic-draft',objective:'Preserve prepared settings',acceptance:['No widening'],environment:'fixture',mode:'collaborative'},'historic-draft');
 assert.equal(c.store.maybe('capacity_config','service'),null);
 assert.throws(()=>new Coordinator({root,serviceMaxConcurrentTasks:4}),/quiescence/);
 assert.equal(c.store.maybe('capacity_config','service'),null);
});
test('profile ceiling applies independently when its group permits more requests',t=>{
 const f=fixture(t,{limit:4,profileLimit:1}),g=f.goal('profile-limit'),a=f.task(g,'profile-a'),b=f.task(g,'profile-b');f.c.claimNext('first');f.c.claimNext('second');f.c.reserve(a.id,{key:'consult-1',kind:'model'},'first');
 assert.throws(()=>f.c.reserve(b.id,{key:'consult-1',kind:'model'},'second'),e=>e.waiting&&e.reasonCode==='profile_capacity_busy');assert.equal(f.c.getTask(b.id).spent.model,0);
});
for(const outcome of [undefined,null,'ambiguous','unrecognized'])for(const kind of ['model','apiReview','codexReview'])test('historical failed '+kind+' '+String(outcome)+' retains capacity and terminal goal configuration',t=>{
 const f=fixture(t,{limit:1}),g=f.goal('historical-unknown'),a=f.task(g,'historical-task');
 const data={reservedAt:1,...(outcome===undefined?{}:{requestOutcome:outcome})};
 // Legacy reviewer failures persisted a failed status without outcome provenance.
 f.c.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?)').run('historical-failed',a.id,'historical-review',kind,'failed',JSON.stringify(data));
 const saved=f.c.store.get('goal',g.id);saved.status='partial';f.c.store.put('goal',saved);
 assert.equal(capacitySnapshot(f.c).requests.length,1);
 assert.equal(inferenceWait(f.c,g,f.c.providerBinding(g,f.a.id)).reasonCode,'legacy_inference_busy');
 assert.throws(()=>f.goal('historical-conflict',4,2),/capacity.*config|contradict/i);
 assert.throws(()=>new Coordinator({root:f.root,serviceMaxConcurrentTasks:3}),/quiescence/);
 assert.equal(f.c.store.spent(a.id)[kind],1);
});
for(const outcome of ['completed','not_dispatched'])test('certified failed '+outcome+' frees legacy inference capacity and quiescent settings',t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'pb14-known-legacy-')),c=new Coordinator({root});let other;t.after(()=>{other?.close();c.close();rmSync(root,{recursive:true,force:true});});
 c.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?)').run('known-failed','historical-task','legacy-review','codexReview','failed',JSON.stringify({reservedAt:1,requestOutcome:outcome}));
 assert.equal(capacitySnapshot(c).requests.length,0);assert.equal(inferenceWait(c,{manifest:{}},null),null);
 other=new Coordinator({root,serviceMaxConcurrentTasks:4});assert.equal(other.serviceMaxConcurrentTasks,4);
 assert.equal(c.store.spent('historical-task').codexReview,1);
});
for(const payload of ['{malformed','null','false','42','[]','"scalar"'])for(const status of ['reserved','failed'])test('corrupt '+status+' payload '+payload+' remains unattributed global capacity without ledger repair',t=>{
 const f=fixture(t),g=f.goal('corrupt'),a=f.task(g,'corrupt-active');f.c.claimNext('active-owner');
 f.c.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?)').run('corrupt-row',g.id,'historical','apiReview',status,payload);
 const before=f.c.store.db.prepare('SELECT * FROM requests WHERE id=?').get('corrupt-row');
 const snapshot=capacitySnapshot(f.c);assert.equal(snapshot.requests.length,1);assert.equal(snapshot.requests[0].resource,null);
 assert.throws(()=>f.c.reserve(a.id,{key:'consult-1',kind:'model'},'active-owner'),e=>e.waiting&&e.reasonCode==='legacy_inference_busy');assert.equal(f.c.getTask(a.id).spent.model,0);
 const saved=f.c.store.get('goal',g.id);saved.status='partial';f.c.store.put('goal',saved);
 assert.throws(()=>f.goal('corrupt-group-widen',4,3),/capacity.*config|contradict/i);
 assert.throws(()=>new Coordinator({root:f.root,serviceMaxConcurrentTasks:3}),/quiescence/);
 assert.deepEqual(f.c.store.db.prepare('SELECT * FROM requests WHERE id=?').get('corrupt-row'),before);
});
for(const resource of [null,'group',[],{}, {capacityGroup:'other',groupLimit:4}, {profileHash:'a'.repeat(64),capacityGroup:'other',baseUrl:'http://127.0.0.1:9/v1',profileLimit:4,groupLimit:4}])test('partial or inconsistent saved capacity resource '+JSON.stringify(resource)+' cannot declare independence',t=>{
 const f=fixture(t),g=f.goal('bad-resource'),a=f.task(g,'bad-resource-active');f.c.claimNext('active-owner');
 const binding=f.c.getTask(a.id).providerBinding,data={providerBinding:binding,capacityResource:resource};
 f.c.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?)').run('bad-resource',g.id,'historical','model','reserved',JSON.stringify(data));
 assert.equal(capacitySnapshot(f.c).requests[0].resource,null);
 assert.throws(()=>f.c.reserve(a.id,{key:'consult-1',kind:'model'},'active-owner'),e=>e.waiting&&e.reasonCode==='legacy_inference_busy');assert.equal(f.c.getTask(a.id).spent.model,0);
});
for(const status of ['reserved','failed'])test('parallel Worker supervisor holds malformed '+status+' API ticket without dispatch or repeat spend',{timeout:10000},async t=>{
 const server=await reviewEndpoint(t),f=fixture(t,{baseUrl:server.baseUrl}),g=f.goal('corrupt-supervisor',4,4,{reviewPolicy:{version:1,source:'api',reviewer:profileIdentity(f.a),fallback:'wait'}}),a=f.task(g,'corrupt-review');
 f.c.claimNext('owner');f.c.completeTask(a.id,{content:'Candidate answer'},'owner',{reviewRequired:true});
 const binding=(await f.c.reviewService.inbox({goalId:g.id})).items[0].binding;
 const ticket={id:'saved-api-ticket',requestId:'saved-api-request',taskId:a.id,goalId:g.id,binding,status:'reserved',reviewer:{source:'api'}};
 const saved=f.c.store.get('task',a.id);saved.reviews=1;f.c.store.put('task',saved);f.c.store.put('review_ticket',ticket);
 f.c.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?)').run(ticket.requestId,a.id,'api-review-corrupt','apiReview',status,'{malformed');
 const before=f.c.store.db.prepare('SELECT * FROM requests WHERE id=?').get(ticket.requestId),worker=new Worker({c:f.c,owner:'supervisor',config:{environment:'fixture'}});
 f.c.store.waitForChange=async()=>{};
 try{for(let n=0;n<3;n++)await worker.tick();}finally{await worker.close();}
 assert.equal(server.posts().length,0);assert.equal(f.c.getTask(a.id).reviews,1);assert.equal(f.c.getTask(a.id).spent.apiReview,1);assert.equal(f.c.getTask(a.id).status,'awaiting_review');
 assert.deepEqual(f.c.store.db.prepare('SELECT * FROM requests WHERE id=?').get(ticket.requestId),before);
});
