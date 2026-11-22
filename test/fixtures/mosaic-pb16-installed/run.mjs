import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {cp,mkdir,readFile,writeFile,chmod,lstat,access,rename} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {installedHarness,command,successful,waitFor,verifyDemo,hash,stopOwnedCommands,beginInterruption,saveUncertainEvidence} from './harness.mjs';

const [bundle,root,input,review='host',updateBundle]=process.argv.slice(2);
assert.ok(bundle&&root&&input&&updateBundle);assert.ok(['host','api'].includes(review));
await mkdir(root,{mode:0o700});
const demo=await verifyDemo(input),backend='src/export.mjs',frontend='src/csv.mjs';
const fixedBackend=await readFile(path.join(input,'project',backend),'utf8');
const initialBackend=fixedBackend.replace('tbody input:checked','tbody input:not(:checked)');
const wrongBackend=fixedBackend.replace('tbody input:checked','tbody input');
const sharedFrontend="const encodeField = field => /[\",\\r\\n]/.test(field) ? `\"${field.replaceAll('\"', '\"\"')}\"` : field;\nexport function encodeCsv(rows) {\n  return rows.map(row => row.map(encodeField).join(',')).join('\\r\\n') + '\\r\\n';\n}\n";
const checkText=await readFile(path.join(input,'project/checks/download.mjs'),'utf8');
const protectedHash='c4d9bac20d9fe9653505d4c60d3d5e417a2ab38950a56a21497e2dfce814fd72';assert.equal(hash(checkText),protectedHash);
const servers=[],calls=[],errors=[],harnesses=[],credentials={'fixture-key-a':'dummy-installed-a','fixture-key-b':'dummy-installed-b'};
const groups=new Map();let active=0,maxActive=0,phase='preparing',h;
const snapshots=[];
function group(name){if(!groups.has(name))groups.set(name,{arrived:0,release:Promise.withResolvers()});return groups.get(name);}
async function workerBarrier(name){const barrier=group(name);barrier.arrived++;if(name==='overlap'&&barrier.arrived===2)barrier.release.resolve();await barrier.release.promise;}
function savedHarnesses(){return harnesses.map(item=>({root:item.root,pid:item.pid,log:item.log,tasks:(()=>{try{return item.rows('task');}catch{return [];}})(),owners:(()=>{try{return item.rows('execution_owner');}catch{return [];}})(),requests:(()=>{try{return item.requests();}catch{return [];}})()}));}
let cleaning;
async function cleanup(){
 if(cleaning)return cleaning;
 cleaning=(async()=>{
  const before=savedHarnesses();for(const value of groups.values())value.release.resolve();
  const stopped=await Promise.allSettled(harnesses.map(item=>item.stop()));const commands=await stopOwnedCommands();
  for(const server of servers){server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));}
  const result={before,after:savedHarnesses(),stopped:stopped.map(row=>({status:row.status,...(row.status==='rejected'?{reason:String(row.reason)}:{})})),commands,testWroteProductState:false};
  await writeFile(path.join(root,'installed-cleanup.json'),JSON.stringify(result,null,2)+'\n');return result;
 })();return cleaning;
}
let interrupted=false;
const interrupt=signal=>{
 if(interrupted)return;interrupted=true;beginInterruption();
 void (async()=>{
  // Capture exact owner/pin state before stopping only this driver's children.
  // Cleanup does not invent a quiescence receipt or release a product hold.
  await writeFile(path.join(root,'installed-interruption.json'),JSON.stringify({signal,phase,snapshots,harnesses:savedHarnesses()},null,2)+'\n');
  await cleanup();process.exit(143);
 })().catch(error=>{console.error('Interrupted fixture cleanup: '+error.stack);process.exitCode=143;});
};
const onTerm=()=>interrupt('SIGTERM'),onInt=()=>interrupt('SIGINT');
process.once('SIGTERM',onTerm);process.once('SIGINT',onInt);
try{
 const profiles=[];
 for(const id of ['a','b']){
  const server=http.createServer(async(req,res)=>{
   try{
    let raw='';for await(const part of req)raw+=part;const body=raw?JSON.parse(raw):null;
    calls.push({id,method:req.method,url:req.url,model:body?.model??null,body,at:Date.now()});
    assert.equal(req.headers.authorization,'Bearer '+credentials['fixture-key-'+id]);res.setHeader('content-type','application/json');
    if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'fixture-'+id}]}));
    assert.equal(req.method,'POST');assert.equal(req.url,'/v1/chat/completions');
    active++;maxActive=Math.max(maxActive,active);let settled=false;const settle=()=>{if(!settled){settled=true;active--;}};res.once('finish',settle);res.once('close',settle);
    let content;
    if(body.model.startsWith('fixture-reviewer')){
     assert.equal(id,'b');assert.match(JSON.stringify(body.messages),/candidate|result/);
     if(review==='api'&&body.model==='fixture-reviewer'&&group('api-review').arrived===0)await workerBarrier('api-review');
     content=JSON.stringify(body.model==='fixture-reviewer-malformed'?{decision:'invalid-decision',feedback:'Malformed verdict inside a valid reviewer JSON envelope',findings:[]}:{decision:'accept',feedback:'Offline API assessment of exact checked candidate',findings:[]});
    }else{
     assert.equal(body.model,'fixture-'+id);assert.equal(body.stream,false);const payload=JSON.parse(body.messages.at(-1).content);
     if(payload.task.kind==='consult'){
      if(payload.task.objective.includes('barrier:overlap'))await workerBarrier('overlap');
      if(payload.task.objective.includes('barrier:saturation'))await workerBarrier('saturation');
      content='Offline answer from specialty '+id;
     }else{
      assert.equal(payload.task.kind,'coding');const uncertain=payload.task.objective.includes('uncertain'),overlap=payload.task.objective.includes('barrier:overlap'),file=uncertain?'src/value.mjs':overlap?'src/'+(id==='a'?'left':'right')+'.mjs':id==='a'?backend:frontend;
      assert.deepEqual(payload.task.permissions.writePaths,[file]);const inventory=payload.inventory.find(item=>item.path===file);assert.ok(inventory?.hash);
      if(!uncertain&&!overlap&&payload.attempt>1){assert.equal(id,'a');assert.equal(payload.repair.failure.category,'functional_check');assert.match(JSON.stringify(payload.repair),/download/);}
      if(overlap)await workerBarrier('overlap');
      content=JSON.stringify({type:'submit_changes',paths:[],summary:'Offline scoped fixture change',edits:[{path:file,action:'write',baseHash:inventory.hash,content:uncertain||overlap?'export const value=1;\n':id==='a'?(payload.attempt===1?wrongBackend:fixedBackend):sharedFrontend}]});
     }
    }
    res.end(JSON.stringify({model:body.model,choices:[{message:{role:'assistant',content},finish_reason:'stop'}],...(id==='a'||body.model.startsWith('fixture-reviewer')?{usage:{prompt_tokens:11,completion_tokens:5}}:{})}));
   }catch(error){errors.push(error.stack);res.writeHead(500).end(JSON.stringify({error:{message:'Offline fixture assertion failed'}}));}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});servers.push(server);
  profiles.push({schema:1,id:'worker-'+id,revision:'r1',displayName:'Offline specialty '+id,transport:'openai-chat',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture-'+id,roles:['worker'],capabilities:{workerProtocol:'mosaic-structured-v1',transports:['json'],modelDiscovery:'advertised',taskKinds:['coding','consult']},maxContextTokens:32000,maxOutputTokens:2048,concurrency:1,capacityGroup:'loopback-'+id,credentialRef:'fixture-key-'+id,streaming:false});
 }
 const reviewer={...profiles[1],id:'fixture-reviewer',displayName:'Offline optional API reviewer',model:'fixture-reviewer',roles:['reviewer'],capabilities:{workerProtocol:null,transports:['json'],modelDiscovery:'manual',taskKinds:[]}};
 const malformed={...reviewer,id:'malformed-reviewer',model:'fixture-reviewer-malformed'};
 const publicProfile=profile=>{const {credentialRef,...identity}=profile;return identity;};
 const routing={version:1,rules:[{id:'backend',category:'backend',providerId:'worker-a'},{id:'frontend',category:'frontend',providerId:'worker-b'}],defaultWorkerId:'worker-a'};
 h=await installedHarness({bundle,root:path.join(root,'installed main'),profiles:[...profiles,reviewer,malformed],review,routing,credentials});harnesses.push(h);
 assert.equal(calls.filter(call=>call.method==='POST').length,0,'Setup must not infer without opt-in');
 assert.equal(calls.length,0,'Declined setup discovery and inference must not contact workers');
 await h.start();const tools=await h.invoke('tools_list'),registry=await h.invoke('registry_list');
 assert.ok(tools.some(tool=>tool.name==='goal_prepare'));assert.ok(!tools.some(tool=>tool.name.startsWith('research_')));assert.ok(registry.modes.some(mode=>mode.id==='collaborative'));
 const help=await h.run(['--help']);assert.equal(help.code,0);assert.match(help.stdout,/Mosaic Beta/);
 for(const host of ['codex','claude-code','cursor','antigravity']){const preview=await h.run(['host-preview','--host',host]);assert.equal(preview.code,0,preview.stderr);}
 const policy={version:1,workers:profiles.map(publicProfile),plannerWorkerId:'worker-a',defaultWorkerId:'worker-a',maxConcurrentTasks:2,capacityGroups:profiles.map(profile=>({id:profile.capacityGroup,limit:1}))};
 const hostReview={version:1,source:'host',hostId:'cursor',fallback:'wait'};
 const apiReview={version:1,source:'api',reviewer:publicProfile(reviewer),fallback:'wait'};
 const diagnosticProject=async label=>{
  // Stopped coding candidates retain their write scopes. Diagnostic consult
  // goals therefore get their own approved repository and real native probe.
  const repo=path.join(root,'Diagnostic '+label+' project');await mkdir(path.join(repo,'src'),{recursive:true});await mkdir(path.join(repo,'checks'));
  await writeFile(path.join(repo,'package.json'),'{"private":true,"type":"module"}\n');await writeFile(path.join(repo,'src/value.mjs'),'export const value=0;\n');await writeFile(path.join(repo,'checks/infrastructure.mjs'),"import assert from 'node:assert/strict';import {value} from '../src/value.mjs';assert.equal(value,0);console.log('Approved diagnostic project remains unchanged');\n");
  const git=async(...args)=>(await successful(['/usr/bin/git','-C',repo,...args],{env:h.env})).stdout.trim();await git('init','-q');await git('add','.');await git('-c','user.name=Offline Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Diagnostic infrastructure base');
  return {repo,baseCommit:await git('rev-parse','HEAD'),readPaths:['package.json','src/','checks/'],writePaths:['src/'],checks:[{id:'infrastructure',argv:[path.join(h.checkRoot,'node'),'checks/infrastructure.mjs'],timeoutMs:5000}]};
 };
 const prepare=async(submissionId,{project,reviewPolicy=hostReview,providerPolicy=policy}={})=>{
  const draft=await h.mutate('goal_prepare',{manifest:{submissionId,objective:'Offline installed '+submissionId,acceptance:['Preserve exact approved state and checked outcomes'],environment:'live',mode:'collaborative',executionPolicy:h.executionPolicy,limits:{hours:1,maxTasks:4,reviewAgentRuns:8},...(project?{project}:{}),providerPolicy,routingPolicy:routing,reviewPolicy}});
  const goal=await h.mutate('goal_activate',{goalId:draft.id,hash:draft.hash});assert.equal(goal.manifest.executionPolicy.runtimeFingerprint,h.fingerprint);return goal;
 };
 const submit=(goal,id,category,{kind='consult',objective=id,permissions,dependsOn=[]}={})=>h.mutate('task_submit',{goalId:goal.id,expectedGoalHash:goal.hash,expectedGoalVersion:goal.version,task:{submissionId:id,kind,objective,acceptance:['Bounded offline fixture expectation'],routing:{version:1,category},dependsOn,...(permissions?{permissions}:{})}});
 const waitTask=(id,predicate,label,timeout=150000)=>waitFor(async()=>{const task=await h.invoke('task_get',{taskId:id});if(['blocked','failed'].includes(task.status)&&!predicate(task))throw Error(JSON.stringify(task));return predicate(task)&&task;},{timeout,label});
 const partial=async goal=>{await h.mutate('work_control',{goalId:goal.id,action:'stop'});return h.mutate('goal_finalize',{goalId:goal.id,summary:'Offline diagnostic retained as partial',partial:true});};

 phase='parallel specialty overlap';
 const parallelRepo=path.join(root,'Parallel coding project');await mkdir(path.join(parallelRepo,'src'),{recursive:true});await mkdir(path.join(parallelRepo,'checks'));await writeFile(path.join(parallelRepo,'package.json'),'{"type":"module","private":true}\n');
 for(const name of ['left','right'])await writeFile(path.join(parallelRepo,'src',name+'.mjs'),'export const value=0;\n');
 await writeFile(path.join(parallelRepo,'checks/value.mjs'),"import assert from 'node:assert/strict';const {value}=await import('../src/'+process.argv[2]+'.mjs');assert.equal(value,1);await new Promise(resolve=>setTimeout(resolve,500));console.log('Checked independent '+process.argv[2]);\n");
 const pgit=async(...args)=>(await successful(['/usr/bin/git','-C',parallelRepo,...args],{env:h.env})).stdout.trim();await pgit('init','-q');await pgit('add','.');await pgit('-c','user.name=Offline Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Parallel base');
 const parallelProject={repo:parallelRepo,baseCommit:await pgit('rev-parse','HEAD'),readPaths:['package.json','src/','checks/'],writePaths:['src/'],checks:['left','right'].map(id=>({id,argv:[path.join(h.checkRoot,'node'),'checks/value.mjs',id],timeoutMs:5000}))};
 const parallelGoal=await prepare('parallel-overlap',{project:parallelProject}),left=await submit(parallelGoal,'left','backend',{kind:'coding',objective:'barrier:overlap backend',permissions:{readPaths:parallelProject.readPaths,writePaths:['src/left.mjs'],checks:['left']}}),right=await submit(parallelGoal,'right','frontend',{kind:'coding',objective:'barrier:overlap frontend',permissions:{readPaths:parallelProject.readPaths,writePaths:['src/right.mjs'],checks:['right']}});
 await waitTask(left.id,t=>t.status==='awaiting_review','first parallel reply');await waitTask(right.id,t=>t.status==='awaiting_review','second parallel reply');
 assert.equal(maxActive,2);assert.equal(group('overlap').arrived,2);assert.deepEqual([h.record('task',left.id).providerBinding.providerId,h.record('task',right.id).providerBinding.providerId],['worker-a','worker-b']);
 const closedHostPosts=calls.filter(call=>call.method==='POST').length,hostInbox=await h.invoke('review_inbox',{goalId:parallelGoal.id});assert.equal(hostInbox.items.length,2);await h.disconnect();await delay(600);assert.equal(h.record('task',left.id).status,'awaiting_review');assert.equal(calls.filter(call=>call.method==='POST').length,closedHostPosts);await h.connect();assert.deepEqual(await h.invoke('review_inbox',{goalId:parallelGoal.id}),hostInbox);await partial(parallelGoal);
 phase='shared capacity saturation';
 const saturationGoal=await prepare('shared-capacity',{project:await diagnosticProject('capacity')}),held=await submit(saturationGoal,'held','backend',{objective:'barrier:saturation first'});
 await waitFor(()=>group('saturation').arrived===1,{label:'held worker request'});
 const postsHeld=calls.filter(call=>call.method==='POST').length,queued=await submit(saturationGoal,'queued','backend',{objective:'same shared capacity must wait'});
 await delay(750);assert.equal(calls.filter(call=>call.method==='POST').length,postsHeld);assert.equal(h.record('task',queued.id).attempts,0);
 const capacityQueue=await h.invoke('queue_get',{goalId:saturationGoal.id});assert.ok(capacityQueue.execution.some(task=>task.id===queued.id));
 const heldBeforeOff=h.record('task',held.id),offRequests=h.requests(),off=await h.run(['off']);assert.equal(off.code,0,off.stderr);assert.match(off.stdout,/off|dispatch/i);
 await delay(400);assert.equal(calls.filter(call=>call.method==='POST').length,postsHeld);assert.equal(h.record('task',held.id).owner,heldBeforeOff.owner);assert.equal(h.record('task',held.id).status,'running');assert.deepEqual(h.requests(),offRequests);assert.equal(h.record('goal',saturationGoal.id).deadline,saturationGoal.deadline);
 const on=await h.run(['on']);assert.equal(on.code,0,on.stderr);assert.equal(h.record('task',held.id).owner,heldBeforeOff.owner);assert.equal(h.record('task',queued.id).attempts,0);
 group('saturation').release.resolve();await waitTask(held.id,t=>t.status==='awaiting_review','released capacity');await waitTask(queued.id,t=>t.status==='awaiting_review','next request after capacity');await partial(saturationGoal);

 phase='protected CSV project';
 const repo=path.join(root,'Checked CSV project');await cp(path.join(input,'project'),repo,{recursive:true});await writeFile(path.join(repo,'package.json'),'{"private":true,"type":"module"}\n');await writeFile(path.join(repo,backend),initialBackend);await chmod(path.join(repo,'checks/unit.mjs'),0o755);
 const git=async(...args)=>(await successful(['/usr/bin/git','-C',repo,...args],{env:h.env})).stdout.trim();
 await git('init','-q');await git('add','.');await git('-c','user.name=Offline Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Offline CSV base');const baseCommit=await git('rev-parse','HEAD');
 const project={repo,baseCommit,readPaths:['package.json','src/','checks/'],writePaths:['src/'],checks:[{id:'unit',argv:[path.join(h.checkRoot,'node'),'checks/unit.mjs'],timeoutMs:10000},{id:'download',argv:[path.join(h.checkRoot,'node'),'checks/download.mjs'],timeoutMs:25000}],behavioralChecks:[{criterionId:'csv',description:'Download exact selected CSV bytes',checkIds:['unit','download']}]};
 const goal=await prepare('csv-composition',{project,reviewPolicy:review==='host'?hostReview:apiReview});
 const first=await submit(goal,'csv-selection','backend',{kind:'coding',objective:'Repair selected-row CSV export',permissions:{readPaths:project.readPaths,writePaths:[backend],checks:['unit','download']}});
 const second=await submit(goal,'csv-encoder','frontend',{kind:'coding',objective:'Extract field encoding preserving CSV bytes',dependsOn:[first.id],permissions:{readPaths:project.readPaths,writePaths:[frontend],checks:['unit','download']}});
 phase='saved response restart';const responseBoundary=await h.restartAt(first.id,t=>t.checkpoint.phase==='apply'&&t.checkpoint.attempt===1,'saved response');snapshots.push({boundary:'saved-response',task:responseBoundary});
 phase='applied edits restart';const editBoundary=await h.restartAt(first.id,t=>t.checkpoint.phase==='checks'&&t.checkpoint.attempt===1,'applied edits');snapshots.push({boundary:'applied-edits',task:editBoundary});
 phase='failed check restart';const failedBoundary=await h.restartAt(first.id,t=>t.checkpoint.phase==='attempt'&&t.checkpoint.failedGate,'failed protected check');snapshots.push({boundary:'failed-check',task:failedBoundary});
 const journalPath=path.join(h.state,'coding/jobs',first.id+'.jsonl'),journal=()=>readFile(journalPath,'utf8').then(bytes=>bytes.trim().split('\n').map(JSON.parse));
 const failedReceipt=(await journal()).findLast(event=>event.type==='operation.completed'&&event.data.key==='harness-attempt-1/checks');assert.ok(failedReceipt);assert.equal(failedReceipt.data.value[0].passed,true);assert.equal(failedReceipt.data.value[1].passed,false);assert.match(failedReceipt.data.value[1].stderr,/downloads selected rows only/);
 // Read the actual browser download's Buffer dump from the unchanged protected
 // assertion, rather than assigning a predicted byte count to the summary.
 const failedDump=/actual: Buffer\((\d+)\) \[Uint8Array\] \[([\d,\s]+)\]/.exec(failedReceipt.data.value[1].stderr);assert.ok(failedDump,'Protected failure must expose its actual bounded Buffer bytes');
 const failedBytes=Buffer.from(failedDump[2].split(',').map(value=>Number(value.trim())));assert.equal(failedBytes.length,Number(failedDump[1]));assert.equal(failedBytes.length,44);assert.deepEqual(failedBytes,Buffer.from('name,total\r\n"North, West",12.50\r\nEast,9.00\r\n'));
 let correctedBytes;
 const accepted=[],reviewReplays=[];let closedHost=true,passingChecks=0;
 let stoppedApprovalUpdate;
 const updateStoppedApproval=async()=>{
  await h.mutate('work_control',{goalId:goal.id,action:'stop'},'stop-goal-for-pointer-update');
  const oldGoal=await h.invoke('goal_get',{goalId:goal.id}),oldTasks=await Promise.all([first,second].map(task=>h.invoke('task_get',{taskId:task.id}))),settingsBytes=await readFile(path.join(h.configDir,'settings.json'));
  assert.equal(oldGoal.status,'stopped');assert.ok(oldTasks.every(task=>task.status==='stopped'&&!task.owner));await h.stop();
  const beforeBytes=hash(await readFile(path.join(h.state,'harness.sqlite3'))),updated=await successful([path.join(updateBundle,'install'),'--home',h.home,'--no-path'],{env:h.env,cwd:root});
  assert.equal(hash(await readFile(path.join(h.state,'harness.sqlite3'))),beforeBytes);assert.deepEqual(await readFile(path.join(h.configDir,'settings.json')),settingsBytes);assert.ok(await lstat(path.join(h.checkRoot,'node')));
  await h.start();const savedGoal=await h.invoke('goal_get',{goalId:goal.id});assert.deepEqual(savedGoal.manifest,oldGoal.manifest);assert.equal(savedGoal.hash,oldGoal.hash);assert.equal(savedGoal.deadline,oldGoal.deadline);assert.equal(savedGoal.status,'stopped');
  assert.ok(savedGoal.manifest.project.checks.every(check=>check.argv[0]===path.join(h.checkRoot,'node')));
  for(const task of oldTasks){const after=await h.invoke('task_get',{taskId:task.id});for(const field of ['providerBinding','routeHash','hash','deadline','spent','checkpoint','status'])assert.deepEqual(after[field],task[field]);}
  stoppedApprovalUpdate={passed:true,oldVersion:h.initialInstallation.version,newVersion:JSON.parse(await readFile(path.join(h.configDir,'installation.json'),'utf8')).version,goalHash:oldGoal.hash,literalArgv:savedGoal.manifest.project.checks.map(check=>check.argv),nativeCheckRuntime:h.settings.nativeCheckRuntime,updated};
 };
 const assertCheck=check=>{assert.equal(check.passed,true);assert.equal(check.code,0);assert.equal(check.backend.id,'darwin-seatbelt');assert.equal(check.backend.revision,2);assert.equal(check.backend.runtime.fingerprint,h.fingerprint);assert.equal(check.provenance.runtimeFingerprint,h.fingerprint);assert.equal(check.provenance.resolvedExecutable,path.join(h.checkRoot,'node'));assert.match(check.provenance.dependencyInventoryHash,/^[a-f0-9]{64}$/);assert.equal(check.quiescence.type,'complete');assert.equal(check.quiescence.groupESRCH,true);assert.equal(check.quiescence.leaderReaped,true);passingChecks++;};
 failedReceipt.data.value.filter(check=>check.passed).forEach(assertCheck);
 for(const taskId of [left.id,right.id])h.record('task',taskId).result.checks.forEach(assertCheck);
 for(const [task,index] of [[first,0],[second,1]]){
  phase='candidate '+index;
  let candidate;
  if(review==='host')candidate=await waitTask(task.id,t=>t.status==='awaiting_review','checked host candidate');
  else{
   if(index===0){
    await waitFor(()=>group('api-review').arrived===1,{label:'bound API review response barrier'});
    await h.mutate('work_control',{taskId:task.id,action:'stop'},'stop-review');group('api-review').release.resolve();
    const stopped=await waitTask(task.id,t=>t.status==='stopped'&&t.reviewWait?.reasonCode==='controls_active','saved API review while stopped');const posts=calls.filter(call=>call.method==='POST').length;
    await updateStoppedApproval();const after=await h.invoke('task_get',{taskId:task.id});assert.equal(after.status,'stopped');for(const field of ['providerBinding','routeHash','hash','deadline','spent','checkpoint','reviewWait'])assert.deepEqual(after[field],stopped[field]);
    await h.mutate('work_control',{goalId:goal.id,action:'resume'},'resume-review');candidate=await waitTask(task.id,t=>t.status==='ready_to_integrate','saved API review replay after restart');assert.equal(calls.filter(call=>call.method==='POST').length,posts);snapshots.push({boundary:'stopped-pending-review',task:stopped});
   }else candidate=await waitTask(task.id,t=>t.status==='ready_to_integrate','checked API candidate');
  }
  assert.equal(candidate.providerBinding.providerId,index===0?'worker-a':'worker-b');assert.equal(await readFile(path.join(candidate.result.worktree,'checks/download.mjs'),'utf8'),checkText);candidate.result.checks.forEach(assertCheck);assert.match(candidate.result.checks.find(check=>check.id==='download').stdout,/Downloaded sales.csv \(33 bytes, sha256=d476f038d8e8c000c50341d68cb44856e7d16109fcc28222b6d3604d9e9afb28\)/);
  correctedBytes=Number(/Downloaded sales.csv \((\d+) bytes/.exec(candidate.result.checks.find(check=>check.id==='download').stdout)[1]);assert.equal(correctedBytes,33);
  if(index===0&&review==='host'){
   await h.mutate('work_control',{taskId:task.id,action:'stop'},'stop-review');const stopped=await h.invoke('task_get',{taskId:task.id});await updateStoppedApproval();const after=await h.invoke('task_get',{taskId:task.id});assert.equal(after.status,'stopped');for(const field of ['providerBinding','routeHash','hash','deadline','spent','checkpoint'])assert.deepEqual(after[field],stopped[field]);
   await h.mutate('work_control',{goalId:goal.id,action:'resume'},'resume-review');snapshots.push({boundary:'stopped-pending-review',task:stopped});
  }
  if(review==='host'){
   const inbox=(await h.invoke('review_inbox',{goalId:goal.id})).items.find(item=>item.taskId===task.id);assert.ok(inbox?.waitingForHost);
   if(index===0){const posts=calls.filter(call=>call.method==='POST').length;await h.disconnect();await delay(600);assert.equal(h.record('task',task.id).status,'awaiting_review');assert.equal(calls.filter(call=>call.method==='POST').length,posts);await h.connect();assert.deepEqual((await h.invoke('review_inbox',{goalId:goal.id})).items.find(item=>item.taskId===task.id).binding,inbox.binding);closedHost=true;}
   const ticket=await h.mutate('review_reserve',inbox.binding,'reserve-'+index),reviewInput={...inbox.binding,ticketId:ticket.ticketId,verdict:{decision:'accept',feedback:'Offline host assessed exact candidate and protected checks',findings:[]}};
   const result=await h.mutate('review_submit',reviewInput,'review-'+index);assert.equal(result.status,'ready_to_integrate');reviewReplays.push(()=>h.mutate('review_submit',reviewInput,'review-'+index));
  }
  phase='combined protected integration '+index;
  const action=await h.invoke('owner_action_context',{goalId:goal.id,taskId:task.id});
  const input={taskId:task.id,feedback:'Integrate exact offline reviewed candidate',expectedIntegrationBinding:action.candidate.binding},result=(await h.operation('task_integrate',input,'integrate-'+index)).result;
  assert.equal(result.status,'accepted');assert.deepEqual(result.providerBinding,candidate.providerBinding);assert.equal(result.routeHash,candidate.routeHash);result.integration.checks.forEach(assertCheck);assert.equal(result.integration.behavioralEvidence.criteria[0].status,'passed');accepted.push({input,result});
  assert.equal((await h.invoke('outcomes_report',{goalId:goal.id})).counts.usefulAccepted,index+1);
 }
 phase='accepted replay';
 const requestsBefore=h.requests(),postsBefore=calls.filter(call=>call.method==='POST').length,ownerCount=h.rows('execution_owner').length;
 await h.restart();for(let index=0;index<2;index++){if(reviewReplays[index])await reviewReplays[index]();assert.deepEqual((await h.operation('task_integrate',accepted[index].input,'integrate-'+index)).result,accepted[index].result);}
 await delay(500);assert.equal(calls.filter(call=>call.method==='POST').length,postsBefore);assert.deepEqual(h.requests(),requestsBefore);assert.equal(h.rows('execution_owner').length,ownerCount);
 const events=h.events();for(const task of [first,second])for(const type of ['task.routed','task.reviewed','task.integrated'])assert.equal(events.filter(event=>event.task_id===task.id&&event.type===type).length,1,type);
 const report=await h.invoke('outcomes_report',{goalId:goal.id});assert.equal(report.counts.usefulAccepted,2);assert.deepEqual(report.tasks.map(task=>task.worker.providerId),['worker-a','worker-b']);
 assert.equal(await readFile(path.join(accepted[1].result.integration.worktree,backend),'utf8'),fixedBackend);assert.equal(await readFile(path.join(accepted[1].result.integration.worktree,frontend),'utf8'),sharedFrontend);assert.equal(await git('rev-parse','HEAD'),baseCommit);assert.equal(await git('status','--porcelain'),'');
 const probes=(await journal()).filter(event=>event.type==='harness.sandbox').map(event=>event.data);assert.ok(probes.length);for(const probe of probes)for(const name of ['readDenied','writeDenied','networkDenied','outputWorks','childProcessWorks'])assert.equal(probe[name],true);
 assert.ok(h.rows('execution_owner').every(owner=>owner.status==='quiescent'));await h.mutate('goal_finalize',{goalId:goal.id,summary:'Both offline routed CSV changes accepted'});

 phase='missing host registration diagnostic';
 const hostBinding=JSON.parse(await readFile(path.join(h.configDir,'host-cursor-binding.json'),'utf8')),hostTarget=hostBinding.target,withheldHost=hostTarget+'.fixture-withheld';
 const beforeMissingHost=calls.filter(call=>call.method==='POST').length;await rename(hostTarget,withheldHost);let missingHost;
 try{missingHost=await h.run(['doctor']);assert.notEqual(missingHost.code,0);assert.match(missingHost.stdout,/CHECK\s+Setup.*needs attention|restore.*bindings/i);assert.equal(calls.filter(call=>call.method==='POST').length,beforeMissingHost);}
 finally{await rename(withheldHost,hostTarget);}

 phase='malformed API reviewer wait';
 const malformedGoal=await prepare('malformed-review',{project:await diagnosticProject('review'),reviewPolicy:{version:1,source:'api',reviewer:publicProfile(malformed),fallback:'wait'}}),malformedTask=await submit(malformedGoal,'malformed','backend');
 const malformedWait=await waitTask(malformedTask.id,t=>{if(t.reviewWait)assert.equal(t.reviewWait.reasonCode,'invalid_response');return t.reviewWait?.reasonCode==='invalid_response';},'malformed reviewer operator wait');assert.equal(malformedWait.status,'awaiting_review');const malformedPosts=calls.filter(call=>call.model==='fixture-reviewer-malformed'&&call.method==='POST').length;assert.equal(malformedPosts,1);await h.restart();await delay(500);assert.equal(calls.filter(call=>call.model==='fixture-reviewer-malformed'&&call.method==='POST').length,1);await partial(malformedGoal);
 phase='unreachable worker retains route';
 // Close only the owned loopback worker after all successful work. The exact
 // pinned endpoint becomes unreachable; no alternate profile may receive it.
 servers[0].closeAllConnections();await new Promise(resolve=>servers[0].close(resolve));
 const unavailableGoal=await prepare('worker-unreachable',{project:await diagnosticProject('unavailable')}),unavailableTask=await submit(unavailableGoal,'unreachable','backend'),unreachable=await waitTask(unavailableTask.id,t=>t.providerWait||t.routingWait,'recoverable unavailable worker',30000);assert.ok(['queued','suspended'].includes(unreachable.status));const unreachablePosts=calls.filter(call=>call.method==='POST').length;await delay(500);assert.equal(calls.filter(call=>call.method==='POST').length,unreachablePosts);await partial(unavailableGoal);

 phase='source-free second-version update and compatible rollback';
 await h.stop();
 const returnToOriginal=await h.run(['rollback',h.initialInstallation.version]);assert.equal(returnToOriginal.code,0,returnToOriginal.stderr);
 const durableState=()=>({goals:h.rows('goal'),tasks:h.rows('task'),requests:h.requests(),executionOwners:h.rows('execution_owner'),events:h.events()});
 const oldInstallation=JSON.parse(await readFile(path.join(h.configDir,'installation.json'),'utf8')),stateBeforeUpdate=hash(await readFile(path.join(h.state,'harness.sqlite3'))),durableBeforeUpdate=durableState(),settingsBeforeUpdate=await readFile(path.join(h.configDir,'settings.json')),credentialsBeforeUpdate=await readFile(path.join(h.configDir,'credentials.json'));
 const updated=await successful([path.join(updateBundle,'install'),'--home',h.home,'--no-path'],{env:h.env,cwd:root});
 const newInstallation=JSON.parse(await readFile(path.join(h.configDir,'installation.json'),'utf8'));assert.notEqual(newInstallation.version,oldInstallation.version);assert.equal((await h.run(['--help'])).code,0);assert.equal(hash(await readFile(path.join(h.state,'harness.sqlite3'))),stateBeforeUpdate);assert.deepEqual(await readFile(path.join(h.configDir,'settings.json')),settingsBeforeUpdate);assert.deepEqual(await readFile(path.join(h.configDir,'credentials.json')),credentialsBeforeUpdate);assert.ok(await lstat(h.checkRoot));
 await h.start();assert.ok((await h.invoke('tools_list')).some(tool=>tool.name==='goal_prepare'));assert.equal((await h.invoke('goal_get',{goalId:goal.id})).hash,goal.hash);await h.stop();assert.deepEqual(durableState(),durableBeforeUpdate);
 const stateBeforeRollback=hash(await readFile(path.join(h.state,'harness.sqlite3'))),rolledBack=await h.run(['rollback',oldInstallation.version]);assert.equal(rolledBack.code,0,rolledBack.stderr);assert.equal(JSON.parse(await readFile(path.join(h.configDir,'installation.json'),'utf8')).version,oldInstallation.version);assert.equal(hash(await readFile(path.join(h.state,'harness.sqlite3'))),stateBeforeRollback);assert.deepEqual(durableState(),durableBeforeUpdate);assert.deepEqual(await readFile(path.join(h.configDir,'settings.json')),settingsBeforeUpdate);assert.deepEqual(await readFile(path.join(h.configDir,'credentials.json')),credentialsBeforeUpdate);assert.ok(await lstat(path.join(h.product,'versions',newInstallation.version)));assert.equal((await h.run(['recover'])).code,0);
 phase='source-free uninstall ownership';
 const unrelated=hostTarget;let hostDocument=JSON.parse(await readFile(unrelated,'utf8'));assert.ok(hostDocument.mcpServers?.['mosaic-beta']);hostDocument.mcpServers.unrelated={command:'/fixture/unrelated',args:[]};await writeFile(unrelated,JSON.stringify(hostDocument),{mode:0o600});
 const stateBefore=hash(await readFile(path.join(h.state,'harness.sqlite3'))),uninstall=await h.run(['uninstall']);assert.equal(uninstall.code,0,uninstall.stderr);const remainingHost=JSON.parse(await readFile(unrelated,'utf8'));assert.deepEqual(remainingHost.mcpServers.unrelated,hostDocument.mcpServers.unrelated);assert.equal(remainingHost.mcpServers['mosaic-beta'],undefined);await assert.rejects(lstat(h.launcher),{code:'ENOENT'});assert.equal(hash(await readFile(path.join(h.state,'harness.sqlite3'))),stateBefore);assert.ok(await lstat(path.join(h.configDir,'settings.json')));assert.ok(await lstat(h.version));assert.ok(await lstat(path.join(h.product,'versions',newInstallation.version)));
 const mainLog=h.log;

 phase='supervisor loss across installed restart';
 // Separate disposable installation keeps unresolved native ownership intact;
 // its bounded child exits naturally, and no test writes a release receipt.
 const u=await installedHarness({bundle,root:path.join(root,'uncertain installed'),profiles:[...profiles,reviewer,malformed],review:'host',routing,credentials});harnesses.push(u);
 // Worker a was deliberately made unreachable above. The second fixture uses
 // worker b for both explicit uncertainty tasks, retaining the configured pin.
 await u.start();const uncertainRepo=path.join(root,'Uncertain project');await mkdir(path.join(uncertainRepo,'src'),{recursive:true});await mkdir(path.join(uncertainRepo,'checks'));await writeFile(path.join(uncertainRepo,'src/value.mjs'),'export const value=0;\n');await writeFile(path.join(uncertainRepo,'checks/bounded.mjs'),"import fs from 'node:fs';fs.writeFileSync('dist/ready','ready');setTimeout(()=>process.exit(0),1500);\n");
 const ugit=async(...args)=>(await successful(['/usr/bin/git','-C',uncertainRepo,...args],{env:u.env})).stdout.trim();await ugit('init','-q');await ugit('add','.');await ugit('-c','user.name=Offline Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Bounded check base');
 const uproject={repo:uncertainRepo,baseCommit:await ugit('rev-parse','HEAD'),readPaths:['src/','checks/'],writePaths:['src/'],checks:[{id:'bounded',argv:[path.join(u.checkRoot,'node'),'checks/bounded.mjs'],timeoutMs:5000}]};
 const udraft=await u.mutate('goal_prepare',{manifest:{submissionId:'uncertain-native',objective:'Retain actual lost-supervisor ownership',acceptance:['Exact hold survives restart'],mode:'collaborative',environment:'live',executionPolicy:u.executionPolicy,project:uproject,providerPolicy:policy,routingPolicy:routing,reviewPolicy:hostReview}}),ugoal=await u.mutate('goal_activate',{goalId:udraft.id,hash:udraft.hash});
 const utask=await u.mutate('task_submit',{goalId:ugoal.id,task:{submissionId:'uncertain-one',kind:'coding',objective:'uncertain check fixture',acceptance:['Hold exact owner'],routing:{version:1,category:'frontend'},permissions:{readPaths:uproject.readPaths,writePaths:['src/value.mjs'],checks:['bounded']}}});
 const runningOwner=await waitFor(async()=>{const owner=u.rows('execution_owner').find(owner=>owner.taskId===utask.id&&owner.status==='running'&&owner.binding.argv.includes('checks/bounded.mjs'));if(!owner)return;assert.ok(owner.workspaceRoot.startsWith(root));try{await access(path.join(owner.workspaceRoot,'dist/ready'));}catch{return;}return owner;},{timeout:60000,label:'actual installed bounded supervisor'});
 process.kill(runningOwner.helperPid,'SIGKILL');const uncertain=await waitFor(()=>u.record('execution_owner',runningOwner.id)?.status==='uncertain'&&u.record('task',utask.id),{label:'durable native uncertainty'});assert.equal(uncertain.status,'uncertain');const uncertainRequests=u.requests(),uncertainOwners=u.rows('execution_owner').length;
 const follower=await u.mutate('task_submit',{goalId:ugoal.id,task:{submissionId:'uncertain-follower',kind:'coding',objective:'uncertain overlapping follower',acceptance:['Cannot run under held scope'],routing:{version:1,category:'frontend'},permissions:{readPaths:uproject.readPaths,writePaths:['src/value.mjs'],checks:['bounded']}}});
 await u.restart();await delay(2000);assert.equal(u.record('execution_owner',runningOwner.id).status,'uncertain');assert.equal(u.rows('execution_owner').length,uncertainOwners);assert.deepEqual(u.requests(),uncertainRequests);assert.equal(u.record('task',follower.id).attempts,0);for(const field of ['providerBinding','routeHash','deadline','hash','checkpoint','attempts'])assert.deepEqual(u.record('task',utask.id)[field],uncertain[field]);
 await assert.rejects(u.mutate('work_control',{goalId:ugoal.id,action:'resume'}),/held|execution|quiescen/i);await assert.rejects(u.mutate('goal_finalize',{goalId:ugoal.id,summary:'Cannot finalize unknown owner',partial:true}),/unfinished|owner|quiescen/i);await u.stop();
 const deniedUpdate=await command([path.join(updateBundle,'install'),'--home',u.home,'--no-path'],{env:u.env,cwd:root});assert.notEqual(deniedUpdate.code,0);assert.match(deniedUpdate.stderr,/active|unresolved|execution/i);assert.equal(u.record('execution_owner',runningOwner.id).status,'uncertain');
 const deniedUninstall=await u.run(['uninstall']);assert.notEqual(deniedUninstall.code,0);assert.match(deniedUninstall.stderr,/active|unresolved|execution/i);
 await waitFor(()=>{try{process.kill(runningOwner.leaderPid,0);return false;}catch(error){if(error.code!=='ESRCH')throw error;return true;}},{timeout:5000,label:'known bounded fixture child exit; owner hold remains unchanged'});
 const uncertaintyEvidence=await saveUncertainEvidence(u,runningOwner.id,path.join(root,'uncertainty-evidence'));
 assert.equal(errors.length,0,JSON.stringify(errors));
 const summary={schema:1,fixtureOnly:true,liveCallsMade:false,sourceImports:false,codexAbsent:true,reviewSource:review,usefulAccepted:report.counts.usefulAccepted,tasks:report.tasks.map(task=>({id:task.id,providerId:task.worker.providerId,attemptCount:task.attemptCount,usefulAccepted:task.usefulAccepted,commit:accepted.find(item=>item.result.id===task.id).result.integration.commit})),parallel:{maxActive,sharedCapacityBlocked:true,queue:capacityQueue},protectedChecks:{failedBytes:failedBytes.length,failedBytesSha256:hash(failedBytes),correctedBytes,unchanged:true,sha256:protectedHash,repairedOnOriginalProvider:true,failedReceipt},restartBoundaries:['saved-response','applied-edits','failed-check','stopped-pending-review','accepted-replay'],restartSnapshots:snapshots,native:{passingChecks,allFingerprintsBound:true,runtimeFingerprint:h.fingerprint,probes,checks:accepted.map(item=>({candidate:item.result.result.checks,combined:item.result.integration.checks})),quiescentExecutions:ownerCount,executionOwners:h.rows('execution_owner')},replay:{noExtraPost:true,exactlyOnce:true},hostClosed:{tested:closedHost,noFallback:true},failureStatuses:{unreachableWorker:true,unreachable,malformedReview:true,malformedWait,missingHost:true,missingHostKind:'withheld isolated MCP registration; actual host app remains untested',missingHostDiagnostic:missingHost,hostUnavailableWait:closedHost},uncertain:{heldAfterRestart:true,sameScopeBlocked:true,noDuplicateLaunch:true,owner:u.record('execution_owner',runningOwner.id),task:u.record('task',utask.id),follower:u.record('task',follower.id),deniedUninstall,deniedUpdate,retainedRoot:u.root,evidenceInventory:uncertaintyEvidence},lifecycle:{discovery:true,uninstallOwnership:true,offOnRetained:true,update:true,compatibleRollback:true,stoppedApprovalUpdate,oldVersion:oldInstallation.version,newVersion:newInstallation.version,updated,rolledBack},demoInput:{inventorySha256:demo.inventorySha256,files:demo.files.length,licenseFiles:demo.licenseFiles,provenance:demo.provenance},requestOrder:calls.filter(call=>call.method==='POST').map(call=>({worker:call.id,model:call.model,kind:call.model?.startsWith('fixture-reviewer')?'review':JSON.parse(call.body.messages.at(-1).content).task.kind})),serviceLogs:mainLog};
 await writeFile(path.join(root,'installed-result.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary));
}catch(error){
 await writeFile(path.join(root,'installed-failure.json'),JSON.stringify({phase,error:error.stack,errors,snapshots,harnesses:savedHarnesses()},null,2)+'\n');console.error('Installed phase: '+phase+'\n'+error.stack);process.exitCode=1;
}finally{
 await cleanup();process.removeListener('SIGTERM',onTerm);process.removeListener('SIGINT',onInt);
}
