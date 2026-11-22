// Fresh beta observer fixtures supply selected host context without changing historical core goals.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';
import {startApi} from '../src/harness/api.mjs';
import {observerClient} from '../src/beta/sources.mjs';
import {locations} from '../src/beta/files.mjs';
import {TerminalObserver,renderTerminal} from '../src/beta/observer.mjs';

const exec=promisify(execFile);
async function fixture(t){
 const home=await mkdtemp(path.join(os.tmpdir(),'mosaic-sources-'));
 const services=[];
 t.after(async()=>{for(const s of services){await s.api.close();s.c.close();}await rm(home,{recursive:true,force:true});});
 for(const name of ['Mosaic Beta','Mosaic']){
  const root=path.join(home,'Library','Application Support',name,'state');
  await mkdir(root,{recursive:true,mode:0o700});
  const c=new Coordinator({root,beta:name==='Mosaic Beta',...(name==='Mosaic Beta'?{selectedHost:'codex'}:{}),workerProfile:name==='Mosaic Beta'?{baseUrl:'http://127.0.0.1:1/v1',model:'fixture',displayName:'Fixture',revision:'fixture',streaming:false}:undefined});
  const dispatcher=new Dispatcher({c});
  if(name==='Mosaic'){
   delete dispatcher.definitions.get('observer_timeline').inputSchema.properties.recent;
   dispatcher.definitions.delete('observer_current_activity');
  }
  const reads=[],invoke=dispatcher.invoke.bind(dispatcher);
  dispatcher.invoke=(name,...args)=>{reads.push(name);return invoke(name,...args);};
  const api=await startApi({dispatcher,token:'a'.repeat(64),viewerToken:'b'.repeat(64),headless:true});
  // Only viewer credentials exist: discovery must never need operator access.
  await writeFile(path.join(root,'viewer-connection.json'),JSON.stringify({url:api.url,token:'b'.repeat(64),role:'viewer'}),{mode:0o600});
  services.push({c,api,root,reads,dispatcher});
 }
 const run=(...args)=>exec(process.execPath,['src/beta/cli.mjs','--home',home,'status','--once',...args],{timeout:10000});
 const goal=(c,label)=>{const g=c.prepareGoal({submissionId:label.replaceAll(" ","-"),objective:label,acceptance:['Evidence'],environment:'fixture'},'prepare');c.activateGoal({goalId:g.id,hash:g.hash},'activate');return g;};
 return {home,beta:services[0],core:services[1],run,goal};
}

test('terminal discovers the existing Mosaic run instead of showing an empty beta',async t=>{
 const f=await fixture(t);
 f.goal(f.core.c,'Build the localhost todo app');
 const {stdout}=await f.run();
 assert.match(stdout,/Build the localhost todo app/);
 assert.match(stdout,/frontier-harness/);
 assert.doesNotMatch(stdout,/no saved goals/);
 assert.doesNotMatch(stdout,/Disconnected/);
});

test('explicit core observation does not require or resume beta setup',async t=>{
 const f=await fixture(t);
 f.goal(f.core.c,'Existing installation');
 const config=path.join(f.home,'Library','Application Support','Mosaic Beta','config');
 await mkdir(config,{recursive:true,mode:0o700});
 await writeFile(path.join(config,'setup-intent.json'),'{}',{mode:0o600});
 const {stdout}=await exec(process.execPath,['src/beta/cli.mjs','--home',f.home,'--source','core'],{timeout:10000});
 assert.match(stdout,/Existing installation/);
 assert.doesNotMatch(stdout,/setup|Choose|Apply these/);
});

test('an open idle terminal discovers a new core run and pages legacy handoff history',async t=>{
 const f=await fixture(t),invoke=observerClient(locations(f.home,true)),observer=new TerminalObserver(invoke);
 await observer.poll();assert.equal(observer.state.snapshot.source,'beta');
 for(let n=0;n<2300;n++)f.core.c.emit('test.unrelated',null,null,{});
 const g=f.goal(f.core.c,'Legacy run');
 await observer.poll();
 assert.equal(observer.state.snapshot.source,'core');
 assert.equal(observer.state.stale,false);
 assert.equal(observer.state.historyPending,true);
 assert.match(renderTerminal(observer.state),/Loading saved handoffs/);
 await observer.poll();
 assert.equal(observer.state.historyPending,false);
 assert.ok(observer.state.events.some(e=>e.goalId===g.id&&e.type==='goal.activated'));
 assert.doesNotMatch(renderTerminal(observer.state),/Loading saved handoffs/);
 await assert.rejects(invoke('goal_activate',{goalId:g.id,hash:g.hash}),/read-only/);
 await rm(path.join(f.core.root,'viewer-connection.json'));
 await observer.poll();
 assert.equal(observer.state.stale,true);
 assert.equal(observer.state.snapshot.source,'core');
 assert.equal(observer.state.goalId,g.id);
});

test('explicit observer source keeps beta and core histories separate',async t=>{
 const f=await fixture(t);
 f.goal(f.core.c,'Core assignment');f.goal(f.beta.c,'Beta assignment');
 const beta=await f.run('--source','beta'),core=await f.run('--source','core');
 assert.match(beta.stdout,/Beta assignment/);assert.doesNotMatch(beta.stdout,/Core assignment/);
 assert.match(core.stdout,/Core assignment/);assert.doesNotMatch(core.stdout,/Beta assignment/);
 await assert.rejects(f.run('--source','unknown'));
});

test('changing the active source resets the feed and routes evidence to its owning coordinator',async t=>{
 const f=await fixture(t),invoke=observerClient(locations(f.home,true)),observer=new TerminalObserver(invoke);
 const coreGoal=f.goal(f.core.c,'Core work');
 const task=f.core.c.submitTask({goalId:coreGoal.id,submissionId:'answer',kind:'consult',objective:'Core evidence',acceptance:['Evidence']},'submit');
 await observer.poll();
 const evidence=await invoke('observer_evidence',{reference:'task-'+task.id,length:4096});
 assert.match(evidence.text,/Core evidence/);
 assert.ok(observer.state.events.some(e=>e.goalId===coreGoal.id));
 f.core.c.control({goalId:coreGoal.id,action:'stop'},'stop');
 const betaGoal=f.goal(f.beta.c,'Beta work');
 await observer.poll();
 assert.equal(observer.state.snapshot.source,'beta');
 assert.equal(observer.state.goalId,betaGoal.id);
 assert.ok(observer.state.events.length>0);
 assert.ok(observer.state.events.every(e=>e.goalId===betaGoal.id));
});

test('current shortcut ignores expired active labels and deadline housekeeping across sources',async t=>{
 const f=await fixture(t),now=Date.now();
 f.core.c.now=()=>now-10000;
 const old=f.goal(f.core.c,'Expired project');
 const record=f.core.c.store.get('goal',old.id);record.deadline=now-100;f.core.c.store.put('goal',record);
 f.beta.c.now=()=>now-1000;
 const recent=f.goal(f.beta.c,'Recent project');
 const done=f.beta.c.store.get('goal',recent.id);done.status='completed';f.beta.c.store.put('goal',done);
 f.beta.c.emit('goal.finalized',recent.id,null,{});
 f.core.c.now=()=>now;f.core.c.emit('task.expired',old.id,null,{});
 const invoke=observerClient(locations(f.home,true));
 assert.equal(typeof invoke.current,'function');
 const result=await invoke.current();
 assert.equal(result.goalId,recent.id);assert.equal(result.snapshot.source,'beta');
 assert.match(result.notice,/No work currently running/);
 assert.equal(f.core.c.store.get('goal',old.id).status,'active');
 assert.equal((await invoke('observer_snapshot')).source,'beta');
});

test('Current uses compact viewer activity where advertised and falls back after a downgrade',async t=>{
 const f=await fixture(t),now=Date.now();
 f.core.c.now=()=>now-1000;f.beta.c.now=()=>now;
 const core=f.goal(f.core.c,'Older core activity'),beta=f.goal(f.beta.c,'Newer beta activity');
 const observer=observerClient(locations(f.home,true));
 assert.equal((await observer.current()).goalId,beta.id);
 assert.deepEqual(f.beta.reads,['observer_snapshot','observer_current_activity']);
 assert.deepEqual(f.core.reads,['observer_snapshot','observer_timeline']);
 f.beta.dispatcher.definitions.delete('observer_current_activity');
 f.beta.reads.length=0;f.core.reads.length=0;
 f.core.c.now=()=>now+2000;
 f.core.c.emit('task.result',core.id,null,{summary:'More recent saved work'});
 assert.equal((await observer.current()).goalId,core.id);
 assert.deepEqual(f.beta.reads,['observer_snapshot','observer_timeline']);
 assert.deepEqual(f.core.reads,['observer_snapshot','observer_timeline']);
});

test('current shortcut picks the freshest genuinely running worker and honors explicit source',async t=>{
 const f=await fixture(t),now=Date.now();
 const create=(service,name,at)=>{
  service.c.now=()=>at;const g=f.goal(service.c,name);
  const task=service.c.submitTask({goalId:g.id,submissionId:'work',kind:'consult',objective:'Work',acceptance:['Evidence']},'submit');
  service.c.claimNext('fixture-worker');
  service.c.emit('model.request.started',g.id,task.id,{actor:'deepseek',provenance:'captured'});
  return g;
 };
 const core=create(f.core,'Core live',now-1000),beta=create(f.beta,'Beta live',now);
 const auto=observerClient(locations(f.home,true));assert.equal(typeof auto.current,'function');
 assert.equal((await auto.current()).goalId,beta.id);
 const explicit=await observerClient(locations(f.home,true),{source:'core'}).current();
 assert.equal(explicit.goalId,core.id);assert.equal(explicit.kind,'running');
});

test('current shortcut does not claim stale native reports are running',async t=>{
 const f=await fixture(t),now=Date.now(),g=f.goal(f.core.c,'Native project');
 const tsk=f.core.c.submitTask({goalId:g.id,submissionId:'native',actor:'codex',kind:'consult',objective:'Native work',acceptance:['Evidence']},'submit');
 const row=f.core.c.getTask(tsk.id);row.status='codex_active';f.core.c.store.put('task',row);
 f.core.c.store.put('agent',{id:'native',goalId:g.id,taskId:tsk.id,actor:'codex',role:'implementer',lastReport:{status:'running',at:now-180000}});
 const invoke=observerClient(locations(f.home,true),{source:'core'});assert.equal(typeof invoke.current,'function');
 const stale=await invoke.current();assert.equal(stale.kind,'unknown');assert.match(stale.notice,/unconfirmed/i);
 f.core.c.store.put('agent',{id:'native',goalId:g.id,taskId:tsk.id,actor:'codex',role:'implementer',lastReport:{status:'running',at:Date.now()}});
 assert.equal((await invoke.current()).kind,'running');
});
