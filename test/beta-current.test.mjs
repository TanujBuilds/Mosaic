import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseCurrent,currentHistory} from '../src/beta/current.mjs';

test('current project recognizes active native review but not reservation alone or retired reports',()=>{
 const now=1000000;
 const snapshot={goals:[{id:'g',status:'active',deadline:now+1000}],tasks:[{id:'t',goalId:'g',status:'awaiting_review',deadline:now+1000}],reviewers:[{goalId:'g',taskId:'t',status:'reserved',at:now-500}],agents:[]};
 assert.equal(chooseCurrent(snapshot,new Map(),now).kind,'recent');
 snapshot.agents.push({goalId:'g',taskId:'t',role:'reviewer',lastReport:{at:now,status:'running'}});
 assert.equal(chooseCurrent(snapshot,new Map(),now).kind,'running');
 snapshot.agents[0].stale=true;
 assert.equal(chooseCurrent(snapshot,new Map(),now).kind,'unknown');
 snapshot.agents[0].lastReport.status='waiting';
 assert.equal(chooseCurrent(snapshot,new Map(),now).kind,'recent');
 snapshot.tasks[0].status='accepted';
 assert.equal(chooseCurrent(snapshot,new Map(),now).kind,'recent');
});

test('empty coordinator and bounded incomplete history remain explicit',async()=>{
 assert.equal(chooseCurrent({goals:[]}).kind,'empty');
 const history={cursor:0,activity:new Map()};let calls=0;
 const invoke=async(name,{after})=>{
  if(name==='tools_list')return [{name:'observer_timeline'}];
  assert.equal(name,'observer_timeline');
  calls++;
  return {cursor:after+1,hasMore:true,events:[{goalId:'g',at:after+1,type:'task.result'}]};
 };
 assert.equal(await currentHistory(invoke,{cursor:100},history),false);
 assert.equal(calls,32);assert.equal(history.cursor,32);
 await currentHistory(invoke,{cursor:100},history);
 assert.equal(history.cursor,64);assert.equal(history.activity.get('g'),64);
});

test('stale native work does not outrank more recent completed work',()=>{
 const now=1000000;
 const choice=chooseCurrent({goals:[{id:'old',status:'active',deadline:now+1000},{id:'new',status:'completed'}],tasks:[{id:'t',goalId:'old',status:'codex_active',lastActivityAt:1}]},new Map([['new',now-1]]),now);
 assert.equal(choice.goalId,'new');assert.equal(choice.kind,'recent');assert.equal(choice.unconfirmed,true);
});
