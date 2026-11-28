import test from 'node:test';
import assert from 'node:assert/strict';
import {projectBoard, observerAction} from '../board.mjs';
import {dispatch} from '../bridge.mjs';
import {loadDetail} from './detail.mjs';

const snapshot={
  goals:[{id:'g-one',objective:'Review changes',status:'active',mode:'collaborative'},{id:'g-two',objective:'Old work',status:'completed'}],
  tasks:[{id:'t-one',goalId:'g-one',status:'awaiting_review',actor:'deepseek',lastActivityAt:100,model:{resolved:'local-model'}}],
  agents:[],overflow:{tasks:false}
};
const index=new Map([['g-one',{project:{id:'r-one',name:'website'},updatedAt:110}],['g-two',{project:{id:'r-two',name:'website'},updatedAt:90}]]);
test('same folder name can identify different repositories',()=>{
  const result=projectBoard(snapshot,index);
  assert.equal(result.projects.length,2);
  assert.notEqual(result.projects[0].name,result.projects[1].name);
  assert.equal(result.cards[0].lane,'attention');
  assert.equal(result.cards[0].worker,'local-model');
  assert.equal(result.cards[1].lane,'finished');
  assert.equal(result.latest.at,110);
});
test('a completed goal stays finished when an old assignment has an issue',()=>{
  const result=projectBoard({...snapshot,goals:[{...snapshot.goals[0],status:'completed'}]},index);
  assert.equal(result.cards[0].lane,'finished');
});
test('selecting an arbitrary path, method or source is rejected',async()=>{
  await assert.rejects(observerAction('observer.detail',{source:'preview',id:'../../a'},{}));
  await assert.rejects(dispatch({method:'observer.board',payload:{source:'preview',repo:'/tmp/a'}},{}));
  await assert.rejects(dispatch({method:'task_integrate',payload:{}},{}));
});
test('detail uses bound task evidence, marks missing evidence, and omits an uncorrelated host link',async()=>{
  const card=projectBoard(snapshot,index).cards[0];
  const data={...snapshot,tasks:[{...snapshot.tasks[0],evidenceRef:'task-foreign',outcome:{checks:{passed:1,total:2}}}]};
  const invoke=async(name)=>{if(name==='tools_list') return []; if(name==='observer_timeline')return {events:[],hasMore:false};throw Error('Unexpected evidence request');};
  const d=await loadDetail(data,card,invoke,'/unavailable');
  assert.equal(d.checks[0].status,'failed');
  assert.equal(d.canOpenHost,false);
  assert.equal(d.limited,true);
  assert.equal(d.diff,null);
});

test('closed partial goals remain in finished history; partial tasks on open goals invite attention',()=>{
  const task={...snapshot.tasks[0],status:'partial'};
  const closed={...snapshot.goals[0],status:'partial'};
  assert.equal(projectBoard({goals:[closed],tasks:[task]}).cards[0].lane,'finished');
  assert.equal(projectBoard({goals:snapshot.goals,tasks:[task]},index).cards[0].lane,'attention');
});

test('the desktop identifies generated locations without relying on project names',async()=>{
  const {isHistoryCheckout}=await import('./project-index.mjs');
  for (const path of ['/private/tmp/experiment', '/repo/.data/job', '/home/user/.codex/worktrees/abc/repo',
    '/home/user/Library/Application Support/Mosaic/state/integration/artifacts/abc/worktree']) assert.ok(isHistoryCheckout(path));
  for (const path of ['/repo/benchmark', '/home/me/worktree', '/repo/.database/website']) assert.equal(isHistoryCheckout(path),false);
});
