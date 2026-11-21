import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Goals} from '../src/harness/goals.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {ProviderRegistry} from '../src/harness/providers/registry.mjs';

const execFileAsync=promisify(execFile);
const verdict={decision:'accept',feedback:'Meets the fixture rubric',findings:[]};
function response(res,content=JSON.stringify(verdict)){
 res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({model:'fixture',choices:[{message:{role:'assistant',content},finish_reason:'stop'}]}));
}
async function apiFixture(t,handler){
 const root=await mkdtemp(path.join(os.tmpdir(),'pb12-recovery-'));let c,posts=0;
 const server=http.createServer(async(req,res)=>{for await(const chunk of req){}posts++;await handler({req,res,c,posts});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const profile={schema:1,id:'reviewer',revision:'r1',displayName:'Fixture',transport:'openai-chat',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture',roles:['reviewer'],capabilities:{workerProtocol:null,transports:['json'],modelDiscovery:'manual',taskKinds:[]},maxContextTokens:null,maxOutputTokens:2048,concurrency:1,capacityGroup:'fixture',credentialRef:null,streaming:false};
 const providers=ProviderRegistry({profiles:[profile]});
 const open=()=>{c=new Coordinator({root,selectedHost:'cursor',providerRegistry:providers});c.acquireWorker('owner');};open();
 const close=()=>{if(c){c.releaseWorker('owner');c.close();c=null;}};
 t.after(async()=>{close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
 return {get c(){return c;},posts:()=>posts,restart(){close();open();},
  async candidate(n){
   const raw={submissionId:'goal-'+n,objective:'Fixture '+n,acceptance:['clear'],mode:'collaborative',environment:'fixture',reviewPolicy:{version:1,source:'api',reviewer:providers.get('reviewer','r1'),fallback:'wait'},limits:{hours:1,maxTasks:1,reviewAgentRuns:3}};
   const goal=c.preparePortableGoal(raw,'prepare-'+n);c.activateGoal({goalId:goal.id,hash:goal.hash},'activate-'+n);
   const task=c.submitTask({goalId:goal.id,submissionId:'task-'+n,kind:'consult',actor:'deepseek',objective:'Answer '+n,acceptance:['clear']},'task-'+n);
   assert.equal(c.claimNext('owner').id,task.id);c.completeTask(task.id,{content:'Fixture answer '+n},'owner',{reviewRequired:true});
   return {goal,task:c.getTask(task.id),raw,binding:(await c.reviewService.inbox({goalId:goal.id})).items[0].binding};
  },
  async childTick(){
   close();
   const code=`import {Coordinator} from ${JSON.stringify(new URL('../src/harness/coordinator.mjs',import.meta.url).href)};import {Worker} from ${JSON.stringify(new URL('../src/harness/worker.mjs',import.meta.url).href)};import {ProviderRegistry} from ${JSON.stringify(new URL('../src/harness/providers/registry.mjs',import.meta.url).href)};const c=new Coordinator({root:process.argv[1],selectedHost:'cursor',providerRegistry:ProviderRegistry({profiles:JSON.parse(process.argv[2])})});c.acquireWorker('child');try{const worker=new Worker({c,owner:'child'});const first=await worker.legacyReview.tick(),second=await worker.legacyReview.tick();console.log(JSON.stringify({first:first?.status??null,second:second?.status??null}));}finally{c.releaseWorker('child');c.close();}`;
   try{const {stdout}=await execFileAsync(process.execPath,['--input-type=module','-e',code,root,JSON.stringify([profile])],{encoding:'utf8',timeout:15000});return JSON.parse(stdout);}finally{open();}
  }
 };
}

for(const failure of ['http','json','verdict'])test(`known terminal API ${failure} wait does not starve a later goal across restart`,async t=>{
 const f=await apiFixture(t,({res,posts})=>posts>1?response(res):failure==='http'?res.writeHead(401).end('{}'):response(res,failure==='json'?'not-json':JSON.stringify({...verdict,command:'untrusted'})));
 const first=await f.candidate(1),second=await f.candidate(2),worker=new Worker({c:f.c,owner:'owner'});
 await assert.rejects(()=>worker.legacyReview.tick(),/failed|JSON|verdict|unknown/i);
 const original=f.c.getTask(first.task.id),ticket=f.c.store.all('review_ticket')[0];
 assert.equal(f.posts(),1);assert.equal(original.reviews,1);
 // A new process must visit goal 2 without retrying the spent request for goal 1.
 assert.equal((await f.childTick()).first,'accepted');assert.equal(f.posts(),2);
 assert.equal(f.c.getTask(second.task.id).status,'accepted');assert.equal(f.c.getTask(first.task.id).status,'awaiting_review');
 assert.equal(f.c.getTask(first.task.id).reviews,1);assert.equal(f.c.store.spent(first.task.id).apiReview,1);
 assert.equal(f.c.store.get('review_ticket',ticket.id).expiresAt,ticket.expiresAt);
 const after=new Worker({c:f.c,owner:'owner'});let attempts=0;const run=f.c.reviewService.runApi.bind(f.c.reviewService);f.c.reviewService.runApi=(...args)=>{attempts++;return run(...args);};
 for(let n=0;n<3;n++)assert.equal(await after.legacyReview.tick(),null);
 assert.equal(attempts,0,'terminal waits must not repeatedly parse or submit invalid responses');
 assert.equal(f.posts(),2);assert.equal(f.c.getTask(first.task.id).reviewWait.recovery,'operator');
});

for(const target of ['goal','task'])test(`valid API response survives supported ${target} pause/resume and process restart without spending again`,async t=>{
 let current;const f=await apiFixture(t,({res,c})=>{c.control({[target+'Id']:current[target].id,action:'pause'},'pause');response(res);});
 current=await f.candidate(1);const worker=new Worker({c:f.c,owner:'owner'});
 await assert.rejects(()=>worker.legacyReview.tick(),/not active|paused|stopped/i);
 assert.equal(f.c.store.db.prepare("SELECT status FROM requests WHERE kind='apiReview'").get().status,'completed');
 const savedTicket=f.c.store.all('review_ticket')[0],savedRequest=f.c.store.db.prepare("SELECT id,data FROM requests WHERE kind='apiReview'").get();
 assert.equal(await worker.legacyReview.tick(),null);assert.equal(f.c.getTask(current.task.id).reviewed,false);
 f.c.control({[target+'Id']:current[target].id,action:'resume'},'resume');
 const result=await f.childTick();assert.equal(result.first,'accepted');assert.equal(result.second,null);
 const task=f.c.getTask(current.task.id);assert.equal(task.reviews,1);assert.equal(task.spent.apiReview,1);assert.equal(f.posts(),1);assert.equal(task.reviewWait,undefined);
 assert.equal(task.deadline,current.task.deadline);assert.equal(f.c.store.all('review_ticket').length,1);
 assert.equal(task.reviewAcceptance.ticketId,savedTicket.id);assert.equal(f.c.store.all('review_ticket')[0].requestId,savedRequest.id);assert.equal(f.c.store.all('review_ticket')[0].expiresAt,savedTicket.expiresAt);
 assert.equal(f.c.store.db.prepare("SELECT count(*) AS n FROM requests WHERE kind='apiReview'").get().n,1);
});

for(const valid of [true,false])test(`pre-fix unclassified completed API wait is ${valid?'recovered':'rejected once'} after supported resume`,async t=>{
 let current;const f=await apiFixture(t,({res,c})=>{c.control({goalId:current.goal.id,action:'pause'},'pause');response(res,JSON.stringify(valid?verdict:{...verdict,command:'untrusted'}));});current=await f.candidate(1);
 const worker=new Worker({c:f.c,owner:'owner'});await assert.rejects(()=>worker.legacyReview.tick(),/not active|JSON|verdict/i);
 const task=f.c.getTask(current.task.id);delete task.reviewWait.reasonCode;delete task.reviewWait.recovery;task.reviewWait.reason='API review needs operator attention; saved requests remain spent and no fallback is dispatched';f.c.store.put('task',task);
 f.c.control({goalId:current.goal.id,action:'resume'},'resume');
 if(valid){assert.equal((await f.childTick()).first,'accepted');assert.equal(f.c.getTask(task.id).reviewWait,undefined);}
 else{await assert.rejects(()=>worker.legacyReview.tick(),/JSON/i);assert.equal(f.c.getTask(task.id).reviewWait.reasonCode,'invalid_response');assert.deepEqual(await f.childTick(),{first:null,second:null});assert.equal(f.c.getTask(task.id).reviewed,false);}
 assert.equal(f.posts(),1);assert.equal(f.c.getTask(task.id).reviews,1);assert.equal(f.c.store.spent(task.id).apiReview,1);
});

for(const mismatch of ['request','reviewer','generation','response'])test(`saved API ${mismatch} mismatch is rejected once and cannot loop or spend after resume`,async t=>{
 let current;const f=await apiFixture(t,({res,c})=>{c.control({taskId:current.task.id,action:'pause'},'pause');response(res);});current=await f.candidate(1);
 await assert.rejects(()=>new Worker({c:f.c,owner:'owner'}).legacyReview.tick(),/paused|stopped/i);f.c.control({taskId:current.task.id,action:'resume'},'resume');
 const row=f.c.store.db.prepare("SELECT id,data FROM requests WHERE kind='apiReview'").get(),data=JSON.parse(row.data);
 if(mismatch==='request'){const ticket=f.c.store.all('review_ticket')[0];ticket.requestId='different-request';f.c.store.put('review_ticket',ticket);}
 if(mismatch==='reviewer')data.reviewerBinding.revision='different-revision';
 if(mismatch==='generation'){const task=f.c.getTask(current.task.id);task.checkpoint.attempt=(task.checkpoint.attempt??1)+1;f.c.store.put('task',task);}
 if(mismatch==='response')data.result={};
 f.c.store.db.prepare('UPDATE requests SET data=? WHERE id=?').run(JSON.stringify(data),row.id);
 const worker=new Worker({c:f.c,owner:'owner'});await assert.rejects(()=>worker.legacyReview.tick(),/changed|stale|binding|JSON|verdict/i);
 assert.equal(f.c.getTask(current.task.id).reviewWait.recovery,'operator');assert.equal(f.c.getTask(current.task.id).reviewed,false);
 assert.deepEqual(await f.childTick(),{first:null,second:null});assert.equal(f.posts(),1);assert.equal(f.c.getTask(current.task.id).reviews,1);assert.equal(f.c.store.spent(current.task.id).apiReview,1);
});

test('completed API submission replay returns its historical receipt after a supported goal revision',async t=>{
 const f=await apiFixture(t,({res})=>response(res)),current=await f.candidate(1),accepted=await f.c.reviewService.runApi(current.binding,'historical-replay');
 const goals=new Goals(f.c),revision=goals.prepareRevision({goalId:current.goal.id,expectedHash:current.goal.hash,manifest:{...current.raw,acceptance:['current rubric']}},'revision');goals.activateRevision({revisionId:revision.id,hash:revision.hash},'activate-revision');
 assert.deepEqual(await f.c.reviewService.runApi(current.binding,'historical-replay'),accepted);
 assert.equal(f.c.getGoal(current.goal.id).version,2);assert.equal(f.c.getTask(current.task.id).goalVersion,1);assert.equal(f.c.getTask(current.task.id).reviews,1);assert.equal(f.posts(),1);
});

test('saved API response cannot outlive its original expiry after resume',async t=>{
 let current;const f=await apiFixture(t,({res,c})=>{c.control({taskId:current.task.id,action:'pause'},'pause');response(res);});current=await f.candidate(1);
 await assert.rejects(()=>new Worker({c:f.c,owner:'owner'}).legacyReview.tick(),/paused|stopped/i);f.c.control({taskId:current.task.id,action:'resume'},'resume');
 const ticket=f.c.store.all('review_ticket')[0],row=f.c.store.db.prepare("SELECT data FROM requests WHERE kind='apiReview'").get(),data=JSON.parse(row.data);f.c.now=()=>ticket.expiresAt;
 await assert.rejects(()=>f.c.reviewService.runApi(ticket.binding,data.runKey),/expiry|deadline/i);
 assert.equal(f.c.getTask(current.task.id).reviewWait.recovery,'operator');assert.equal(f.c.getTask(current.task.id).reviewed,false);assert.equal(f.posts(),1);
 assert.equal(f.c.store.get('review_ticket',ticket.id).expiresAt,ticket.expiresAt);assert.equal(f.c.getTask(current.task.id).reviews,1);
});

test('supported goal revision and rebind retire only the stale host ticket and preserve original spending and expiry',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pb12-host-rebind-')),c=new Coordinator({root,selectedHost:'cursor'});
 t.after(async()=>{c.close();await rm(root,{recursive:true,force:true});});
 const raw={submissionId:'goal',mode:'codex_only',environment:'fixture',objective:'Fixture',acceptance:['clear'],limits:{hours:1,maxTasks:1,reviewAgentRuns:3}};
 const goal=c.preparePortableGoal(raw,'prepare');c.activateGoal({goalId:goal.id,hash:goal.hash},'activate');
 const task=c.submitTask({goalId:goal.id,submissionId:'task',kind:'consult',actor:'codex',objective:'Answer',acceptance:['clear']},'task');c.startNativeText({taskId:task.id},'start');c.finishNativeText({taskId:task.id,content:'Clear answer'},'finish');
 const first=(await c.reviewService.inbox({goalId:goal.id})).items[0],old=await c.reviewService.reserve(first.binding,'reserve'),saved=c.store.get('review_ticket',old.ticketId);
 await assert.rejects(()=>c.reviewService.reserve(first.binding,'duplicate-reserve'),/already reserved/i);
 const goals=new Goals(c),revision=goals.prepareRevision({goalId:goal.id,expectedHash:goal.hash,manifest:{...raw,acceptance:['clear','current rubric']}},'revision');goals.activateRevision({revisionId:revision.id,hash:revision.hash},'activate-revision');goals.rebind({taskId:task.id},'rebind');
 await assert.rejects(()=>c.reviewService.submit({...first.binding,ticketId:old.ticketId,verdict},'stale-before'),/stale/i);
 const current=(await c.reviewService.inbox({goalId:goal.id})).items[0],fresh=await c.reviewService.reserve(current.binding,'fresh-reserve'),retired=c.store.get('review_ticket',old.ticketId);
 assert.equal(retired.status,'stale');assert.equal(retired.reasonCode,'binding_superseded');
 for(const field of ['binding','reviewer','requestId','createdAt','expiresAt'])assert.deepEqual(retired[field],saved[field]);
 assert.equal(c.getTask(task.id).reviews,2);assert.equal(c.store.all('review_ticket').length,2);assert.equal(fresh.expiresAt,old.expiresAt);
 await assert.rejects(()=>c.reviewService.submit({...first.binding,ticketId:old.ticketId,verdict},'stale-after'),/not available|stale/i);
 assert.equal(c.getTask(task.id).reviewed,false);assert.equal((await c.reviewService.submit({...current.binding,ticketId:fresh.ticketId,verdict},'fresh-submit')).status,'accepted');
});

for(const malformed of [false,true])test(`${malformed?'malformed':'uncertain'} API ledger holds other goals without dispatch after restart`,async t=>{
 const f=await apiFixture(t,({req})=>req.socket.destroy()),first=await f.candidate(1),second=await f.candidate(2),worker=new Worker({c:f.c,owner:'owner'});
 await assert.rejects(()=>worker.legacyReview.tick(),/uncertain|billed/i);
 if(malformed)f.c.store.db.prepare("UPDATE requests SET data=? WHERE kind='apiReview'").run('{malformed');
 assert.deepEqual(await f.childTick(),{first:null,second:null});assert.equal(f.posts(),1);
 assert.equal(f.c.getTask(first.task.id).reviews,1);assert.equal(f.c.getTask(second.task.id).reviews,0);assert.equal(f.c.getTask(second.task.id).status,'awaiting_review');
});

test('a completed API response with stale bindings becomes a terminal wait, never acceptance or a fresh dispatch',async t=>{
 let current;const f=await apiFixture(t,({res,c})=>{c.control({goalId:current.goal.id,action:'pause'},'pause');response(res);});current=await f.candidate(1);
 await assert.rejects(()=>new Worker({c:f.c,owner:'owner'}).legacyReview.tick(),/not active/i);
 f.c.control({goalId:current.goal.id,action:'resume'},'resume');
 const goals=new Goals(f.c),revision=goals.prepareRevision({goalId:current.goal.id,expectedHash:current.goal.hash,manifest:{...current.raw,acceptance:['current rubric']}},'revision');goals.activateRevision({revisionId:revision.id,hash:revision.hash},'activate-revision');goals.rebind({taskId:current.task.id},'rebind');
 const ticket=f.c.store.all('review_ticket')[0],binding=(await f.c.reviewService.inbox({goalId:current.goal.id})).items[0].binding;
 await assert.rejects(()=>f.c.reviewService.reserve(binding,'fresh-api-ticket'),/API review evidence/i);assert.equal(f.c.store.get('review_ticket',ticket.id).status,'reserved');
 // Resume eligibility permits one validation of saved bytes; rejection is durable.
 const worker=new Worker({c:f.c,owner:'owner'});await assert.rejects(()=>worker.legacyReview.tick(),/stale|changed|binding/i);
 assert.equal(f.c.getTask(current.task.id).reviewWait.recovery,'operator');assert.deepEqual(await f.childTick(),{first:null,second:null});
 assert.equal(f.c.getTask(current.task.id).reviewed,false);assert.equal(f.c.getTask(current.task.id).reviews,1);assert.equal(f.posts(),1);
});
