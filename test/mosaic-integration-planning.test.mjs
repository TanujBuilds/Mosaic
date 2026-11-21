// Fresh beta planner-only fixtures select a host; historical nonbeta preparation stays unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {LocalProvider} from '../src/harness/provider.mjs';
import {OvernightPreflight} from '../src/harness/overnight-preflight.mjs';
import {git} from '../src/project/process.mjs';

const plan={content:JSON.stringify({tasks:[{
 key:'final',kind:'coding',role:'final',objective:'Verify the fixture',acceptance:['Gate passes'],dependsOn:[],
 permissions:{readPaths:['gate.mjs','src/'],writePaths:['src/'],checks:['gate']},
}]})};
const unavailable=()=>Object.assign(Error('Provider unavailable'),{requestOutcome:'not_dispatched'});

async function fixture(t,{beta=false,workerProfile,verifyCurrentWorker}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'mosaic-integration-planning-')),repo=path.join(root,'repo');
 let now=Date.UTC(2026,10,10);
 const c=new Coordinator({root:path.join(root,'state'),now:()=>now,beta,...(beta?{selectedHost:'codex'}:{}),workerProfile,verifyCurrentWorker});
 t.after(async()=>{c.close();await rm(root,{recursive:true,force:true});});
 await mkdir(repo);await writeFile(path.join(repo,'gate.mjs'),'process.exit(0);\n');
 await git(repo,'init','-q');await git(repo,'add','.');
 await git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','base');
 const config={environment:'fixture',codexPath:process.execPath};
 const checksFactory=()=>({verify:async()=>({fixture:true}),run:async checks=>checks.map(({id})=>({id,passed:true}))});
 const goal=c.prepareGoal({submissionId:'planner',objective:'Plan safely',acceptance:['Preserve boundaries'],
  environment:'fixture',mode:'overnight_review',modeVersion:2,overnightPolicy:{preflightCheckIds:['gate'],finalOnlyCheckIds:[],reconnectMs:30000},
  project:{repo,baseCommit:await git(repo,'rev-parse','HEAD'),readPaths:['gate.mjs','src/'],writePaths:['src/'],checks:[{id:'gate',argv:[process.execPath,'gate.mjs']}]},
 },'prepare');
 const receipt=await new OvernightPreflight({c,config,checksFactory}).run({goalId:goal.id,hash:goal.hash},'preflight');
 assert.equal(receipt.passed,true,JSON.stringify(receipt));
 c.activateGoal({goalId:goal.id,hash:goal.hash},'activate');
 const owner='planner-original';c.acquireWorker(owner);
 const worker=provider=>new Worker({c,config,checksFactory,owner,provider});
 return {c,goal,owner,worker,setNow:value=>{now=value;},state:()=>c.store.get('planning',goal.id),
  replace:()=>{c.releaseWorker(owner);c.acquireWorker('planner-replacement');}};
}

for(const boundary of ['pause','stop','cutoff','deadline','replacement'])test(`planner readiness preserves original state at ${boundary}`,async t=>{
 const f=await fixture(t),entered=Promise.withResolvers(),finish=Promise.withResolvers();let calls=0;
 const w=f.worker({complete:async()=>{calls++;throw unavailable();},availability:async()=>{entered.resolve();return finish.promise;}});
 await w.planner.tick();const before=f.state();f.setNow(before.providerWait.retryAt);
 const pending=w.planner.tick();await entered.promise;
 if(boundary==='cutoff')f.setNow(before.providerWait.until);
 else if(boundary==='deadline')f.setNow(f.c.getGoal(f.goal.id).deadline);
 else if(boundary==='replacement')f.replace();
 else f.c.control({goalId:f.goal.id,action:boundary},'control');
 const snapshot=f.state();finish.resolve(true);
 if(boundary==='replacement')await assert.rejects(pending,/lease|ownership/i);else await pending;
 const after=f.state();assert.equal(calls,1);assert.equal(f.c.store.spent(f.goal.id).model,1);
 assert.equal(after.attempt,before.attempt);assert.deepEqual(after.providerWait,before.providerWait);
 if(boundary==='replacement')assert.deepEqual(after,snapshot);
 else assert.equal(after.status,['cutoff','deadline'].includes(boundary)?'blocked':'queued');
});

for(const control of ['pause','stop'])test(`saved planner response survives ${control} and explicit resume without another request`,async t=>{
 const f=await fixture(t),entered=Promise.withResolvers(),finish=Promise.withResolvers();let calls=0;
 const w=f.worker({complete:async()=>{calls++;entered.resolve();return finish.promise;}});
 const pending=w.planner.tick();await entered.promise;
 f.c.control({goalId:f.goal.id,action:control},'hold');finish.resolve(plan);await pending;
 const request=f.c.store.request(f.goal.id,'plan-1');
 assert.equal(request.status,'completed');assert.equal(f.c.getGoal(f.goal.id).tasks.length,0);
 assert.equal(f.state().recoveryPending,true);
 f.c.control({goalId:f.goal.id,action:'resume'},'resume');await w.planner.tick();
 assert.equal(calls,1);assert.equal(f.c.store.spent(f.goal.id).model,1);
 assert.equal(f.c.store.request(f.goal.id,'plan-1').id,request.id);
 assert.equal(f.c.getGoal(f.goal.id).tasks.length,1);
 assert.equal(f.state().status,'completed');assert.equal(f.c.getGoal(f.goal.id).hash,f.goal.hash);
});

for(const outcome of ['response','unknown error','known refusal'])test(`replaced planner cannot persist a late ${outcome}`,async t=>{
 const f=await fixture(t),entered=Promise.withResolvers(),finish=Promise.withResolvers();
 const w=f.worker({complete:async()=>{entered.resolve();return finish.promise;}});
 const pending=w.planner.tick();await entered.promise;f.replace();
 const before=f.state(),request=f.c.store.request(f.goal.id,'plan-1');
 if(outcome==='response')finish.resolve(plan);
 else finish.reject(outcome==='known refusal'?unavailable():Error('socket closed'));
 await assert.rejects(pending,/lease|ownership/i);
 assert.deepEqual(f.state(),before);assert.deepEqual(f.c.store.request(f.goal.id,'plan-1'),request);
 assert.equal(f.c.getGoal(f.goal.id).tasks.length,0);assert.equal(f.c.store.spent(f.goal.id).model,1);
});

test('lease replacement after response persistence cannot materialize the saved plan',async t=>{
 const f=await fixture(t),emit=f.c.emit.bind(f.c);
 f.c.emit=(type,...args)=>{const result=emit(type,...args);if(type==='planning.saved')f.replace();return result;};
 await assert.rejects(f.worker({complete:async()=>plan}).planner.tick(),/lease|ownership/i);
 assert.equal(f.c.store.request(f.goal.id,'plan-1').status,'completed');
 assert.equal(f.state().status,'uncertain');assert.equal(f.c.getGoal(f.goal.id).tasks.length,0);
 f.c.recoverPlanning(f.goal.id,'planner-replacement');
 await new Worker({c:f.c,owner:'planner-replacement',config:{environment:'fixture'},provider:{complete:()=>assert.fail('saved reply must be reused')}}).planner.tick();
 assert.equal(f.c.getGoal(f.goal.id).tasks.length,1);assert.equal(f.c.store.spent(f.goal.id).model,1);
});

for(const replacement of ['released','same token, new generation'])test(`planner completion remains fenced when lease is ${replacement}`,async t=>{
 const f=await fixture(t),entered=Promise.withResolvers(),finish=Promise.withResolvers();
 const pending=f.worker({complete:async()=>{entered.resolve();return finish.promise;}}).planner.tick();
 await entered.promise;f.c.releaseWorker(f.owner);
 if(replacement!=='released')f.c.acquireWorker(f.owner);
 const before=f.state(),request=f.c.store.request(f.goal.id,'plan-1');
 finish.resolve(plan);await assert.rejects(pending,/lease|ownership/i);
 assert.deepEqual(f.state(),before);assert.deepEqual(f.c.store.request(f.goal.id,'plan-1'),request);
});

test('beta planner retains the approved profile and expected model through saved response reuse',async t=>{
 const profile={baseUrl:'http://127.0.0.1:9/v1',model:'fixture-alias',displayName:'Fixture API',revision:'fixture-v1',streaming:false};
 const f=await fixture(t,{beta:true,workerProfile:profile});let calls=0;
 const w=f.worker({complete:async(messages,options)=>{
  calls++;assert.equal(options.expectedModel,profile.model);
  assert.equal(Object.hasOwn(JSON.parse(messages.at(-1).content).goal,'workerProfile'),false);
  f.c.control({goalId:f.goal.id,action:'pause'},'hold-profile');return {...plan,requestedModel:profile.model};
 }});
 await w.planner.tick();const saved=f.c.store.request(f.goal.id,'plan-1');
 assert.deepEqual(saved.workerProfile,profile);
 f.c.control({goalId:f.goal.id,action:'resume'},'resume-profile');await w.planner.tick();
 assert.equal(calls,1);assert.equal(f.state().status,'completed');
 assert.deepEqual(f.c.store.request(f.goal.id,'plan-1').workerProfile,profile);
});

test('beta planner rechecks binding at dispatch and never posts on a changed profile',async t=>{
 const profile={baseUrl:'http://127.0.0.1:9/v1',model:'fixture-model',displayName:'Fixture API',revision:'fixture-v1',streaming:false};
 const f=await fixture(t,{beta:true,workerProfile:profile});let posts=0;
 const w=f.worker({complete:async(messages,options)=>{
  f.c.workerProfile={...profile,revision:'fixture-v2'};
  options.onModel(profile.model);posts++;return plan;
 }});
 await w.planner.tick();assert.equal(posts,0);assert.equal(f.state().status,'blocked');
 assert.equal(f.c.store.spent(f.goal.id).model,1);
 assert.deepEqual(f.c.store.request(f.goal.id,'plan-1').workerProfile,profile);
 assert.equal(f.c.store.request(f.goal.id,'plan-1').requestOutcome,'not_dispatched');
});

test('beta profile change after response persistence blocks materialization without requeueing the saved response',async t=>{
 const profile={baseUrl:'http://127.0.0.1:9/v1',model:'fixture-model',displayName:'Fixture API',revision:'fixture-v1',streaming:false};
 const f=await fixture(t,{beta:true,workerProfile:profile}),emit=f.c.emit.bind(f.c);
 f.c.emit=(type,...args)=>{const result=emit(type,...args);if(type==='planning.saved')f.c.workerProfile={...profile,revision:'fixture-v2'};return result;};
 await f.worker({complete:async()=>plan}).planner.tick();
 assert.equal(f.c.store.request(f.goal.id,'plan-1').status,'completed');
 assert.equal(f.state().status,'blocked');assert.equal(f.c.getGoal(f.goal.id).tasks.length,0);
});

for(const reconnect of [false,true])for(const control of ['pause','stop','deadline',...(reconnect?['cutoff']:[])]){
 test(`${reconnect?'reconnect':'initial'} planner discovery refuses POST after ${control}`,async t=>{
  const f=await fixture(t),discovery=Promise.withResolvers(),finish=Promise.withResolvers();let posts=0,gets=0;
  const server=http.createServer(async(req,res)=>{
   res.setHeader('content-type','application/json');
   if(req.url==='/v1/models'){
    gets++;if(gets===(reconnect?2:1)){discovery.resolve();await finish.promise;}
    return res.end(JSON.stringify({data:[{id:'fixture-model'}]}));
   }
   posts++;req.resume();res.end(JSON.stringify({model:'fixture-model',choices:[{message:{content:plan.content}}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const w=f.worker(reconnect?{complete:async()=>{throw unavailable();}}:null);
  let wait;
  if(reconnect){await w.planner.tick();wait=f.state().providerWait;f.setNow(wait.retryAt);}
  w.provider=new LocalProvider({baseUrl:`http://127.0.0.1:${server.address().port}/v1`});
  const pending=w.planner.tick();await discovery.promise;
  if(control==='deadline')f.setNow(f.c.getGoal(f.goal.id).deadline);
  else if(control==='cutoff')f.setNow(wait.until);
  else f.c.control({goalId:f.goal.id,action:control},'hold');
  finish.resolve();await pending;
  assert.equal(posts,0);assert.equal(f.c.getGoal(f.goal.id).tasks.length,0);
  assert.equal(f.c.store.spent(f.goal.id).model,reconnect?2:1);
  const request=f.c.store.request(f.goal.id,reconnect?'plan-2':'plan-1');
  assert.equal(request.status,'failed');assert.equal(request.requestOutcome,'not_dispatched');
  if(control==='cutoff')assert.equal(f.state().status,'blocked');
  if(control==='deadline')assert.equal(f.state().status,'partial');
  if(reconnect&&['pause','stop'].includes(control)){
   const deadline=f.c.getGoal(f.goal.id).deadline,before=f.state();
   f.setNow(wait.until);f.c.control({goalId:f.goal.id,action:'resume'},'resume-at-cutoff');
   await w.planner.tick();
   assert.equal(f.state().status,'blocked');assert.equal(f.state().owner,null);
   assert.equal(f.state().attempt,before.attempt);assert.equal(f.c.store.spent(f.goal.id).model,2);
   assert.equal(f.c.getGoal(f.goal.id).deadline,deadline);assert.equal(posts,0);
   const changes=f.c.store.db.prepare('SELECT total_changes() AS n').get().n;
   for(let i=0;i<3;i++)assert.equal(await w.planner.tick(),null);
   assert.equal(f.c.store.db.prepare('SELECT total_changes() AS n').get().n,changes);
   const next=f.c.prepareGoal({submissionId:'next',objective:'Explain recovery',acceptance:['Answer'],mode:'deepseek_only',environment:'fixture'},'next-prepare');
   f.c.activateGoal({goalId:next.id,hash:next.hash},'next-activate');
   w.provider={complete:async()=>({content:JSON.stringify({tasks:[{key:'answer',kind:'consult',objective:'Explain',acceptance:['Answer']}]})})};
   await w.planner.tick();assert.equal(f.c.getGoal(next.id).tasks.length,1);
   assert.equal(f.c.store.spent(f.goal.id).model,2);
  }
 });
}

test('old running planner with no reservation settles at the saved reconnect cutoff',async t=>{
 const f=await fixture(t),w=f.worker({complete:async()=>{throw unavailable();}});
 await w.planner.tick();const pending=f.state(),until=pending.providerWait.until;
 // Reopen the exact state left by the former reservation-guard throw.
 f.c.store.tx(()=>{pending.status='running';pending.owner=f.owner;pending.attempt=2;
  pending.reconnectUntil=until;delete pending.providerWait;f.c.store.put('planning',pending);});
 f.setNow(until);await w.planner.tick();
 assert.equal(f.state().status,'blocked');assert.equal(f.state().owner,null);
 assert.equal(f.state().attempt,2);assert.equal(f.c.store.spent(f.goal.id).model,1);
 assert.equal(await w.planner.tick(),null);
});

test('reconnect cutoff between planner claim and reservation settles without throwing or spending',async t=>{
 const f=await fixture(t),w=f.worker({complete:async()=>{throw unavailable();}});
 await w.planner.tick();const wait=f.state().providerWait;f.setNow(wait.retryAt);
 const verify=f.c.verifyWorkerBinding.bind(f.c);
 f.c.verifyWorkerBinding=goal=>{verify(goal);if(f.state().status==='running')f.setNow(wait.until);};
 w.provider={availability:async()=>true,complete:()=>assert.fail('expired reconnect must not dispatch')};
 await w.planner.tick();assert.equal(f.state().status,'blocked');assert.equal(f.state().owner,null);
 assert.equal(f.c.store.spent(f.goal.id).model,1);assert.equal(f.c.store.request(f.goal.id,'plan-2'),null);
 assert.equal(await w.planner.tick(),null);
});

test('completed reconnect response remains reusable after reconnect cutoff inside the original goal deadline',async t=>{
 const f=await fixture(t);let calls=0;
 const w=f.worker({complete:async()=>{calls++;throw unavailable();}});
 await w.planner.tick();const wait=f.state().providerWait;f.setNow(wait.retryAt);
 w.provider={availability:async()=>true,complete:async()=>{
  calls++;f.c.control({goalId:f.goal.id,action:'pause'},'pause-saved');return plan;
 }};
 await w.planner.tick();const request=f.c.store.request(f.goal.id,'plan-2');
 assert.equal(request.status,'completed');f.setNow(wait.until);
 f.c.control({goalId:f.goal.id,action:'resume'},'resume-saved');await w.planner.tick();
 assert.equal(f.state().status,'completed');assert.equal(calls,2);
 assert.equal(f.c.store.request(f.goal.id,'plan-2').id,request.id);
 assert.equal(f.c.store.spent(f.goal.id).model,2);assert.equal(f.c.getGoal(f.goal.id).tasks.length,1);
});

for(const boundary of ['between claim and reservation','existing running record'])test(`original planner deadline settles ${boundary} without starving another goal`,async t=>{
 const f=await fixture(t),deadline=f.c.getGoal(f.goal.id).deadline;
 const w=f.worker({complete:()=>assert.fail('original goal deadline must prevent dispatch')});
 if(boundary==='existing running record'){
  f.c.store.tx(()=>f.c.store.put('planning',{id:f.goal.id,goalId:f.goal.id,status:'running',attempt:1,feedback:[],owner:f.owner}));
  f.setNow(deadline);
 }else{
  const verify=f.c.verifyWorkerBinding.bind(f.c);
  f.c.verifyWorkerBinding=goal=>{verify(goal);f.setNow(deadline);};
 }
 await w.planner.tick();assert.equal(f.state().status,'partial');assert.equal(f.state().owner,null);
 assert.equal(f.state().attempt,1);assert.equal(f.c.store.spent(f.goal.id).model??0,0);
 assert.equal(f.c.getGoal(f.goal.id).deadline,deadline);
 const changes=f.c.store.db.prepare('SELECT total_changes() AS n').get().n;
 for(let i=0;i<3;i++)assert.equal(await w.planner.tick(),null);
 assert.equal(f.c.store.db.prepare('SELECT total_changes() AS n').get().n,changes);
 const next=f.c.prepareGoal({submissionId:'after-deadline',objective:'Explain recovery',acceptance:['Answer'],mode:'deepseek_only',environment:'fixture'},'after-deadline');
 f.c.activateGoal({goalId:next.id,hash:next.hash},'activate-after-deadline');
 w.provider={complete:async()=>({content:JSON.stringify({tasks:[{key:'answer',kind:'consult',objective:'Explain',acceptance:['Answer']}]})})};
 await w.planner.tick();assert.equal(f.c.getGoal(next.id).tasks.length,1);
});
