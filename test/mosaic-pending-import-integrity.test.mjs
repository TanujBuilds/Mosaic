import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod,readFile} from 'node:fs/promises';
import path from 'node:path';
import {Journal} from '../src/project/journal.mjs';
import {fixture,goal,candidate,accept} from './fixtures/mosaic-pb14-integration/fixture.mjs';

for(const type of ['integration.import.intent','edits.intent'])test(`pending integration preserves a discrepant ${type} before applying it`,async t=>{
 const f=await fixture(t),g=goal(f,'pending'),a=await candidate(f,g,'a');
 await a.finish();
 const append=Journal.prototype.append;
 const interruption=t.mock.method(Journal.prototype,'append',async function(event,data){
  if(event!==type||!data.key.startsWith('import-'))return append.call(this,event,data);
  const changes=data.changes.map(change=>({...change,afterMode:'100755'}));
  await append.call(this,event,{...data,changes});
  throw Error('Fixture interrupted after pending receipt');
 });
 try{await assert.rejects(accept(f,a.task),/Fixture interrupted/);}finally{interruption.mock.restore();}
 const {integration,integrationPending}=f.c.getGoal(g.id);
 const file=path.join(integration.worktree,'src/a.mjs');
 assert.equal(await readFile(file,'utf8'),'export const a=0;\n');
 const journal=await f.i.integrationJournal(f.c.store.get('goal',g.id));
 const saved=await readFile(journal.file);
 await assert.rejects(accept(f,a.task),/Saved pending integration.*src\/a\.mjs/);
 assert.deepEqual(f.c.getGoal(g.id).integrationPending,integrationPending);
 assert.equal(f.c.getTask(a.task.id).status,'ready_to_integrate');
 assert.equal(await readFile(file,'utf8'),'export const a=0;\n');
 assert.deepEqual(await readFile(journal.file),saved);
});

test('an already applied ordinary-file import can resume with historical mode-less rows',async t=>{
 const f=await fixture(t),g=goal(f,'historical'),a=await candidate(f,g,'a');
 await a.finish();
 const append=Journal.prototype.append;
 const interruption=t.mock.method(Journal.prototype,'append',async function(event,data){
  if(!data.key?.startsWith('import-'))return append.call(this,event,data);
  if(['integration.import.intent','edits.intent'].includes(event)){
   const changes=data.changes.map(({beforeMode,afterMode,...change})=>change);
   return append.call(this,event,{...data,changes});
  }
  const result=await append.call(this,event,data);
  if(event==='edits.applied')throw Error('Fixture interrupted after applied edits');
  return result;
 });
 try{await assert.rejects(accept(f,a.task),/Fixture interrupted/);}finally{interruption.mock.restore();}
 const {integration,integrationPending}=f.c.getGoal(g.id);
 assert.equal(await readFile(path.join(integration.worktree,'src/a.mjs'),'utf8'),'export const a=1;\n');
 const accepted=await accept(f,a.task);
 assert.equal(accepted.status,'accepted');
 assert.equal(f.c.getGoal(g.id).integrationPending,null);
 const journal=await f.i.integrationJournal(f.c.store.get('goal',g.id));
 assert.equal(journal.events.filter(event=>event.type==='edits.applied'&&event.data.key===integrationPending.importKey).length,1);
});

test('integration checks the applied file mode before running target checks',async t=>{
 const runs=[],f=await fixture(t,{onRun:async(workspace,checks,key)=>runs.push(key)}),g=goal(f,'applied'),a=await candidate(f,g,'a');
 await a.finish();
 const apply=f.i.applyChanges;
 t.mock.method(f.i,'applyChanges',async function(workspace,...args){
  await apply.call(this,workspace,...args);
  await chmod(path.join(workspace.root,'src/a.mjs'),0o755);
 });
 await assert.rejects(accept(f,a.task),/Imported file differs from the verified checkpoint.*src\/a\.mjs/);
 assert.ok(f.c.getGoal(g.id).integrationPending);
 assert.equal(f.c.getTask(a.task.id).status,'ready_to_integrate');
 assert.ok(runs.every(key=>!key.startsWith('integrate-')));
});
