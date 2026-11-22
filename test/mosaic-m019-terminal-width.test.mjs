import test from 'node:test';
import assert from 'node:assert/strict';
import {stripVTControlCharacters} from 'node:util';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {renderTerminal} from '../src/beta/observer.mjs';
import {consoleCells,matrix} from './fixtures/mosaic-m019-terminal-width/console-width.mjs';

function state(text){
 const goal={id:'goal',objective:text,status:'active',mode:'codex_only'};
 return {snapshot:{goals:[goal],tasks:[],agents:[],reviewers:[]},goalId:'goal',events:[]};
}
function bounded(frame,width,height){
 const rows=stripVTControlCharacters(frame).split('\n');
 assert.ok(rows.length<=height,`height ${rows.length} > ${height}`);
 for(const row of rows)assert.ok(consoleCells(row)<=width,`${consoleCells(row)} > ${width} cells: ${JSON.stringify(row)}`);
}

test('public Console.table padding declares the measured Node width matrix',()=>{
 for(const [name,text,want] of matrix)assert.equal(consoleCells(text),want,name);
});

test('sixty fullwidth U+FF21 characters fit the declared twenty-cell plain frame',()=>{
 const frame=renderTerminal(state('Ａ'.repeat(60)),{width:20,height:20,color:false,interactive:false});
 bounded(frame,20,20);
 assert.ok(frame.includes('Ａ'.repeat(10)),'the objective remains visible');
});

test('mixed-width word remainders stay within the same measured contract',()=>{
 const text='a ＡＡＡＡＡ ＡＡＡＡＡ ＡＡＡＡＡ a 界界界界界 end';
 bounded(renderTerminal(state(text),{width:20,height:40}),20,40);
});

for(const [name,text] of matrix){
 test(`measured ${name} specimen stays bounded in wrapping, compact and polished views`,()=>{
  const s=state((text+' ').repeat(30));
  for(const [width,height] of [[8,20],[20,20],[55,30],[80,36]]){
   for(const interactive of [false,true])bounded(renderTerminal(s,{width,height,interactive}),width,height);
  }
 });
}


test('declared graphemes fill measured rows without splitting accents or sequences',()=>{
 for(const [name,text,perRow] of [['accent','e\u0301',20],['halfwidth','ｶ',20],['text pictograph','☀️',20],['Hangul','가',10],['ZWJ','👩‍💻',5],['flag','🇺🇸',5],['family','👨‍👩‍👧‍👦',2]]){
  const frame=renderTerminal(state('Goal'),{width:20,height:30,detail:text.repeat(perRow*2),detailTitle:'Evidence'});
  bounded(frame,20,30);
  assert.ok(frame.split('\n').includes(text.repeat(perRow)),name+' fills a measured row');
 }
});

function populated(text){
 const s=state(text),goal=s.snapshot.goals[0];
 goal.id='Ａ'.repeat(8);s.goalId=goal.id;goal.workerProfile={displayName:'Worker '+text};
 s.snapshot.tasks=Array.from({length:5},(_,i)=>({id:'t'+i,goalId:goal.id,actor:'deepseek',kind:'consult',objective:i===4?'Selected '+text:'Assignment '+text,status:'running',lastActivityAt:Date.now(),provenance:'captured'}));
 s.events=[{seq:1,at:Date.now(),provenance:'Ａ'.repeat(15),summary:'Saved '+text,actor:'codex'}];
 return s;
}

test('picker padding, actor badges and feed prefixes share measured cell widths',()=>{
 for(const text of ['Ａ！'.repeat(30),('e\u0301ｶ☀️👩‍💻🇺🇸 ').repeat(15)]){
  const s=populated(text);
  for(const [width,height] of [[8,10],[20,20],[55,24],[56,36],[80,50],[110,50]]){
   for(const color of [false,true]){
    for(const options of [{selected:4},{picker:0},{detail:text,detailTitle:text}])
     bounded(renderTerminal(s,{width,height,color,interactive:true,...options}),width,height);
   }
  }
 }
});

test('unrecognized wide goal status and workflow labels remain bounded',()=>{
 const s=populated('Ａ'.repeat(12));
 s.snapshot.goals[0].status='Ａ'.repeat(40);s.snapshot.goals[0].mode='！'.repeat(40);
 bounded(renderTerminal(s,{width:55,height:36,interactive:true}),55,36);
});

test('control, OSC, ANSI and bidi input stays inert before measurement in every view',()=>{
 const hostile='Ａ'.repeat(18)+'\x1b]52;c;PAYLOAD\x07'+'\x1b[2J'+'\x1b[31mBAD\x1b[0m'+'\u009d52;c;C1PAYLOAD\x07'+'\x1b]unfinished'+'\u202e\u2066';
 const s=populated(hostile);s.currentNotice=hostile;s.snapshot.sourceLabel=hostile;s.snapshot.sourceHint=hostile;
 s.snapshot.connections={host:{id:'cursor',lastConnection:null},worker:{displayName:hostile,lastConnection:null}};
 for(const [width,height] of [[8,20],[20,20],[55,36],[80,50]]){
  for(const color of [false,true]){
   for(const options of [{interactive:false},{interactive:true,selected:4},{interactive:true,picker:0},{interactive:true,detail:hostile,detailTitle:hostile},{interactive:true,view:'connections'},{interactive:true,view:'activity'}]){
    const frame=renderTerminal(s,{width,height,color,...options}),plain=stripVTControlCharacters(frame);
    bounded(frame,width,height);
    assert.doesNotMatch(plain,/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]|PAYLOAD|unfinished/u);
    assert.doesNotMatch(frame.replace(/\x1b\[[0-9;]*m/gu,''),/\x1b/u,'only renderer SGR escapes survive');
   }
  }
 }
});


test('a cluster wider than its entire column uses a bounded replacement',()=>{
 const frame=renderTerminal(state('Goal'),{width:20,height:20,detail:'क्'.repeat(40),detailTitle:'Evidence'});
 bounded(frame,20,20);
 assert.ok(frame.split('\n').includes('�'));
 const picker=renderTerminal(state('👨‍👩‍👧‍👦'),{width:8,height:10,interactive:true,picker:0});
 bounded(picker,8,10);
 assert.ok(picker.includes('�'));
});

test('word wrapping never removes a space that is the base of a combining grapheme',()=>{
 for(const suffix of ['\u0301','\ufe0f']){
  const text='a'.repeat(12)+' '+suffix+'b'.repeat(10);
  const frame=renderTerminal(state('Goal'),{width:20,height:20,detail:text,detailTitle:'Evidence'});
  bounded(frame,20,20);
  const rows=frame.split('\n'),body=rows.slice(rows.indexOf('Evidence')+1,rows.indexOf(''));
  assert.equal(body.join(''),text,'wrapped content retains the base and combining suffix');
  for(const line of body)assert.doesNotMatch(line,/^[\u0301\ufe0f]/u,'no detached suffix on a new line');
 }
});

for(const [name,key] of [['q','71'],['Ctrl-C','03']]){
 test(`owned PTY resize and ${name} preserve selection, handoff and terminal cleanup`,{skip:process.platform!=='darwin',timeout:20000},()=>{
  const driver=fileURLToPath(new URL('./fixtures/mosaic-m019-terminal-width/drive-pty.py',import.meta.url));
  const subject=fileURLToPath(new URL('./fixtures/mosaic-m019-terminal-width/observer-pty.mjs',import.meta.url));
  const child=spawnSync('python3',[driver,process.execPath,subject,key],{encoding:'utf8',timeout:17000,maxBuffer:3*1024*1024});
  assert.equal(child.status,0,child.stderr||String(child.error));
  const result=JSON.parse(child.stdout);
  assert.equal(result.exitCode,0);
  for(const field of ['rawDuringRun','rawRestored','termiosRestored','resizeRestored','sigintRestored','sigtermRestored','alternateEntered','alternateLeft','cursorRestored','ownedGroupAbsent'])assert.equal(result[field],true,field);
  assert.equal(result.keypressListeners,0);
  for(const frame of result.frames)bounded(frame.text,frame.width,frame.height);
  const narrow=result.frames.find(frame=>frame.width===20&&frame.height===10&&frame.text.includes('Selected'));
  assert.ok(narrow,'selected row survives resize');
  assert.match(stripVTControlCharacters(narrow.text),/Selected ＡＡ task/);
  assert.match(stripVTControlCharacters(narrow.text),/Saved ＡＡ handoff/);
 });
}
