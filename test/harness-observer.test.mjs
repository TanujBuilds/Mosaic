import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';
import {Artifacts} from '../src/harness/artifacts.mjs';
import {Observer} from '../src/harness/observer.mjs';
import {startApi} from '../src/harness/api.mjs';
import {normalizeLegacyWorkerProfile,profileIdentity} from '../src/harness/providers/contracts.mjs';
import {ProviderRegistry} from '../src/harness/providers/registry.mjs';
function fixture(t){const root=mkdtempSync(path.join(os.tmpdir(),'harness-observer-')),c=new Coordinator({root});t.after(()=>{c.close();rmSync(root,{recursive:true,force:true});});const g=c.prepareGoal({submissionId:'observer',objective:'Observe useful work',acceptance:['Evidence'],environment:'fixture'},'prepare');c.activateGoal({goalId:g.id,hash:g.hash},'activate');const ds=c.submitTask({goalId:g.id,submissionId:'ds',kind:'consult',objective:'DeepSeek task',acceptance:['Useful']},'ds'),native=c.submitTask({goalId:g.id,submissionId:'native',kind:'consult',actor:'codex',objective:'Codex task',acceptance:['Useful']},'native');return {root,c,g,ds,native,observer:new Observer({c,artifacts:new Artifacts(c)})};}
async function apiFixture(t,options={}){const f=fixture(t),dispatcher=new Dispatcher({c:f.c}),token='o'.repeat(64),viewerToken='v'.repeat(64),api=await startApi({dispatcher,token,viewerToken,...options});t.after(()=>api.close());const call=(name,input={},credential=viewerToken,extra={})=>fetch(api.url+'/api/invoke',{method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json',...extra},body:JSON.stringify({name,input})});return {...f,dispatcher,token,viewerToken,api,call};}
test('observer snapshots distinguish captured execution and reported native work without fabricated accounting',t=>{
 const f=fixture(t);f.c.claimNext('worker');f.c.emit('model.request.started',f.g.id,f.ds.id,{version:1,actor:'deepseek',provenance:'captured',requestId:'request-1'});f.c.store.put('agent',{id:'agent-1',goalId:f.g.id,taskId:f.native.id,actor:'codex',role:'implementer',model:{requested:null,resolved:null},modelSource:'inherited',registeredAt:0,lastReport:{summary:'Editing scoped file',status:'running',at:0}});
 const x=f.observer.snapshot({goalId:f.g.id});assert.equal(x.goals[0].mode,'collaborative');assert.equal(x.tasks.find(t=>t.id===f.ds.id).provenance,'captured');assert.equal(x.agents[0].provenance,'reported');assert.equal(x.agents[0].stale,true);assert.equal(x.agents[0].accounting.tokens,null);assert.equal(x.tasks.find(t=>t.id===f.native.id).model.resolved,null);assert.equal(x.operatorToken,undefined);assert.equal(x.goals[0].manifest,undefined);
});
for(const schema of ['legacy','portable'])test(`beta viewer projects ${schema} display identity and the last saved live response`,t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'harness-observer-connections-'));
 let now=1000;
 const workerProfile={baseUrl:'https://private-worker.example/v1',model:'private-model',displayName:'Selected Worker',revision:'private-revision',streaming:false};
 const profile=normalizeLegacyWorkerProfile({schema:1,worker:{profile:workerProfile}},{id:'private-worker-id',capacityGroup:'private-capacity',credentialRef:'private-key'});
 const providerRegistry=ProviderRegistry({profiles:[profile]});
 const workerOptions=schema==='legacy'?{workerProfile}:{providerRegistry,configuredPolicies:{providerPolicy:{
  version:1,workers:[profileIdentity(profile)],plannerWorkerId:profile.id,defaultWorkerId:profile.id,capacityGroups:[{id:profile.capacityGroup,limit:1}]
 }}};
 const c=new Coordinator({root,now:()=>now,beta:true,selectedHost:'cursor',...workerOptions});
 t.after(()=>{c.close();rmSync(root,{recursive:true,force:true});});
 const observer=new Observer({c});
 const configured={host:{id:'cursor',lastConnection:null},worker:{displayName:'Selected Worker',lastConnection:null}};
 assert.deepEqual(observer.snapshot().connections,configured);
 function saveResponse(environment,at){
  const g=c.prepareGoal({submissionId:environment,objective:'Connect',acceptance:['Evidence'],mode:'deepseek_only',environment},'prepare-'+environment);
  c.activateGoal({goalId:g.id,hash:g.hash},'activate-'+environment);
  const task=c.submitTask({goalId:g.id,submissionId:'response',kind:'consult',objective:'Answer',acceptance:['Evidence']},'task-'+environment);
  assert.equal(c.claimNext('owner').id,task.id);
  const request=c.reserve(task.id,{key:'request',kind:'model'},'owner');
  now=at;c.saveRequest(request.id,{content:'private-result',model:'private-model'},'owner');
  c.completeTask(task.id,{summary:'Saved response'},'owner');
  return g;
 }
 const live=saveResponse('live',2000);
 saveResponse('fixture',3000);
 const result=observer.snapshot({goalId:live.id}).connections;
 assert.deepEqual(result,{...configured,worker:{displayName:'Selected Worker',lastConnection:{kind:'worker_response',at:2000}}});
 assert.doesNotMatch(JSON.stringify(result),/private-/);
});
test('timeline uses global scan cursors through filters and excludes chunk/checkpoint noise',t=>{
 const f=fixture(t),after=f.c.store.events(0,1000).at(-1).seq;
 for(let i=0;i<240;i++)f.c.emit('model.output',f.g.id,f.ds.id,{actor:'deepseek',provenance:'captured',requestId:'stream',content:'sample'});
 f.c.emit('agent.reported',f.g.id,f.native.id,{agentId:'a',summary:'Reported action'});f.c.emit('coding.files.read',f.g.id,f.ds.id,{actor:'deepseek',provenance:'captured',files:[{path:'src/a.mjs',hash:'saved'}]});
 const first=f.observer.timeline({after,actor:'codex',limit:1});assert.equal(first.events.length,1);assert.equal(first.events[0].provenance,'reported');assert.equal(first.events[0].summary,'Reported action');
 const second=f.observer.timeline({after:first.cursor,actor:'codex'});assert.equal(second.events.length,0);assert.ok(second.cursor>first.cursor);assert.equal(second.hasMore,false);
 const all=f.observer.timeline({after});assert.equal(all.events.length,2);assert.deepEqual(all.events.map(e=>e.seq),[...all.events.map(e=>e.seq)].sort((a,b)=>a-b));
 for(const q of [{limit:201},{after:-1},{actor:'invalid'},{path:'/etc/passwd'}])assert.throws(()=>f.observer.timeline(q));
});
test('saved request evidence and live visible chunks are bounded, provenance-labeled and cannot read private config',async t=>{
 const f=fixture(t);f.c.claimNext('worker');const reserved=f.c.reserve(f.ds.id,{key:'model-1',kind:'model'},'worker');f.c.emit('model.output',f.g.id,f.ds.id,{actor:'deepseek',provenance:'captured',requestId:reserved.id,content:'Visible partial'});
 const partial=await f.observer.evidence({reference:'request-'+reserved.id});assert.equal(partial.partial,true);assert.match(partial.text,/Visible partial/);assert.doesNotMatch(partial.text,/operatorToken/);
 f.c.saveRequest(reserved.id,{content:'界'.repeat(14000),model:'fixture',usage:{total_tokens:12}});const complete=await f.observer.evidence({reference:'request-'+reserved.id,length:32768});assert.equal(complete.partial,false);assert.ok(Buffer.byteLength(complete.text)<=32768);assert.equal(complete.text.includes('\ufffd'),false);assert.ok(complete.totalBytes>32768);assert.equal(complete.sha256.length,64);
 const snap=f.observer.snapshot({});assert.equal(snap.tasks.find(t=>t.id===f.ds.id).usage.reportedTokens,12);
 for(const q of [{reference:'../../connection.json'},{reference:'task-no-such-task'},{reference:'request-no-such-request'},{reference:'request-'+reserved.id,length:32769},{reference:'request-'+reserved.id,path:'/etc/passwd'}])await assert.rejects(f.observer.evidence(q));
});
test('viewer can discover only observer reads and is denied every mutation before effects',async t=>{
 const f=await apiFixture(t),before=f.c.store.events(0,1000).length;
 const discovery=await f.call('tools_list');assert.equal(discovery.status,200);const list=await discovery.json();assert.ok(list.some(x=>x.name==='observer_snapshot'));assert.ok(list.every(x=>x.annotations.readOnlyHint));assert.ok(!list.some(x=>x.name==='goal_prepare'));
 for(const tool of f.dispatcher.tools().filter(x=>!x.annotations.readOnlyHint)){assert.equal((await f.call(tool.name,{idempotencyKey:'viewer-'+tool.name})).status,403,tool.name);}
 f.dispatcher.definitions.set('late_mutator',{name:'late_mutator',annotations:{readOnlyHint:false},inputSchema:{type:'object'},fn:()=>{throw Error('must not execute');},mutating:true});assert.equal((await f.call('late_mutator')).status,403);
 assert.equal((await f.call('goal_get')).status,403);assert.equal(f.c.store.events(0,1000).length,before);assert.equal((await f.call('observer_snapshot')).status,200);
 assert.equal((await f.call('goal_get',{},f.token)).status,200);
});
test('viewer current activity preserves bounded history cursors without returning event payloads',async t=>{
 const f=await apiFixture(t),store=f.c.store;
 const early='activity-early',later='activity-later';
 store.tx(()=>{
  // These rows consume the scan budget without consuming a visible event slot.
  for(let i=0;i<1100;i++){
   const type=['model.output','execution.checkpoint','task.checkpoint'][i%3];
   store.event(type,{goalId:early,at:50000,data:{status:'running',summary:'Filtered payload'}});
  }
  for(let i=0;i<6600;i++){
   const goalId=i%5===0?null:i%2?early:later;
   const type=i%13===0?'goal.expired':i%17===0?'task.checkpoint':'task.result';
   store.event(type,{goalId,at:i===6599?70000:type==='goal.expired'?60000:1000+i,
    data:{summary:'Visible payload',...(i%17===0?{status:'saved'}:{})}});
  }
 });
 function legacy(after){
  let cursor=after,hasMore=false;const activity=new Map();
  for(let i=0;i<32;i++){
   const page=f.observer.timeline({after:cursor,limit:200});
   cursor=page.cursor;hasMore=page.hasMore;
   for(const e of page.events)if(e.goalId&&!['task.expired','goal.expired'].includes(e.type)){
    activity.set(e.goalId,Math.max(activity.get(e.goalId)??0,e.at));
   }
   if(!hasMore)break;
  }
  return {cursor,hasMore,activity:[...activity].map(([goalId,at])=>({goalId,at}))};
 }
 const discover=await f.call('tools_list');
 const tools=await discover.json();
 assert.equal(tools.find(tool=>tool.name==='observer_current_activity')?.annotations.readOnlyHint,true);
 const read=async after=>{
  const response=await f.call('observer_current_activity',{after});
  assert.equal(response.status,200);
  return response.json();
 };
 const first=await read(0);
 assert.deepEqual(first,legacy(0));
 assert.equal(first.hasMore,true);
 assert.ok(first.activity.find(e=>e.goalId===early).at<50000);
 const second=await read(first.cursor);
 assert.deepEqual(second,legacy(first.cursor));
 assert.equal(second.hasMore,false);
 assert.deepEqual(second.activity.find(e=>e.goalId===early),{goalId:early,at:70000});
 assert.deepEqual(await read(second.cursor),{cursor:second.cursor,hasMore:false,activity:[]});
 assert.equal((await f.call('observer_current_activity',{after:-1})).status,400);
});
test('viewer login role is derived from its key, cannot be promoted, and sessions retain CSRF checks',async t=>{
 const f=await apiFixture(t);const login=await fetch(f.api.url+'/login',{method:'POST',headers:{origin:f.api.url,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:f.viewerToken,role:'operator'}),redirect:'manual'});assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];const session=await fetch(f.api.url+'/api/session',{headers:{cookie}}).then(r=>r.json());assert.equal(session.role,'viewer');assert.ok(session.csrf);
 const send=(name,csrf)=>fetch(f.api.url+'/api/invoke',{method:'POST',headers:{cookie,origin:f.api.url,'content-type':'application/json',...(csrf?{'x-csrf-token':csrf}:{})},body:JSON.stringify({name,input:{}})});assert.equal((await send('observer_snapshot')).status,403);assert.equal((await send('observer_snapshot',session.csrf)).status,200);assert.equal((await send('service_stop',session.csrf)).status,403);
 assert.equal((await f.call('observer_snapshot',{},f.viewerToken,{origin:'https://evil.invalid'})).status,403);
});
function rawRequest(api,headers,path='/api/session',body){return new Promise((resolve,reject)=>{const req=http.request(api.url+path,{method:body?'POST':'GET',headers},res=>{let data='';res.on('data',x=>data+=x);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:data}));});req.on('error',reject);req.end(body);});}
test('configured private HTTPS proxy origins are explicit and forwarded headers cannot widen trust',async t=>{
 const origin='https://fixture-mac.example.ts.net',f=await apiFixture(t,{trustedOrigins:[origin]}),auth={authorization:'Bearer '+f.viewerToken};
 assert.equal((await rawRequest(f.api,{...auth,host:new URL(origin).host,origin})).status,200);
 const valid={...auth,host:new URL(f.api.url).host,origin,'x-forwarded-host':new URL(origin).host,'x-forwarded-proto':'https'};assert.equal((await rawRequest(f.api,valid)).status,200);
 for(const headers of [{...valid,'x-forwarded-host':'evil.invalid'},{...valid,'x-forwarded-proto':'http'},{...valid,'x-forwarded-host':[new URL(origin).host,new URL(origin).host]},{...valid,forwarded:'host=evil.invalid'},{...auth,host:'evil.invalid'},{...valid,origin:'https://evil.invalid'}])assert.equal((await rawRequest(f.api,headers)).status,403);
 const login=await rawRequest(f.api,{...valid,'content-type':'application/x-www-form-urlencoded'},'/login',new URLSearchParams({token:f.viewerToken}).toString());assert.equal(login.status,303);assert.match(login.headers['set-cookie'][0],/Secure/);
 await assert.rejects(startApi({dispatcher:f.dispatcher,token:f.token,viewerToken:f.token}),/distinct|different/);await assert.rejects(startApi({dispatcher:f.dispatcher,token:f.token,trustedOrigins:['http://public.invalid']}),/HTTPS|private/);
});
test('observer artifact windows verify membership and checksums',async t=>{
 const f=fixture(t),directory=path.join(f.root,'research',f.ds.id);await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'report.md'),'# Saved report\n<script>alert(1)</script>');const task=f.c.store.get('task',f.ds.id);task.result={checksumsVerified:true,directory};f.c.store.put('task',task);const artifacts=await f.observer.artifacts.list(task.id);const ref='artifact-'+artifacts[0].id;assert.match((await f.observer.evidence({reference:ref})).text,/<script>/);await writeFile(path.join(directory,'report.md'),'tampered');await assert.rejects(f.observer.evidence({reference:ref}),/checksum|changed/);
});

test('snapshot display text and observed model identity stay bounded',t=>{
 const f=fixture(t),task=f.c.store.get('task',f.ds.id);task.spec.objective='x'.repeat(12000);task.questions=[{text:'y'.repeat(8000),id:'question'}];task.result={model:{untrusted:'shape'}};f.c.store.put('task',task);const row=f.observer.snapshot({}).tasks.find(t=>t.id===task.id);assert.ok(row.objective.length<=2000);assert.ok(row.question.text.length<=2000);assert.equal(row.model.resolved,null);assert.equal(row.objectiveTruncated,true);
});

test('evidence never skips a multibyte character with a small or misaligned window',async t=>{
 const f=fixture(t),task=f.c.store.get('task',f.ds.id);task.result={text:'界a'};f.c.store.put('task',task);const ref='task-'+task.id,full=await f.observer.evidence({reference:ref}),at=Buffer.from(full.text).indexOf(Buffer.from('界'));for(const length of [1,2])await assert.rejects(f.observer.evidence({reference:ref,start:at,length}),/UTF-8|character/);await assert.rejects(f.observer.evidence({reference:ref,start:at+1,length:4}),/UTF-8|boundary/);assert.equal((await f.observer.evidence({reference:ref,start:at,length:4})).text,'界a');
});
test('snapshot filters before limiting and prioritizes actionable work over history',t=>{
 const f=fixture(t);for(let i=0;i<501;i++)f.c.store.put('task',{...f.ds,id:'history-'+i,status:'accepted'});const filtered=f.observer.snapshot({actor:'codex'});assert.ok(filtered.tasks.some(t=>t.id===f.native.id));assert.ok(f.observer.snapshot({}).queue.some(t=>t.id===f.native.id));assert.equal(f.observer.snapshot({}).overflow.tasks,true);
});
test('viewer discovers saved artifact IDs without operator registration',async t=>{
 const f=await apiFixture(t),directory=path.join(f.root,'research',f.ds.id);await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'report.md'),'# Available report');const task=f.c.store.get('task',f.ds.id);task.result={checksumsVerified:true,directory};f.c.store.put('task',task);const response=await f.call('observer_artifacts',{taskId:task.id});assert.equal(response.status,200);const [item]=await response.json();assert.equal(item.file,undefined);assert.equal(item.reference.startsWith('artifact-'),true);assert.match((await f.observer.evidence({reference:item.reference})).text,/Available report/);
});

test('worker overview never relabels supervisor activity as captured worker activity',t=>{
 const f=fixture(t);f.c.emit('coding.files.read',f.g.id,f.ds.id,{actor:'deepseek',provenance:'captured'});f.c.emit('task.reviewed',f.g.id,f.ds.id,{actor:'codex',summary:'Supervisor review'});const row=f.observer.snapshot({}).tasks.find(t=>t.id===f.ds.id);assert.equal(row.lastActivity,'Read approved files');
});

test('the product home opens the read-only observer; legacy controls require operator authority',async t=>{
 const f=await apiFixture(t);for(const token of [f.viewerToken,f.token]){const r=await fetch(f.api.url+'/',{headers:{authorization:'Bearer '+token},redirect:'manual'});assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/observer');}
 assert.equal((await fetch(f.api.url+'/legacy-console',{headers:{authorization:'Bearer '+f.viewerToken}})).status,403);const legacy=await fetch(f.api.url+'/legacy-console',{headers:{authorization:'Bearer '+f.token}});assert.equal(legacy.status,200);assert.match(await legacy.text(),/new-goal/);
});

test('outcome summary uses authoritative integration and checks without copying source or private paths',t=>{
 const f=fixture(t),task=f.c.store.get('task',f.native.id);
 task.status='accepted';task.result={summary:'Added the checklist counter',changes:[{path:'src/counter.mjs',content:'PRIVATE SOURCE'}],checks:[{id:'old',passed:false}]};
 task.feedback=[{decision:'accept',text:'Matches the approved task'}];
 task.integration={commit:'a'.repeat(40),checks:[{id:'counter',passed:true}],review:'codex_operator',worktree:'/private/path'};f.c.store.put('task',task);
 const outcome=f.observer.snapshot({}).tasks.find(t=>t.id===task.id).outcome;
 assert.deepEqual(outcome,{summary:'Added the checklist counter',files:['src/counter.mjs'],checks:{passed:1,total:1},review:'Codex review accepted',integrated:true,commit:'a'.repeat(40)});
 assert.doesNotMatch(JSON.stringify(outcome),/PRIVATE|private\/path/);
});

test('outcome summary does not invent checks, review or integration for an unfinished task',t=>{
 const f=fixture(t),outcome=f.observer.snapshot({}).tasks.find(t=>t.id===f.ds.id).outcome;
 assert.equal(outcome.checks,null);assert.equal(outcome.integrated,false);assert.equal(outcome.review,'No recorded review');
});

test('invalidated replacement does not inherit historical review acceptance',t=>{
 const f=fixture(t),task=f.c.store.get('task',f.native.id);
 task.status='codex_ready';task.reviewed=false;task.result=null;task.legacyDecision=null;task.feedback=[{decision:'accept',text:'An earlier candidate was accepted'}];f.c.store.put('task',task);
 const outcome=f.observer.snapshot({}).tasks.find(t=>t.id===task.id).outcome;
 assert.equal(outcome.review,'No recorded review');assert.equal(outcome.checks,null);assert.equal(outcome.integrated,false);
 task.status='awaiting_review';task.result={summary:'Replacement candidate'};task.reviewed=true;f.c.store.put('task',task);
 assert.equal(f.observer.snapshot({}).tasks.find(t=>t.id===task.id).outcome.review,'No recorded review');
});

test('unchanged observer polls reuse history while clock and committed changes stay visible',t=>{
 const {c,observer,g,native}=fixture(t);
 let now=c.now();
 c.now=()=>now;
 c.store.put('agent',{id:'idle-agent',goalId:g.id,taskId:native.id,actor:'codex',role:'implementer',lastReport:{summary:'Saved report',status:'running',at:now}});
 const query={goalId:g.id};
 const first=observer.snapshot(query);
 assert.equal(first.agents[0].stale,false);
 assert.equal(first.goals[0].taskCount,2);
 const prepare=c.store.db.prepare.bind(c.store.db);
 let historyQueries=0;
 c.store.db.prepare=sql=>{
  if(/FROM (records|events)/i.test(sql))historyQueries++;
  return prepare(sql);
 };
 now+=120001;
 const later=observer.snapshot(query);
 assert.equal(later.generatedAt,now);
 assert.equal(later.agents[0].stale,true);
 assert.equal(historyQueries,0,'unchanged viewer polls must not read saved history again');
 later.tasks[0].objective='caller mutation';
 assert.equal(observer.snapshot(query).tasks[0].objective,first.tasks[0].objective);
 const task=c.store.get('task',native.id);
 c.store.tx(()=>c.store.put('task',{...task,status:'accepted'}));
 assert.equal(observer.snapshot(query).tasks.find(row=>row.id===task.id).status,'accepted');
 assert.ok(observer.snapshot({actor:'deepseek'}).tasks.every(row=>row.actor==='deepseek'));
});
