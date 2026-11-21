import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {ProviderRegistry} from '../src/harness/providers/registry.mjs';
import {git} from '../src/project/process.mjs';

// Scripted inference/review; real workspace, protected checks and Git integration.
const file='src/value.mjs',original='export const value = 0;\n',fixed='export const value = 42;\n';
async function fixture(t,beta,{api=false}={}) {
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'mosaic-pb12-composition-'))),repo=path.join(root,'repo'),state=path.join(root,'state');
 const calls=[];
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=raw?JSON.parse(raw):null;calls.push({url:req.url,body});res.setHeader('content-type','application/json');
  if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'fixture-worker'}]}));
  if(body.model==='fixture-reviewer')return res.end(JSON.stringify({model:'reported-reviewer-alias',choices:[{message:{role:'assistant',content:JSON.stringify({decision:'accept',feedback:'Scripted API assessment of protected evidence',findings:[]})},finish_reason:'stop'}],usage:{prompt_tokens:31,completion_tokens:8,total_tokens:39}}));
  const inventory=JSON.parse(body.messages.at(-1).content).inventory;
  res.end(JSON.stringify({model:'fixture-worker',choices:[{message:{role:'assistant',content:JSON.stringify({type:'submit_changes',paths:[],summary:'Return the required value',edits:[{path:file,action:'write',baseHash:inventory.find(x=>x.path===file).hash,content:fixed}]})},finish_reason:'stop'}],usage:{prompt_tokens:11,completion_tokens:5,total_tokens:16}}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
 const outsideMarker='OUTSIDE_REVIEW_SCOPE_CANARY';
 const profile={schema:1,id:'worker',revision:'r1',displayName:'Scripted worker',transport:'openai-chat',baseUrl,model:'fixture-worker',roles:['worker'],capabilities:{workerProtocol:'mosaic-structured-v1',transports:['json'],modelDiscovery:'advertised',taskKinds:['coding']},maxContextTokens:null,maxOutputTokens:2048,concurrency:1,capacityGroup:'fixture-service',credentialRef:null,streaming:false};
 const reviewer={...profile,id:'reviewer',displayName:'Scripted reviewer',model:'fixture-reviewer',roles:['reviewer'],capabilities:{workerProtocol:null,transports:['json'],modelDiscovery:'manual',taskKinds:[]}};
 let c,d,worker,generation=0,owner,seq=0;
 const connect=()=>{c=new Coordinator({root:state,beta,selectedHost:'cursor',providerRegistry:ProviderRegistry({profiles:[profile,reviewer]})});owner=`composition-${++generation}`;c.acquireWorker(owner);worker=new Worker({c,owner,config:{environment:'fixture',beta}});d=new Dispatcher({c,worker,config:{environment:'fixture',beta}});};
 connect();
 t.after(async()=>{await d.whenIdle();c.releaseWorker(owner);c.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
 await mkdir(path.join(repo,'src'),{recursive:true});await mkdir(path.join(repo,'checks'));
 await writeFile(path.join(repo,file),original);
 await writeFile(path.join(repo,'outside.txt'),outsideMarker);
 await writeFile(path.join(repo,'checks/value.mjs'),"import assert from 'node:assert/strict';import {value} from '../src/value.mjs';assert.equal(value,42);\n");
 await git(repo,'init','-q');await git(repo,'add','.');await git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','base');
 const project={repo,baseCommit:await git(repo,'rev-parse','HEAD'),readPaths:['src/','checks/'],writePaths:['src/'],checks:[{id:'value-check',argv:[process.execPath,'checks/value.mjs'],timeoutMs:10000}],behavioralChecks:[{criterionId:'value',description:'Returns the approved value',checkIds:['value-check']}]};
 const invoke=(name,input={})=>d.invoke(name,input),mutate=(name,input,key=`composition-${++seq}`)=>invoke(name,{...input,idempotencyKey:key});
 const workers=c.providerRegistry.snapshot([{id:'worker',revision:'r1'}]);
 const manifest={submissionId:'review-composition',objective:'Set the value to 42',acceptance:['Value is 42'],environment:'fixture',mode:'collaborative',limits:{hours:1,maxTasks:1,reviewAgentRuns:4},project,providerPolicy:{version:1,workers,plannerWorkerId:'worker',defaultWorkerId:'worker',maxConcurrentTasks:1,capacityGroups:[{id:'fixture-service',limit:1}]},...(api?{reviewPolicy:{version:1,source:'api',reviewer:c.providerRegistry.get('reviewer','r1'),fallback:'wait'}}:{})};
 const draft=await mutate('assignment_prepare',{manifest});assert.equal(draft.status,'prepared',JSON.stringify(draft));
 const goal=await mutate('goal_activate',{goalId:draft.goalId,hash:draft.hash});
 const task=await mutate('task_submit',{goalId:goal.id,task:{submissionId:'value',kind:'coding',actor:'deepseek',objective:'Set src/value.mjs to 42',acceptance:['Value is 42'],permissions:{readPaths:['src/','checks/'],writePaths:[file],checks:['value-check']}}});
 const operation=async(name,input,key)=>{const op=await mutate(name,input,key);await d.whenIdle();const result=await invoke('operation_get',{operationId:op.id});assert.equal(result.status,'completed',result.error);return result.result;};
 return {root,repo,file,goal,task,calls,baseUrl,outsideMarker,invoke,mutate,operation,current:()=>c,worker:()=>worker,waitIdle:()=>d.whenIdle(),restart:async()=>{await d.whenIdle();c.releaseWorker(owner);c.close();connect();}};
}
async function candidate(f){for(let n=0;n<12;n++){const task=await f.invoke('task_get',{taskId:f.task.id});if(task.status==='awaiting_review')return task;assert.ok(['queued','running'].includes(task.status),JSON.stringify(task));await f.worker().tick();}assert.fail('Candidate did not finish within bounded fixture');}
async function row(f){const inbox=await f.invoke('review_inbox',{goalId:f.goal.id,limit:5});return (inbox.items??inbox.tasks??inbox.entries??inbox)[0];}
function binding(item){return item.binding??item;}
for(const beta of [false,true])test(`common host review composes actual checks, disconnect, bound verdict, exactly-once integration (${beta?'beta':'core'})`,{timeout:120000},async t=>{
 const f=await fixture(t,beta),ready=await candidate(f);
 assert.ok(ready.result.checks.every(x=>x.passed));
 // Old review/integration tools cannot silently confer acceptance on a new-policy candidate.
 await assert.rejects(f.mutate('task_review',{taskId:f.task.id,decision:'accept',feedback:'Attempt old bypass'}),/review|ticket|bound/i);
 const bypass=await f.mutate('task_integrate',{taskId:f.task.id,feedback:'Attempt integration before assessment',...(beta?{expectedIntegrationBinding:'0'.repeat(64)}:{})});await f.waitIdle();
 // Asynchronous tool failures are recorded in the durable operation.
 const pre=await f.invoke('operation_get',{operationId:bypass.id});
 assert.equal(pre.status,'failed');assert.match(pre.error,/review|ticket|bound|inbox/i);
 // Reconnect closes only the fixture service and leaves the durable inbox intact.
 await f.restart();
 const item=await row(f);assert.equal(item.taskId,f.task.id);
 const ticket=await f.mutate('review_reserve',{taskId:f.task.id,...binding(item)},'host-reserve');
 assert.equal(JSON.stringify(ticket).includes('dummy-'),false);
 await f.restart();
 const input={ticketId:ticket.ticketId??ticket.id,...binding(item),verdict:{decision:'accept',feedback:'Scripted host assessment of the diff and protected evidence',findings:[]}};
 const reviewed=await f.mutate('review_submit',input,'host-submit');assert.equal(reviewed.status,'ready_to_integrate');
 assert.deepEqual(await f.mutate('review_submit',input,'host-submit'),reviewed);
 assert.equal((await f.invoke('outcomes_report',{goalId:f.goal.id})).counts.usefulAccepted,0);
 let integrationBinding;
 if(beta){
  await assert.rejects(f.mutate('task_integrate',{taskId:f.task.id,feedback:'Missing the confirmed plan'}),/integration binding/i);
  const {candidate}=await f.invoke('owner_action_context',{goalId:f.goal.id,taskId:f.task.id});
  assert.deepEqual(candidate.changedFiles,[file]);
  integrationBinding=candidate.binding;
 }
 const integrate={taskId:f.task.id,feedback:'Import reviewed candidate',...(integrationBinding?{expectedIntegrationBinding:integrationBinding}:{})};
 const accepted=await f.operation('task_integrate',integrate,'integrate');assert.equal(accepted.status,'accepted');
 assert.equal(await readFile(path.join(accepted.integration.worktree,file),'utf8'),fixed);
 assert.equal(await readFile(path.join(f.repo,file),'utf8'),original);
 assert.equal((await f.invoke('outcomes_report',{goalId:f.goal.id})).counts.usefulAccepted,1);
 const posts=f.calls.filter(x=>x.body).length;await f.restart();
 assert.deepEqual(await f.operation('task_integrate',integrate,'integrate'),accepted);
 assert.equal((await f.invoke('outcomes_report',{goalId:f.goal.id})).counts.usefulAccepted,1);assert.equal(f.calls.filter(x=>x.body).length,posts);
});

test('API reviewer shares the checked integration gate and reports provider attribution separately',{timeout:120000},async t=>{
 const f=await fixture(t,false,{api:true});await candidate(f);const item=await row(f);
 assert.deepEqual(item.disclosure.recipient,{source:'api',baseUrl:f.baseUrl,model:'fixture-reviewer',transport:'openai-chat'});
 assert.deepEqual(item.disclosure.files,['checks/value.mjs',file]);
 assert.equal(f.calls.filter(x=>x.body?.model==='fixture-reviewer').length,0);
 await assert.rejects(f.mutate('review_reserve',binding(item),'try-host-reservation'),/API review evidence/i);
 assert.equal(f.current().getTask(f.task.id).reviews,0);
 const apiInput={taskId:f.task.id,...binding(item)};const result=await f.current().reviewService.runApi(apiInput,'api-review');assert.equal(result.status,'ready_to_integrate');
 const captured=f.calls.find(({body})=>body?.model==='fixture-reviewer');
 const evidence=JSON.parse(captured.body.messages.at(-1).content);
 assert.deepEqual(evidence.files.map(candidate=>candidate.path),item.disclosure.files);
 assert.equal(evidence.files.find(candidate=>candidate.path===file).content,fixed);
 assert.equal(evidence.files.find(candidate=>candidate.path==='checks/value.mjs').content,await readFile(path.join(f.repo,'checks/value.mjs'),'utf8'));
 assert.deepEqual(evidence.checks.map(({id,stdout,stderr})=>({id,stdoutCharacters:stdout.length,stderrCharacters:stderr.length})),item.disclosure.checks);
 assert.ok(!JSON.stringify(evidence).includes(f.outsideMarker));

 assert.equal(f.calls.filter(x=>x.body?.model==='fixture-reviewer').length,1);
 await f.operation('task_integrate',{taskId:f.task.id,feedback:'Import API reviewed candidate'},'api-integrate');
 const report=await f.invoke('outcomes_report',{goalId:f.goal.id});assert.equal(report.counts.usefulAccepted,1);
 const review=report.usage.requests.find(x=>x.kind==='apiReview');assert.equal(review.requestedModel,'fixture-reviewer');assert.equal(review.reportedModel,'reported-reviewer-alias');assert.equal(review.role,'reviewer');
 assert.equal(report.usage.nativeHost.tokens,null);
 assert.equal(report.usage.requests.find(x=>x.kind==='apiReview').knownInputTokens,31);
 await f.restart();assert.deepEqual(await f.current().reviewService.runApi(apiInput,'api-review'),result);
 assert.equal(f.calls.filter(x=>x.body?.model==='fixture-reviewer').length,1);
 assert.equal((await f.invoke('outcomes_report',{goalId:f.goal.id})).counts.usefulAccepted,1);
});
