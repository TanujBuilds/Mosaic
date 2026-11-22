import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {ProviderRegistry} from '../src/harness/providers/registry.mjs';
import {DatabaseSync} from 'node:sqlite';
import {validateQuiescenceReceipt} from '../src/project/check-backends/native-supervisor.mjs';
import {capacitySnapshot} from '../src/harness/scheduling/capacity.mjs';
import {Journal} from '../src/project/journal.mjs';
import {git} from '../src/project/process.mjs';
import {profile} from './fixtures/mosaic-pb13/public-fixture.mjs';
import {buildFixtureArtifact} from './fixtures/mosaic-pb15-v2-composition/artifact.mjs';
import {fixture as integrationFixture,goal as integrationGoal} from './fixtures/mosaic-pb14-integration/fixture.mjs';

const nativeAvailable=process.platform==='darwin'&&process.arch==='arm64'&&Boolean(process.env.MOSAIC_NATIVE_TEST_NODE);
const nativeRequired=process.env.MOSAIC_REQUIRE_NATIVE==='1';
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Concurrent coding barrier not reached')),20000);})]);}finally{clearTimeout(timer);}}
async function saveEvidence(value){if(process.env.MOSAIC_CODING_OVERLAP_EVIDENCE_DIR){await mkdir(process.env.MOSAIC_CODING_OVERLAP_EVIDENCE_DIR,{recursive:true});await writeFile(path.join(process.env.MOSAIC_CODING_OVERLAP_EVIDENCE_DIR,'public-overlap.json'),JSON.stringify(value,null,2)+'\n');}}

test('required coding overlap has the actual native runtime',()=>{if(nativeRequired)assert.ok(nativeAvailable,'MOSAIC_REQUIRE_NATIVE=1 requires Darwin arm64 and MOSAIC_NATIVE_TEST_NODE');});

test('execution base waits for the same local repository owner and rechecks paused goal authority',{timeout:10000},async t=>{
 const f=await integrationFixture(t),first=integrationGoal(f,'first'),second=integrationGoal(f,'second'),held=await f.i.lockedGoal(first.id);
 let settled=false;const pending=f.i.executionBase(second.id).then(value=>({value}),error=>({error}));pending.then(()=>{settled=true;});
 try{
  await new Promise(setImmediate);assert.equal(settled,false);
  await assert.rejects(f.i.lockedGoal(second.id),error=>error.code==='locked');
  const before=f.c.getGoal(second.id);f.c.control({goalId:second.id,action:'pause'},'pause-waiter');await held.release();
  const result=await pending;assert.match(result.error?.message??'',/active|paused/i);
  assert.equal(f.c.getGoal(second.id).hash,before.hash);assert.equal(f.c.getGoal(second.id).deadline,before.deadline);assert.deepEqual(f.c.getGoal(second.id).spent,before.spent);
  f.c.control({goalId:second.id,action:'resume'},'resume-waiter');assert.equal(await f.i.executionBase(second.id),f.base);
 }finally{if(!settled){await held.release();await pending;}}
});

test('a local preparation wait does not serialize a different destination repository',{timeout:10000},async t=>{
 const f=await integrationFixture(t),first=integrationGoal(f,'first'),otherRepo=path.join(f.root,'other-repo');execFileSync('/usr/bin/git',['clone','--quiet','--local','--',f.repo,otherRepo],{env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
 const second=integrationGoal(f,'other',{project:{repo:otherRepo}}),held=await f.i.lockedGoal(first.id);
 try{assert.equal(await bounded(f.i.executionBase(second.id)),f.base);}finally{await held.release();}
});

test('failed local holder releases its turn so the next approved goal can prepare',{timeout:10000},async t=>{
 const f=await integrationFixture(t),first=integrationGoal(f,'failed-holder'),second=integrationGoal(f,'healthy-waiter');
 f.c.control({goalId:first.id,action:'pause'},'pause-holder');
 const failed=f.i.lockedGoal(first.id).then(value=>({value}),error=>({error})),pending=f.i.executionBase(second.id);
 assert.match((await failed).error?.message??'',/active|paused/i);assert.equal(await bounded(pending),f.base);
 const next=await f.i.lockedGoal(second.id);await next.release();
});

for(const action of ['pause','stop','deadline'])test(`task ${action} while awaiting its execution base spends nothing and enters no coding attempt`,{timeout:10000},async t=>{
 const f=await integrationFixture(t),g=integrationGoal(f,'task-control'),owner='waiting-worker',worker=new Worker({c:f.c,owner,config:{environment:'fixture'}});
 const task=f.c.submitTask({goalId:g.id,submissionId:'waiting-task',kind:'coding',objective:'Change independent source',acceptance:['No dispatch after control'],permissions:{readPaths:['src/','checks/'],writePaths:['src/a.mjs'],checks:['verify']}},'waiting-task');
 const held=await worker.integration.lockedGoal(g.id),claimed=f.c.claimNext(owner),pending=worker.executeTask(claimed);let released=false;
 try{
  await new Promise(setImmediate);if(action==='deadline')f.c.now=()=>claimed.deadline+1;else f.c.control({taskId:task.id,action},'control-waiter');await held.release();released=true;
  const result=await bounded(pending);assert.equal(result.status,action==='deadline'?'partial':action==='pause'?'paused':'stopped');
  const saved=f.c.getTask(task.id);assert.equal(saved.attempts,0);assert.equal(saved.spent.model,0);assert.equal(saved.hash,claimed.hash);assert.equal(saved.deadline,claimed.deadline);assert.equal(saved.providerBinding.providerId,claimed.providerBinding.providerId);assert.equal(f.c.store.request(task.id,'code-1-0'),null);
  await assert.rejects(readFile(path.join(f.c.store.root,'coding','jobs',task.id+'.jsonl')),{code:'ENOENT'});
 }finally{if(!released)await held.release();await pending;await worker.close();}
});

test('unregistered durable lock ownership is not waited away or recovered from a live PID',{timeout:10000},async t=>{
 const f=await integrationFixture(t),g=integrationGoal(f,'external'),journal=await new Journal(path.join(f.c.store.root,'integration-repository-locks'),f.i.repositoryId(g)).load(),release=await journal.lock(),file=path.join(journal.dir,'lock.json'),before=await readFile(file,'utf8');
 try{await assert.rejects(f.i.executionBase(g.id),error=>error.code==='locked');assert.equal(await readFile(file,'utf8'),before);}finally{await release();}
 assert.equal(await f.i.executionBase(g.id),f.base);
});

test('public scheduler overlaps independent coding requests before either reply and checks both real native candidates',{skip:!nativeAvailable&&!nativeRequired,timeout:120000},async t=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'mosaic-pb16-coding-overlap-'))),repo=path.join(root,'repo'),state=path.join(root,'state');
 const release=Promise.withResolvers(),bothPosted=Promise.withResolvers(),calls=[],errors=[],servers=[];
 let c,worker,d,pump,active=0,maxActive=0;
 t.after(async()=>{
  release.resolve();const reasons=[];
  // Settle only this fixture's work, then inspect persisted ownership after the
  // writer is closed. A failed test must not erase an uncertain supervisor.
  for(const settle of [()=>worker?.close(),()=>pump,()=>d?.whenIdle()])try{await settle();}catch(error){reasons.push(String(error?.message??error));}
  for(const server of servers)try{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}catch(error){reasons.push(String(error?.message??error));}
  if(c){try{if(c.workerLease)c.releaseWorker('coding-overlap');}catch(error){reasons.push(String(error.message));}try{c.close();}catch(error){reasons.push(String(error.message));}}
  let db,owners=[],tasks=[],snapshotReadable=false;
  try{
   db=new DatabaseSync(path.join(state,'harness.sqlite3'),{readOnly:true});db.exec('BEGIN');
   owners=db.prepare("SELECT data FROM records WHERE kind='execution_owner'").all().map(row=>JSON.parse(row.data));
   tasks=db.prepare("SELECT data FROM records WHERE kind='task'").all().map(row=>JSON.parse(row.data));
   snapshotReadable=true;
   for(const owner of owners){
    if(owner.status!=='quiescent')throw Error('Native owner remains '+owner.status+': '+owner.id);
    validateQuiescenceReceipt(owner.receipt,{requestId:owner.id,bindingHash:owner.bindingHash,helperPid:owner.helperPid,leaderPid:owner.leaderPid});
   }
   if(tasks.some(task=>task.status==='uncertain'||task.owner||task.native?.writerActive))throw Error('Task ownership remains held or uncertain');
   db.exec('COMMIT');
  }catch(error){reasons.push('Closed ownership snapshot: '+String(error?.message??error));}finally{try{db?.close();}catch(error){reasons.push(String(error?.message??error));}}
  const proof={root,closedSnapshot:snapshotReadable,removed:reasons.length===0,reasons,owners,tasks};
  if(process.env.MOSAIC_CODING_OVERLAP_EVIDENCE_DIR){await mkdir(process.env.MOSAIC_CODING_OVERLAP_EVIDENCE_DIR,{recursive:true});await writeFile(path.join(process.env.MOSAIC_CODING_OVERLAP_EVIDENCE_DIR,'cleanup.json'),JSON.stringify(proof,null,2)+'\n');}
  if(reasons.length){await writeFile(path.join(root,'fixture-cleanup-retained.json'),JSON.stringify(proof,null,2)+'\n');t.diagnostic('Retained uncertain fixture: '+root);throw Error('Fixture retained for ownership inspection: '+reasons.join('; '));}
  await rm(root,{recursive:true,force:true});
 });
 const artifact=await buildFixtureArtifact(root),profiles=[];
 for(const id of ['a','b']){
  const server=http.createServer(async(req,res)=>{try{
   let raw='';for await(const chunk of req)raw+=chunk;
   if(req.method==='GET')return res.end(JSON.stringify({data:[{id:'alias-'+id}]}));
   const body=JSON.parse(raw),input=JSON.parse(body.messages.at(-1).content),file=id==='a'?'src/left.mjs':'src/right.mjs';
   assert.equal(req.headers.authorization,'Bearer dummy-bearer');assert.equal(input.task.kind,'coding');assert.deepEqual(input.task.permissions.writePaths,[file]);
   const inventory=input.inventory.find(item=>item.path===file);assert.ok(inventory?.hash);
   calls.push({id,taskId:input.task.id??null,attempt:input.attempt,entered:calls.length+1});active++;maxActive=Math.max(maxActive,active);
   if(calls.length===2)bothPosted.resolve();await release.promise;
   active--;res.end(JSON.stringify({model:'alias-'+id,choices:[{message:{content:JSON.stringify({type:'submit_changes',paths:[],summary:'Change the assigned independent value',edits:[{path:file,action:'write',baseHash:inventory.hash,content:'export const value=1;\n'}]})},finish_reason:'stop'}],usage:{total_tokens:5}}));
  }catch(error){errors.push(error);res.writeHead(500).end('Fixture assertion failed');}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));servers.push(server);profiles.push(profile(id,`http://127.0.0.1:${server.address().port}/v1`));
 }
 await mkdir(path.join(repo,'src'),{recursive:true});await mkdir(path.join(repo,'checks'));
 for(const name of ['left','right'])await writeFile(path.join(repo,'src',name+'.mjs'),'export const value=0;\n');
 await writeFile(path.join(repo,'package.json'),'{"private":true,"type":"module"}\n');
 await writeFile(path.join(repo,'checks/value.mjs'),"import {value as left} from '../src/left.mjs';import {value as right} from '../src/right.mjs';if(![0,1].includes(left)||![0,1].includes(right)||left+right<1)process.exit(1);console.log(JSON.stringify({left,right}));\n");
 for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','base']])await git(repo,...args);
 const baseCommit=await git(repo,'rev-parse','HEAD'),config={environment:'fixture',nativeCheckRuntime:artifact.config};
 c=new Coordinator({root:state,selectedHost:'cursor',serviceMaxConcurrentTasks:2,providerRegistry:ProviderRegistry({profiles,credentialResolver:()=> 'dummy-bearer'}),nativeCheckRuntime:artifact.config,executionPolicy:artifact.policy});
 c.acquireWorker('coding-overlap');worker=new Worker({c,owner:'coding-overlap',config});d=new Dispatcher({c,worker,config});
 const mutate=(name,input,key)=>d.invoke(name,{...input,idempotencyKey:key});
 const raw={submissionId:'coding-overlap',objective:'Check two independent coding candidates concurrently',acceptance:['Both scoped candidates pass protected native checks'],mode:'collaborative',environment:'fixture',executionPolicy:artifact.policy,limits:{hours:1,maxTasks:2,reviewAgentRuns:2},project:{repo,baseCommit,readPaths:['package.json','src/','checks/'],writePaths:['src/'],checks:[{id:'value',argv:[path.join(artifact.root,'node'),'checks/value.mjs'],timeoutMs:10000}]},providerPolicy:{version:1,workers:c.providerRegistry.snapshot(profiles.map(({id,revision})=>({id,revision}))),plannerWorkerId:'worker-a',defaultWorkerId:'worker-a',maxConcurrentTasks:2,capacityGroups:profiles.map(p=>({id:p.capacityGroup,limit:1}))},routingPolicy:{version:1,rules:[{id:'backend',category:'backend',providerId:'worker-a'},{id:'frontend',category:'frontend',providerId:'worker-b'}],defaultWorkerId:'worker-a'},reviewPolicy:{version:1,source:'host',hostId:'cursor',fallback:'wait'}};
 const prepared=await mutate('assignment_prepare',{manifest:raw},'prepare');assert.equal(prepared.status,'prepared',JSON.stringify(prepared));
 const goal=await mutate('goal_activate',{goalId:prepared.goalId,hash:prepared.hash},'activate'),tasks=[];
 for(const [name,category] of [['left','backend'],['right','frontend']])tasks.push(await mutate('task_submit',{goalId:goal.id,task:{submissionId:name,kind:'coding',objective:'Change '+name,acceptance:['Scoped source passes'],permissions:{readPaths:raw.project.readPaths,writePaths:['src/'+name+'.mjs'],checks:['value']},routing:{version:1,category}}},'submit-'+name));
 const initial=tasks.map(task=>c.getTask(task.id));
 const advance=async(done)=>{for(let n=0;n<30;n++){if(done())return;await worker.tick();}assert.fail('Coding fixture did not reach expected boundary');};
 pump=advance(()=>calls.length===2||tasks.some(task=>c.getTask(task.id).status==='blocked'));
 await bounded(Promise.race([pump,bothPosted.promise]));
 const overlapping=tasks.map(task=>c.getTask(task.id));await saveEvidence({phase:'overlap',calls,tasks:overlapping,events:c.store.events(0,1000)});
 assert.deepEqual(overlapping.filter(task=>task.status==='blocked').map(task=>({id:task.id,reason:task.reason})),[],'An independent coding lane must wait for shared base preparation');
 assert.equal(calls.length,2);assert.equal(maxActive,2);assert.equal(capacitySnapshot(c).requests.length,2);
 assert.notEqual(overlapping[0].owner,overlapping[1].owner);assert.equal(overlapping[0].checkpoint.executionBase,baseCommit);assert.equal(overlapping[1].checkpoint.executionBase,baseCommit);
 assert.deepEqual(overlapping.map(task=>task.attempts),[1,1]);release.resolve();await pump;
 await advance(()=>tasks.every(task=>c.getTask(task.id).status==='awaiting_review'));
 const candidates=tasks.map(task=>c.getTask(task.id));assert.notEqual(candidates[0].result.worktree,candidates[1].result.worktree);
 for(const [index,task] of candidates.entries()){
  assert.equal(task.hash,initial[index].hash);assert.equal(task.deadline,overlapping[index].deadline);assert.equal(task.spent.model,1);assert.equal(task.providerBinding.providerId,profiles[index].id);
  assert.ok(task.result.checks.every(check=>check.passed&&check.code===0&&check.backend.id==='darwin-seatbelt'&&check.backend.revision===2&&check.backend.runtime.fingerprint===artifact.fingerprint));
  const journal=await new Journal(path.join(state,'coding'),task.id).load();assert.equal(journal.last('harness.sandbox').readDenied,true);assert.equal(journal.last('harness.sandbox').networkDenied,true);
 }
 for(const task of candidates){
  const item=(await d.invoke('review_inbox',{goalId:goal.id})).items.find(item=>item.taskId===task.id),ticket=await mutate('review_reserve',item.binding,'reserve-'+task.id);
  await mutate('review_submit',{...item.binding,ticketId:ticket.ticketId,verdict:{decision:'accept',feedback:'Fixture host assesses exact candidate and actual checks',findings:[]}},'review-'+task.id);
  const operation=await mutate('task_integrate',{taskId:task.id,feedback:'Integrate exact checked candidate'},'integrate-'+task.id);await d.whenIdle();const saved=await d.invoke('operation_get',{operationId:operation.id});assert.equal(saved.status,'completed',saved.error);assert.equal(saved.result.status,'accepted');
  assert.ok(saved.result.integration.checks.every(check=>check.passed&&check.backend.runtime.fingerprint===artifact.fingerprint));
 }
 const accepted=tasks.map(task=>c.getTask(task.id));assert.equal(accepted[0].integration.worktree,accepted[1].integration.worktree);
 for(const name of ['left','right'])assert.equal(await readFile(path.join(accepted[1].integration.worktree,'src',name+'.mjs'),'utf8'),'export const value=1;\n');
 assert.equal(calls.length,2);assert.deepEqual(errors,[]);assert.ok(c.store.all('execution_owner').length>0);assert.ok(c.store.all('execution_owner').every(owner=>owner.status==='quiescent'));
 await saveEvidence({phase:'accepted',calls,maxActive,goal:c.getGoal(goal.id),tasks:accepted,executionOwners:c.store.all('execution_owner'),events:c.store.events(0,1000),liveCallsMade:false});
});
