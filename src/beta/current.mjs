const time=value=>Number.isFinite(value)?value:0;
const live=(deadline,now)=>!Number.isFinite(deadline)||deadline>now;
const fresh=(agent,now)=>agent&&!agent.stale&&time(agent.lastReport?.at)>now-120000&&time(agent.lastReport?.at)<=now+5000;
export const currentRank=choice=>({running:2,unknown:1,recent:1,empty:0}[choice.kind]);

// Saved state alone is not evidence of live native work. Deadline expiry and
// coordinator housekeeping must not make an abandoned goal look current.
export function chooseCurrent(snapshot,activity=new Map(),now=Date.now()){
 const choices=(snapshot.goals??[]).map(goal=>{
  const tasks=(snapshot.tasks??[]).filter(t=>t.goalId===goal.id);
  const agents=(snapshot.agents??[]).filter(a=>a.goalId===goal.id);
  const planning=(snapshot.planning??[]).filter(p=>p.goalId===goal.id);
  let running=false,unknown=false;
  if(goal.status==='active'&&live(goal.deadline,now))for(const task of tasks){
   if(!live(task.deadline,now))continue;
   if(['running','legacy_reviewing'].includes(task.status))running=true;
   if(task.status==='codex_active'){
    const reports=agents.filter(a=>a.taskId===task.id&&a.role!=='reviewer').sort((a,b)=>time(b.lastReport?.at)-time(a.lastReport?.at));
    const report=reports[0];
    if(fresh(report,now)&&report.lastReport.status==='running')running=true;
    else if(!fresh(report,now))unknown=true;
   }
   if(task.status==='awaiting_review'){
    const reservation=(snapshot.reviewers??[]).find(r=>r.goalId===goal.id&&r.taskId===task.id&&r.status==='reserved');
    const report=reservation&&agents.filter(a=>a.taskId===task.id&&a.role==='reviewer'&&a.lastReport?.at>=reservation.at).sort((a,b)=>b.lastReport.at-a.lastReport.at)[0];
    if(report?.lastReport.status==='running'){
     if(fresh(report,now))running=true;else unknown=true;
    }
   }
  }
  if(['active','draft'].includes(goal.status)&&live(goal.deadline,now)&&planning.some(p=>p.status==='running'))running=true;
  const at=Math.max(time(activity.get(goal.id)),...tasks.map(t=>time(t.lastActivityAt)),...agents.map(a=>time(a.lastReport?.at)),...planning.map(p=>time(p.at)));
  return {goalId:goal.id,kind:running?'running':unknown?'unknown':'recent',at};
 });
 choices.sort((a,b)=>currentRank(b)-currentRank(a)||b.at-a.at);
 return {...(choices[0]??{goalId:null,kind:'empty',at:0}),unconfirmed:choices.some(c=>c.kind==='unknown')};
}

export async function currentHistory(invoke,snapshot,history,signal){
 if(snapshot.cursor<history.cursor){history.cursor=0;history.activity.clear();}
 const remember=({goalId,at})=>history.activity.set(goalId,Math.max(history.activity.get(goalId)??0,time(at)));
 const tools=await invoke('tools_list',{},signal);
 signal?.throwIfAborted();
 if(tools.some(tool=>tool.name==='observer_current_activity')){
  const result=await invoke('observer_current_activity',{after:history.cursor},signal);
  signal?.throwIfAborted();
  for(const item of result.activity)remember(item);
  history.cursor=Math.max(history.cursor,result.cursor);
  return !result.hasMore;
 }
 let complete=false;
 // Bound old coordinators' chronological API. Repeated shortcuts continue
 // from the saved cursor, and incomplete history is disclosed to the viewer.
 for(let page=0;page<32;page++){
  const result=await invoke('observer_timeline',{after:history.cursor,limit:200},signal);
  signal?.throwIfAborted();
  for(const event of result.events){
   if(!event.goalId||['task.expired','goal.expired'].includes(event.type))continue;
   remember(event);
  }
  const advanced=result.cursor>history.cursor;history.cursor=Math.max(history.cursor,result.cursor);
  if(!result.hasMore){complete=true;break;}
  if(!advanced)break;
 }
 return complete;
}
