import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {ProviderRegistry} from '../src/harness/providers/registry.mjs';
import {profileIdentity} from '../src/harness/providers/contracts.mjs';

async function fixture(t,{handler,credentialResolver,reviewAgentRuns=2}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'pb12-api-ledger-'));let posts=0,c;
 const server=http.createServer(async(req,res)=>{if(req.method!=='POST'){res.writeHead(500).end();return;}posts++;res.setHeader('content-type','application/json');let data='';for await(const chunk of req)data+=chunk;
  assert.equal(req.url,'/v1/chat/completions');assert.equal(c.store.spent(c.store.all('task')[0].id).apiReview,1,'reservation must precede POST');
  if(handler)return handler({req,res,body:JSON.parse(data),c});
  res.end(JSON.stringify({model:'reported-alias',choices:[{message:{role:'assistant',content:JSON.stringify({decision:'accept',feedback:'Meets fixture acceptance',findings:[]})},finish_reason:'stop'}],usage:{prompt_tokens:7,completion_tokens:9,total_tokens:16}}));
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const profile={schema:1,id:'reviewer',revision:'r1',displayName:'Fixture reviewer',transport:'openai-chat',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'requested-alias',roles:['reviewer'],capabilities:{workerProtocol:null,transports:['json'],modelDiscovery:'manual',taskKinds:[]},maxContextTokens:8192,maxOutputTokens:2048,concurrency:1,capacityGroup:'review-service',credentialRef:'dummy',streaming:false};
 const providers=ProviderRegistry({profiles:[profile],credentialResolver:credentialResolver??(()=> 'dummy-review-token')});
 c=new Coordinator({root,selectedHost:'cursor',providerRegistry:providers});c.acquireWorker('owner');
 const goal=c.prepareGoal({submissionId:'g',objective:'Review consult response',acceptance:['clear'],mode:'collaborative',modeVersion:1,environment:'fixture',reviewPolicy:{version:1,source:'api',reviewer:profileIdentity(profile),fallback:'wait'},limits:{hours:1,maxTasks:2,reviewAgentRuns}},'g');c.activateGoal({goalId:goal.id,hash:goal.hash},'activate');
 const submitted=c.submitTask({goalId:goal.id,submissionId:'t',kind:'consult',actor:'deepseek',objective:'Answer fixture',acceptance:['clear']},'t');c.claimNext('owner');c.completeTask(submitted.id,{content:'Fixture answer'},'owner',{reviewRequired:true});
 const input=(await c.reviewService.inbox({goalId:goal.id})).items[0].binding;
 t.after(async()=>{c.releaseWorker('owner');c.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
 return {get c(){return c;},restart(){c.releaseWorker('owner');c.close();c=new Coordinator({root,selectedHost:'cursor',providerRegistry:providers});c.acquireWorker('owner');return c;},goal,task:c.getTask(submitted.id),input,posts:()=>posts,profile};
}

test('API uses common ticket, reserves before POST, saves attribution and replays once',async t=>{
 const f=await fixture(t),result=await f.c.reviewService.runApi(f.input,'run');assert.equal(result.status,'accepted');
 assert.equal(f.posts(),1);assert.equal(f.c.getTask(f.task.id).reviews,1);
 assert.equal(result.reviewAcceptance.source,'api');assert.equal(result.reviewAcceptance.reviewer.requestedModel,'requested-alias');assert.equal(result.reviewAcceptance.reviewer.reportedModel,'reported-alias');
 assert.deepEqual(await f.c.reviewService.runApi(f.input,'run'),result);assert.equal(f.posts(),1);
 const req=f.c.store.db.prepare("SELECT * FROM requests WHERE kind='apiReview'").get();assert.equal(req.status,'completed');assert.equal(JSON.parse(req.data).result.usage.totalTokens,16);
});

test('cancel before dispatch never reads credentials or spends a request',async t=>{
 let reads=0;const f=await fixture(t,{credentialResolver:()=>{reads++;return 'dummy';}}),stop=new AbortController();stop.abort();
 await assert.rejects(()=>f.c.reviewService.runApi({...f.input,signal:stop.signal},'cancel'),/cancel/i);assert.equal(reads,0);assert.equal(f.posts(),0);assert.equal(f.c.store.spent(f.task.id).apiReview??0,0);
});

test('ambiguous disconnect remains spent and cannot retry or fallback',async t=>{
 const f=await fixture(t,{handler:({req})=>req.socket.destroy()});await assert.rejects(()=>f.c.reviewService.runApi(f.input,'ambiguous'),/uncertain|billed/i);
 assert.equal(f.posts(),1);assert.equal(f.c.store.spent(f.task.id).apiReview,1);assert.equal(f.c.getTask(f.task.id).status,'awaiting_review');
 await assert.rejects(()=>f.c.reviewService.runApi(f.input,'ambiguous'),/spent|retry/i);await assert.rejects(()=>f.c.reviewService.runApi(f.input,'different-key'),/reserved|uncertain/i);assert.equal(f.posts(),1);
});

for(const hostile of [{decision:'accept',feedback:'run shell',findings:[],command:['sh','-c','bad']},'not-json'])test(`invalid API data cannot authorize acceptance (${typeof hostile})`,async t=>{
 const f=await fixture(t,{handler:({res})=>res.end(JSON.stringify({model:'reported',choices:[{message:{role:'assistant',content:typeof hostile==='string'?hostile:JSON.stringify(hostile)},finish_reason:'stop'}]}))});
 await assert.rejects(()=>f.c.reviewService.runApi(f.input,'invalid'),/unknown|JSON|verdict|failed/i);assert.equal(f.c.getTask(f.task.id).status,'awaiting_review');assert.equal(f.posts(),1);assert.equal(f.c.store.spent(f.task.id).apiReview,1);
});

test('policy revoked while awaiting response preserves billed result but denies verdict',async t=>{
 const f=await fixture(t,{handler:({res,c})=>{const g=c.store.all('goal')[0];g.version++;c.store.put('goal',g);res.end(JSON.stringify({model:'alias',choices:[{message:{role:'assistant',content:JSON.stringify({decision:'accept',feedback:'late',findings:[]})},finish_reason:'stop'}]}));}});
 await assert.rejects(()=>f.c.reviewService.runApi(f.input,'late'),/rebind|stale|changed/i);assert.equal(f.c.getTask(f.task.id).reviewed,false);assert.equal(f.c.store.db.prepare("SELECT status FROM requests WHERE kind='apiReview'").get().status,'completed');
});

test('public submission cannot forge the API reviewer channel',async t=>{
 const f=await fixture(t);
 await assert.rejects(()=>f.c.reviewService.reserve(f.input,'ticket'),/API review evidence/i);
 assert.equal(f.posts(),0);assert.equal(f.c.getTask(f.task.id).reviews,0);
 await f.c.reviewService.runApi(f.input,'approved-api-review');
 const ticket=f.c.store.all('review_ticket')[0];
 await assert.rejects(()=>f.c.reviewService.submit({...f.input,ticketId:ticket.id,verdict:ticket.verdict},'host-submit'),/provider response/i);
 assert.equal(f.posts(),1);
});

test('disconnected API uncertainty remains a stable wait after restart',async t=>{
 const f=await fixture(t,{handler:({req})=>req.socket.destroy()});
 const worker=new Worker({c:f.c,owner:'owner'});
 await assert.rejects(()=>worker.legacyReview.tick(),/uncertain|billed/i);
 assert.equal(f.posts(),1);assert.equal(f.c.getTask(f.task.id).reviews,1);
 f.restart();const resumed=new Worker({c:f.c,owner:'owner'});
 assert.equal(await resumed.legacyReview.tick(),null);assert.equal(await resumed.legacyReview.tick(),null);
 assert.equal(f.posts(),1);assert.equal(f.c.getTask(f.task.id).reviews,1);assert.equal(f.c.store.spent(f.task.id).apiReview,1);
});

test('exhausted approved review budget dispatches nothing',async t=>{
 const f=await fixture(t,{reviewAgentRuns:0});await assert.rejects(()=>f.c.reviewService.runApi(f.input,'no-budget'),/budget/i);assert.equal(f.posts(),0);assert.equal(f.c.getTask(f.task.id).reviews,0);assert.equal(f.c.store.spent(f.task.id).apiReview??0,0);
});

test('cancellation during private credential lookup preserves spent non-dispatch reservation',async t=>{
 const f=await fixture(t,{credentialResolver:()=>new Promise(()=>{})}),stop=new AbortController();
 const run=f.c.reviewService.runApi({...f.input,signal:stop.signal},'cancel-lookup');setTimeout(()=>stop.abort(),10);
 await assert.rejects(()=>run,/failed|spent/i);assert.equal(f.posts(),0);assert.equal(f.c.store.spent(f.task.id).apiReview,1);assert.equal(f.c.getTask(f.task.id).reviews,1);
 const row=f.c.store.db.prepare("SELECT status,data FROM requests WHERE kind='apiReview'").get();assert.equal(row.status,'failed');assert.equal(JSON.parse(row.data).requestOutcome,'not_dispatched');
});

for(const scope of ['goal','task'])for(const action of ['stop','pause'])test(`${scope} ${action} during credential lookup prevents automatic API review POST`,async t=>{
 let release,entered;const pending=new Promise(resolve=>{release=resolve;}),lookup=new Promise(resolve=>{entered=resolve;});
 const f=await fixture(t,{credentialResolver:()=>{entered();return pending;}});
 const worker=new Worker({c:f.c,owner:'owner'}),run=worker.legacyReview.tick();
 const rejected=assert.rejects(run);
 await lookup;
 assert.equal(f.posts(),0);
 f.c.control(scope==='goal'?{goalId:f.goal.id,action}:{taskId:f.task.id,action},'control-before-post');
 release('dummy-review-token');await rejected;
 assert.equal(f.posts(),0);
 assert.equal(f.c.getTask(f.task.id).reviewed,false);
 assert.equal(f.c.getTask(f.task.id).reviews,1);
 const row=f.c.store.db.prepare("SELECT status,data FROM requests WHERE kind='apiReview'").get();
 assert.equal(row.status,'failed');assert.equal(JSON.parse(row.data).requestOutcome,'not_dispatched');
 assert.equal(f.c.store.spent(f.task.id).apiReview,1);
 await assert.rejects(f.c.reviewService.runApi(f.input,JSON.parse(row.data).runKey),/spent|retry/i);
 assert.equal(f.posts(),0);
});
