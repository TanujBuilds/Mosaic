import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';
import {startApi} from '../src/harness/api.mjs';
import {runOwnerAction} from '../src/beta/owner-actions.mjs';

async function setup(t,{coding=false}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'mosaic-owner-'));
 const c=new Coordinator({root,beta:true,workerProfile:{displayName:'Local fixture',baseUrl:'http://127.0.0.1:8989/v1',model:'fixture',revision:'r1',streaming:false}});
 t.after(async()=>{c.close();await rm(root,{recursive:true,force:true});});
 const d=new Dispatcher({c,config:{beta:true}});
 const invoke=(name,input)=>d.invoke(name,input);
 const goal=c.prepareGoal({submissionId:'demo',objective:'Inspect saved work',acceptance:['Evidence'],mode:'deepseek_only',environment:'fixture',...(coding?{project:{repo:root,baseCommit:'a'.repeat(40),readPaths:['src/','checks/'],writePaths:['src/'],checks:[{id:'unit',argv:['node','checks/unit.mjs']}]}}:{})},'prepare');
 const output={isTTY:true,text:'',write(value){this.text+=value;}};
 const perform=(args,...answers)=>runOwnerAction({},args,{input:{isTTY:true},output,invoke,ask:async()=>answers.shift()});
 return {goal,c,d,invoke,perform,output};
}

test('terminal approves only the exact prepared goal and submits a bound control',async t=>{
 const {goal,c,invoke,perform,output}=await setup(t);
 const {items}=await invoke('owner_inbox',{});
 assert.deepEqual(items,(await invoke('observer_snapshot',{})).needsYou.items);
 assert.equal(items[0].binding,goal.hash);
 await perform([items[0].id],'no');assert.equal(c.getGoal(goal.id).status,'draft');
 await perform([items[0].id],'yes');assert.equal(c.getGoal(goal.id).status,'active');
 assert.match(output.text,/acceptance/);
 const original=await invoke('owner_action_context',{goalId:goal.id});
 await perform(['pause',goal.id],'yes');
 await assert.rejects(invoke('work_control',{goalId:goal.id,action:'resume',expectedControlBinding:original.controlBinding,idempotencyKey:'stale'}),/changed/);
 await perform(['control-'+goal.id],'yes');assert.equal(c.getGoal(goal.id).status,'active');
 await assert.rejects(invoke('work_control',{goalId:goal.id,action:'stop',expectedControlBinding:original.controlBinding,idempotencyKey:'aba'}),/changed/);
 await perform(['stop',goal.id],'yes');assert.equal(c.getGoal(goal.id).status,'stopped');
});

test('question identity rejects stale answers and exact replay does not answer the next question',async t=>{
 const {c,goal,invoke,perform}=await setup(t,{coding:true});
 c.activateGoal({goalId:goal.id,hash:goal.hash},'activate');
 const task=c.submitTask({goalId:goal.id,submissionId:'question',kind:'coding',objective:'Ask',acceptance:['Answers'],limits:{questions:2}},'submit');
 const ask=text=>{c.claimNext('worker');c.ask(task.id,text,{},'worker');};
 ask('First?');
 const first=(await invoke('owner_inbox',{})).items[0];
 const body={taskId:task.id,expectedQuestionId:first.binding,responder:'user',answer:'One',idempotencyKey:'first-answer'};
 await invoke('question_answer',body);
 ask('Second\x1b[31m?');
 assert.equal((await invoke('owner_inbox',{})).items[0].detail,'Second?');
 await invoke('question_answer',body);
 assert.equal(c.getTask(task.id).status,'awaiting_user');
 await assert.rejects(invoke('question_answer',{...body,idempotencyKey:'stale-answer'}),/question changed/);
 await perform([first.id],'Two','yes');assert.deepEqual(c.getTask(task.id).answers.map(row=>row.text),['One','Two']);
});

test('viewer may read the inbox and cannot submit any owner mutation',async t=>{
 const {d,goal}=await setup(t),token='1'.repeat(64),viewerToken='2'.repeat(64);
 const api=await startApi({dispatcher:d,token,viewerToken});
 try{
  const call=(name,input)=>fetch(api.url+'/api/invoke',{method:'POST',headers:{authorization:'Bearer '+viewerToken,'content-type':'application/json'},body:JSON.stringify({name,input})});
  assert.equal((await (await call('owner_inbox',{})).json()).items[0].goalId,goal.id);
  for(const name of ['owner_action_context','goal_activate','work_control','question_answer','task_integrate'])assert.equal((await call(name,{})).status,403);
 }finally{await api.close();}
});

test('older decisions remain addressable after the list fills and terminal confirmation rechecks state',async t=>{
 const {c,goal,invoke,output}=await setup(t);
 for(let n=0;n<53;n++)c.prepareGoal({submissionId:'other-'+n,objective:'Other goal',acceptance:['Evidence'],mode:'deepseek_only',environment:'fixture'},'other-'+n);
 const list=await invoke('owner_inbox',{});
 assert.equal(list.hasMore,true);assert.equal(list.items.length,50);
 assert.ok(list.items.every(row=>row.goalId!==goal.id));
 const [item]=(await invoke('owner_inbox',{itemId:'approval-'+goal.id})).items;
 assert.equal(item.binding,goal.hash);
 c.activateGoal({goalId:goal.id,hash:goal.hash},'activate');
 await assert.rejects(runOwnerAction({},['pause',goal.id],{input:{isTTY:true},output,invoke,ask:async()=>{
  c.control({goalId:goal.id,action:'stop'},'concurrent-stop');
  return 'yes';
 }}),/Control state changed/);
 assert.equal(c.getGoal(goal.id).status,'stopped');
});
