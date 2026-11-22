import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, realpath, lstat} from 'node:fs/promises';
import {Coordinator} from '../../../src/harness/coordinator.mjs';
import {Worker} from '../../../src/harness/worker.mjs';
import {Dispatcher} from '../../../src/harness/tools.mjs';
import {ProviderRegistry} from '../../../src/harness/providers/registry.mjs';
import {nativeRuntime} from '../../../src/harness/execution.mjs';
import {git} from '../../../src/project/process.mjs';
import {assertNoGitRepositoryOverride} from '../../../scripts/lib/git-environment.mjs';

export {git};
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function freshRoot(root) {
  await assertNoGitRepositoryOverride('rehearsal');
  const parent = path.dirname(root);
  if (await realpath(parent)!==parent || !(await lstat(parent)).isDirectory()) throw Error('Root parent must exist at a canonical path');
  await mkdir(root,{mode:0o700}); // Atomic refusal of existing or symlink roots.
}
export function runtimeConfiguration() {
  const artifactManifestPath=process.env.MOSAIC_THREE_WORKER_NATIVE_MANIFEST;
  const artifactManifestSha256=process.env.MOSAIC_THREE_WORKER_NATIVE_SHA256;
  const nativeCheckRuntime={schema:1,artifactManifestPath,artifactManifestSha256};
  const identity=nativeRuntime({nativeCheckRuntime}); // Validates bytes, modes, implementation and platform.
  return {nativeCheckRuntime, identity, executionPolicy:{version:1,backend:'darwin-seatbelt',backendRevision:2,runtimeFingerprint:identity.fingerprint}};
}
export async function bounded(promise, label, ms=30000) {
  let timer;
  try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Barrier timeout: '+label)),ms);})]); }
  finally { clearTimeout(timer); }
}

// One independently listening server per endpoint. No auth bytes are retained.
export async function endpoint(id, timeline) {
  const calls=[], entered=Promise.withResolvers(), state={online:true,hold:null,disconnect:false,reply:null,onPost:null};
  let active=0;
  const server=http.createServer(async(req,res)=>{
    try {
      assert.equal(req.headers.authorization,'Bearer dummy-bearer-'+id);
      let raw=''; for await(const chunk of req) {raw+=chunk;assert.ok(raw.length<256*1024);}
      const body=raw?JSON.parse(raw):null;
      assert.ok(calls.length<100,'bounded fixture requests');
      const call={endpoint:id,method:req.method,url:req.url,model:body?.model??null,entered:++timeline.sequence};calls.push(call);
      res.setHeader('content-type','application/json');
      if(req.method==='GET') {
        assert.equal(req.url,'/v1/models');
        return state.online?res.end(JSON.stringify({data:[{id:'scripted-'+id}]})):res.writeHead(503).end('{}');
      }
      assert.equal(req.method,'POST');assert.equal(req.url,'/v1/chat/completions');assert.equal(body.stream,false);
      // Aliases intentionally use another model ID on this same physical endpoint.
      assert.ok([`scripted-${id}`,`scripted-${id}-alias`].includes(body.model));
      const input=JSON.parse(body.messages.at(-1).content);
      call.taskSubmissionId=input.task.submissionId??null; call.kind=input.task.kind;call.category=input.task.routing?.category??null;call.attempt=input.attempt??1;
      active++;timeline.active++;timeline.maximum=Math.max(timeline.maximum,timeline.active);
      let settled=false;const settle=()=>{if(!settled){settled=true;active--;timeline.active--;call.settled=++timeline.sequence;}};
      res.once('finish',settle);res.once('close',settle);
      entered.resolve(call);state.onPost?.(call);
      if(state.hold)await state.hold.promise;
      if(state.disconnect){call.disconnected=true;req.socket.destroy();return;}
      const content=state.reply?await state.reply(input,body):'Scripted bounded consultation';
      call.responseReleased=++timeline.sequence;
      res.end(JSON.stringify({model:body.model,choices:[{message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:7,completion_tokens:5}}));
    } catch(error) { timeline.errors.push(String(error));if(!res.destroyed)res.writeHead(500).end('{}'); }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
  const profile={schema:1,id:'worker-'+id,revision:'r1',displayName:'Scripted '+id,transport:'openai-chat',baseUrl,model:'scripted-'+id,roles:['worker'],capabilities:{workerProtocol:'mosaic-structured-v1',transports:['json'],modelDiscovery:'advertised',taskKinds:['coding','consult']},maxContextTokens:32000,maxOutputTokens:2048,concurrency:1,capacityGroup:'physical-'+id,credentialRef:'fixture-key-'+id,streaming:false};
  return {id,profile,calls,state,entered,posts:()=>calls.filter(c=>c.method==='POST'),get active(){return active;},
    async close(){state.hold?.resolve();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));assert.equal(active,0);}};
}
export function timeline() {return {sequence:0,active:0,maximum:0,errors:[]};}

export async function session(root, profiles, runtime, {project,groups,limit=3}={}) {
  await mkdir(root);
  let c,worker,d,owner,generation=0,now=Date.now(),sequence=0;
  const config={environment:'fixture',...(project?{nativeCheckRuntime:runtime.nativeCheckRuntime}:{})};
  function connect() {
    c=new Coordinator({root,now:()=>now,selectedHost:'codex',serviceMaxConcurrentTasks:3,
      ...(project?{nativeCheckRuntime:runtime.nativeCheckRuntime,executionPolicy:runtime.executionPolicy}:{}),
      providerRegistry:ProviderRegistry({profiles,credentialResolver:ref=>'dummy-bearer-'+ref.replace('fixture-key-','')})});
    owner='rehearsal-owner-'+(++generation);c.acquireWorker(owner);
    worker=new Worker({c,owner,config});d=new Dispatcher({c,worker,config});
  }
  connect();
  const invoke=(name,input={})=>d.invoke(name,input);
  const mutate=(name,input,key='command-'+(++sequence))=>invoke(name,{...input,idempotencyKey:key});
  const raw={submissionId:'rehearsal',objective:'Three routed scripted worker rehearsal',acceptance:['Bounded exact contributions and pinned requests'],environment:'fixture',mode:'collaborative',
    limits:{hours:1,maxTasks:8,reviewAgentRuns:6,taskLimits:{coding:{seconds:600,attempts:2,modelCalls:2,reviews:1,questions:0},consult:{seconds:120,attempts:1,modelCalls:1,reviews:1,questions:0}}},
    ...(project?{project,executionPolicy:runtime.executionPolicy}:{}),
    providerPolicy:{version:1,workers:c.providerRegistry.snapshot(profiles.map(({id,revision})=>({id,revision}))),plannerWorkerId:profiles[0].id,defaultWorkerId:profiles[0].id,maxConcurrentTasks:limit,capacityGroups:groups??[...new Set(profiles.map(p=>p.capacityGroup))].map(id=>({id,limit:1}))},
    routingPolicy:{version:1,rules:profiles.filter(p=>['worker-backend','worker-frontend','worker-tests'].includes(p.id)).map(p=>({id:p.id,category:p.id.replace('worker-',''),providerId:p.id})),defaultWorkerId:profiles[0].id},reviewPolicy:{version:1,source:'host',hostId:'codex',fallback:'wait'}};
  const prepared=await mutate(project?'assignment_prepare':'goal_prepare',{manifest:raw},'prepare');
  const goal=await mutate('goal_activate',{goalId:prepared.goalId??prepared.id,hash:prepared.hash},'activate');
  async function close(){await worker.close();await d.whenIdle();c.releaseWorker(owner);c.close();}
  return {raw,goal,invoke,mutate,get c(){return c;},get worker(){return worker;},get owner(){return owner;},
    async restart(){await close();now+=20000;connect();},close,
    advanceClock(){now+=20000;},
    async until(done,label,max=120){for(let n=0;n<max;n++){if(done())return;await worker.tick();}assert.ok(done(),label+': '+JSON.stringify(c.store.all('task').map(t=>({id:t.id,status:t.status,reason:t.reason,checkpoint:t.checkpoint.phase}))));},
    submit(id,providerId,extra={}) {return mutate('task_submit',{goalId:goal.id,task:{submissionId:id,kind:'consult',objective:'Return bounded fixture contribution',acceptance:['Exact route and outcome'],routing:{version:1,preferredProviderId:providerId},...extra}},'submit-'+id);},
    async operation(name,input,key){const op=await mutate(name,input,key);await d.whenIdle();const saved=await invoke('operation_get',{operationId:op.id});assert.equal(saved.status,'completed',saved.error);return saved.result;},
  };
}

export async function project(root, runtime, parts, checkText) {
  await mkdir(path.join(root,'src'),{recursive:true});await mkdir(path.join(root,'checks'));
  for(const p of parts)await writeFile(path.join(root,p.file),p.initial);
  await writeFile(path.join(root,'checks/invitation.mjs'),checkText);
  await git(root,'init','-q');await git(root,'add','.');await git(root,'-c','user.name=Rehearsal','-c','user.email=rehearsal@example.invalid','commit','-qm','Trusted fixture base');
  return {repo:root,baseCommit:await git(root,'rev-parse','HEAD'),readPaths:['src/','checks/'],writePaths:['src/'],checks:[{id:'invitation',argv:[runtime.identity.runtime.executable,'checks/invitation.mjs'],timeoutMs:10000}],behavioralChecks:[{criterionId:'invitation',description:'Canonical address with frontend label and independent adversarial specimens',checkIds:['invitation']}]};
}
export const safeTask = task => ({id:task.id,status:task.status,hash:task.hash,goalVersion:task.goalVersion,spec:task.spec,providerBinding:task.providerBinding??null,routeHash:task.routeHash??null,route:task.route??null,routingWait:task.routingWait??null,spent:task.spent,attempts:task.attempts,deadline:task.deadline,stopRequested:task.stopRequested??false});
export function requestRows(c, taskId) {
  return c.store.requestOutcomes(taskId).map(r=>c.store.request(taskId,r.key));
}
export async function writeEvidence(root, name, value) {
  const text=JSON.stringify(value,null,2)+'\n';assert.ok(Buffer.byteLength(text)<1024*1024,'bounded raw evidence');
  assert.doesNotMatch(text,/dummy-bearer|fixture-key|Bearer /);
  await writeFile(path.join(root,name+'.json'),text,{mode:0o600});
  return sha256(Buffer.from(text));
}
