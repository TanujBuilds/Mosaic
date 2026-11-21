import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile, mkdir, open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Journal} from '../../src/project/journal.mjs';
import {capacitySnapshot} from '../../src/harness/scheduling/capacity.mjs';
import {parts,checkText} from '../../test/fixtures/mosaic-three-worker-rehearsal/project.mjs';
import {freshRoot,runtimeConfiguration,bounded,endpoint,timeline,session,project,safeTask,requestRows,writeEvidence,sha256,git} from '../../test/fixtures/mosaic-three-worker-rehearsal/runtime.mjs';

const sourceRoot=fileURLToPath(new URL('../../',import.meta.url));
const sourceFiles=['scripts/demo-three-worker-rehearsal.mjs','scripts/fixtures/three-worker-rehearsal.mjs','scripts/lib/git-environment.mjs','test/fixtures/mosaic-three-worker-rehearsal/runtime.mjs','test/fixtures/mosaic-three-worker-rehearsal/project.mjs','test/mosaic-three-worker-rehearsal.test.mjs','docs/THREE_WORKER_REHEARSAL.md'];
const endpointIdentity=p=>{const {credentialRef,...publicProfile}=p;return publicProfile;};
async function sourceIdentity(){
  const files=[...new Set([...sourceFiles,...(await git(sourceRoot,'ls-files','src/')).split('\n').filter(Boolean)])].sort();
  return {head:await git(sourceRoot,'rev-parse','HEAD'),tree:await git(sourceRoot,'rev-parse','HEAD^{tree}'),trackedStatus:await git(sourceRoot,'status','--porcelain','--untracked-files=no'),
    files:await Promise.all(files.map(async file=>({path:file,sha256:sha256(await readFile(path.join(sourceRoot,file)))})))};
}
const summaryRequest=r=>({id:r.id,key:r.key,kind:r.kind,status:r.status,requestOutcome:r.requestOutcome??null,providerBinding:r.providerBinding,routeHash:r.routeHash,capacityResource:r.capacityResource});
const checkSummary=c=>({id:c.id,passed:c.passed,code:c.code,stdout:c.stdout,stderr:c.stderr,backend:c.backend,provenance:c.provenance,quiescence:c.quiescence});
const stableBindings=t=>({providerBinding:t.providerBinding,routeHash:t.routeHash,hash:t.hash,goalVersion:t.goalVersion,deadline:t.deadline,spent:t.spent,attempts:t.attempts});

async function closeAll(f,endpoints){
  // Release only responses owned by this scenario. Unknown remote outcome holds
  // remain in SQLite; closing a local server is not a refund or remote receipt.
  for(const ep of endpoints)ep.state.hold?.resolve();
  if(f)await f.close();
  for(const ep of endpoints)await ep.close();
}

async function mainScenario(root,runtime){
  await mkdir(root);const clock=timeline(),eps=[];let f;
  try {
    for(const p of parts)eps.push(await endpoint(p.id,clock));
    const both=Promise.withResolvers(),release=Promise.withResolvers();let arrivals=0;
    for(const [index,ep] of eps.entries()){
      ep.state.hold=release;
      ep.state.onPost=()=>{if(++arrivals===3)both.resolve();};
      ep.state.reply=input=>{
        const p=parts[index];assert.equal(input.task.kind,'coding');assert.equal(input.task.routing.category,p.id);
        assert.deepEqual(input.task.permissions.writePaths,[p.file]);assert.ok(input.inventory.find(file=>file.path===p.file)?.hash);
        assert.equal(input.attempt<=2,true);
        if(input.attempt>1){assert.equal(index,0);assert.equal(input.repair.failure.category,'functional_check');}
        return JSON.stringify({type:'submit_changes',paths:[],summary:'Scripted '+p.id+' contribution',edits:[{path:p.file,action:'write',baseHash:input.inventory.find(file=>file.path===p.file).hash,content:index===0&&input.attempt===1?p.wrong:p.correct}]});
      };
    }
    const specification=await project(path.join(root,'repo'),runtime,parts,checkText);
    f=await session(path.join(root,'state'),eps.map(ep=>ep.profile),runtime,{project:specification});
    const tasks=[];
    for(const p of parts)tasks.push(await f.submit(p.id,'worker-'+p.id,{kind:'coding',objective:'Refactor '+p.id+' invitation behavior under protected reference checks',routing:{version:1,category:p.id},permissions:{readPaths:['src/','checks/'],writePaths:[p.file],checks:['invitation']}}));
    // Drive only the actual Worker runner path. The server barriers observe
    // all three entered POSTs before the first response can leave.
    const pending=f.until(()=>arrivals>=3,'three coding POSTs admitted');
    let held;
    try {await bounded(both.promise,'all three actual coding POSTs');
      held={requests:capacitySnapshot(f.c).requests,tasks:tasks.map(t=>safeTask(f.c.getTask(t.id))),calls:eps.flatMap(ep=>ep.calls)};
      assert.equal(held.requests.length,3);assert.equal(clock.maximum,3);assert.equal(clock.active,3);
      assert.equal(new Set(held.tasks.map(t=>f.c.getTask(t.id).owner)).size,3);
    } finally {release.resolve();}
    await pending;
    await f.until(()=>tasks.every(t=>f.c.getTask(t.id).status==='awaiting_review'),'all three checked candidates');
    const failedJournal=await new Journal(path.join(root,'state','coding'),tasks[0].id).load();
    const failed=failedJournal.completed('harness-attempt-1/checks');assert.equal(failed.value[0].passed,false);assert.match(failed.value[0].stderr,/combined invitation behavior/);
    const accepted=[];
    for(const t of tasks){
      const candidate=f.c.getTask(t.id);assert.ok(candidate.result.checks.every(c=>c.passed));
      assert.equal(await readFile(path.join(candidate.result.worktree,'checks/invitation.mjs'),'utf8'),checkText);
      for(const check of candidate.result.checks){assert.equal(check.backend.id,'darwin-seatbelt');assert.equal(check.backend.revision,2);assert.equal(check.backend.runtime.fingerprint,runtime.identity.fingerprint);}
      const item=(await f.invoke('review_inbox',{goalId:f.goal.id})).items.find(item=>item.taskId===t.id);assert.ok(item);
      const ticket=await f.mutate('review_reserve',item.binding,'reserve-'+t.id);
      const reviewInput={...item.binding,ticketId:ticket.ticketId,verdict:{decision:'accept',feedback:'Scripted host assessment of bound candidate and real protected checks; no actual coding app review',findings:[]}};
      await f.mutate('review_submit',reviewInput,'review-'+t.id);
      const integrationInput={taskId:t.id,feedback:'Combine exact scripted assessed contribution'};
      const result=await f.operation('task_integrate',integrationInput,'integrate-'+t.id);
      assert.equal(result.status,'accepted');assert.ok(result.integration.checks.every(c=>c.passed));
      assert.equal(result.integration.behavioralEvidence.criteria[0].status,'passed');
      assert.deepEqual(result.providerBinding,candidate.providerBinding);
      await writeEvidence(root,'task-'+t.spec.submissionId,{task:result,requests:requestRows(f.c,t.id)});
      accepted.push({result,reviewInput,integrationInput});
    }
    const combined=accepted.at(-1).result.integration.worktree;
    assert.equal(new Set(accepted.map(a=>a.result.integration.worktree)).size,1);
    for(const p of parts)assert.equal(await readFile(path.join(combined,p.file),'utf8'),p.correct);
    assert.equal(await readFile(path.join(combined,'checks/invitation.mjs'),'utf8'),checkText);
    assert.equal(await git(specification.repo,'rev-parse','HEAD'),specification.baseCommit);assert.equal(await git(specification.repo,'status','--porcelain'),'');
    const requestsBefore=tasks.flatMap(t=>requestRows(f.c,t.id)),pins=tasks.map(t=>stableBindings(f.c.getTask(t.id))),postCount=eps.flatMap(ep=>ep.posts()).length;
    for(const t of tasks)for(const r of requestRows(f.c,t.id)){
      assert.deepEqual(r.providerBinding,f.c.getTask(t.id).providerBinding);assert.equal(r.routeHash,f.c.getTask(t.id).routeHash);
    }
    await f.restart();
    for(const a of accepted){await f.mutate('review_submit',a.reviewInput,'review-'+a.result.id);assert.deepEqual(await f.operation('task_integrate',a.integrationInput,'integrate-'+a.result.id),a.result);}
    await f.worker.tick();assert.equal(eps.flatMap(ep=>ep.posts()).length,postCount);
    assert.deepEqual(tasks.flatMap(t=>requestRows(f.c,t.id)),requestsBefore);assert.deepEqual(tasks.map(t=>stableBindings(f.c.getTask(t.id))),pins);
    const events=f.c.store.events(0,1000);
    for(const t of tasks)for(const type of ['task.routed','task.reviewed','task.integrated'])assert.equal(events.filter(e=>e.task_id===t.id&&e.type===type).length,1);
    assert.equal((await f.invoke('outcomes_report',{goalId:f.goal.id})).counts.usefulAccepted,3);
    assert.ok(f.c.store.all('execution_owner').every(o=>o.status==='quiescent'));
    assert.deepEqual(clock.errors,[]);
    const evidenceHash=await writeEvidence(root,'observations',{held,events,calls:eps.flatMap(ep=>ep.calls),requests:requestsBefore,executionOwners:f.c.store.all('execution_owner'),failedCheck:failed});
    return {root,goalId:f.goal.id,goalHash:f.goal.hash,baseCommit:specification.baseCommit,endpoints:eps.map(ep=>endpointIdentity(ep.profile)),
      overlap:{configured:{service:3,goal:3,groups:1,profile:1},observedMaximum:clock.maximum,heldRequests:held.requests.length,barrier:'three POST handlers entered before any response released',protectedChecks:'production ownership and repository gates retained; no claim of parallel check throughput'},
      tasks:accepted.map(({result:t})=>({...safeTask(t),integration:{commit:t.integration.commit,worktree:t.integration.worktree,checks:t.integration.checks.map(checkSummary)},requests:requestRows(f.c,t.id).map(summaryRequest)})),
      protectedChecks:{sha256:sha256(Buffer.from(checkText)),rejectedWrongCandidate:true,combinedPassed:true,combinedOutput:'Invite: alice@example.invalid',specimens:5},replay:{sameBindings:true,noDuplicatePost:true},evidenceHash};
  } finally {await closeAll(f,eps);}
}

async function busyScenario(root,runtime){
  await mkdir(root);const clock=timeline(),eps=[];let f;
  try {
    for(const id of ['backend','frontend','tests'])eps.push(await endpoint(id,clock));
    const [a,b,c]=eps;c.state.hold=Promise.withResolvers();
    f=await session(path.join(root,'state'),eps.map(ep=>ep.profile),runtime);
    const occupied=await f.submit('occupied','worker-tests');
    const tick=f.worker.tick();await bounded(c.entered.promise,'busy third worker entered');await tick;
    const waiting=await f.submit('busy-third','worker-tests'),healthy=await f.submit('healthy','worker-backend');
    await f.until(()=>f.c.getTask(healthy.id).status==='awaiting_review'&&!!f.c.getTask(waiting.id).routingWait,'independent work while third busy');
    const waitingTask=f.c.getTask(waiting.id);assert.equal(waitingTask.spent.model,0);assert.equal(c.posts().length,1);
    assert.equal(waitingTask.routingWait.decision.binding.providerId,'worker-tests');assert.equal(a.posts().length,1);assert.equal(b.posts().length,0);
    const beforeRelease={spend:waitingTask.spent.model,posts:c.posts().length-1,task:safeTask(waitingTask),capacity:capacitySnapshot(f.c).requests};
    c.state.hold.resolve();await f.until(()=>f.c.getTask(occupied.id).status==='awaiting_review','occupied response completes');
    f.advanceClock();await f.until(()=>f.c.getTask(waiting.id).status==='awaiting_review','original pinned third worker resumes');
    assert.equal(c.posts().length,2);assert.equal(f.c.getTask(waiting.id).providerBinding.providerId,'worker-tests');
    const observations={beforeRelease,after:safeTask(f.c.getTask(waiting.id)),calls:eps.flatMap(ep=>ep.calls)};
    await writeEvidence(root,'observations',observations);assert.deepEqual(clock.errors,[]);
    return {root,beforeRelease,after:observations.after,independentProgress:true};
  } finally {await closeAll(f,eps);}
}

async function offlineScenario(root,runtime){
  await mkdir(root);const clock=timeline(),eps=[];let f;
  try {
    for(const id of ['backend','frontend','tests'])eps.push(await endpoint(id,clock));
    const [a,,c]=eps;c.state.online=false;
    f=await session(path.join(root,'state'),eps.map(ep=>ep.profile),runtime);
    const offline=await f.submit('offline-third','worker-tests'),healthy=await f.submit('healthy','worker-backend');
    await f.until(()=>f.c.getTask(healthy.id).status==='awaiting_review'&&!!f.c.getTask(offline.id).routingWait,'offline route does not starve independent worker');
    const before=f.c.getTask(offline.id);assert.equal(before.spent.model,0);assert.equal(c.posts().length,0);assert.equal(before.routingWait.decision.reasonCode,'provider_offline');
    assert.equal(before.routingWait.decision.binding.providerId,'worker-tests');assert.equal(a.posts().length,1);
    const beforeDispatch={task:safeTask(before),spend:before.spent.model,posts:c.posts().length};
    // Recovery of readiness followed by actual dispatch and socket disconnect.
    c.state.online=true;c.state.disconnect=true;f.advanceClock();
    await f.until(()=>f.c.getTask(offline.id).status==='uncertain','attempted offline outcome retained');
    const attempted=f.c.getTask(offline.id),request=requestRows(f.c,offline.id)[0];
    assert.equal(attempted.spent.model,1);assert.equal(request.requestOutcome,'unknown');assert.equal(c.posts().length,1);
    assert.equal(attempted.providerBinding.providerId,'worker-tests');
    const pins=stableBindings(attempted);await f.restart();await f.worker.tick();
    assert.deepEqual(stableBindings(f.c.getTask(offline.id)),pins);assert.equal(c.posts().length,1);
    assert.equal(capacitySnapshot(f.c).requests.length,1);assert.deepEqual(clock.errors,[]);
    await writeEvidence(root,'observations',{beforeDispatch,attempted:safeTask(attempted),request,calls:eps.flatMap(ep=>ep.calls),capacity:capacitySnapshot(f.c).requests});
    return {root,beforeDispatch,attempted:{task:safeTask(attempted),spend:attempted.spent.model,request:summaryRequest(request)},restart:{sameBindings:true,noDuplicatePost:true,holdRetained:true}};
  } finally {await closeAll(f,eps);}
}

async function ambiguousScenario(root,runtime){
  await mkdir(root);const clock=timeline(),eps=[];let f;
  try {
    for(const id of ['backend','frontend','tests'])eps.push(await endpoint(id,clock));
    const [a,,c]=eps,alias={...c.profile,id:'worker-tests-alias',model:'scripted-tests-alias',displayName:'Same physical service alias',capabilities:{...c.profile.capabilities,modelDiscovery:'manual'}};
    c.state.hold=Promise.withResolvers();c.state.disconnect=true;
    f=await session(path.join(root,'state'),[...eps.map(ep=>ep.profile),alias],runtime);
    const original=await f.submit('ambiguous-third','worker-tests');
    const tick=f.worker.tick();await bounded(c.entered.promise,'original dispatched third worker');await tick;
    const aliasTask=await f.submit('alias-third','worker-tests-alias'),healthy=await f.submit('healthy','worker-backend');
    await f.until(()=>f.c.getTask(healthy.id).status==='awaiting_review'&&!!f.c.getTask(aliasTask.id).routingWait,'shared capacity occupied');
    assert.equal(c.posts().length,1);assert.equal(f.c.getTask(aliasTask.id).spent.model,0);assert.equal(a.posts().length,1);
    // Supported control while the lane is running; a disconnect cannot certify
    // completion even when a stop was requested.
    await f.mutate('work_control',{taskId:original.id,action:'stop'},'stop-original');
    c.state.hold.resolve();await f.until(()=>f.c.getTask(original.id).status==='uncertain','ambiguous request after requested stop');
    const before=f.c.getTask(original.id),request=requestRows(f.c,original.id)[0],pins=stableBindings(before);
    assert.equal(before.spent.model,1);assert.equal(request.requestOutcome,'unknown');
    const aliasBefore=f.c.getTask(aliasTask.id);assert.equal(aliasBefore.routingWait.decision.binding.providerId,alias.id);
    await f.restart();
    // Replay public submissions, worker scheduling and stop. No SQL manufacture.
    assert.equal((await f.submit('ambiguous-third','worker-tests')).id,original.id);
    assert.equal((await f.submit('alias-third','worker-tests-alias')).id,aliasTask.id);
    let stopRefusal;try{await f.mutate('work_control',{taskId:original.id,action:'stop'},'stop-after-restart');}catch(e){stopRefusal=e.message;}
    assert.match(stopRefusal,/uncertain|reconcil|ownership/i);
    f.advanceClock();await f.worker.tick();await f.worker.tick();
    assert.deepEqual(stableBindings(f.c.getTask(original.id)),pins);assert.deepEqual(requestRows(f.c,original.id)[0],request);
    assert.equal(c.posts().length,1);assert.equal(f.c.getTask(aliasTask.id).spent.model,0);assert.equal(capacitySnapshot(f.c).requests.length,1);
    assert.equal(f.c.getTask(aliasTask.id).routingWait.decision.binding.providerId,alias.id);assert.deepEqual(clock.errors,[]);
    await writeEvidence(root,'observations',{original:safeTask(before),request,alias:safeTask(f.c.getTask(aliasTask.id)),profiles:[endpointIdentity(c.profile),endpointIdentity(alias)],calls:eps.flatMap(ep=>ep.calls),capacity:capacitySnapshot(f.c).requests,stopRefusal});
    return {root,original:{task:safeTask(before),request:summaryRequest(request)},alias:{task:safeTask(f.c.getTask(aliasTask.id)),spend:0,posts:0,profiles:[endpointIdentity(c.profile),endpointIdentity(alias)],groupLimit:1},replay:{sameBindings:true,noDuplicatePost:true,holdRetained:true,stopRefusal}};
  } finally {await closeAll(f,eps);}
}

export async function runRehearsal({root}) {
  await freshRoot(root);
  try {
    const runtime=runtimeConfiguration(),source=await sourceIdentity();
    const main=await mainScenario(path.join(root,'main'),runtime);
    const busy=await busyScenario(path.join(root,'busy'),runtime);
    const offline=await offlineScenario(path.join(root,'offline'),runtime);
    const ambiguous=await ambiguousScenario(path.join(root,'ambiguous'),runtime);
    const report={schemaVersion:1,label:'Scripted model/reviewer rehearsal',fixtureOnly:true,liveCallsMade:false,root,source,
      runtime:{backend:runtime.executionPolicy,fingerprint:runtime.identity.fingerprint,identity:runtime.identity},main,busy,offline,ambiguous,
      quiescence:{localWorkersClosed:true,listenersClosed:true,uncertainRootsRetained:[offline.root,ambiguous.root]},
      limits:{fixtureHours:1,serviceConcurrentTasks:3,goalConcurrentTasks:3,physicalGroup:1,codingAttempts:2,codingModelCalls:2,reviewsPerTask:1,maxTasksPerScenario:8},
      unclosed:['M027 multiple-worker wizard','M063 real three-worker project pilot','M064 live efficiency qualification','Actual coding-app review']};
    assert.ok(Buffer.byteLength(JSON.stringify(report))<256*1024);await writeEvidence(root,'rehearsal-result',report);return report;
  } catch(error) {
    await writeEvidence(root,'failure',{schemaVersion:1,fixtureOnly:true,root,reason:String(error),stack:error.stack,retained:true});throw error;
  }
}

export async function inspectRehearsal(root) {
  const file=path.join(root,'rehearsal-result.json');
  const limit=256*1024;
  // Open once without following a final symlink or blocking on a FIFO. Bound
  // actual bytes read too: a regular file can grow after its initial stat.
  const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let text;
  try {
    const info=await handle.stat();assert.ok(info.isFile(),'Report must be a regular file');assert.ok(info.size<limit,'report exceeds bound');
    const bytes=Buffer.alloc(limit);let used=0;
    while(used<limit){const chunk=await handle.read(bytes,used,limit-used,null);if(!chunk.bytesRead)break;used+=chunk.bytesRead;}
    assert.ok(used<limit,'report exceeds bound');text=bytes.subarray(0,used).toString('utf8');
  } finally {await handle.close();}
  const report=JSON.parse(text);
  assert.equal(report.schemaVersion,1);assert.equal(report.fixtureOnly,true);assert.equal(report.liveCallsMade,false);assert.equal(report.label,'Scripted model/reviewer rehearsal');
  assert.equal(report.root,root);assert.ok(report.main?.tasks?.length===3);assert.ok(report.main.overlap.observedMaximum>=2);
  assert.ok(report.quiescence.localWorkersClosed&&report.quiescence.listenersClosed);assert.doesNotMatch(text,/dummy-bearer|fixture-key|Bearer /);
  return report; // Reads no database and acquires no worker lease.
}
