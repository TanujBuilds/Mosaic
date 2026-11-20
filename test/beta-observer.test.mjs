import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {stripVTControlCharacters} from 'node:util';
import {spawnSync} from 'node:child_process';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {savedBetaGoal} from './fixtures/mosaic-pb12/historical-beta.mjs';
import {Observer} from '../src/harness/observer.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {actorRows,renderTerminal,TerminalObserver,runObserver} from '../src/beta/observer.mjs';

const goal={id:'goal-1',objective:'Ship\x1b]52;c;injection\x07 work',status:'active',mode:'collaborative',workerProfile:{displayName:'Fixture Model'}};
const task={id:'task-1',goalId:goal.id,actor:'deepseek',kind:'coding',objective:'Run protected checks',status:'running',phase:'checks',provenance:'captured',lastActivityAt:1000,evidenceRef:'task-task-1'};
const native={id:'task-2',goalId:goal.id,actor:'codex',objective:'Independent implementation',status:'codex_active',provenance:'reported',lastActivityAt:1000};
const snapshot={goals:[goal],tasks:[task,native],agents:[{id:'a',goalId:goal.id,taskId:native.id,actor:'codex',role:'implementer',lastReport:{status:'running',at:1000}}],reviewers:[],cursor:101};

test('Connections separates saved configuration from historical evidence and stale data',()=>{
 const connections={host:{id:'cursor',lastConnection:null},worker:{displayName:'Local Worker',lastConnection:{kind:'worker_response',at:1000}}};
 const state={snapshot:{...snapshot,goals:[],connections},events:[]};
 const view={view:'connections',interactive:true,width:90,height:24};
 const frame=renderTerminal(state,view);
 assert.match(frame,/Connections/);
 assert.match(frame,/Cursor · configured/);
 assert.match(frame,/Local Worker · configured/);
 assert.match(frame,/Last connection · unverified/);
 assert.match(frame,/Last response · /);
 assert.doesNotMatch(frame,/Offline|Detected/i);
 const observed={...state.snapshot,connections:{...connections,host:{...connections.host,lastConnection:{kind:'registry_call',at:1000}}}};
 const receipt=renderTerminal({...state,snapshot:observed},view);
 assert.match(receipt,/Bridge registry call · /);
 assert.doesNotMatch(receipt,/Last connection · unverified|Online/i);
 assert.match(renderTerminal({...state,stale:true},view),/Disconnected.*stale/);
 assert.match(renderTerminal({...state,stale:true},{...view,width:24,height:18}),/Disconnected.*stale/);
 assert.match(renderTerminal({snapshot:null,stale:true,events:[]},view),/Configuration unavailable/);
 const empty=renderTerminal({snapshot:{...snapshot,goals:[],connections:{host:null,worker:null}},events:[]},view);
 assert.match(empty,/No coding app selected/);
 assert.match(empty,/No API worker configured/);
});

test('a goal-scoped refresh preserves the connection evidence from the source snapshot',async()=>{
 const connections={host:{id:'cursor',lastConnection:{kind:'registry_call',at:1000}},worker:null};
 const scoped={...snapshot,connections:{host:{id:'cursor',lastConnection:null},worker:null}};
 const observer=new TerminalObserver(async(name,input)=>
  name==='observer_snapshot'?input.goalId?scoped:{...snapshot,connections,overflow:{tasks:true}}:{events:[],cursor:101});
 const state=await observer.poll();
 assert.deepEqual(state.snapshot.connections,connections);
});

test('Activity shows distinct lifecycle states and preserves handoffs and navigation',()=>{
 const statuses=[['queued','Queued task'],['running','Running task'],['blocked','Blocked task'],['awaiting_review','Review task'],['accepted','Finished task'],['stopped','Stopped task']];
 const tasks=statuses.map(([status,objective],i)=>({...task,id:'lifecycle-'+i,status,objective}));
 const events=[{seq:42,at:1000,provenance:'coordinator',type:'work.control',summary:'Execution control recorded'}];
 const state={snapshot:{...snapshot,tasks},goalId:goal.id,events};
 for(const [width,height] of [[90,32],[24,18]]){
  const frame=renderTerminal(state,{view:'activity',interactive:true,width,height});
  assert.match(frame,/Activity/);
  assert.match(frame,/Queued/);
  assert.match(frame,/Running/);
  assert.match(frame,/Blocked/);
  assert.match(frame,/Needs review/);
  assert.match(frame,/Completed/);
  assert.match(frame,/Stopped/);
  assert.match(frame,/Handoff feed/);
  assert.ok(frame.split('\n').length<=height);
  assert.ok(frame.split('\n').every(line=>[...line].length<=width));
  assert.match(frame.split('\n').at(-1),/q/);
 }
 assert.match(renderTerminal(state,{view:'activity',interactive:true,width:90,height:32}),/Execution control recorded/);
 assert.match(renderTerminal({snapshot:{...snapshot,goals:[]},events:[]},{view:'activity'}),/No saved goals/);
 const uncertain=renderTerminal({...state,snapshot:{...snapshot,tasks:[native],agents:[]}},{view:'activity',interactive:true,color:true,width:90,height:24});
 assert.match(uncertain,/\x1b\[33mNative owner · activity unknown\x1b\[0m/);
});

test('Connections actions guide users to existing commands without invoking them',async()=>{
 const input=new EventEmitter();input.isTTY=true;input.isRaw=false;
 input.setRawMode=value=>{input.isRaw=value;};input.resume=()=>{};input.pause=()=>{};
 const {promise:ready,resolve:firstFrame}=Promise.withResolvers();
 const frames=[];
 const output={isTTY:true,columns:24,rows:14,write(value){if(value.includes('Mosaic Beta')){frames.push(stripVTControlCharacters(value));firstFrame();}}};
 const calls=[];
 const invoke=async name=>{calls.push(name);return name==='observer_snapshot'?snapshot:{events:[],cursor:101,hasMore:false};};
 const pending=runObserver({input,output,invoke,pollMs:1000,noColor:false});
 const press=name=>input.emit('keypress',name,{name});
 try{
  await ready;
  press('c');
  assert.match(frames.at(-1),/Connections/);
  assert.match(frames.at(-1).split('\n').at(-1),/e.*h.*q/);
  press('e');
  assert.match(frames.at(-1),/Edit setup/);
  assert.match(frames.at(-1),/mosaic setup/);
  press('escape');
  press('h');
  assert.match(frames.at(-1),/Connection help/);
  assert.match(frames.at(-1),/mosaic connect/);
  press('escape');
  press('v');
  assert.match(frames.at(-1),/Activity/);
  press('escape');
  assert.doesNotMatch(frames.at(-1),/^(Connections|Activity)$/m);
  assert.ok(calls.every(name=>['observer_snapshot','observer_timeline'].includes(name)));
 }finally{press('q');await pending;}
});

test('narrow plain observer strips terminal injection and distinguishes running actors from waiting reviewer',()=>{
 const terminal=renderTerminal({snapshot,goalId:goal.id,events:[]},{width:31,height:60,color:false});
 assert.match(terminal,/Fixture Model/);
 assert.match(terminal,/Codex/);
 assert.match(terminal,/Waiting for checks/i);
 assert.match(terminal,/captured/);
 assert.match(terminal,/reported/);
 assert.doesNotMatch(terminal,/\x1b|injection/);
 assert.ok(terminal.split('\n').every(line=>line.length<=31));
 const workerOnly=renderTerminal({snapshot:{...snapshot,goals:[{...goal,mode:'deepseek_only'}],tasks:[task]},goalId:goal.id,events:[]},{width:70,height:40});
 assert.doesNotMatch(workerOnly,/Reviewer/);
 const failed=renderTerminal({snapshot:{...snapshot,tasks:[{...task,status:'blocked',outcome:{checks:{passed:0,total:1}}}]},goalId:goal.id,events:[]},{width:70,height:40,color:false});
 assert.match(failed,/checks failed/i);
});

test('observer reopens recent history, deduplicates by sequence and reconnects with its durable cursor',async ()=>{
 let connected=true;
 const event=seq=>({seq,goalId:goal.id,type:'goal.activated',summary:'Event '+seq,provenance:'coordinator',at:seq});
 const requests=[];
 const observer=new TerminalObserver(async(name,input)=>{
  requests.push([name,input]);
  if(!connected)throw Error('unavailable');
  if(name==='observer_snapshot')return snapshot;
  if(name==='observer_timeline')return {events:[event(100),event(101)],cursor:101,hasMore:false};
  assert.fail('unexpected endpoint');
 });
 await observer.poll();
 assert.deepEqual(observer.state.events.map(e=>e.seq),[100,101]);
 connected=false;
 await observer.poll();
 assert.equal(observer.state.stale,true);
 assert.equal(observer.state.snapshot.goals[0].id,goal.id);
 connected=true;
 await observer.poll();
 assert.equal(observer.state.stale,false);
 assert.deepEqual(observer.state.events.map(e=>e.seq),[100,101]);
 assert.equal(requests.at(-1)[1].after,101);
});

test('observer snapshot exposes real reviewer reservations and provider attribution',t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'mosaic-beta-observe-'));
 const workerProfile={displayName:'Fixture Model',baseUrl:'https://provider.example/v1',model:'custom',revision:'revision-a',streaming:false};
 const c=new Coordinator({root,beta:true,workerProfile});
 t.after(()=>{c.close();rmSync(root,{force:true,recursive:true});});
 const g=savedBetaGoal(c,{submissionId:'g',objective:'Build',acceptance:['Evidence']});
 c.activateGoal({goalId:g.id,hash:g.hash},'activate');
 const assignment=c.submitTask({goalId:g.id,submissionId:'a',kind:'consult',objective:'Answer',acceptance:['Evidence']},'submit');
 const reservation=c.reserveReviewer({taskId:assignment.id},'reserve');
 const state=new Observer({c}).snapshot({goalId:g.id});
 assert.equal(state.tasks[0].workerProfile.displayName,'Fixture Model');
 assert.ok(state.reviewers.some(r=>r.id===reservation.id&&r.status==='reserved'));
});

test('q restores the TTY and leaves its input usable',async ()=>{
 const input=new EventEmitter();
 input.isTTY=true;
 input.isRaw=false;
 input.setRawMode=value=>{input.isRaw=value;};
 input.resume=()=>{};
 input.pause=()=>{};
 const output={isTTY:true,columns:80,rows:30,content:'',write(s){this.content+=s;}};
 const pending=runObserver({input,output,noColor:false,invoke:async name=>name==='observer_snapshot'?snapshot:{events:[],cursor:101},pollMs:10});
 await new Promise(resolve=>setImmediate(resolve));
 input.emit('keypress','q',{name:'q'});
 await pending;
 assert.equal(input.isRaw,false);
 assert.match(output.content,/\x1b\[\?25h/);
 assert.equal(input.listenerCount('keypress'),0);
});

test('switching coordinators closes old evidence and ignores a late reply',async ()=>{
 const input=new EventEmitter();
 input.isTTY=true;input.isRaw=false;input.setRawMode=value=>{input.isRaw=value;};input.resume=()=>{};input.pause=()=>{};
 let source='core',finishEvidence,firstFrame,secondFrame,evidenceStarted;
 const first=new Promise(resolve=>{firstFrame=resolve;}),second=new Promise(resolve=>{secondFrame=resolve;});
 const started=new Promise(resolve=>{evidenceStarted=resolve;});
 const frames=[];
 const output={isTTY:true,columns:100,rows:30,write(value){
  if(!value.includes('Mosaic Beta'))return;
  frames.push(value);
  if(value.includes('Watching core'))firstFrame();
  if(value.includes('Watching beta'))secondFrame();
 }};
 const invoke=async name=>{
  if(name==='observer_snapshot')return {...snapshot,source,sourceLabel:source};
  if(name==='observer_evidence'){evidenceStarted();return new Promise(resolve=>{finishEvidence=resolve;});}
  return {events:[],cursor:101,hasMore:false};
 };
 const running=runObserver({input,output,invoke,noColor:false,pollMs:1});
 try{
  await first;input.emit('keypress','\r',{name:'return'});await started;
  source='beta';await second;
  finishEvidence({text:'Evidence from the old coordinator',provenance:'saved'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.doesNotMatch(frames.at(-1),/Saved evidence|Evidence from the old coordinator|Loading saved evidence/);
 }finally{input.emit('keypress','q',{name:'q'});await running;}
});

test('native reports describe activity and reserved reviewers wait for actual work',()=>{
 const state={snapshot:{...snapshot,agents:[{...snapshot.agents[0],lastReport:{status:'waiting',at:1000}}],
  reviewers:[{id:'review-1',taskId:task.id,goalId:goal.id,status:'reserved',at:1001}]},goalId:goal.id,events:[]};
 const rows=actorRows(state);
 assert.equal(rows.find(row=>row.id===native.id).status,'Waiting');
 assert.equal(rows.find(row=>row.id==='review-'+task.id).state,'waiting');
 const silent=actorRows({...state,snapshot:{...state.snapshot,agents:[]}});
 assert.equal(silent.find(row=>row.id===native.id).status,'Native owner · activity unknown');
});

test('q and Ctrl-C end the actual observer process on a macOS pseudoterminal', {skip:process.platform!=='darwin'},()=>{
 const url=new URL('../src/beta/observer.mjs',import.meta.url).href;
 const code=`import {runObserver} from ${JSON.stringify(url)}; await runObserver({noColor:false,invoke:async()=>({goals:[],tasks:[],cursor:0})});`;
 const pty=`
import os, pty, select, signal, sys, time
key, node, code = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execv(node, [node, '--input-type=module', '-e', code])
output, sent = b'', False
end = time.monotonic() + 2
while time.monotonic() < end:
    if select.select([fd], [], [], 0.1)[0]:
        try:
            output += os.read(fd, 4096)
        except OSError:
            pass
        if not sent and b'\\x1b[?25l' in output:
            os.write(fd, bytes.fromhex(key))
            sent = True
    child, status = os.waitpid(pid, os.WNOHANG)
    if child:
        sys.stdout.buffer.write(output)
        sys.exit(os.waitstatus_to_exitcode(status))
os.kill(pid, signal.SIGKILL)
os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
sys.exit(9)
`;
 for(const key of ['71','03']){
  const result=spawnSync('python3',['-c',pty,key,process.execPath,code],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,'observer quit while PTY input was still open: '+result.stderr);
  assert.match(result.stdout,/\x1b\[\?25h/);
 }
});

test('narrow screen preserves the selected assignment and saved handoff',()=>{
 const narrowGoal={...goal,id:'7a40b167-97c6-4b0c-abb3-0105e00c21ab',objective:'Check the fixture goal'};
 const row={...task,goalId:narrowGoal.id,objective:'Selected assignment'};
 const event={seq:1,at:Date.now(),provenance:'coordinator',summary:'Saved handoff'};
 const output=renderTerminal({snapshot:{goals:[narrowGoal],tasks:[row]},goalId:narrowGoal.id,events:[event]},{width:20,height:10,interactive:true});
 assert.match(output,/Fixture Model/);
 assert.match(output,/Running/);
 assert.match(output,/Selected assignment/);
 assert.match(output,/Handoff feed/);
 assert.match(output,/Saved handoff/);
 assert.ok(output.split('\n').length<=10);
 assert.ok(output.split('\n').every(line=>line.length<=20));
});

test('saved check outcomes survive later checkpoints and an accepted task retires reviewer reports',t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'mosaic-beta-check-state-'));
 const workerProfile={displayName:'Fixture Model',baseUrl:'https://provider.example/v1',model:'custom',revision:'revision-a',streaming:false};
 const c=new Coordinator({root,beta:true,workerProfile});
 t.after(()=>{c.close();rmSync(root,{force:true,recursive:true});});
 const g=savedBetaGoal(c,{submissionId:'g',objective:'Build',acceptance:['Evidence'],project:{repo:root,baseCommit:'a'.repeat(40),readPaths:['src/'],writePaths:['src/'],checks:[{id:'verify',argv:['/bin/true']}]}});
 c.activateGoal({goalId:g.id,hash:g.hash},'activate');
 const assignment=c.submitTask({goalId:g.id,submissionId:'a',kind:'coding',objective:'Implement',acceptance:['Evidence']},'submit');
 c.claimNext('owner');
 c.emit('coding.checks.failed',g.id,assignment.id,{actor:'deepseek',provenance:'captured',checks:[{id:'verify',passed:false}]});
 c.emit('execution.checkpoint',g.id,assignment.id,{actor:'deepseek',provenance:'captured',phase:'attempt'});
 const saved=c.getTask(assignment.id);
 saved.status='blocked';saved.owner=null;c.store.put('task',saved);
 const observer=new Observer({c}),blocked=observer.snapshot({goalId:g.id});
 assert.match(actorRows({snapshot:blocked,goalId:g.id}).find(row=>row.id===saved.id).status,/checks failed/i);
 c.store.put('agent',{id:'review-agent',goalId:g.id,taskId:saved.id,actor:'codex',role:'reviewer',lastReport:{status:'running',at:Date.now()}});
 saved.status='accepted';c.store.put('task',saved);
 assert.ok(!actorRows({snapshot:observer.snapshot({goalId:g.id}),goalId:g.id}).some(row=>row.role==='Reviewer'));
});

test('a 50×24 interactive terminal shows concurrent worker and native assignments',()=>{
 const events=[{seq:1,at:Date.now(),provenance:'coordinator',summary:'Saved handoff'}];
 const output=renderTerminal({snapshot,goalId:goal.id,events},{width:50,height:24,interactive:true});
 assert.match(output,/Fixture Model/);
 assert.match(output,/Run protected checks/);
 assert.match(output,/Codex/);
 assert.match(output,/Independent implementation/);
 assert.match(output,/captured/);
 assert.match(output,/reported/);
 assert.match(output,/Saved handoff/);
 assert.ok(output.split('\n').length<=24);
 assert.ok(output.split('\n').every(line=>line.length<=50));
});

test('styled desktop sizes retain the selected status, newest handoff and quit control',()=>{
 const events=Array.from({length:20},(_,n)=>({seq:n,at:Date.now(),provenance:'captured',summary:n===19?'Newest handoff':'Older saved event'}));
 for(const width of [55,80,110]){
  const output=stripVTControlCharacters(renderTerminal({snapshot,goalId:goal.id,events},{width,height:30,color:true,interactive:true,selected:1}));
  assert.match(output,/Codex/);
  assert.match(output,/Running/);
  assert.match(output,/Newest handoff/);
  assert.match(output.split('\n').at(-1),/q quit/);
  assert.equal(output.split('\n').length,30);
  assert.ok(output.split('\n').every(line=>[...line].length<=width));
 }
});

test('a tight styled frame keeps the newest handoff when only one feed line fits',()=>{
 const g={...goal,objective:'A long objective describing the full application being built and its remaining work'};
 const t={...native,objective:'A long assignment describing the interface implementation and remaining checks'};
 const state={snapshot:{...snapshot,sourceLabel:'Mosaic core (frontier-harness)',sourceHint:'Other saved goals: mosaic --source beta',goals:[g],tasks:[t],agents:[]},
  goalId:g.id,stale:true,historyPending:true,events:[{seq:1,at:Date.now(),provenance:'captured',summary:'Newest handoff with enough detail to wrap onto a second line'}]};
 const output=stripVTControlCharacters(renderTerminal(state,{width:55,height:24,interactive:true,color:true}));
 assert.match(output,/Newest handoff/);
 assert.match(output,/Disconnected/);
 assert.match(output,/activity unknown/);
 assert.match(output,/q quit/);
});

test('goal picker bounds long rows and keeps the selected goal visible across viewport sizes',()=>{
 const goals=Array.from({length:25},(_,i)=>({...goal,id:`goal-${i}`,objective:`Project ${i}: `+'Long instructions for the assignment. '.repeat(20),status:i%2?'completed':'active'}));
 for(const [width,height] of [[20,10],[55,24],[80,30],[160,50]])for(const picker of [0,12,24]){
  const output=stripVTControlCharacters(renderTerminal({snapshot:{...snapshot,goals},events:[]},{width,height,picker,color:true,interactive:true}));
  assert.match(output,new RegExp(`Project ${picker}`));
  assert.match(output,new RegExp(`${picker+1}/25`));
  assert.ok(output.split('\n').length<=height);
  assert.ok(output.split('\n').every(line=>[...line].length<=width));
  assert.match(output.split('\n').at(-1),/q/);
  if(width>=55){assert.match(output,/Selected goal/);assert.match(output,new RegExp(`ID: goal-${picker}\\b`));}
 }
});

test('goal details show the full objective and Escape returns to the picker',async ()=>{
 const input=new EventEmitter();input.isTTY=true;input.isRaw=false;
 input.setRawMode=value=>{input.isRaw=value;};input.resume=()=>{};input.pause=()=>{};
 let firstFrame;
 const ready=new Promise(resolve=>{firstFrame=resolve;});
 const frames=[];
 const output={isTTY:true,columns:80,rows:30,write(value){if(value.includes('Mosaic Beta')){frames.push(stripVTControlCharacters(value));firstFrame();}}};
 const invoke=async name=>name==='observer_snapshot'?snapshot:{events:[],cursor:101,hasMore:false};
 const pending=runObserver({input,output,invoke,noColor:false,pollMs:1000});
 try{
  await ready;
  input.emit('keypress','g',{name:'g'});
  input.emit('keypress','d',{name:'d'});
  assert.match(frames.at(-1),/Goal details/);
  assert.match(frames.at(-1),/goal-1/);
  input.emit('keypress',null,{name:'escape'});
  assert.match(frames.at(-1),/Choose a goal/);
  input.emit('keypress','\r',{name:'return'});
  assert.doesNotMatch(frames.at(-1),/Choose a goal/);
 }finally{input.emit('keypress','q',{name:'q'});await pending;}
});

test('a jumps to the current project from main, picker and details without dispatch',async ()=>{
 for(const keys of [[],['g'],['g','d']]){
  const input=new EventEmitter();input.isTTY=true;input.isRaw=false;
  input.setRawMode=v=>{input.isRaw=v;};input.resume=()=>{};input.pause=()=>{};
  let first,jumped;const ready=new Promise(r=>{first=r;}),current=new Promise(r=>{jumped=r;});
  const fresh={...goal,id:'recent-goal',objective:'Most recent project',status:'completed'};
  const frames=[];const output={isTTY:true,columns:80,rows:30,write(value){if(value.includes('Mosaic Beta')){frames.push(stripVTControlCharacters(value));first();if(value.includes('No work currently running'))jumped();}}};
  const invoke=async name=>{assert.ok(['observer_snapshot','observer_timeline'].includes(name));return name==='observer_snapshot'?{...snapshot,goals:[goal,fresh]}:{events:[],cursor:101,hasMore:false};};
  invoke.current=async()=>({snapshot:{...snapshot,goals:[goal,fresh]},goalId:fresh.id,notice:'No work currently running · most recent project'});
  const pending=runObserver({input,output,invoke,noColor:false,pollMs:1});
  try{
   await ready;for(const key of keys)input.emit('keypress',key,{name:key});
   input.emit('keypress','a',{name:'a'});await current;
   assert.match(frames.at(-1),/Most recent project/);assert.doesNotMatch(frames.at(-1),/Choose a goal|Goal details/);
  }finally{input.emit('keypress','q',{name:'q'});await pending;}
 }
});

test('passing native candidate checks take precedence over a historical worker check failure',t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'mosaic-beta-native-check-'));
 let at=1000;
 const workerProfile={displayName:'Fixture Model',baseUrl:'https://provider.example/v1',model:'custom',revision:'revision-a',streaming:false};
 const c=new Coordinator({root,beta:true,workerProfile,now:()=>at});
 t.after(()=>{c.close();rmSync(root,{force:true,recursive:true});});
 const g=savedBetaGoal(c,{submissionId:'g',objective:'Build',acceptance:['Evidence'],project:{repo:root,baseCommit:'a'.repeat(40),readPaths:['src/'],writePaths:['src/'],checks:[{id:'verify',argv:['/bin/true']}]}});
 c.activateGoal({goalId:g.id,hash:g.hash},'activate');
 const assignment=c.submitTask({goalId:g.id,submissionId:'a',kind:'coding',objective:'Implement',acceptance:['Evidence']},'submit');
 c.claimNext('owner');
 c.emit('coding.checks.failed',g.id,assignment.id,{actor:'deepseek',provenance:'captured',checks:[{id:'verify',passed:false}]});
 const saved=c.getTask(assignment.id);
 at=2000;
 saved.status='awaiting_review';
 saved.owner=null;
 saved.executionActor='codex';
 saved.result={summary:'Passing native takeover',checks:[{id:'verify',passed:true}]};
 c.store.put('task',saved);
 c.emit('task.native_finished',g.id,assignment.id,{status:saved.status});
 const observer=new Observer({c}),current=observer.snapshot({goalId:g.id});
 assert.deepEqual(current.tasks[0].outcome.checks,{passed:1,total:1});
 assert.equal(current.tasks[0].lastCheck.status,'failed');
 const reviewer=actorRows({snapshot:current,goalId:g.id}).find(row=>row.role==='Reviewer');
 assert.deepEqual({status:reviewer.status,state:reviewer.state,at:reviewer.at},{status:'Waiting in Codex',state:'waiting',at:2000});
 assert.ok(observer.timeline({goalId:g.id}).events.some(event=>event.type==='coding.checks.failed'));
});

test('manual navigation cancels a pending current jump and ignores its late result',async()=>{
 let finish,lookupSignal;
 const invoke=async(name)=>name==='observer_snapshot'?snapshot:{events:[],cursor:101,hasMore:false};
 invoke.current=signal=>{lookupSignal=signal;return new Promise(resolve=>{finish=resolve;});};
 const observer=new TerminalObserver(invoke);
 await observer.poll();observer.requestCurrent();
 const pending=observer.poll();
 observer.select('manual-selection');
 assert.equal(lookupSignal.aborted,true);
 finish({snapshot,goalId:goal.id,notice:'Current project · working now'});
 await pending;
 assert.equal(observer.state.goalId,'manual-selection');
 assert.equal(observer.state.currentNotice,null);
 assert.equal(observer.state.stale,false);
});
