// Historical no-policy workflows explicitly select the legacy preparation tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {Store} from '../src/harness/store.mjs';

const cli=fileURLToPath(new URL('../src/harness/cli.mjs',import.meta.url));
async function eventually(get,check,ms=3000){
 const end=performance.now()+ms;
 do{const value=await get();if(check(value))return value;await delay(25);}while(performance.now()<end);
 assert.fail('Expected state did not arrive before the timeout');
}
test('history queries preserve insertion order without a SQLite temporary sort',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'mosaic-history-'));
 t.after(()=>rm(root,{force:true,recursive:true}));
 const c=new Coordinator({root});
 try{
  for(const id of ['z','a','b'])c.store.put('task',{id,history:'x'.repeat(120000)});
  assert.deepEqual(c.store.all('task').map(row=>row.id),['z','a','b']);
  const plan=c.store.db.prepare('EXPLAIN QUERY PLAN SELECT data FROM records WHERE kind=? ORDER BY rowid').all('task');
  assert.doesNotMatch(plan.map(row=>row.detail).join('\n'),/TEMP B-TREE/i);
 }finally{c.close();}
});

for(const serviceMaxConcurrentTasks of [1,2])test(`idle scheduler skips closed task history at service limit ${serviceMaxConcurrentTasks}`,async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'mosaic-scheduler-history-'));
 const c=new Coordinator({root,serviceMaxConcurrentTasks});
 const worker=new Worker({c,config:{environment:'fixture'}});
 t.after(async()=>{await worker.close();c.close();await rm(root,{force:true,recursive:true});});
 const now=c.now();
 c.store.put('goal',{id:'history',status:'completed',deadline:now-1,manifest:{mode:{id:'collaborative'}}});
 c.store.tx(()=>{for(let n=0;n<80;n++)c.store.put('task',{id:'old-'+n,goalId:'history',status:'accepted',
  spec:{kind:'consult',actor:'deepseek',dependsOn:[]},result:{content:'Completed fixture '.repeat(300)}});});

 c.store.waitForChange=async()=>{};
 const readAll=c.store.all.bind(c.store);
 const historyReads=[];
 c.store.all=kind=>{if(kind==='task')historyReads.push(kind);return readAll(kind);};
 const before=c.store.revision();
 await worker.executeTick();
 assert.equal(worker.nextIdleCheck(now),Infinity);
 assert.equal(c.store.revision(),before);
 assert.deepEqual(historyReads,[]);
});

test('an active planner does a goal lookup when only closed tasks remain',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'mosaic-planner-history-'));
 const c=new Coordinator({root});
 const worker=new Worker({c,config:{environment:'fixture'},provider:{complete:async()=>assert.fail('Planner must not repeat a completed goal')}});
 t.after(async()=>{await worker.close();c.close();await rm(root,{force:true,recursive:true});});
 const g=c.prepareLegacyGoal({submissionId:'planned',objective:'Preexisting planned work',acceptance:['Preserve the prior result'],mode:'deepseek_only',environment:'fixture'},'prepare');
 c.activateGoal({goalId:g.id,hash:g.hash},'activate');
 const task=c.submitTask({goalId:g.id,submissionId:'result',kind:'consult',objective:'Previously planned task',acceptance:['Saved']},'submit');
 c.store.put('task',{...c.store.get('task',task.id),status:'accepted'});
 const readAll=c.store.all.bind(c.store),historyReads=[];
 c.store.all=kind=>{if(kind==='task')historyReads.push(kind);return readAll(kind);};
 assert.equal(worker.planner.schedulable(c.store.get('goal',g.id)),false);
 assert.equal(await worker.executeTick(),null);
 assert.equal(c.store.maybe('planning',g.id),null);
 assert.deepEqual(historyReads,[]);
});

test('unfinished task reads follow schema-1 restart, external writes and rollback',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'mosaic-scheduler-reopen-'));
 t.after(()=>rm(root,{force:true,recursive:true}));
 const initial=new Store(root);
 initial.put('task',{id:'z',status:'uncertain'});
 initial.put('task',{id:'closed',goalId:'saved-goal',status:'accepted'});
 initial.put('task',{id:'a',status:'stopped'});
 initial.db.exec('DROP INDEX records_unfinished_tasks; DROP INDEX records_task_goal');
 initial.close();

 const store=new Store(root),other=new Store(root);
 try{
  const ids=()=>store.unfinishedTasks().map(row=>row.id);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,1);
  assert.deepEqual(ids(),['z','a']);
  assert.equal(store.hasTasksForGoal('saved-goal'),true);
  assert.equal(store.hasTasksForGoal('other-goal'),false);
  other.put('task',{id:'z',status:'partial'});
  other.put('task',{id:'closed',status:'suspended'});
  assert.deepEqual(ids(),['closed','a']);
  assert.throws(()=>store.tx(()=>{
   store.put('task',{id:'a',status:'cancelled'});
   assert.deepEqual(ids(),['closed']);
   throw Error('rollback fixture');
  }),/rollback fixture/);
  assert.deepEqual(ids(),['closed','a']);
  assert.equal(other.unfinishedTasks().length,2);
 }finally{other.close();store.close();}
});

test('idle service leaves expired reports and history alone, then wakes on work and deadlines', {timeout:15000},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'mosaic-idle-'));
 t.after(()=>rm(root,{force:true,recursive:true}));
 const config=path.join(root,'fixture.json'),preload=path.join(root,'count.mjs');
 await writeFile(config,JSON.stringify({environment:'fixture'}));
 // Count actual task history scans in the service without writing from the child.
 await writeFile(preload,`import {Store} from ${JSON.stringify(new URL('../src/harness/store.mjs',import.meta.url).href)};
 let scans=0;const all=Store.prototype.all;Store.prototype.all=function(kind){if(kind==='task')scans++;return all.call(this,kind);};
 process.on('message',()=>process.send(scans));`);
 const c=new Coordinator({root});
 try{
  const now=Date.now(),deadline=now-1000;
  for(const id of ['old-z','old-a']){
   c.store.put('goal',{id,hash:id,status:'active',deadline,manifest:{mode:{id:'overnight_review',version:2},limits:{},acceptance:[]}});
   for(let n=0;n<12;n++)c.store.put('task',{id:id+'-'+n,goalId:id,status:'accepted',deadline,attempts:1,reviews:1,spec:{objective:'Saved stage',role:'implementation',actor:'deepseek',dependsOn:[],limits:{}},result:{content:'x'.repeat(160000)}});
  }
 }finally{c.close();}
 const child=spawn(process.execPath,['--import',preload,cli,'serve','--root',root,'--config',config,'--port','0'],{stdio:['ignore','pipe','pipe','ipc']});
 const exit=once(child,'exit');
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exit;});
 await once(child.stdout,'data');
 const cfg=JSON.parse(await readFile(path.join(root,'connection.json'),'utf8'));
 const call=async(name,input)=>{
  const response=await fetch(cfg.url+'/api/invoke',{method:'POST',headers:{authorization:'Bearer '+cfg.token,'content-type':'application/json'},body:JSON.stringify({name,input})});
  const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;
 };
 const reader=new DatabaseSync(path.join(root,'harness.sqlite3'),{readOnly:true});
 t.after(()=>reader.close());
 const runs=()=>reader.prepare("SELECT data FROM records WHERE kind='overnight_run' ORDER BY id").all().map(row=>row.data);
 const scans=async()=>{const next=once(child,'message');child.send('count');return (await next)[0];};
 await eventually(runs,rows=>rows.length===2&&rows.every(row=>JSON.parse(row).phase==='expired')).catch(async error=>{const events=await call('events_wait',{});throw Error(JSON.stringify(events.events.filter(event=>event.type==='service.error').slice(-2)),{cause:error});});
 await delay(400); // Let initial report/notification commits settle.
 const before=runs(),beforeScans=await scans();
 await delay(1300);
 assert.deepEqual(runs(),before,'expired reports must not be rewritten');
 assert.equal(await scans(),beforeScans,'unchanged idle service must not rescan task history');

 const g=await call('legacy_goal_prepare',{idempotencyKey:'prepare',manifest:{submissionId:'idle-wakeup',objective:'Fixture task',acceptance:['Return a saved response'],environment:'fixture'}});
 await call('goal_activate',{idempotencyKey:'activate',goalId:g.id,hash:g.hash});
 await delay(400); // Exercise submission from a settled idle worker.
 const at=performance.now();
 const task=await call('task_submit',{idempotencyKey:'submit',goalId:g.id,task:{submissionId:'fixture-consult',kind:'consult',objective:'Return answer',acceptance:['Answer saved'],limits:{seconds:2}}});
 const ready=await eventually(()=>call('task_get',{taskId:task.id}),row=>row.status==='awaiting_review',2000);
 assert.ok(performance.now()-at<2200,'new work must wake before the idle fallback');
 assert.equal(ready.spent.model,1);

 // No submission or write wakes the worker when this deadline comes due.
 const expired=await eventually(()=>call('task_get',{taskId:task.id}),row=>row.status==='partial',3200);
 assert.equal(expired.deadline,ready.deadline);
 assert.equal(expired.spent.model,1);
 assert.deepEqual(runs(),before);
 await call('service_stop',{idempotencyKey:'stop'});
 child.disconnect();
 assert.deepEqual(await exit,[0,null]);
});
