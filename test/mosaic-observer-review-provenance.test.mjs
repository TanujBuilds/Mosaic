import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Observer} from '../src/harness/observer.mjs';
import {Agents} from '../src/harness/agents.mjs';
import {Integration} from '../src/harness/integration.mjs';
import {ProviderRegistry} from '../src/harness/providers/registry.mjs';
import {profileIdentity} from '../src/harness/providers/contracts.mjs';
import {git} from '../src/project/process.mjs';
import {actorRows} from '../src/beta/observer.mjs';

// All services, repositories and requests in this entry belong to this fixture.
async function fixture(t,{hostId='cursor',api=false,coding=false,reviews=2,credentialResolver=()=> 'OWNED_SECRET_CANARY'}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'observer-review-'));
 let reply={decision:'accept',feedback:'Owned fixture meets acceptance',findings:[]},release,entered;
 let posts=0,reportedModel='reported-review-model',usage={total_tokens:0},disconnect=false;
 const server=api?http.createServer(async(req,res)=>{
  posts++;for await(const chunk of req){};
  if(entered){entered();await new Promise(resolve=>{release=resolve;});}
  if(disconnect){req.socket.destroy();return;}
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({...(reportedModel?{model:reportedModel}:{}),choices:[{message:{role:'assistant',content:JSON.stringify(reply)},finish_reason:'stop'}],...(usage?{usage}:{})}));
 }):null;
 if(server)await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const profile=api?{schema:1,id:'fixture-reviewer',revision:'r1',displayName:'Owned reviewer',transport:'openai-chat',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'requested-review-model',roles:['reviewer'],capabilities:{workerProtocol:null,transports:['json'],modelDiscovery:'manual',taskKinds:[]},maxContextTokens:8192,maxOutputTokens:2048,concurrency:1,capacityGroup:'owned-review',credentialRef:'fixture-only',streaming:false}:null;
 const providers=api?ProviderRegistry({profiles:[profile],credentialResolver}):undefined;
 const c=new Coordinator({root:path.join(root,'state'),beta:true,selectedHost:hostId,providerRegistry:providers,...(api?{workerProfile:{displayName:'Owned worker',baseUrl:'https://owned.invalid/v1',model:'fixture',revision:'r1',streaming:false}}:{})});
 t.after(async()=>{release?.();c.releaseWorker('fixture-owner');c.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await rm(root,{recursive:true,force:true});});
 let project;
 if(coding){
  const repo=path.join(root,'repo');await mkdir(repo);await writeFile(path.join(repo,'file.txt'),'base\n');
  await writeFile(path.join(repo,'check.mjs'),"import {readFileSync} from 'node:fs'; if(!['base\\n','candidate\\n','replacement\\n'].includes(readFileSync('file.txt','utf8')))process.exit(1);\n");
  await git(repo,'init','-q');await git(repo,'add','.');await git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','base');
  project={repo,baseCommit:await git(repo,'rev-parse','HEAD'),readPaths:['file.txt','check.mjs'],writePaths:['file.txt'],checks:[{id:'owned-node-check',argv:[process.execPath,'check.mjs'],timeoutMs:1000}]};
 }
 const reviewPolicy=api?{version:1,source:'api',reviewer:profileIdentity(profile),fallback:'wait'}:{version:1,source:'host',hostId,fallback:'wait'};
 const g=c.prepareGoal({submissionId:'goal',objective:'Observe saved fixture review',acceptance:['Bound review evidence'],mode:api?'collaborative':'codex_only',environment:'fixture',reviewPolicy,...(project?{project}:{}),limits:{hours:1,maxTasks:2,reviewAgentRuns:reviews}},'prepare');
 c.activateGoal({goalId:g.id,hash:g.hash},'activate');
 let task=c.submitTask({goalId:g.id,submissionId:'task',kind:coding?'coding':'consult',actor:coding?'codex':'deepseek',objective:'Owned candidate',acceptance:['Clear evidence'],limits:{reviews}},'submit');
 const integration=coding?new Integration({c,checksFactory:workspace=>({verify:async()=>({fixture:true}),run:async specs=>specs.map(spec=>{const r=spawnSync(spec.argv[0],spec.argv.slice(1),{cwd:workspace.root,encoding:'utf8',timeout:spec.timeoutMs});return {id:spec.id,passed:r.status===0,code:r.status,stdout:r.stdout,stderr:r.stderr};})})}):null;
 async function candidate(){
  if(coding){const started=await integration.startNative({taskId:task.id,layout:'candidate_v1'},'native-start');await writeFile(path.join(started.native.worktree,'file.txt'),'candidate\n');task=await integration.finishNative({taskId:task.id,summary:'Owned candidate'},'native-finish');}
  else{c.acquireWorker('fixture-owner');c.claimNext('fixture-owner');task=c.completeTask(task.id,{content:'Owned answer'},'fixture-owner',{reviewRequired:true});}
  return task;
 }
 const observer=new Observer({c});
 const snapshot=()=>observer.snapshot({goalId:g.id});
 const rows=()=>actorRows({snapshot:snapshot(),goalId:g.id});
 const reviewRow=()=>rows().find(row=>row.role==='Reviewer');
 const binding=async()=>(await c.reviewService.inbox({goalId:g.id})).items[0].binding;
 async function reserve(){const b=await binding();return c.reviewService.reserve(b,'reserve');}
 async function submit(ticket,decision='accept'){return c.reviewService.submit({...ticket.binding,ticketId:ticket.ticketId,verdict:{decision,feedback:'Owned fixture verdict',findings:[]}},'verdict');}
 return {c,g,task,root,integration,observer,candidate,snapshot,rows,reviewRow,binding,reserve,submit,posts:()=>posts,setReply:value=>{reply=value;},setResponse:(model,tokens)=>{reportedModel=model;usage=tokens;},disconnect:()=>{disconnect=true;},hold:()=>new Promise(resolve=>{entered=resolve;}),release:()=>release?.()};
}

for(const [hostId,want] of [['codex','Codex'],['claude-code','Claude Code'],['cursor','Cursor'],['antigravity','Antigravity']])test(`prepared host review is displayed as ${want} through saved tickets`,async t=>{
 const f=await fixture(t,{hostId,coding:true});await f.candidate();
 assert.equal(typeof f.snapshot().goals[0].reviewPolicy,'string');
 assert.equal(f.reviewRow()?.actor,want,'waiting common reviewer must be visible');
 assert.equal(f.reviewRow().provenance,'coordinator');
 const ticket=await f.reserve();assert.equal(f.reviewRow().status,'Reserved · waiting');
 assert.equal(f.snapshot().tasks[0].review.ticketId,ticket.ticketId);
 await f.submit(ticket);assert.match(f.snapshot().tasks[0].outcome.review,new RegExp(want+' review accepted'));
 const event=f.observer.timeline({goalId:f.g.id}).events.findLast(e=>e.type==='task.reviewed');
 assert.equal(event.actor,hostId==='codex'?'codex':null);assert.match(event.summary,new RegExp(want+' review accepted'));
 assert.equal(f.reviewRow().actor,want);
 const item=f.snapshot().needsYou.items.find(item=>item.taskId===f.task.id);
 assert.equal(item.action,'integrate');
 await assert.rejects(f.integration.accept({taskId:f.task.id,feedback:'Stale',expectedIntegrationBinding:'stale'},'stale-integrate'),/candidate or goal changed/);
 const approved={taskId:f.task.id,feedback:'Owned import',expectedIntegrationBinding:item.binding};
 const integrated=await f.integration.accept(approved,'integrate');
 assert.equal((await f.integration.accept(approved,'integrate')).integration.commit,integrated.integration.commit);
 assert.equal(f.observer.timeline({goalId:f.g.id}).events.findLast(e=>e.type==='task.integrated').actor,hostId==='codex'?'codex':null);
 assert.equal(f.snapshot().tasks[0].review.status,'integrated');assert.equal(f.snapshot().tasks[0].outcome.integrated,true);
 assert.doesNotMatch(JSON.stringify(f.snapshot().tasks[0].review),/worktree|credential|baseUrl|Owned fixture verdict/);
});

for(const [hostId,want] of [['codex','Codex'],['claude-code','Claude Code'],['cursor','Cursor'],['antigravity','Antigravity']])test(`${want} progress remains reported, becomes stale, and never supplies native tokens`,async t=>{
 const f=await fixture(t,{coding:true,hostId});await f.candidate();await f.reserve();
 let now=f.c.now();f.c.now=()=>now;
 const agents=new Agents({c:f.c}),agent=agents.register({version:1,taskId:f.task.id,actor:'codex',role:'reviewer',hostAgentId:'owned-review-agent'},'agent');
 agents.report({version:1,agentId:agent.id,status:'running',summary:'Reviewing owned evidence'},'report');
 const event=f.observer.timeline({goalId:f.g.id}).events.findLast(e=>e.type==='agent.reported');
 assert.equal(event.actor,hostId==='codex'?'codex':null);assert.match(event.summary,new RegExp(want+' reviewer'));assert.equal(event.provenance,'reported');
 assert.equal(f.reviewRow().state,'running');assert.equal(f.reviewRow().provenance,'reported');
 assert.equal(f.snapshot().tasks[0].review.identityProvenance,'unknown');
 assert.equal(f.snapshot().tasks[0].usage.reportedTokens,null);
 now+=120001;assert.equal(f.reviewRow().state,'waiting');assert.equal(f.reviewRow().provenance,'coordinator');
});

test('API review stays provider attributed before, during and after the captured response',async t=>{
 const f=await fixture(t,{api:true});await f.candidate();
 assert.equal(f.reviewRow()?.actor,'API review · fixture-reviewer');
 const started=f.hold(),pending=f.c.reviewService.runApi(await f.binding(),'api-review');await started;
 assert.equal(f.reviewRow().state,'reserved');assert.equal(f.reviewRow().provenance,'coordinator');
 f.release();await pending;
 const row=f.snapshot().tasks[0];assert.equal(row.review.status,'accepted');assert.equal(row.review.provenance,'captured');
 assert.equal(row.review.requestedModel,'requested-review-model');assert.equal(row.review.reportedModel,'reported-review-model');
 assert.equal(row.review.identityProvenance,'reported');assert.equal(row.review.usage.reportedTokens,0);
 assert.equal(f.reviewRow().actor,'API review · fixture-reviewer');assert.match(row.outcome.review,/API review accepted/);assert.doesNotMatch(row.outcome.review,/Codex/);
 const event=f.observer.timeline({goalId:f.g.id}).events.findLast(e=>e.type==='task.reviewed');assert.equal(event.actor,null);assert.match(event.summary,/API review/);assert.doesNotMatch(event.summary,/Codex/);
 const activity=f.observer.timeline({goalId:f.g.id}).events.filter(e=>e.type.startsWith('model.request.'));
 assert.equal(activity.length,2);
 for(const event of activity){assert.equal(event.actor,null);assert.match(event.summary,/API review · fixture-reviewer/);assert.equal(event.displayName,undefined);assert.equal(event.provenance,event.type==='model.request.completed'?'captured':'coordinator');}
 assert.equal(f.posts(),1);assert.doesNotMatch(JSON.stringify(f.snapshot()),/OWNED_SECRET_CANARY|credentialRef|127\.0\.0\.1/);
});

test('bound revisions and exhausted review budgets stay distinct from acceptance',async t=>{
 for(const reviews of [1,2]){
  const f=await fixture(t,{coding:true,reviews});await f.candidate();const ticket=await f.reserve();await f.submit(ticket,'revise');
  const row=f.snapshot().tasks[0];assert.equal(row.review.status,reviews===1?'blocked':'revision');
  assert.match(row.outcome.review,/requested changes/);assert.doesNotMatch(row.outcome.review,/accepted/);
  assert.equal(f.reviewRow().state,reviews===1?'blocked':'revision');
 }
});

test('changed saved candidates and invalidated or stale tickets cannot lend old acceptance',async t=>{
 for(const mutation of ['replacement','stale','invalidated','policy','acceptance']){
  const f=await fixture(t,{coding:true});await f.candidate();const ticket=await f.reserve();await f.submit(ticket);
  const task=f.c.getTask(f.task.id);
  if(mutation==='replacement'){task.result.summary='Replacement content';f.c.store.put('task',task);}
  else if(mutation==='policy'){const g=f.c.store.get('goal',f.g.id);g.manifest.reviewPolicy.hostId='codex';f.c.store.put('goal',g);}
  else if(mutation==='acceptance'){delete task.reviewAcceptance;f.c.store.put('task',task);}
  else{const saved=f.c.store.get('review_ticket',ticket.ticketId);saved.status=mutation;f.c.store.put('review_ticket',saved);}
  assert.doesNotMatch(f.snapshot().tasks[0].outcome.review,/accepted/,'old acceptance must not survive '+mutation);
 }
});

test('observer reads preserve approvals, deadlines, requests, reservations and store revision',async t=>{
 const f=await fixture(t,{coding:true});await f.candidate();await f.reserve();
 const before={revision:f.c.store.revision(),goal:f.c.getGoal(f.g.id),task:f.c.getTask(f.task.id),tickets:f.c.store.all('review_ticket'),requests:f.c.store.db.prepare('SELECT * FROM requests').all()};
 for(let i=0;i<3;i++){f.snapshot();f.rows();}
 assert.deepEqual({revision:f.c.store.revision(),goal:f.c.getGoal(f.g.id),task:f.c.getTask(f.task.id),tickets:f.c.store.all('review_ticket'),requests:f.c.store.db.prepare('SELECT * FROM requests').all()},before);
});

test('new native revision waits for its own receipt and expired reservations stay expired without writes',async t=>{
 const f=await fixture(t,{coding:true});await f.candidate();const ticket=await f.reserve();await f.submit(ticket,'revise');
 const next=await f.integration.startNative({taskId:f.task.id,layout:'candidate_v1'},'start-revision');
 assert.doesNotMatch(f.snapshot().tasks[0].outcome.review,/accepted|requested changes/);
 await writeFile(path.join(next.native.worktree,'file.txt'),'replacement\n');
 await f.integration.finishNative({taskId:f.task.id,summary:'Replacement candidate'},'finish-revision');
 assert.equal(f.reviewRow().state,'stale');assert.equal(f.snapshot().tasks[0].outcome.review,'No recorded review');
 const second=await f.c.reviewService.reserve(await f.binding(),'reserve-replacement');
 let now=f.c.now();f.c.now=()=>now;f.snapshot();const revision=f.c.store.revision();
 now=second.expiresAt;
 assert.equal(f.snapshot().tasks[0].review.status,'expired');assert.equal(f.c.store.revision(),revision);
});

test('API invalid verdicts never become host activity or acceptance',async t=>{
 const f=await fixture(t,{api:true});await f.candidate();f.setReply({decision:'accept',feedback:'Invalid extra authority',findings:[],command:'forbidden'});
 await assert.rejects(f.c.reviewService.runApi(await f.binding(),'invalid-api'));
 const row=f.snapshot().tasks[0];assert.equal(row.review.status,'blocked');assert.equal(row.review.identityProvenance,'reported');
 assert.equal(f.reviewRow().actor,'API review · fixture-reviewer');assert.equal(f.reviewRow().provenance,'captured');assert.equal(row.outcome.review,'No recorded review');
});

test('pre-POST credential failure remains coordinator evidence with unknown response metadata',async t=>{
 let lookups=0;
 const f=await fixture(t,{api:true,credentialResolver:()=>{lookups++;return Promise.reject(Error('Owned credential lookup failure'));}});
 await f.candidate();
 const binding=await f.binding();await assert.rejects(f.c.reviewService.runApi(binding,'credential-failure'),/failed.*spent/i);
 assert.equal(lookups,1);assert.equal(f.posts(),0);
 const request=f.c.store.db.prepare("SELECT * FROM requests WHERE kind='apiReview'").get(),data=JSON.parse(request.data),ticket=f.c.store.get('review_ticket',data.ticketId);
 assert.equal(request.status,'failed');assert.equal(data.requestOutcome,'not_dispatched');assert.equal(Object.hasOwn(data,'result'),false);
 assert.equal(ticket.requestId,request.id);assert.equal(ticket.status,'reserved');assert.deepEqual(ticket.binding,binding);
 const before={revision:f.c.store.revision(),goal:f.c.getGoal(f.g.id),task:f.c.getTask(f.task.id),ticket,request};
 const row=f.snapshot().tasks[0],reviewer=f.reviewRow();
 t.diagnostic(JSON.stringify({posts:f.posts(),credentialLookups:lookups,requestStatus:request.status,requestOutcome:data.requestOutcome,resultPresent:Object.hasOwn(data,'result'),ticketStatus:ticket.status,review:row.review,actorRow:reviewer,spent:before.task.spent}));
 assert.equal(row.review.status,'blocked');assert.equal(row.review.provenance,'coordinator');
 assert.equal(row.review.reportedModel,null);assert.equal(row.review.identityProvenance,'unknown');assert.equal(row.review.usage,null);
 assert.equal(reviewer.state,'blocked');assert.equal(reviewer.provenance,'coordinator');assert.equal(reviewer.actor,'API review · fixture-reviewer');
 assert.equal(row.outcome.review,'No recorded review');assert.equal(before.task.spent.apiReview,1);assert.equal(before.task.reviews,1);
 for(let i=0;i<3;i++){f.snapshot();f.rows();}
 assert.deepEqual({revision:f.c.store.revision(),goal:f.c.getGoal(f.g.id),task:f.c.getTask(f.task.id),ticket:f.c.store.get('review_ticket',ticket.id),request:f.c.store.db.prepare('SELECT * FROM requests WHERE id=?').get(request.id)},before);
 assert.equal(f.posts(),0);assert.equal(lookups,1);
});

test('API missing model and usage stay unknown while ambiguous requests remain spent',async t=>{
 const f=await fixture(t,{api:true});await f.candidate();f.setResponse(null,null);await f.c.reviewService.runApi(await f.binding(),'unknown-identity');
 const review=f.snapshot().tasks[0].review;assert.equal(review.reportedModel,null);assert.equal(review.identityProvenance,'unknown');assert.equal(review.usage.reportedTokens,null);assert.equal(review.usage.usageUnavailable,1);
 const uncertain=await fixture(t,{api:true});await uncertain.candidate();uncertain.disconnect();await assert.rejects(uncertain.c.reviewService.runApi(await uncertain.binding(),'ambiguous'));
 const row=uncertain.snapshot().tasks[0];assert.equal(row.review.status,'blocked');assert.equal(row.review.identityProvenance,'unknown');assert.equal(row.outcome.review,'No recorded review');
 const spent=uncertain.c.getTask(uncertain.task.id).spent;uncertain.rows();uncertain.snapshot();assert.deepEqual(uncertain.c.getTask(uncertain.task.id).spent,spent);assert.equal(uncertain.posts(),1);
});

test('API acceptance requires the saved response to remain bound to its current ticket',async t=>{
 const f=await fixture(t,{api:true});await f.candidate();await f.c.reviewService.runApi(await f.binding(),'api-bound');
 const request=f.c.store.db.prepare("SELECT id,data FROM requests WHERE kind='apiReview'").get(),data=JSON.parse(request.data);data.inputHash='0'.repeat(64);
 f.c.store.db.prepare('UPDATE requests SET data=? WHERE id=?').run(JSON.stringify(data),request.id);
 assert.equal(f.snapshot().tasks[0].outcome.review,'No recorded review');
});

test('cleared candidate data with retained history is unavailable rather than crashing or borrowing acceptance',async t=>{
 const f=await fixture(t,{coding:true});await f.candidate();const ticket=await f.reserve();await f.submit(ticket);
 const task=f.c.getTask(f.task.id);task.result=null;f.c.store.put('task',task);
 assert.equal(f.snapshot().tasks[0].outcome.review,'No recorded review');
});

test('provider totals retain zero and partial counts but reject invalid values and aggregate overflow',async t=>{
 const f=await fixture(t,{api:true});await f.candidate();
 const insert=(id,value)=>f.c.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?)').run(id,f.task.id,id,'model','completed',JSON.stringify({result:{usage:{total_tokens:value}}}));
 for(const [i,value] of [0,null,-1,1.5,'4',Number.MAX_SAFE_INTEGER+1].entries())insert('usage-'+i,value);
 assert.deepEqual(f.observer.usage(f.task.id),{reportedTokens:0,completedModelRequests:6,usageUnavailable:5});
 insert('max',Number.MAX_SAFE_INTEGER);assert.equal(f.observer.usage(f.task.id).reportedTokens,Number.MAX_SAFE_INTEGER);
 insert('overflow',1);assert.equal(f.observer.usage(f.task.id).reportedTokens,null);assert.equal(f.observer.usage(f.task.id).aggregateOverflow,true);
});
