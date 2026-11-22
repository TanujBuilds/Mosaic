import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as turn,setTimeout as delay} from 'node:timers/promises';
import {fixture,goal as portableGoal,task as codingTask} from './fixtures/mosaic-pb14-integration/fixture.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {configureServiceCapacity} from '../src/harness/scheduling/capacity.mjs';

async function advance(worker,done){
 const deadline=performance.now()+5000;
 while(!done()&&performance.now()<deadline){
  await worker.executeTick();
  if(!done())await delay(5);
 }
 assert.ok(done(),'Supervisor reached the expected checkpoint');
}
async function startBarrier(worker,entered){
 const ready=entered.then(()=>true);
 for(let n=0;n<100;n++){
  const step=worker.executeTick();
  if(await Promise.race([ready,step.then(()=>false)]))return {step};
  await delay(5);
 }
 throw Error('Supervisor did not enter the protected barrier');
}
async function setup(t,limit){
 const f=await fixture(t);f.c.store.tx(()=>configureServiceCapacity(f.c,limit));
 // Readiness waits are irrelevant to the explicit check barrier below.
 f.c.store.waitForChange=async()=>{};
 const project={repo:f.repo,baseCommit:f.base,readPaths:['src/','checks/'],writePaths:['src/'],checks:[{id:'verify',argv:[process.execPath,'checks/verify.mjs']}]};
 const draft=f.c.prepareLegacyGoal({submissionId:'legacy-review',objective:'Review unchanged source',acceptance:['Checks pass'],mode:'overnight_review',modeVersion:1,environment:'fixture',project},'prepare-review'),g=f.c.activateGoal({goalId:draft.id,hash:draft.hash},'activate-review');
 const task=f.c.submitTask({goalId:g.id,submissionId:'code',kind:'coding',objective:'Check unchanged source',acceptance:['Checked'],permissions:{readPaths:['src/','checks/'],writePaths:['src/a.mjs'],checks:['verify']}},'submit-code');
 return {...f,g,task,submit(){const d=f.c.prepareLegacyGoal({submissionId:'legacy-consult',objective:'Independent question',acceptance:['Answer'],mode:'collaborative',environment:'fixture'},'prepare-consult'),g=f.c.activateGoal({goalId:d.id,hash:d.hash},'activate-consult');return f.c.submitTask({goalId:g.id,submissionId:'consult',kind:'consult',objective:'Answer independent question',acceptance:['Answer']},'submit-consult');}};
}
for(const phase of ['review preparation','integration checks'])for(const limit of [1,2])test(`legacy ${phase} retains global execution ownership at service limit ${limit}`,{timeout:15000},async t=>{
 const f=await setup(t,limit),entered=Promise.withResolvers(),release=Promise.withResolvers();let verifies=0,calls=0;
 const w=new Worker({c:f.c,owner:'legacy-owner',config:{environment:'fixture'},provider:{complete:async()=>{calls++;return {content:JSON.stringify({type:'submit_changes',paths:[],edits:[],summary:'No edits'})};}},reviewer:{reviewCode:async()=>({decision:phase==='review preparation'?'blocked':'accept',feedback:'Fixture review complete',unverified:[]})},checksFactory:()=>({verify:async()=>{if(++verifies===(phase==='review preparation'?2:3)){entered.resolve();await release.promise;}return {};},run:async checks=>checks.map(c=>({id:c.id,passed:true}))})});
 t.after(async()=>{release.resolve();await w.close();});
 await advance(w,()=>f.c.getTask(f.task.id).status===(phase==='review preparation'?'awaiting_legacy_review':'ready_to_integrate'));
 const {step:review}=await startBarrier(w,entered.promise);
 try{
  assert.equal(f.c.getTask(f.task.id).spent.codexReview,phase==='review preparation'?0:1,'Barrier binds the expected review phase');
  const other=f.submit();
  if(limit>1){await review;for(let n=0;n<5;n++){await w.executeTick();await turn();}}
  assert.equal(f.c.getTask(other.id).spent.model,0,'Legacy review preparation must hold the global slot');
  assert.equal(calls,1);release.resolve();await review;
  await advance(w,()=>f.c.getTask(other.id).status==='awaiting_review');assert.equal(f.c.getTask(other.id).spent.model,1);
 }finally{release.resolve();await review;await w.close();}
});

for(const outcome of ['failed-check','shutdown'])test(`legacy preparation releases its owning lane after ${outcome}`,{timeout:15000},async t=>{
 const f=await setup(t,2),entered=Promise.withResolvers(),release=Promise.withResolvers();let verifies=0;
 const w=new Worker({c:f.c,owner:'legacy-owner',config:{environment:'fixture'},provider:{complete:async()=>({content:JSON.stringify({type:'submit_changes',paths:[],edits:[],summary:'No edits'})})},reviewer:{reviewCode:async()=>({decision:'blocked',feedback:'Fixture done',unverified:[]})},checksFactory:()=>({verify:async signal=>{if(++verifies===2){entered.resolve();if(outcome==='shutdown')await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('Owned check interrupted')),{once:true}));else{await release.promise;throw Error('Fixture protected check unavailable');}}return {};},run:async checks=>checks.map(c=>({id:c.id,passed:true}))})});
 t.after(async()=>{release.resolve();await w.close();});
 await advance(w,()=>f.c.getTask(f.task.id).status==='awaiting_legacy_review');const {step:review}=await startBarrier(w,entered.promise);await review;const other=f.submit();
 assert.ok(w.nextIdleCheck(f.c.now())<=f.c.now()+5000,'In-flight legacy work retains a bounded supervisor wake');
 if(outcome==='shutdown'){await w.close();assert.equal(f.c.getTask(other.id).spent.model,0);assert.equal(w.runners.size+w.auxiliary.size,0);}
 else{release.resolve();await Promise.allSettled([...w.auxiliary.values()].map(entry=>entry.promise));await w.close();}
 // A failure before any review request needs no invented uncertainty. A fresh
 // supervisor can advance unrelated work, including after a clean shutdown.
 assert.equal(f.c.getTask(f.task.id).spent.codexReview,0);
 const replacement=new Worker({c:f.c,owner:'replacement-owner',config:{environment:'fixture'},provider:{complete:async()=>({content:'Independent fixture answer'})},reviewer:{reviewCode:async()=>({decision:'blocked',feedback:'Fixture recovered review',unverified:[]})},checksFactory:()=>({verify:async()=>({}),run:async checks=>checks.map(c=>({id:c.id,passed:true}))})});t.after(()=>replacement.close());
 try{await advance(replacement,()=>f.c.getTask(other.id).status==='awaiting_review');assert.equal(f.c.getTask(other.id).spent.model,1);}finally{await replacement.close();}
});

import {endpoint,profile} from './fixtures/mosaic-pb13/public-fixture.mjs';
import {fixture as portableFixture} from './fixtures/mosaic-pb14/runtime.mjs';
function legacyConsult(f,id='late-legacy'){
 const draft=f.c.prepareLegacyGoal({submissionId:id,objective:'Independent legacy question',acceptance:['Answer'],mode:'collaborative',environment:'fixture'},'prepare-'+id),g=f.c.activateGoal({goalId:draft.id,hash:draft.hash},'activate-'+id);
 return f.c.submitTask({goalId:g.id,submissionId:id,kind:'consult',priority:'blocking',objective:'Answer legacy question',acceptance:['Answer']},'submit-'+id);
}

test('portable requests drain before a newly queued legacy turn and portable parallelism resumes',{timeout:15000},async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b');a.state.holdPost=Promise.withResolvers();b.state.holdPost=Promise.withResolvers();
 const f=await portableFixture(t,[profile('a',a.baseUrl),profile('b',b.baseUrl)]);f.c.store.waitForChange=async()=>{};f.worker.provider={complete:async()=>({content:'Legacy fixture answer'})};
 const ta=f.submit('portable-a','worker-a'),tb=f.submit('portable-b','worker-b');
 const tick=f.worker.executeTick();await Promise.all([a.posted.promise,b.posted.promise]);await tick;
 const old=legacyConsult(f);for(let n=0;n<3;n++)await f.worker.executeTick();assert.equal(f.c.getTask(old.id).spent.model,0);
 a.state.holdPost.resolve();b.state.holdPost.resolve();await advance(f.worker,()=>f.c.getTask(old.id).status==='awaiting_review');
 for(const task of [ta,tb,old])assert.equal(f.c.getTask(task.id).spent.model,1);
 // The completed no-policy history must not force subsequent portable requests
 // back into a sequential loop: both POST barriers must enter before release.
 a.state.holdPost=Promise.withResolvers();b.state.holdPost=Promise.withResolvers();
 const tc=f.submit('portable-c','worker-a'),td=f.submit('portable-d','worker-b');
 // Inspect persisted reservations while the two independent responses are held.
 await advance(f.worker,()=>[tc,td].every(x=>f.c.getTask(x.id).spent.model===1));
 assert.equal(f.worker.runners.size,2);a.state.holdPost.resolve();b.state.holdPost.resolve();
 await advance(f.worker,()=>[tc,td].every(x=>f.c.getTask(x.id).status==='awaiting_review'));
});

test('legacy arrival during portable readiness cannot claim alongside an API review',{timeout:15000},async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b'),pa={...profile('a',a.baseUrl),roles:['worker','reviewer']},pb=profile('b',b.baseUrl),{credentialRef,...reviewer}=pa;
 pb.capabilities={...pb.capabilities,modelDiscovery:'advertised'};
 const f=await portableFixture(t,[pa,pb],{reviewPolicy:{version:1,source:'api',reviewer,fallback:'wait'}});f.c.store.waitForChange=async()=>{};
 const candidate=f.submit('candidate','worker-a');await advance(f.worker,()=>f.c.getTask(candidate.id).status==='awaiting_review');
 a.state.reply=JSON.stringify({decision:'accept',feedback:'Fixture exact candidate',findings:[]});a.state.holdPost=Promise.withResolvers();b.state.hold=Promise.withResolvers();
 const portable=f.submit('portable-ready','worker-b');const tick=f.worker.executeTick();await b.entered.promise;
 const old=legacyConsult(f);b.state.hold.resolve();await tick;
 assert.equal(f.c.getTask(old.id).startedAt,null,'Awaited admission must not claim newly queued legacy work');
 assert.equal(f.c.getTask(old.id).spent.model,0);assert.equal(f.c.autonomousParallelBusy,undefined);
 a.state.holdPost.resolve();await advance(f.worker,()=>f.c.getTask(portable.id).status==='awaiting_review');
});

test('parallel admission restores its temporary legacy fence when claim throws',{timeout:10000},async t=>{
 const a=await endpoint(t,'a'),f=await portableFixture(t,[profile('a',a.baseUrl)]);f.c.autonomousParallelBusy=false;
 const original=f.c.claimNext;f.c.claimNext=()=>{throw Error('Fixture admission failure');};
 await assert.rejects(()=>f.worker.executeParallel(),/Fixture admission failure/);assert.equal(f.c.autonomousParallelBusy,false);f.c.claimNext=original;
 const old=legacyConsult(f);f.worker.provider={complete:async()=>({content:'Legacy fixture answer'})};
 await advance(f.worker,()=>f.c.getTask(old.id).status==='awaiting_review');assert.equal(f.c.getTask(old.id).spent.model,1);
});

test('legacy planner retains the global lane through its response boundary',{timeout:10000},async t=>{
 const a=await endpoint(t,'a'),f=await portableFixture(t,[profile('a',a.baseUrl)]),entered=Promise.withResolvers(),release=Promise.withResolvers();f.c.store.waitForChange=async()=>{};
 const draft=f.c.prepareLegacyGoal({submissionId:'legacy-plan',objective:'Plan legacy work',acceptance:['Answer'],mode:'deepseek_only',environment:'fixture'},'prepare-plan'),goal=f.c.activateGoal({goalId:draft.id,hash:draft.hash},'activate-plan');
 f.worker.provider={complete:async messages=>{if(JSON.parse(messages.at(-1).content).goal){entered.resolve();await release.promise;return {content:JSON.stringify({tasks:[{key:'answer',kind:'consult',objective:'Answer legacy plan',acceptance:['Answer']}]})};}return {content:'Legacy answer'};}};
 const {step:tick}=await startBarrier(f.worker,entered.promise);await tick;const task=f.submit('portable-after-plan','worker-a');
 for(let n=0;n<3;n++)await f.worker.executeTick();assert.equal(f.c.getTask(task.id).spent.model,0);assert.equal(f.c.store.spent(goal.id).model,1);
 release.resolve();await advance(f.worker,()=>f.c.getTask(task.id).status==='awaiting_review');assert.equal(f.c.store.get('planning',goal.id).status,'completed');assert.equal(a.posts().length,1);
});


test('legacy arrival between portable coding steps drains the durable runner before taking its lane',{timeout:10000},async t=>{
 const f=await fixture(t),g=portableGoal(f,'portable-between-steps'),task=codingTask(f,g,'a',{actor:'deepseek'});
 const w=new Worker({c:f.c,owner:'supervisor',config:{environment:'fixture'},checksFactory:()=>({verify:async()=>({fixture:true}),run:async checks=>checks.map(c=>({id:c.id,passed:true}))})});t.after(()=>w.close());
 // Replace only the external completion boundary; binding and actual coding
 // attempt/model/apply/check state transitions remain production code.
 w.getProvider=()=>({complete:async()=>({model:'fixture',content:JSON.stringify({type:'submit_changes',paths:[],edits:[],summary:'No edits'})})});f.c.store.waitForChange=async()=>{};
 try{await w.executeTick();await Promise.all([...w.runners.values(),...w.auxiliary.values()].map(entry=>entry.promise));
 assert.equal(f.c.getTask(task.id).status,'running');assert.equal(f.c.getTask(task.id).checkpoint.phase,'model');assert.equal(w.runners.size,0);
 const old=legacyConsult(f,'between-steps');
 await advance(w,()=>f.c.getTask(old.id).status==='awaiting_review');
 await advance(w,()=>f.c.getTask(task.id).status==='awaiting_review');
 assert.equal(f.c.getTask(task.id).status,'awaiting_review');assert.equal(f.c.getTask(task.id).spent.model,1);assert.equal(f.c.getTask(old.id).spent.model,1);
 }finally{await w.close();}
});
