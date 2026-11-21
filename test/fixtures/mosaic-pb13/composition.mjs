import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {Coordinator} from '../../../src/harness/coordinator.mjs';
import {Dispatcher} from '../../../src/harness/tools.mjs';
import {Worker} from '../../../src/harness/worker.mjs';
import {ProviderRegistry} from '../../../src/harness/providers/registry.mjs';
import {WorkflowRecipes} from '../../../src/harness/workflow-recipes/service.mjs';
import {Journal} from '../../../src/project/journal.mjs';
import {git} from '../../../src/project/process.mjs';
import {digest} from '../../../src/harness/contracts.mjs';

const backend='src/backend.mjs',frontend='src/frontend.mjs';
const initialBackend='export const parse = input => input;\n';
const initialFrontend='export const title = input => input.trim();\n';
const fixedBackend='export const parse = input => input.trim();\n';
const sharedFrontend="import {parse} from './backend.mjs';\nexport const title = input => parse(input);\n";
const dummy={a:'dummy-routing-a',b:'dummy-routing-b'};
const checkText="import assert from 'node:assert/strict';\nimport {parse} from '../src/backend.mjs';\nimport {title} from '../src/frontend.mjs';\nassert.equal(parse(' backend '),'backend');\nassert.equal(parse('   '),'');\nassert.equal(title(' frontend '),'frontend');\nassert.equal(title('   '),'');\nconsole.log('protected composition behavior passed');\n";
const routing={backend:{version:1,category:'backend'},frontend:{version:1,category:'frontend'}};
const definition={schemaVersion:1,id:'offline-two-parts',version:1,title:'Two checked fixture parts',mode:'collaborative',parameters:{},tasks:[
 {key:'backend',kind:'coding',objective:'Repair backend whitespace parsing',acceptance:['Parser trims input under protected checks'],dependsOn:[],permissions:{readPaths:['src/','checks/'],writePaths:[backend],checks:['composition']}},
 {key:'frontend',kind:'coding',objective:'Use the checked backend parser for frontend formatting',acceptance:['Frontend imports the checked parser and preserves formatting behavior'],dependsOn:['backend'],permissions:{readPaths:['src/','checks/'],writePaths:[frontend],checks:['composition']}},
],provenance:{source:'Offline developer fixture',description:'Trusted fixture recipe; never installed into the shipping catalog'}};

// Only inference and assessment are scripted. Workspace edits, sandbox denial
// probes, protected candidate/combined checks, recovery and integration are real.
export async function runComposition({root,review='host',beta=false}) {
 if(!['host','api'].includes(review))throw Error('review must be host or api');
 // Git repository overrides take precedence over cwd, including in downstream
 // workspace calls. Reject them at the exported entry before any fixture write.
 const gitVariables=(await git(os.tmpdir(),'rev-parse','--local-env-vars')).split('\n');
 const override=gitVariables.find(name=>Object.hasOwn(process.env,name));
 if(override)throw Error('Clear Git repository override before running the demo: '+override);
 await mkdir(root); // Refuse existing roots; never overwrite state or reset spend.
 const repo=path.join(root,'repo'),state=path.join(root,'state'),servers=[],calls=[],errors=[];
 let c,d,worker,recipes,owner,generation=0,sequence=0,active=0,maxActive=0,now=Date.now();
 try {
  const endpoints=[];
  for(const id of ['a','b']){
   const server=http.createServer(async(req,res)=>{
    try {
     let raw='';for await(const part of req)raw+=part;
     const body=raw?JSON.parse(raw):null;calls.push({id,method:req.method,url:req.url,model:body?.model??null,body});
     assert.equal(req.headers.authorization,'Bearer '+dummy[id]);res.setHeader('content-type','application/json');
     if(req.url==='/v1/models'){assert.equal(req.method,'GET');return res.end(JSON.stringify({data:[{id:'fixture-'+id}]}));}
     assert.equal(req.method,'POST');assert.equal(req.url,'/v1/chat/completions');
     active++;maxActive=Math.max(maxActive,active);
     let settled=false;const settle=()=>{if(!settled){settled=true;active--;}};
     res.once('finish',settle);res.once('close',settle);
     if(body.model==='fixture-reviewer'){
      assert.equal(id,'b');const evidence=JSON.stringify(body.messages);assert.match(evidence,/checks/);assert.match(evidence,/candidate/);
      return res.end(JSON.stringify({model:'reported-reviewer',choices:[{message:{role:'assistant',content:JSON.stringify({decision:'accept',feedback:'Fixture assessment of exact candidate and protected passing evidence',findings:[]})},finish_reason:'stop'}],usage:{prompt_tokens:7,completion_tokens:3}}));
     }
     assert.equal(body.model,'fixture-'+id);assert.equal(body.stream,false);
     const input=JSON.parse(body.messages.at(-1).content),file=id==='a'?backend:frontend;
     assert.equal(input.task.kind,'coding');assert.equal(input.task.routing.category,id==='a'?'backend':'frontend');assert.deepEqual(input.task.permissions.writePaths,[file]);
     const inventory=input.inventory.find(entry=>entry.path===file);assert.ok(inventory?.hash);
     if(input.attempt>1){assert.equal(id,'a');assert.equal(input.repair.failure.category,'functional_check');assert.match(JSON.stringify(input.repair),/composition/);}
     const content=id==='a'?(input.attempt===1?'export const parse = input => input.toUpperCase();\n':fixedBackend):sharedFrontend;
     res.end(JSON.stringify({model:'fixture-'+id,choices:[{message:{role:'assistant',content:JSON.stringify({type:'submit_changes',paths:[],summary:id==='a'?'Trim parser input':'Reuse the checked parser',edits:[{path:file,action:'write',baseHash:inventory.hash,content}]})},finish_reason:'stop'}],...(id==='a'?{usage:{prompt_tokens:11,completion_tokens:5}}:{})}));
    }catch(error){errors.push(error);res.writeHead(500).end(JSON.stringify({error:{message:'Fixture assertion failed'}}));}
   });
   await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});servers.push(server);
   endpoints.push({schema:1,id:'worker-'+id,revision:'r1',displayName:'Loopback worker '+id,transport:'openai-chat',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture-'+id,roles:['worker'],capabilities:{workerProtocol:'mosaic-structured-v1',transports:['json'],modelDiscovery:'advertised',taskKinds:['coding','consult']},maxContextTokens:32000,maxOutputTokens:2048,concurrency:1,capacityGroup:'loopback-'+id,credentialRef:'fixture-key-'+id,streaming:false});
  }
  const reviewer={...endpoints[1],id:'fixture-reviewer',displayName:'Loopback reviewer',model:'fixture-reviewer',roles:['reviewer'],capabilities:{workerProtocol:null,transports:['json'],modelDiscovery:'manual',taskKinds:[]}};
  const connect=()=>{
   const providers=ProviderRegistry({profiles:[...endpoints,reviewer],credentialResolver:ref=>dummy[ref.replace('fixture-key-','')]});
   c=new Coordinator({root:state,beta,selectedHost:'cursor',providerRegistry:providers,now:()=>now});owner='composition-'+(++generation);c.acquireWorker(owner);
   worker=new Worker({c,owner,config:{environment:'fixture',beta}});d=new Dispatcher({c,worker,config:{environment:'fixture',beta}});
   recipes=new WorkflowRecipes({c});recipes.register(definition);
  };
  const restart=async()=>{await d.whenIdle();c.releaseWorker(owner);c.close();now+=1000;connect();};
  const invoke=(name,input={})=>d.invoke(name,input),mutate=(name,input,key='fixture-'+(++sequence))=>invoke(name,{...input,idempotencyKey:key});
  const operation=async(name,input,key,{failure=false}={})=>{const pending=await mutate(name,input,key);await d.whenIdle();const saved=await invoke('operation_get',{operationId:pending.id});assert.equal(saved.status,failure?'failed':'completed',saved.error);return saved;};
  const advance=async(id,predicate)=>{for(let n=0;n<24;n++){const task=c.getTask(id);if(predicate(task))return task;assert.ok(['queued','running','suspended'].includes(task.status),JSON.stringify({status:task.status,reason:task.reason,feedback:task.feedback}));await worker.tick();}assert.fail('Bounded fixture failed to reach the expected boundary');};
  connect();await mkdir(path.join(repo,'src'),{recursive:true});await mkdir(path.join(repo,'checks'));
  await writeFile(path.join(repo,backend),initialBackend);await writeFile(path.join(repo,frontend),initialFrontend);await writeFile(path.join(repo,'checks/composition.mjs'),checkText);
  await git(repo,'init','-q');await git(repo,'add','.');await git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Fixture base');
  const baseCommit=await git(repo,'rev-parse','HEAD'),workers=c.providerRegistry.snapshot(endpoints.map(({id,revision})=>({id,revision})));
  const raw={submissionId:'offline-composition',objective:'Repair backend parsing and share it with frontend formatting',acceptance:['Both checked changes are integrated'],environment:'fixture',mode:'collaborative',limits:{hours:1,maxTasks:2,reviewAgentRuns:4},project:{repo,baseCommit,readPaths:['src/','checks/'],writePaths:['src/'],checks:[{id:'composition',argv:[process.execPath,'checks/composition.mjs'],timeoutMs:10000}],behavioralChecks:[{criterionId:'whitespace',description:'Backend and frontend preserve checked formatting',checkIds:['composition']}]},providerPolicy:{version:1,workers,plannerWorkerId:'worker-a',defaultWorkerId:'worker-a',maxConcurrentTasks:1,capacityGroups:endpoints.map(p=>({id:p.capacityGroup,limit:1}))},routingPolicy:{version:1,rules:[{id:'backend-rule',category:'backend',providerId:'worker-a'},{id:'frontend-rule',category:'frontend',providerId:'worker-b'}],defaultWorkerId:'worker-a'},reviewPolicy:review==='api'?{version:1,source:'api',reviewer:c.providerRegistry.get(reviewer.id,reviewer.revision),fallback:'wait'}:{version:1,source:'host',hostId:'cursor',fallback:'wait'}};
  const draft=await mutate('assignment_prepare',{manifest:raw},'prepare');assert.equal(draft.status,'prepared',JSON.stringify(draft));
  const goal=await mutate('goal_activate',{goalId:draft.goalId,hash:draft.hash},'activate');
  const previewInput={goalId:goal.id,recipeId:definition.id,version:1,parameters:{},taskRouting:routing};
  const preview=recipes.preview(previewInput);assert.equal(preview.launchable,true,JSON.stringify(preview.diagnostics));assert.deepEqual(preview.requirements.tasks.map(task=>task.route.binding.providerId),['worker-a','worker-b']);assert.equal(calls.length,0);
  const submission={...previewInput,expectedGoalHash:goal.hash,definitionDigest:preview.definitionDigest,parameterDigest:preview.parameterDigest,previewDigest:preview.previewDigest,submissionId:'two-parts'};
  const run=recipes.submit(submission,'recipe'),initial=run.tasks.map(id=>c.getTask(id));assert.equal(initial.length,2);assert.ok(initial.every(task=>!task.providerBinding));
  await restart();assert.deepEqual(run.tasks.map(id=>c.getTask(id)),initial);assert.deepEqual(recipes.submit(submission,'recipe'),run);assert.deepEqual(recipes.submit(submission,'recipe-replay'),run);
  const [first,second]=run.tasks;
  const failed=await advance(first,task=>task.checkpoint.phase==='attempt'&&task.checkpoint.failedGate);assert.equal(failed.attempts,1);assert.equal(failed.spent.model,1);assert.equal(failed.providerBinding.providerId,'worker-a');assert.equal(failed.route.decision.reasonCode,'selected_by_rule');assert.equal(calls.filter(call=>call.id==='b').length,0);
  const journal=await new Journal(path.join(state,'coding'),first).load(),failedReceipt=journal.completed('harness-attempt-1/checks');assert.equal(failedReceipt.value[0].passed,false);assert.match(failedReceipt.value[0].stderr,/AssertionError/);
  const sandbox=journal.last('harness.sandbox');for(const name of ['readDenied','writeDenied','networkDenied','outputWorks'])assert.equal(sandbox[name],true);
  await restart();assert.equal(c.getTask(first).status,'uncertain');const recovered=c.recoverSaved(first,owner);
  for(const field of ['providerBinding','route','routeHash','checkpoint','spent','deadline','hash','goalVersion','attempts'])assert.deepEqual(recovered[field],failed[field],field);
  const replayAssessments=[],accepted=[];
  for(const [id,index] of [[first,0],[second,1]]){
   const candidate=await advance(id,task=>task.status==='awaiting_review');assert.ok(candidate.result.checks.every(check=>check.passed));assert.equal(candidate.providerBinding.providerId,index===0?'worker-a':'worker-b');
   assert.equal(await readFile(path.join(candidate.result.worktree,'checks/composition.mjs'),'utf8'),checkText);
   const before=await invoke('outcomes_report',{goalId:goal.id});assert.equal(before.counts.usefulAccepted,index);
   if(index===0){const denied=await operation('task_integrate',{taskId:id,feedback:'Attempt before bound assessment',...(beta?{expectedIntegrationBinding:'0'.repeat(64)}:{})},'pre-review',{failure:true});assert.match(denied.error,/review|ticket|bound|inbox/i);}
   const item=(await invoke('review_inbox',{goalId:goal.id})).items.find(item=>item.taskId===id);assert.ok(item);
   if(review==='host'){
    const ticket=await mutate('review_reserve',item.binding,'reserve-'+index),input={...item.binding,ticketId:ticket.ticketId,verdict:{decision:'accept',feedback:'Fixture host assessed exact diff and protected evidence',findings:[]}};
    const result=await mutate('review_submit',input,'review-'+index);assert.equal(result.status,'ready_to_integrate');replayAssessments.push(()=>mutate('review_submit',input,'review-'+index));
   }else{
    const result=await c.reviewService.runApi(item.binding,'api-'+index);assert.equal(result.status,'ready_to_integrate');replayAssessments.push(()=>c.reviewService.runApi(item.binding,'api-'+index));
   }
   assert.equal((await invoke('outcomes_report',{goalId:goal.id})).counts.usefulAccepted,index);
   const action=beta?await invoke('owner_action_context',{goalId:goal.id,taskId:id}):null;
   const input={taskId:id,feedback:'Import the exact assessed fixture candidate',...(action?{expectedIntegrationBinding:action.candidate.binding}:{})},result=(await operation('task_integrate',input,'integrate-'+index)).result;
   assert.equal(result.status,'accepted');assert.deepEqual(result.providerBinding,candidate.providerBinding);assert.equal(result.routeHash,candidate.routeHash);assert.equal(result.hash,initial[index].hash);assert.ok(result.integration.checks.every(check=>check.passed&&check.code===0));assert.equal(result.integration.behavioralEvidence.criteria[0].status,'passed');
   assert.equal((await invoke('outcomes_report',{goalId:goal.id})).counts.usefulAccepted,index+1);accepted.push({input,result});
  }
  const requestsBefore=c.store.db.prepare('SELECT * FROM requests ORDER BY id').all(),eventsBefore=c.store.events(0,1000),postsBefore=calls.filter(call=>call.method==='POST').length;
  await restart();assert.deepEqual(recipes.submit(submission,'recipe'),run);
  for(let n=0;n<2;n++){await replayAssessments[n]();assert.deepEqual((await operation('task_integrate',accepted[n].input,'integrate-'+n)).result,accepted[n].result);}
  await worker.tick();assert.equal(calls.filter(call=>call.method==='POST').length,postsBefore);assert.deepEqual(c.store.db.prepare('SELECT * FROM requests ORDER BY id').all(),requestsBefore);
  const events=c.store.events(0,1000);for(const id of run.tasks){assert.equal(events.filter(e=>e.task_id===id&&e.type==='task.routed').length,1);assert.equal(events.filter(e=>e.task_id===id&&e.type==='task.reviewed').length,1);assert.equal(events.filter(e=>e.task_id===id&&e.type==='task.integrated').length,1);}
  const report=await invoke('outcomes_report',{goalId:goal.id});assert.equal(report.counts.usefulAccepted,2);assert.equal(report.tasks.length,2);assert.equal(report.usage.knownUsageRequests,review==='host'?2:4);assert.equal(report.usage.eligibleCompletedRequests,review==='host'?3:5);assert.equal(report.usage.nativeHost.tokens,null);
  assert.deepEqual(report.tasks.map(task=>task.worker.providerId),['worker-a','worker-b']);assert.ok(report.tasks.every(task=>task.worker.routeReasonCode==='selected_by_rule'&&task.worker.routeProvenance==='recorded'));
  for(const task of run.tasks.map(id=>c.getTask(id))){const rows=c.store.requestOutcomes(task.id).filter(row=>row.kind==='model');for(const row of rows){const request=c.store.request(task.id,row.key);assert.deepEqual(request.providerBinding,task.providerBinding);assert.equal(request.routeHash,task.routeHash);}}
  const finalJournal=await new Journal(path.join(state,'coding'),first).load();assert.deepEqual(finalJournal.completed('harness-attempt-1/checks'),failedReceipt);assert.equal(finalJournal.events.filter(event=>event.type==='operation.started'&&event.data.key==='harness-attempt-1/checks').length,1);
  assert.equal(await readFile(path.join(accepted[1].result.integration.worktree,backend),'utf8'),fixedBackend);assert.equal(await readFile(path.join(accepted[1].result.integration.worktree,frontend),'utf8'),sharedFrontend);assert.equal(await readFile(path.join(repo,backend),'utf8'),initialBackend);assert.equal(await git(repo,'rev-parse','HEAD'),baseCommit);assert.equal(await git(repo,'status','--porcelain'),'');
  assert.deepEqual(errors,[]);assert.equal(maxActive,1);assert.deepEqual(calls.filter(call=>call.method==='POST'&&call.model!=='fixture-reviewer').map(call=>[call.id,JSON.parse(call.body.messages.at(-1).content).attempt]),[['a',1],['a',2],['b',1]]);
  const saved=JSON.stringify({records:c.store.db.prepare('SELECT data FROM records').all(),requests:requestsBefore,events:eventsBefore});for(const secret of Object.values(dummy))assert.equal(saved.includes(secret),false);assert.equal(saved.includes('fixture-key-'),false);
  const evidenceFor=id=>({
   routedEventId:events.find(event=>event.task_id===id&&event.type==='task.routed').seq,
   failedCheckEventIds:events.filter(event=>event.task_id===id&&['checks.failed','coding.checks.failed'].includes(event.type)).map(event=>event.seq),
   passedCheckEventIds:events.filter(event=>event.task_id===id&&event.type==='coding.checks.passed').map(event=>event.seq),
   reviewEventId:events.find(event=>event.task_id===id&&event.type==='task.reviewed').seq,
   integrationEventId:events.find(event=>event.task_id===id&&event.type==='task.integrated').seq,
   requests:c.store.db.prepare('SELECT id,key,kind,status FROM requests WHERE task_id=? ORDER BY rowid').all(id),
  });
  const summary={schemaVersion:1,fixtureOnly:true,root,reviewSource:review,beta,goalId:goal.id,deadline:goal.deadline,taskIds:run.tasks,tasks:report.tasks.map(task=>({id:task.id,worker:task.worker,usefulAccepted:task.usefulAccepted,attemptCount:task.attemptCount,commit:accepted.find(row=>row.result.id===task.id).result.integration.commit,evidence:evidenceFor(task.id)})),requestOrder:calls.filter(call=>call.method==='POST').map(call=>call.model),maxSimultaneousFixtureRequests:maxActive,protectedChecks:{failedFirst:true,repairedOnSameWorker:true,sandbox:{readDenied:true,writeDenied:true,networkDenied:true,outputWorks:true}},usefulAccepted:report.counts.usefulAccepted,usage:{known:report.usage.knownUsageRequests,eligible:report.usage.eligibleCompletedRequests,input:report.usage.input,output:report.usage.output,nativeHost:report.usage.nativeHost},replay:{sameTaskIds:true,samePins:true,noExtraPost:true,oneReviewAndIntegrationPerTask:true},liveCallsMade:false};
  await writeFile(path.join(root,'composition-result.json'),JSON.stringify(summary,null,2)+'\n');return summary;
 }finally{
  if(d)await d.whenIdle();if(c){c.releaseWorker(owner);c.close();}
  for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 }
}
