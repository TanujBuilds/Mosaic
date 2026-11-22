import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {chmod,mkdtemp,mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';
import {Integration} from '../src/harness/integration.mjs';
import {normalizeReviewPolicy,normalizeVerdict} from '../src/harness/review/contracts.mjs';
import {normalizeGoal,digest} from '../src/harness/contracts.mjs';
import {git} from '../src/project/process.mjs';
import {Workspace} from '../src/project/workspace.mjs';

async function fixture(t,{beta=false,mode='codex_only',selectedHost='cursor',reviewPolicy}={}){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'pb12-review-'))),repo=path.join(root,'repo');
 await mkdir(repo);await writeFile(path.join(repo,'file.txt'),'base\n');await writeFile(path.join(repo,'check.mjs'),'// UNCHANGED_REVIEW_CANARY\n');await writeFile(path.join(repo,'.env'),'SECRET_CANARY_DO_NOT_EXPOSE');await writeFile(path.join(repo,'excluded.txt'),'EXCLUDED_CANARY_DO_NOT_EXPOSE');
 await git(repo,'init','-q');await git(repo,'add','.');await git(repo,'-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','-qm','base');
 const c=new Coordinator({root:path.join(root,'state'),beta,selectedHost});
 const project={repo,baseCommit:await git(repo,'rev-parse','HEAD'),readPaths:['file.txt','check.mjs'],writePaths:['file.txt'],checks:[{id:'unit',argv:[process.execPath,'check.mjs'],timeoutMs:1000}]};
 const raw={submissionId:'goal',objective:'Review exact checked candidate',acceptance:['checked behavior'],mode,modeVersion:1,project,environment:'fixture',limits:{hours:1,maxTasks:2,reviewAgentRuns:3},...(reviewPolicy?{reviewPolicy}:{})};
 let checksPass=true;
 const integration=new Integration({c,checksFactory:()=>({verify:async()=>({fixture:true}),run:async specs=>specs.map(x=>({id:x.id,passed:checksPass,code:checksPass?0:1,stdout:'fixture check',stderr:''}))})});
 t.after(async()=>{c.close();await rm(root,{recursive:true,force:true});});
 return {c,raw,project,integration,setChecks:pass=>{checksPass=pass;},async candidate({content='candidate\n',executable=false}={}){
  const goal=c.prepareGoal(raw,'prepare');c.activateGoal({goalId:goal.id,hash:goal.hash},'activate');
  const task=c.submitTask({goalId:goal.id,submissionId:'task',kind:'coding',actor:'codex',objective:'Change file',acceptance:['checked']},'task');
  const started=await integration.startNative({taskId:task.id,layout:'candidate_v1'},'start');
  const file=path.join(started.native.worktree,'file.txt');
  await writeFile(file,content);
  if(executable)await chmod(file,0o755);
  const finished=await integration.finishNative({taskId:task.id,summary:'Changed fixture'},'finish');
  return {goal,task:finished};
 }};
}

async function acceptPrivateReview(f,goal){
 const {binding}=(await f.c.reviewService.inbox({goalId:goal.id})).items[0];
 const ticket=await f.c.reviewService.reserve(binding,'reserve');
 await f.c.reviewService.submit({...binding,ticketId:ticket.ticketId,verdict:{decision:'accept',feedback:'Fixture host checked the supplied evidence',findings:[]}},'submit');
}

test('private bound review compares the target checkpoint with the checked snapshot',async t=>{
 const f=await fixture(t,{beta:true}),{goal,task}=await f.candidate();
 assert.equal(goal.manifest.project.behavioralChecks,undefined);
 await acceptPrivateReview(f,goal);
 const original=Workspace.prototype.checkpoint;
 t.mock.method(Workspace.prototype,'checkpoint',async function(stage){
  const checked=await original.call(this,stage);
  return stage.id.startsWith('task-')?{...checked,commit:f.project.baseCommit}:checked;
 });
 await assert.rejects(f.integration.accept({taskId:task.id,feedback:'Import'},'integrate'),/Commit bytes differ from the checked snapshot/);
 assert.equal(f.c.getTask(task.id).status,'ready_to_integrate');
 assert.equal(f.c.getGoal(goal.id).integration.journalId,undefined);
});

test('bound import reads exact checkpoint bytes and executable mode',async t=>{
 const f=await fixture(t,{beta:true}),content='\ufeffexact café\n\n  \n',{goal,task}=await f.candidate({content,executable:true});
 await acceptPrivateReview(f,goal);
 t.mock.method(f.integration,'changes',async()=>{throw Error('Accepted import requested editable worktree content');});
 const accepted=await f.integration.accept({taskId:task.id,feedback:'Import'},'integrate');
 assert.equal(accepted.status,'accepted');
 assert.equal(await readFile(path.join(accepted.integration.worktree,'file.txt'),'utf8'),content);
 assert.equal((await git(accepted.integration.worktree,'ls-tree',accepted.integration.commit,'--','file.txt')).split(' ')[0],'100755');
});

test('review reservation rejects source text that differs from its captured snapshot',async t=>{
 const f=await fixture(t,{beta:true}),{goal,task}=await f.candidate();
 const {binding}=(await f.c.reviewService.inbox({goalId:goal.id})).items[0];
 const original=Workspace.prototype.readFiles,file=path.join(task.native.worktree,'file.txt');
 t.mock.method(Workspace.prototype,'readFiles',async function(files){
  const saved=await readFile(file);
  await writeFile(file,'second fixture revision\n');
  try{return await original.call(this,files);}finally{await writeFile(file,saved);}
 });
 await assert.rejects(f.c.reviewService.reserve(binding,'reserve'),/Review file content differs from the checked snapshot/);
 assert.equal(f.c.getTask(task.id).reviews,0);
});

for(const beta of [false,true])test(`host review exact candidate, replay and integration (${beta?'beta':'core'})`,async t=>{
 const f=await fixture(t,{beta}),{c}=f,{goal,task}=await f.candidate();
 const inbox=await c.reviewService.inbox({goalId:goal.id,limit:1});assert.equal(inbox.items.length,1);
 const {binding}=inbox.items[0],ticket=await c.reviewService.reserve({taskId:task.id,...binding},'reserve');
 assert.deepEqual(inbox.items[0].disclosure,{
  recipient:{source:'host',hostId:'cursor',mayUseCloudService:true},
  files:['check.mjs','file.txt'],
  checks:[{id:'unit',stdoutCharacters:13,stderrCharacters:0}],
  includesTaskSummary:false,
 });
 assert.deepEqual(ticket.disclosure,inbox.items[0].disclosure);
 assert.deepEqual(ticket.evidence.files.map(file=>file.path),ticket.disclosure.files);
 assert.match(ticket.evidence.files[0].content,/UNCHANGED_REVIEW_CANARY/);
 assert.equal(ticket.evidence.files[1].content,'candidate\n');
 assert.equal(ticket.evidence.checks[0].stdout,'fixture check');
 assert.ok(!JSON.stringify(inbox).includes('UNCHANGED_REVIEW_CANARY'));

 assert.ok(!JSON.stringify(ticket).includes('SECRET_CANARY_DO_NOT_EXPOSE'));assert.ok(!JSON.stringify(ticket).includes('EXCLUDED_CANARY_DO_NOT_EXPOSE'));
 assert.equal(ticket.reviewer.model,null);assert.equal(ticket.reviewer.provenance,'unknown');
 const input={ticketId:ticket.ticketId,...binding,verdict:{decision:'accept',feedback:'Checked fixture meets goal',findings:[]}};
 const accepted=await c.reviewService.submit(input,'submit');assert.equal(accepted.status,'ready_to_integrate');
 assert.deepEqual(await c.reviewService.reserve(binding,'reserve'),ticket);
 await assert.rejects(c.reviewService.reserve(binding,'reserve-after-acceptance'),/awaiting.*review/i);
 assert.equal(c.reviewService.budget(goal).spent,1);
 assert.deepEqual(await c.reviewService.submit(input,'submit-again'),accepted);
 await assert.rejects(()=>c.reviewService.submit({...input,verdict:{...input.verdict,feedback:'Conflict'}},'conflict'),/conflict/i);
 const integrated=await f.integration.accept({taskId:task.id,feedback:'Import'},'integrate');assert.equal(integrated.status,'accepted');
 assert.equal((await f.integration.accept({taskId:task.id,feedback:'Import'},'integrate-again')).integration.commit,integrated.integration.commit);
 assert.equal(c.getTask(task.id).reviews,1);
});

test('a historical outstanding ticket cannot replace the saved acceptance of a coding candidate',async t=>{
 const f=await fixture(t,{beta:true}),{c}=f,{goal,task}=await f.candidate();
 const {binding}=(await c.reviewService.inbox({goalId:goal.id})).items[0];
 const ticket=await c.reviewService.reserve(binding,'reserve');
 const reservation=c.store.get('review_ticket',ticket.ticketId);
 const verdict={decision:'accept',feedback:'The checked candidate meets the fixture goal',findings:[]};
 await c.reviewService.submit({...binding,ticketId:ticket.ticketId,verdict},'submit');
 // Earlier builds could leave a second reservation after saving acceptance.
 const extra={...reservation,id:'historical-review',requestId:'historical-request'};
 const ready=c.getTask(task.id);
 ready.reviews++;
 c.store.put('review_ticket',extra);c.store.put('task',ready);
 await assert.rejects(c.reviewService.submit({...binding,ticketId:extra.id,verdict},'late-submit'),/awaiting.*review/i);
 assert.deepEqual(c.getTask(task.id).reviewAcceptance,ready.reviewAcceptance);
 assert.deepEqual(c.store.get('review_ticket',extra.id),extra);
 assert.equal(c.reviewService.budget(goal).spent,2);
});

test('legacy acceptance tools and integration cannot bypass new common review',async t=>{
 const f=await fixture(t),{task}=await f.candidate();
 assert.throws(()=>f.c.review({taskId:task.id,decision:'accept',feedback:'bypass'},'bypass'),/bound|review_submit/i);
 assert.throws(()=>f.c.reserveReviewer({taskId:task.id},'old'),/bound|review_reserve/i);
 await assert.rejects(()=>f.integration.accept({taskId:task.id,feedback:'bypass'},'bypass-import'),/review/i);
});

for(const mutation of ['candidate','checks','rubric','goal','policy','executable'])test(`stale ${mutation} blocks reserved verdict`,async t=>{
 const f=await fixture(t),{c}=f,{goal,task}=await f.candidate();
 const {binding}=(await c.reviewService.inbox({goalId:goal.id})).items[0];
 const ticket=await c.reviewService.reserve({...binding,taskId:task.id},'reserve');
 if(mutation==='candidate')await writeFile(path.join(task.native.worktree,'file.txt'),'changed after check\n');
 if(mutation==='executable'){const {chmod}=await import('node:fs/promises');await chmod(path.join(task.native.worktree,'file.txt'),0o755);}
 if(mutation==='checks'){const x=c.getTask(task.id);x.result.checks[0].passed=false;c.store.put('task',x);}
 if(mutation==='rubric'){const g=c.store.get('goal',goal.id);g.manifest.acceptance=['different'];c.store.put('goal',g);}
 if(mutation==='goal'){const g=c.store.get('goal',goal.id);g.version++;c.store.put('goal',g);}
 if(mutation==='policy'){const g=c.store.get('goal',goal.id);g.manifest.reviewPolicy.hostId='codex';c.store.put('goal',g);}
 await assert.rejects(()=>c.reviewService.submit({...binding,ticketId:ticket.ticketId,verdict:{decision:'accept',feedback:'stale',findings:[]}},'submit'),/changed|stale|checks|binding|hash|snapshot|candidate|rebind/i);
 assert.equal(c.getTask(task.id).reviewed,false);
});

test('failed checks deny reservation and findings are data with strict scope and bounds',async t=>{
 const f=await fixture(t),{c}=f,{task}=await f.candidate(),entry=(await c.reviewService.inbox({})).items[0];
 const current=c.getTask(task.id);current.result.checks[0].passed=false;c.store.put('task',current);
 await assert.rejects(()=>c.reviewService.reserve({...entry.binding,taskId:task.id},'reserve'),/checks/i);
 assert.throws(()=>normalizeVerdict({decision:'accept',feedback:'x'.repeat(16385),findings:[]}),/feedback/i);
 assert.throws(()=>normalizeVerdict({decision:'accept',feedback:'x',findings:Array(51).fill({path:'file.txt',message:'x'})}),/findings/i);
 assert.throws(()=>normalizeVerdict({decision:'accept',feedback:'x',findings:[{path:'../secret',line:0,message:'x'}]}),/path|line/i);
});

test('portable mode matrix preserves historical bytes and requires trusted host context',async t=>{
 const f=await fixture(t),legacy={submissionId:'legacy',objective:'old',acceptance:['old'],mode:'overnight_review',modeVersion:1};
 const old=normalizeGoal(legacy);assert.equal(Object.hasOwn(old,'reviewPolicy'),false);assert.equal(digest(old),digest(normalizeGoal(legacy)));
 for(const [mode,source,allowed,planner]of [
 ['collaborative','host',true,'codex'],['collaborative','api',true,'codex'],['deepseek_only','host',false,'deepseek'],['deepseek_only','api',false,'deepseek'],['codex_only','host',true,'codex'],['codex_only','api',false,'codex'],['overnight_review','host',true,'deepseek']]){
  const raw={submissionId:mode+source,objective:'matrix',acceptance:['x'],mode,modeVersion:1,reviewPolicy:{version:1,source,hostId:'cursor',fallback:'wait'}};
  if(source==='api'){delete raw.reviewPolicy.hostId;raw.reviewPolicy.reviewer={};}
  if(source==='api'&&allowed)continue; // Complete configured API identities exercised in accounting tests.
  if(allowed){const g=normalizeGoal(raw);assert.equal(g.mode.planner,planner);assert.equal(g.reviewPolicy.source,source);}
  else assert.throws(()=>normalizeGoal(raw));
 }
 const noHost=new Coordinator({root:path.join(f.project.repo,'other-state'),beta:true});t.after(()=>noHost.close());
 assert.throws(()=>noHost.prepareGoal({...f.raw,submissionId:'no-host'},'no-host'),/host/i);
 const d=new Dispatcher({c:f.c});const goal=await d.invoke('goal_prepare',{manifest:{...f.raw,submissionId:'mcp'},idempotencyKey:'mcp'});
 assert.equal(goal.manifest.reviewPolicy.hostId,'cursor');
 assert.equal(goal.manifest.reviewPolicy.fallback,'wait');
});

 test('fresh portable MCP preparation requires context while exact historical replay preserves bytes',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pb12-historic-'));const c=new Coordinator({root});t.after(async()=>{c.close();await rm(root,{recursive:true,force:true});});
 const raw={submissionId:'historic',objective:'Historical goal',acceptance:['kept'],mode:'overnight_review',modeVersion:1,environment:'fixture'};
 const saved=c.prepareLegacyGoal(raw,'old-key');
 assert.equal(saved.hash,'718db6f46badc6aee9409e7844f327b4cf796e68bff0babfc3dfb15de3a42a6a');
 const d=new Dispatcher({c});
 assert.deepEqual(await d.invoke('goal_prepare',{manifest:raw,idempotencyKey:'old-key'}),saved);
 await assert.rejects(()=>d.invoke('goal_prepare',{manifest:{...raw,submissionId:'fresh'},idempotencyKey:'fresh'}),/host/i);
 await assert.rejects(()=>d.invoke('goal_prepare',{manifest:{...raw,submissionId:'raw-host',reviewPolicy:{version:1,source:'host',hostId:'cursor',fallback:'wait'}},idempotencyKey:'raw-host'}),/trusted|host/i);
 assert.equal(Object.hasOwn(saved.manifest,'reviewPolicy'),false);
 const explicit=await d.invoke('legacy_goal_prepare',{manifest:{...raw,submissionId:'explicit-legacy'},idempotencyKey:'explicit-legacy'});assert.equal(Object.hasOwn(explicit.manifest,'reviewPolicy'),false);
 });

test('host-reviewed overnight waits durably for the active host and keeps worker-only authority',async()=>{
 const {deriveOvernightState}=await import('../src/harness/overnight-lifecycle.mjs');
 const manifest=normalizeGoal({submissionId:'night',objective:'overnight',acceptance:['checked'],mode:'overnight_review',modeVersion:1,reviewPolicy:{version:1,source:'host',hostId:'cursor',fallback:'wait'}});
 assert.deepEqual(manifest.mode.actors,['deepseek']);assert.equal(manifest.mode.planner,'deepseek');
 const state=deriveOvernightState({id:'g',manifest,status:'active',deadline:10000},[{id:'t',status:'awaiting_review',deadline:9000,spec:{dependsOn:[]}}],null,1000);
 assert.equal(state.phase,'review');assert.equal(state.code,'waiting_host_review');assert.match(state.reason,/host|return/i);
});

test('review and coding modules load independently in fresh ESM processes',async()=>{
 const {execFileSync}=await import('node:child_process');
 for(const name of ['coding','native-candidates','review/service','review/evidence','legacy-review']){
  assert.doesNotThrow(()=>execFileSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(new URL('../src/harness/'+name+'.mjs',import.meta.url).href)})`],{encoding:'utf8',stdio:'pipe'}),name+' standalone import');
 }
});
