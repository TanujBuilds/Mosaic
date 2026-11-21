import path from 'node:path';
import {client} from './client.mjs';
import {OBSERVER_TOOLS} from '../harness/observer.mjs';
import {entry} from './files.mjs';
import {chooseCurrent,currentHistory,currentRank} from './current.mjs';
import {readHostConnection} from './hosts/connection-evidence.mjs';

const labels={beta:'Mosaic Beta (mosaic-beta)',core:'Mosaic core (frontier-harness)'};
const rank=snapshot=>snapshot.goals.some(g=>g.status==='active')?2:snapshot.goals.length?1:0;

// The observer can read either installation; operator/MCP traffic stays bound
// to its original coordinator. Never use an operator credential for discovery.
export function observerClient(paths,{source='auto'}={}){
 if(!['auto','beta','core'].includes(source))throw Error('Observer source must be auto, beta or core');
 const clients={
  beta:client(paths,{viewer:true}),
  core:client({...paths,state:path.join(paths.home,'Library','Application Support','Mosaic','state')},{viewer:true})
 };
 const recentSupport=new Map();
 const histories=new Map();
 let pinned=false;
 let selected=source==='auto'?null:source;
 const decorate=async(id,snapshot,other=[])=>{
  const connections=snapshot.connections;
  const receipt=id==='beta'&&connections?.host?await readHostConnection(paths).catch(()=>null):null;
  return {...snapshot,source:id,sourceLabel:labels[id],
   ...(receipt&&receipt.hostId===connections.host.id?{
    connections:{...connections,host:{...connections.host,lastConnection:receipt}}
   }:{}),
   sourceHint:other.length?`Other saved goals: mosaic --source ${other[0]}`:null,
   goals:id==='core'?snapshot.goals.map(g=>({...g,workerProfile:g.workerProfile??{displayName:'DeepSeek'}})):snapshot.goals};
 };
 const invoke=async(name,input={},signal)=>{
  if(!OBSERVER_TOOLS.has(name))throw Error('Terminal observer has read-only access');
  if(name!=='observer_snapshot'||input.goalId){
   if(!selected)throw Error('Read an observer snapshot before requesting evidence');
   const id=selected,invoke=clients[id];
   if(name==='observer_timeline'&&input.recent){
    if(!recentSupport.has(id)){
     const tools=await invoke('tools_list',{},signal);
     recentSupport.set(id,!!tools.find(t=>t.name==='observer_timeline')?.inputSchema.properties.recent);
    }
    if(!recentSupport.get(id)){const {recent,...query}=input;input={...query,after:0};}
   }
   const result=await invoke(name,input,signal);
   return name==='observer_timeline'&&id==='core'?{...result,events:result.events.map(e=>e.actor==='deepseek'?{...e,displayName:e.displayName??'DeepSeek'}:e)}:result;
  }
  const names=source==='auto'?['beta','core']:[source];
  const results=await Promise.allSettled(names.map(id=>clients[id](name,input,signal)));
  const snapshots=new Map(results.flatMap((result,i)=>result.status==='fulfilled'?[[names[i],result.value]]:[]));
  // Preserve the last observed source on disconnect. An empty second service
  // must not turn a running or failed job into a misleading "idle" screen.
  if(selected&&!snapshots.has(selected))throw Error('Observed coordinator is disconnected');
  for(const id of names){
   if(snapshots.has(id)&&(!selected||!pinned&&rank(snapshots.get(id))>rank(snapshots.get(selected))))selected=id;
  }
  if(!selected)throw Error('No Mosaic observer is available. Run mosaic doctor.');
  const snapshot=snapshots.get(selected);
  const other=names.filter(id=>id!==selected&&snapshots.get(id)?.goals.length);
  return decorate(selected,snapshot,other);
 };
 invoke.current=async signal=>{
  const timeout=AbortSignal.timeout(10000),bounded=signal?AbortSignal.any([signal,timeout]):timeout;
  const names=source==='auto'?['beta','core']:[source];
  const results=await Promise.allSettled(names.map(async id=>{
   const state=id==='beta'?paths.state:path.join(paths.home,'Library','Application Support','Mosaic','state');
   if(!await entry(path.join(state,'viewer-connection.json')))return null;
   const snapshot=await clients[id]('observer_snapshot',{},bounded);
   let history=histories.get(id);if(!history){history={cursor:0,activity:new Map()};histories.set(id,history);}
   const complete=await currentHistory(clients[id],snapshot,history,bounded);
   return {id,snapshot,...chooseCurrent(snapshot,history.activity),incomplete:!complete||snapshot.overflow?.tasks||snapshot.goals.length>=snapshot.limits?.goals};
  }));
  bounded.throwIfAborted();
  const candidates=results.flatMap(r=>r.status==='fulfilled'&&r.value?[r.value]:[]);
  if(!candidates.length)throw Error('No coordinator is available');
  candidates.sort((a,b)=>currentRank(b)-currentRank(a)||b.at-a.at);
  const choice=candidates[0],uncertain=results.some(r=>r.status==='rejected')||candidates.some(c=>c.incomplete);
  let notice=choice.kind==='running'?'Current project · working now':choice.kind==='unknown'?'Current project · native activity is unconfirmed':choice.kind==='recent'?'No work currently running · most recent project':'No work currently running · no saved projects';
  if(choice.kind==='recent'&&candidates.some(c=>c.unconfirmed))notice='Most recent project · no confirmed running work; native activity is unconfirmed';
  if(uncertain)notice='Showing available activity · some service history is unavailable or still loading';
  const snapshot=await decorate(choice.id,choice.snapshot,candidates.filter(c=>c.id!==choice.id&&c.snapshot.goals.length).map(c=>c.id));
  bounded.throwIfAborted();
  selected=choice.id;pinned=true;
  return {...choice,notice,snapshot};
 };
 return invoke;
}
