import {emitKeypressEvents} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import {stripVTControlCharacters} from 'node:util';

const feedLimit=100;
const clean=value=>stripVTControlCharacters(String(value??''))
 .replace(/[\u001b\u0090\u0098\u009d\u009e\u009f][^\r\n]*/gu,'')
 .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,' ');
const localClock=new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const localDate=new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',year:'numeric'});
function clock(at){
 if(!Number.isFinite(at)||Math.abs(at)>8.64e15)return 'unknown';
 const date=new Date(at),time=localClock.format(date);
 return date.toDateString()===new Date().toDateString()?time:localDate.format(date)+' '+time;
}
const labels={waiting:'Waiting',running:'Running',codex_active:'Running',queued:'Queued',codex_ready:'Ready in Codex',awaiting_review:'Waiting for review',awaiting_legacy_review:'Waiting for review',legacy_reviewing:'Reviewing',awaiting_supervisor:'Waiting for Codex',awaiting_user:'Waiting for user',blocked:'Blocked',uncertain:'Unknown',accepted:'Accepted',ready_to_integrate:'Ready to integrate',completed:'Complete',stopped:'Stopped',partial:'Partial',failed:'Failed',cancelled:'Cancelled',draft:'Prepared',active:'Active',paused:'Paused'};
const status=value=>labels[value]??clean(value).replaceAll('_',' ');
const hostNames=new Map([['codex','Codex'],['claude-code','Claude Code'],['cursor','Cursor'],['antigravity','Antigravity']]);
const reviewModes={collaborative:'operator',codex_only:'operator',overnight_review:'legacy',deepseek_only:'checks'};
function goalFor(state){
 return state.snapshot?.goals.find(g=>g.id===state.goalId)??state.snapshot?.goals.find(g=>g.status==='active')??state.snapshot?.goals[0];
}

const candidateReady=new Set(['awaiting_review','awaiting_legacy_review','legacy_reviewing','ready_to_integrate','accepted']);
function checksFailed(task){
 const checks=task.outcome?.checks;
 if(task.actor==='codex'||checks&&candidateReady.has(task.status))return !!checks&&checks.passed<checks.total;
 if(task.lastCheck)return task.lastCheck.status==='failed';
 return !!checks&&checks.passed<checks.total;
}
const reviewComplete=new Set(['accepted','failed','partial','cancelled','ready_to_integrate','stopped']);

export function actorRows(state){
 const goal=goalFor(state);
 if(!goal)return [];
 const {snapshot}=state,tasks=snapshot.tasks.filter(task=>task.goalId===goal.id),rows=[];
 const agents=(snapshot.agents??[]).filter(agent=>agent.goalId===goal.id);
 const workerName=goal.workerProfile?.displayName??'API worker';
 const hostName=hostNames.get(goal.hostId)??'Codex';
 const reviewPolicy=goal.reviewPolicy??reviewModes[goal.mode];
 for(const task of tasks){
  const native=task.actor==='codex',reports=agents.filter(agent=>agent.taskId===task.id&&agent.actor==='codex'&&agent.role!=='reviewer');
  const report=reports.filter(a=>a.lastReport).sort((a,b)=>b.lastReport.at-a.lastReport.at)[0];
  const captured=task.provenance==='captured';
  const nativeActive=native&&task.status==='codex_active',reported=report?.lastReport;
  const stateName=nativeActive?(reported&&!report.stale?reported.status:'uncertain'):task.status==='legacy_reviewing'?'awaiting_legacy_review':task.status;
  const wait=task.routingWait?.decision,worker=task.worker;
  const routeExplanation=worker?.routeExplanation??(worker?.routeProvenance==='legacy_binding'?'Pinned '+worker.providerId+' · historical routing reason unavailable':null)??wait?.explanation??null;
  rows.push({id:task.id,actor:native?hostName:worker?.bindingProvenance==='unverified'?'API worker · identity unverified':worker?.displayName??task.workerProfile?.displayName??(wait?.binding?'Selected '+wait.binding.providerId:workerName),role:report?.role==='explorer'?'Explorer':report?.role==='supervisor'?'Supervisor':'Implementer',assignment:task.objective,routeExplanation,
   status:checksFailed(task)&&task.status==='blocked'?'Checks failed':wait&&['queued','suspended'].includes(task.status)?'Waiting · '+String(wait.reasonCode).replaceAll('_',' '):nativeActive&&stateName==='uncertain'?'Native owner · activity unknown':status(stateName),
   state:stateName,at:reported?.at??task.lastActivityAt??task.updatedAt,evidence:task.evidenceRef,provenance:native?(reported?'reported':'coordinator'):captured?'captured':'coordinator'});
 }
 const planning=snapshot.planning?.find(p=>p.goalId===goal.id);
 if(planning&&planning.status!=='completed')rows.unshift({id:'planner',actor:workerName,role:'Planner',assignment:goal.objective,status:status(planning.status),state:planning.status,at:planning.at,provenance:'coordinator'});
 for(const task of tasks){
  if(goal.reviewSelection){
   const review=task.review;
   if(!review||review.status==='inactive')continue;
   const name=review.source==='host'?hostNames.get(review.hostId)??'Host · identity unknown':review.source==='api'?'API review · '+review.providerId:'Reviewer · identity unknown';
   const report=review.source==='host'&&review.status==='reserved'?agents.filter(a=>a.taskId===task.id&&a.role==='reviewer'&&a.hostId===review.hostId&&!a.stale&&a.lastReport?.at>=review.at).sort((a,b)=>b.lastReport.at-a.lastReport.at)[0]:null;
   const running=report?.lastReport.status==='running';
   const state=running?'running':report?.lastReport.status==='blocked'?'blocked':review.status==='reserved'&&review.source==='host'?'waiting':review.status;
   const text={waiting:'Waiting in '+name,reserved:'Reserved · waiting',checks:'Waiting for checks',blocked:'Review blocked',revision:'Revision requested',accepted:'Review accepted',integrated:'Integrated · review accepted',stale:'Stale review · waiting',unavailable:'Review evidence unavailable',expired:'Review reservation expired'};
   rows.push({id:'review-'+task.id,actor:name,role:'Reviewer',assignment:task.objective,at:report?.lastReport.at??review.at??task.updatedAt,evidence:task.evidenceRef,state,
    status:running?'Reviewing':report?.lastReport.status==='blocked'?'Reported blocked':text[review.status]??'Review state unknown',provenance:report?'reported':review.provenance});
   continue;
  }
  if(!['operator','legacy'].includes(reviewPolicy)||reviewComplete.has(task.status))continue;
  const awaiting=reviewPolicy==='operator'?task.status==='awaiting_review':['awaiting_legacy_review','legacy_reviewing'].includes(task.status);
  const reservation=awaiting?snapshot.reviewers?.find(r=>r.goalId===goal.id&&r.taskId===task.id&&r.status==='reserved'):null;
  const report=reservation?agents.find(a=>a.taskId===task.id&&a.role==='reviewer'&&!a.stale&&a.lastReport?.at>=reservation.at):null;
  const checking=task.kind==='coding'&&task.status==='running'&&task.phase==='checks';
  const failed=task.kind==='coding'&&checksFailed(task);
  if(!awaiting&&!checking&&!failed)continue;
  const reviewing=task.status==='legacy_reviewing'||report?.lastReport.status==='running';
  const heldByChecks=failed&&!checking&&!awaiting;
  rows.push({id:'review-'+task.id,actor:hostName,role:'Reviewer',assignment:task.objective,
   at:report?.lastReport.at??reservation?.at??(heldByChecks?task.lastCheck?.at:null)??task.updatedAt,evidence:task.evidenceRef,
   state:reviewing?'running':heldByChecks?'blocked':'waiting',
   status:reviewing?'Reviewing':checking?'Waiting for checks':heldByChecks?'Waiting · checks failed':reservation?'Reserved · waiting':'Waiting in '+hostName,
   provenance:report?'reported':'coordinator'});
 }
 return rows;
}

// A scoped display-cell model qualified against Node 24.22 Console.table padding.
// Emoji sequences retain grapheme boundaries but count their constituent cells;
// this deliberately does not promise the width used by every terminal emulator.
const graphemes=new Intl.Segmenter(undefined,{granularity:'grapheme'});
function cells(value){
 let width=0;
 for(const char of clean(value).normalize('NFC')){
  const code=char.codePointAt(0);
  if(/[\p{Nonspacing_Mark}\p{Enclosing_Mark}\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u.test(char)||code>=0x1160&&code<=0x11ff)continue;
  const wide=code>=0x1100&&code<=0x115f||code===0x2329||code===0x232a||
   code>=0x2e80&&code<=0xa4cf&&code!==0x303f||code>=0xac00&&code<=0xd7a3||
   code>=0xf900&&code<=0xfaff||code>=0xfe10&&code<=0xfe19||code>=0xfe30&&code<=0xfe6f||
   code>=0xff01&&code<=0xff60||code>=0xffe0&&code<=0xffe6||
   code>=0x1b000&&code<=0x1b2ff||code>=0x1f200&&code<=0x1f251||
   code>=0x20000&&code<=0x3fffd;
  width+=wide||/\p{Emoji_Presentation}/u.test(char)?2:1;
 }
 return width;
}
function lines(value,width){
 const result=[];
 let line='',columns=0;
 for(const {segment} of graphemes.segment(clean(value))){
  // An indivisible cluster may exceed even the entire available column.
  const char=cells(segment)>width?'�':segment,cell=cells(char);
  if(columns+cell>width&&line){
   let space=-1;
   for(const part of graphemes.segment(line))if(part.segment===' ')space=part.index;
   if(space>0&&cells(line.slice(0,space))>columns/2){
    result.push(line.slice(0,space));line=line.slice(space+1);columns=cells(line);
   }else{result.push(line);line='';columns=0;}
   if(columns+cell>width){result.push(line);line='';columns=0;}
  }
  line+=char;columns+=cell;
 }
 if(line||!result.length)result.push(line);
 return result;
}
function clip(value,size){
 if(size<1)return '';
 const wrapped=lines(value,size);
 return wrapped.length>1?(size===1?'':lines(value,size-1)[0].trimEnd())+'…':wrapped[0];
}
const pad=(value,size)=>{const text=clip(value,size);return text+' '.repeat(Math.max(0,size-cells(text)));};
const keysFor=(width,...options)=>options.find(value=>cells(value)<=width)??options.at(-1);
const accent=value=>'\x1b[36m'+value+'\x1b[0m';
const statusColor=(value,state)=>`\x1b[${['blocked','failed'].includes(state)?31:['running','active','accepted','codex_active','completed'].includes(state)?32:33}m${value}\x1b[0m`;

function eventText(event){
 const actor=event.actor==='deepseek'?event.displayName??'API worker':event.actor==='codex'?'Codex':'';
 const summary=String(event.summary??'');
 const legacyActor=event.actor==='deepseek'&&summary.startsWith('DeepSeek ');
 const text=legacyActor?actor+summary.slice('DeepSeek'.length):summary;
 return actor&&!legacyActor&&!text.startsWith(actor+' ')?actor+' · '+text:text;
}

function compactMain(state,goal,{width,height,color,selected,offset}){
 const first=value=>lines(value,width)[0];
 const heading=value=>color?accent(first(value)):first(value);
 const rows=actorRows(state),index=Math.max(0,Math.min(selected,rows.length-1));
 const frame=[heading('Mosaic Beta')];
 if(state.snapshot?.source)frame.push(first('Source: '+state.snapshot.source));
 if(state.stale)frame.push(first(state.snapshot?'Disconnected · stale':'Disconnected'));
 if(state.currentNotice)frame.push(first(state.currentNotice));
 if(goal){
  if(height>=8)frame.push(first(goal.objective));
  const end=Math.max(0,state.events.length-offset);
  if(rows.length){
   // Reserve the footer, feed heading and the newest visible event.
   const room=Math.max(1,height-frame.length-2-(end?1:0));
   const blocks=rows.map((row,rowIndex)=>{
    const marker=rowIndex===index?'› ':'  ';
    const joined=lines(`${marker}${row.actor} · ${row.status}`,width);
    const identity=joined.length===1?joined:[first(marker+row.actor),...lines(row.status,width)];
    const heading=color?identity.map(line=>statusColor(line,row.state)):identity;
    const detail=height>=18?[...(row.routeExplanation?[first('  '+row.routeExplanation)]:[]),first(`  ${row.provenance} · updated ${clock(row.at)}`)]:[];
    return [...heading,first(row.assignment),...detail];
   });
   let start=index,after=index+1,used=blocks[index].length;
   while(start>0&&used+blocks[start-1].length<=room)used+=blocks[--start].length;
   while(after<blocks.length&&used+blocks[after].length<=room)used+=blocks[after++].length;
   if(used>room)frame.push(...blocks[index].slice(0,room-1),first('› '+rows[index].assignment));
   else frame.push(...blocks.slice(start,after).flat());
  }else frame.push(first('Idle · no assignments'));
  frame.push(heading('Handoff feed'));
  if(state.historyPending)frame.push(first('Loading saved handoffs…'));
  const room=Math.max(0,height-frame.length-1);
  for(const event of state.events.slice(Math.max(0,end-room),end))
   frame.push(first(width>=42?`[${event.provenance}] ${eventText(event)}`:eventText(event)));
 }else if(!state.stale)frame.push(first('Idle · no goals'));
 const footer=first(keysFor(width,'↑↓ Enter a g c Connections v Activity q','↑↓ Enter a g c Conn v Act q','↑↓ ↵ a g c Conn v Act q','↑↓ Enter a g c v q','↑↓ a g c v q','a c v q'));
 return [...frame.slice(0,height-1),footer].join('\n');
}

function polishedMain(state,goal,{width,height,color,selected,offset}){
 const margin='  ',space=Math.min(104,width-4);
 const paint=(value,codes)=>color?`\x1b[${codes}m${value}\x1b[0m`:value;
 const quiet=value=>paint(value,'2'),bold=value=>paint(value,'1');
 const tone=(value,state)=>color?statusColor(value,state):value;
 const section=(title,aside='')=>bold(title)+quiet(' '+ '─'.repeat(Math.max(1,space-cells(title)-cells(aside)-2))+(aside?' '+aside:''));
 const out=[paint('▦','36')+' '+bold('Mosaic Beta')];
 if(state.snapshot?.sourceLabel)out.push(quiet(clip('Watching '+state.snapshot.sourceLabel,space)));
 if(state.snapshot?.sourceHint)out.push(quiet(clip(state.snapshot.sourceHint,space)));
 if(state.stale)out.push(tone(clip(state.snapshot?'Disconnected · last observed state is stale':'Disconnected · coordinator state unknown',space),'blocked'));
 if(state.currentNotice)out.push(...lines(state.currentNotice,space).slice(0,2).map(quiet));
 out.push(quiet('─'.repeat(space)),'');
 if(!goal){
  out.push(bold(state.stale?'Waiting for the coordinator':'Ready when you are'),'');
  out.push(...lines(state.stale?'Run mosaic doctor to check the connection.':
   'Start a Mosaic goal in your selected host. Agent activity and handoffs will appear here.',space));
 }else{
  const title=lines(goal.objective,space);
  out.push(...title.slice(0,2).map((line,i)=>bold(i===1&&title.length>2?clip(line+' …',space):line)));
  const modes={collaborative:'Collaborative',codex_only:'Codex only',deepseek_only:'API worker only',overnight_review:'Overnight review'};
  const badge='['+status(goal.status)+']',mode=modes[goal.mode]??clean(goal.mode);
  if(cells(badge)+2+cells(mode)<=space)out.push(tone(badge,goal.status)+'  '+quiet(mode));
  else out.push(...lines(badge,space).map(line=>tone(line,goal.status)),...lines(mode,space).map(quiet));
  out.push(quiet(clip('Goal '+goal.id,space)),'');
  const rows=actorRows(state),index=Math.max(0,Math.min(selected,rows.length-1));
  out.push(section('Agents',rows.length?`${index+1}/${rows.length}`:''));
  const blocks=rows.map((row,i)=>{
   const actor=clip(row.actor,Math.max(16,space-40)),left=(i===index?'› ':'  ')+actor+'  '+row.role;
   const badge='['+row.status+']',gap=space-cells(left)-cells(badge);
   const identity=(i===index?paint('› ','36'):'  ')+bold(actor)+'  '+quiet(row.role);
   const head=gap>=2?[identity+' '.repeat(gap)+tone(badge,row.state)]:[identity,...lines(badge,space-2).map(line=>'  '+tone(line,row.state))];
   const assignment=lines(row.assignment,space-2);
   return [...head,...assignment.slice(0,2).map((line,j)=>'  '+(j===1&&assignment.length>2?clip(line+' …',space-2):line)),
    ...(row.routeExplanation?['  '+quiet(clip(row.routeExplanation,space-2))]:[]),
    '  '+quiet(clip(`${row.provenance}  updated ${clock(row.at)}`,space-2))];
  });
  if(!blocks.length)out.push(quiet('No assignments recorded.'));
  else{
   const budget=Math.max(blocks[index].length,height-out.length-8);
   let start=index,end=index+1,used=blocks[index].length;
   while(start>0&&used+blocks[start-1].length+1<=budget){used+=blocks[--start].length+1;}
   while(end<blocks.length&&used+blocks[end].length+1<=budget){used+=blocks[end++].length+1;}
   out.push(...blocks.slice(start,end).flatMap((block,i)=>i?['',...block]:block));
  }
  out.push('',section('Handoff feed'));
  if(state.historyPending)out.push(quiet('Loading saved handoffs…'));
  const end=Math.max(0,state.events.length-offset),room=Math.max(0,height-out.length-3),feed=[];
  for(let i=end-1;i>=0;i--){
   const event=state.events[i],stamp=clock(event.at),provenance=clean(event.provenance??'coordinator');
   const prefix=stamp+'  '+pad(provenance,11)+'  ',text=lines(eventText(event),Math.max(8,space-cells(prefix)));
   const block=text.slice(0,2).map((line,n)=>(n?' '.repeat(cells(prefix)):quiet(prefix))+(n===1&&text.length>2?clip(line+' …',space-cells(prefix)):line));
   if(feed.length+block.length>room){
    if(!feed.length&&room)feed.push(quiet(prefix)+clip(eventText(event),Math.max(8,space-cells(prefix))));
    break;
   }
   feed.unshift(...block);
  }
  out.push(...(feed.length?feed:[quiet(clip(state.events.length?'No handoffs fit. Enlarge the terminal to see the feed.':'Waiting for the first handoff.',space))]).slice(0,room));
 }
 const keys=keysFor(space,'↑↓ select  Enter evidence  a current  g goals  c Connections  v Activity  [/] feed  q quit',
  '↑↓ Enter  a current  g goals  c Connections  v Activity  [/]  q quit','↑↓ Enter a current g goals c Conn v Act [/] q quit');
 const body=out.slice(0,height-3);
 while(body.length<height-3)body.push('');
 return [...body,'',quiet('─'.repeat(space)),quiet(clip(keys,space))].map(line=>margin+line).join('\n');
}

function polishedPicker(state,{width,height,color,picker}){
 const roomy=width>=55&&height>=24,margin=roomy?'  ':'',space=roomy?Math.min(104,width-4):width;
 const paint=(value,codes)=>color?`\x1b[${codes}m${value}\x1b[0m`:value;
 const quiet=value=>paint(value,'2'),bold=value=>paint(value,'1');
 const goals=state.snapshot?.goals??[],index=Math.max(0,Math.min(picker,goals.length-1)),goal=goals[index];
 const count=goals.length?`${index+1}/${goals.length}`:'0/0';
 const out=[bold(clip(roomy?'▦ Mosaic Beta':'Mosaic Beta',space))];
 if(height>=18&&state.snapshot?.sourceLabel)out.push(quiet(clip('Watching '+state.snapshot.sourceLabel,space)));
 if(state.stale)out.push(paint(clip('Disconnected · saved goals may be stale',space),'33'));
 if(roomy)out.push(quiet('─'.repeat(space)),'');
 out.push(space<count.length+4?quiet(count):bold(clip('Choose a goal',space-count.length-1))+' '+quiet(count));
 const preview=[];
 if(roomy&&goal){
  preview.push('',bold('Selected goal')+quiet('  ·  d for full details'));
  const objective=lines(goal.objective,space);
  preview.push(...objective.slice(0,3).map((line,i)=>i===2&&objective.length>3?clip(line+' …',space):line));
  preview.push(quiet(clip(`${status(goal.status)}  ·  ${String(goal.mode).replaceAll('_',' ')}  ·  ${goal.taskCount??0} assignments`,space)));
  preview.push(quiet(clip('ID: '+goal.id,space)));
 }else if(goal&&height>=8)out.push(quiet(clip(status(goal.status),space)));
 const footer=roomy?(space>=70?'↑↓ Enter open  a current  d details  [/] jump  Esc back  q quit':'↑↓ Enter  a current  d details  Esc back  q quit'):space>=20?'↑↓ Enter a d Esc q':space>=12?'↑↓ a d Esc q':'↑↓ a q';
 const tail=roomy?['',quiet('─'.repeat(space)),quiet(clip(footer,space))]:[quiet(clip(footer,space))];
 const titleWidth=space-24;
 if(roomy)out.push('',quiet('  '+pad('Goal',titleWidth)+'  '+pad('Status',10)+'  ID'));
 const capacity=Math.max(1,Math.min(roomy?12:100,height-out.length-preview.length-tail.length));
 const start=Math.max(0,Math.min(index-Math.floor(capacity/2),goals.length-capacity));
 for(const [i,g] of goals.slice(start,start+capacity).entries()){
  const chosen=i+start===index,marker=chosen?'› ':'  ',title=clip(g.objective,roomy?titleWidth:space-2);
  const identity=chosen?paint(marker+pad(title,roomy?titleWidth:space-2),'1;36'):marker+pad(title,roomy?titleWidth:space-2);
  out.push(roomy?identity+'  '+(color?statusColor(pad(status(g.status),10),g.status):pad(status(g.status),10))+'  '+quiet(clip(g.id,8)):identity);
 }
 if(!goals.length)out.push(quiet(clip('No saved goals yet.',space)));
 out.push(...preview);
 const body=out.slice(0,height-tail.length);
 while(body.length<height-tail.length)body.push('');
 return [...body,...tail].map(line=>margin+line).join('\n');
}

const connectionActions={
 e:{title:'Edit setup',command:'mosaic setup',details:'Review the configuration in setup and approve the changes there.'},
 h:{title:'Connection help',command:'mosaic connect',details:'Follow the registration steps in your coding app and verify the registry_list result there.'}
};

function connectionLines(snapshot){
 const connections=snapshot?.connections;
 if(!connections)return [['Configuration unavailable','Run mosaic setup to review your connections.']];
 const {host,worker}=connections,hostName=hostNames.get(host?.id);
 const hostAt=host?.lastConnection?.kind==='registry_call'?host.lastConnection.at:null;
 const workerAt=worker?.lastConnection?.kind==='worker_response'?worker.lastConnection.at:null;
 return [
  ['Coding app',hostName?hostName+' · configured':'No coding app selected',
   ...(hostName?[Number.isFinite(hostAt)?'Bridge registry call · '+clock(hostAt):'Last connection · unverified']:[])],
  ['Default API worker',worker?worker.displayName+' · configured':'No API worker configured',
   ...(worker?[Number.isFinite(workerAt)?'Last response · '+clock(workerAt):'Last response · unverified']:[])]
 ];
}

function lifecycle(task,nativeRow){
 if(task.status==='codex_active')return nativeRow?.status??'Native activity unknown';
 if(task.status==='running'&&task.phase==='checks')return 'Running checks';
 if(task.status==='blocked'&&checksFailed(task))return 'Blocked · checks failed';
 if(task.status==='awaiting_review'||task.status==='awaiting_legacy_review')return 'Needs review';
 if(task.status==='accepted')return task.outcome?.integrated?'Completed · integrated':'Completed';
 if(task.status==='suspended')return 'Waiting';
 return status(task.status);
}

function secondaryScreen(state,goal,{view,width,height,color,interactive,activitySelected,offset}){
 const wide=interactive&&width>=55&&height>=24,margin=wide?'  ':'',space=wide?Math.min(104,width-4):width;
 const trim=value=>clip(value,space);
 const heading=value=>color?accent(trim(value)):trim(value);
 const isConnections=view==='connections',title=isConnections?'Connections':'Activity';
 const out=[heading('Mosaic Beta'),heading(title)];
 if(state.stale){
  const stale=state.snapshot?'Disconnected · saved view is stale':'Disconnected · coordinator state unknown';
  out.push(trim(space>=43?stale:state.snapshot?(space>=20?'Disconnected · stale':'Stale view'):'Disconnected'));
 }
 if(wide&&state.snapshot?.sourceLabel)out.push(trim('Watching '+state.snapshot.sourceLabel));
 const keys=isConnections
  ?keysFor(space,'e Edit setup  h Connection help  v Activity  Esc  q','e h v Esc q','e h v q')
  :keysFor(space,'↑↓ Assignments  [/] Handoffs  c Connections  Esc  q','↑↓ [/] c Esc q','↑↓ c q');
 const bodyHeight=height-(interactive?1:0);
 if(isConnections){
  const groups=connectionLines(state.snapshot);
  if(wide&&space>=72&&groups.length===2){
   const left=Math.floor((space-3)/2),right=space-left-3;
   for(let i=0;i<Math.max(groups[0].length,groups[1].length);i++)
    out.push(pad(groups[0][i]??'',left)+'   '+clip(groups[1][i]??'',right));
  }else{
   for(const group of groups)for(const text of group)out.push(...lines(text,space));
  }
  out.push('',...Object.entries(connectionActions).flatMap(([key,action])=>
   lines((interactive?key+' ':'')+action.title+' · '+action.command,space)));
 }else if(goal){
  out.push(trim(status(goal.status)+' · '+goal.objective));
  const tasks=state.snapshot.tasks.filter(task=>task.goalId===goal.id);
  const nativeRows=tasks.some(task=>task.status==='codex_active')?new Map(actorRows(state).map(row=>[row.id,row])):null;
  const room=Math.max(0,bodyHeight-out.length),taskRoom=Math.max(0,Math.floor((room-2)*0.67));
  const selected=Math.max(0,Math.min(activitySelected,tasks.length-1));
  const start=Math.max(0,Math.min(selected-Math.floor(taskRoom/2),tasks.length-taskRoom));
  out.push(heading(taskRoom&&tasks.length>taskRoom?`Assignments ${start+1}–${start+taskRoom}/${tasks.length}`:'Assignments'));
  for(const [index,task] of tasks.slice(start,start+taskRoom).entries()){
   const marker=interactive?(index+start===selected?'› ':'  '):'';
   const nativeRow=task.status==='codex_active'?nativeRows?.get(task.id):null;
   const label=lifecycle(task,nativeRow),badge=clip(label,space-cells(marker));
   const tone=color?statusColor(badge,nativeRow?.state??task.status):badge;
   const available=space-cells(marker)-cells(badge)-3;
   out.push(marker+tone+(available>0?' · '+clip(task.objective,available):''));
  }
  if(!tasks.length)out.push(trim('No saved assignments'));
  if(wide)out.push('');
  out.push(heading('Handoff feed'));
  if(state.historyPending)out.push(trim('Loading saved handoffs…'));
  const end=Math.max(0,state.events.length-offset),feedRoom=Math.max(0,bodyHeight-out.length);
  if(!state.events.length&&!state.historyPending)out.push(trim('No saved handoffs'));
  for(const event of state.events.slice(Math.max(0,end-feedRoom),end)){
   const text=eventText(event);
   out.push(trim(wide?`${clock(event.at)} [${event.provenance}] ${text}`:text));
  }
 }else{
  out.push(trim(state.snapshot?'No saved goals':'Saved activity unavailable'));
 }
 const visible=out.slice(0,bodyHeight);
 if(interactive){
  while(wide&&visible.length<bodyHeight)visible.push('');
  visible.push(trim(keys));
 }
 return visible.map(line=>margin+line).join('\n');
}

export function renderTerminal(state,{width=80,height=36,color=false,selected=0,picker=null,detail=null,detailTitle='Saved evidence',detailOffset=0,offset=0,activitySelected=0,view=null,interactive=false}={}){
 width=Math.max(8,Math.min(300,width));height=Math.max(5,Math.min(200,height));
 const header=(value)=>lines(value,width).map(line=>color?accent(line):line);
 const compact=interactive&&(width<55||height<24);
 const goal=goalFor(state);
 if(view&&!detail&&picker===null)return secondaryScreen(state,goal,{view,width,height,color,interactive,activitySelected,offset});
 if(interactive&&picker!==null&&!detail)return polishedPicker(state,{width,height,color,picker});
 if(compact&&picker===null&&!detail)return compactMain(state,goal,{width,height,color,selected,offset});
 if(interactive&&picker===null&&!detail)return polishedMain(state,goal,{width,height,color,selected,offset});
 const out=header(compact?'Mosaic Beta':'Mosaic Beta  /  Terminal observer');
 if(state.snapshot?.sourceLabel)out.push(...lines('Watching '+state.snapshot.sourceLabel,width));
 if(state.snapshot?.sourceHint)out.push(...lines(state.snapshot.sourceHint,width));
 if(state.stale)out.push(...lines(state.snapshot?'Disconnected · last observed state is stale':'Disconnected · coordinator state unknown',width));
 if(state.currentNotice)out.push(...lines(state.currentNotice,width));
 if(picker!==null&&!detail){
  out.push(...header('Choose a goal'));
  const goals=state.snapshot?.goals??[];
  const start=compact?Math.max(0,picker-height+5):Math.max(0,picker-1);
  for(const [index,g] of goals.slice(start).entries()){
   const item=lines(`${index+start===picker?'›':' '} ${status(g.status)} · ${g.objective} [${g.id}]`,width);
   out.push(...(compact?item.slice(0,1):item.slice(0,2)));
  }
 }else if(detail){
  out.push(...header(detailTitle));
  const detailLines=detail.split('\n').flatMap(line=>lines(line,width));
  out.push(...detailLines.slice(Math.min(detailOffset,Math.max(0,detailLines.length-1))));
 }else if(!goal){
  if(!state.stale||state.snapshot)out.push(...lines('Idle · no saved goals. Start a Mosaic Beta goal in Codex.',width));
 }else{
  const title=lines(`${status(goal.status)} · ${goal.objective}`,width);
  out.push(...(interactive?title.slice(0,2):title),...lines(`Goal ${goal.id} · ${goal.mode}`,width),'');
  const rows=actorRows(state),budget=Math.max(2,Math.floor((height-out.length-5)*0.58));
  if(!rows.length)out.push(...lines('Idle · no assignments recorded.',width));
  const blocks=rows.map((row,index)=>{
   const prefix=interactive&&index===selected?'› ':'  ';
   const identity=width<55?[...lines(`${prefix}${row.actor} · ${row.role}`,width),...lines('  '+row.status,width)]:lines(`${prefix}${row.actor} · ${row.role} · ${row.status}`,width);
   const assignment=lines(`  ${row.assignment}`,width);
   return [...(color?identity.map(line=>statusColor(line,row.state)):identity),
    ...(interactive?assignment.slice(0,2):assignment),...lines(`  ${row.provenance} · updated ${clock(row.at)}`,width)];
  });
  if(interactive&&blocks.length){
   let start=Math.min(selected,blocks.length-1),used=blocks[start].length;
   while(start>0&&used+blocks[start-1].length<=budget){start--;used+=blocks[start].length;}
   out.push(...blocks.slice(start).flat().slice(0,Math.max(budget,blocks[Math.min(selected,blocks.length-1)].length)));
  }else out.push(...blocks.flat());
  out.push('',...header('Handoff feed'));
  if(state.historyPending)out.push(...lines('Loading saved handoffs…',width));
  const room=Math.max(0,height-out.length-(interactive?4:2)),end=Math.max(0,state.events.length-offset);
  for(const event of state.events.slice(Math.max(0,end-Math.max(1,room)),end)){
   out.push(...lines(`${clock(event.at)} [${event.provenance}] ${eventText(event)}`,width));
  }
 }
 const footer=detail?'↑↓ or [/] scroll · a current · Esc back · q quit':picker!==null?'↑↓ choose · Enter select · a current · Esc back · q quit':interactive?'↑↓ rows · Enter evidence · a current · g goals · [ older · ] newer · q quit':'Approvals and decisions stay in Codex.';
 const tail=lines(compact?'↑↓ a Esc q':footer,width);
 return [...out.slice(0,Math.max(0,height-tail.length-1)),'',...tail].join('\n');
}

export class TerminalObserver {
 constructor(invoke){
  this.invoke=invoke;
  this.state={snapshot:null,stale:false,goalId:null,events:[]};
  this.cursor=null;
  this.fixedGoal=null;
  this.navigation=0;this.currentRequested=false;this.currentController=null;
 }
 select(goalId){
  this.navigation++;this.currentRequested=false;this.currentController?.abort();this.state.currentNotice=null;
  this.fixedGoal=goalId;this.state.goalId=goalId;this.state.events=[];this.cursor=null;
 }
 requestCurrent(){
  this.navigation++;this.currentController?.abort();this.currentRequested=true;
  this.state.currentNotice='Finding current project…';
 }
 async poll(signal){
  const navigation=this.navigation,requested=this.currentRequested;
  try{
   let current;
   if(requested){
    this.currentRequested=false;this.currentController=new AbortController();
    if(!this.invoke.current)throw Error('Current project lookup unavailable');
    current=await this.invoke.current(signal?AbortSignal.any([signal,this.currentController.signal]):this.currentController.signal);
   }
   const snapshot=current?.snapshot??await this.invoke('observer_snapshot',{},signal);
   if(navigation!==this.navigation)return this.state;
   const previous=this.state.snapshot;
   if(snapshot.source!==previous?.source){this.fixedGoal=null;this.cursor=null;this.state.events=[];this.state.historyPending=false;}
   if(current){this.fixedGoal=current.goalId;this.state.currentNotice='Last check: '+current.notice;}
   const goal=(this.fixedGoal?snapshot.goals.find(g=>g.id===this.fixedGoal):null)??snapshot.goals.find(g=>g.status==='active')??snapshot.goals[0];
   if(goal?.id!==this.state.goalId||snapshot.cursor<(previous?.cursor??0)){
    this.cursor=null;this.state.events=[];this.state.goalId=goal?.id??null;this.state.historyPending=false;
   }
   this.state.snapshot=snapshot;
   if(goal){
    if(snapshot.overflow?.tasks){
     const selected=await this.invoke('observer_snapshot',{goalId:goal.id},signal);
     if(navigation!==this.navigation)return this.state;
     if(this.state.goalId===goal.id)this.state.snapshot={...selected,goals:snapshot.goals,connections:snapshot.connections??selected.connections,source:snapshot.source,sourceLabel:snapshot.sourceLabel,sourceHint:snapshot.sourceHint};
    }
    for(let page=0;page<2;page++){
     const recent=this.cursor===null;
     const result=await this.invoke('observer_timeline',{goalId:goal.id,limit:feedLimit,...(recent?{recent:true}:{after:this.cursor})},signal);
     if(navigation!==this.navigation)return this.state;
     if(this.state.goalId!==goal.id)break;
     const events=new Map(this.state.events.map(event=>[event.seq,event]));
     for(const event of result.events)if(event.type!=='model.output'&&(recent||event.seq>this.cursor))events.set(event.seq,event);
     this.state.events=[...events.values()].sort((a,b)=>a.seq-b.seq).slice(-feedLimit);
     this.cursor=Math.max(this.cursor??0,result.cursor);
     this.state.historyPending=!!result.hasMore;
     if(!result.hasMore)break;
    }
   }
   this.state.stale=false;
  }catch{if(navigation===this.navigation){this.state.stale=true;if(requested)this.state.currentNotice='Could not refresh the current project · showing saved view. Press a to retry.';}}
  return this.state;
 }
}

export async function runObserver({invoke,input=process.stdin,output=process.stdout,once=false,noColor=Object.hasOwn(process.env,'NO_COLOR'),pollMs=1000}){
 const observer=new TerminalObserver(invoke);
 if(once||!input.isTTY||!output.isTTY||noColor){
  const state=await observer.poll();
  output.write(renderTerminal(state,{width:output.columns??80,height:200})+'\n');
  return state;
 }
 const controller=new AbortController(),close=()=>controller.abort();
 const originalRaw=!!input.isRaw,wasFlowing=input.readableFlowing===true;
 let selected=0,picker=null,detail=null,detailTitle='Saved evidence',detailOffset=0,offset=0,activitySelected=0,view=null;
 const draw=()=>{
  if(controller.signal.aborted)return;
  output.write('\x1b[H\x1b[2J'+renderTerminal(observer.state,{width:output.columns,height:output.rows,color:true,interactive:true,selected,picker,detail,detailTitle,detailOffset,offset,activitySelected,view}));
 };
 const keypress=async(_,key={})=>{
  if(!key.ctrl&&!key.meta&&(_==='['||_===']'))key={...key,name:_==='['?'pageup':'pagedown'};
  if(key.name==='q'||key.ctrl&&key.name==='c'){close();return;}
  if(key.name==='a'){
   picker=null;detail=null;view=null;selected=0;offset=0;detailOffset=0;activitySelected=0;
   observer.requestCurrent();draw();return;
  }
  if(key.name==='escape'){if(detail)detail=null;else if(picker!==null)picker=null;else view=null;draw();return;}
  if(detail){
   const delta={up:-1,down:1,pageup:-10,pagedown:10}[key.name];
   if(delta){detailOffset=Math.max(0,Math.min(4096,detailOffset+delta));draw();}
   return;
  }
  if(key.name==='c'||key.name==='v'){
   view=key.name==='c'?'connections':'activity';picker=null;activitySelected=0;offset=0;draw();return;
  }
  if(view==='connections'){
   if(Object.hasOwn(connectionActions,key.name)){
    const action=connectionActions[key.name];detailTitle=action.title;detailOffset=0;
    detail='Run '+action.command+'\n\n'+action.details;
   }
   draw();return;
  }
  if(view==='activity'){
   const goalId=goalFor(observer.state)?.id,tasks=observer.state.snapshot?.tasks.filter(task=>task.goalId===goalId).length??0;
   if(key.name==='up')activitySelected=Math.max(0,Math.min(tasks-1,activitySelected)-1);
   if(key.name==='down')activitySelected=Math.min(Math.max(0,tasks-1),activitySelected+1);
   if(key.name==='pageup')offset=Math.min(Math.max(0,observer.state.events.length-1),offset+6);
   if(key.name==='pagedown')offset=Math.max(0,offset-6);
   draw();return;
  }
  const goals=observer.state.snapshot?.goals??[],rows=actorRows(observer.state);
  if(picker!==null){
   if(key.name==='up')picker=Math.max(0,picker-1);
   if(key.name==='down')picker=Math.min(goals.length-1,picker+1);
   if(key.name==='pageup')picker=Math.max(0,picker-10);
   if(key.name==='pagedown')picker=Math.min(goals.length-1,picker+10);
   if(key.name==='d'&&goals[picker]){
    const g=goals[picker];detailTitle='Goal details';detailOffset=0;
    detail=`${g.objective}\n\nStatus: ${status(g.status)}\nWorkflow: ${g.mode}\nAssignments: ${g.taskCount??0}\nDeadline: ${clock(g.deadline)}\nID: ${g.id}`;
   }
   if(key.name==='return'&&goals[picker]){observer.select(goals[picker].id);picker=null;selected=0;offset=0;}
  }else{
   if(key.name==='g'&&goals.length)picker=Math.max(0,goals.findIndex(g=>g.id===observer.state.goalId));
   if(key.name==='up')selected=Math.max(0,selected-1);
   if(key.name==='down')selected=Math.max(0,Math.min(rows.length-1,selected+1));
   if(key.name==='pageup')offset=Math.min(Math.max(0,observer.state.events.length-1),offset+6);
   if(key.name==='pagedown')offset=Math.max(0,offset-6);
   if(key.name==='return'&&rows[selected]?.evidence){
    const source=observer.state.snapshot?.source;
    detailTitle='Saved evidence';detail='Loading saved evidence…';detailOffset=0;draw();
    try{
     const evidence=await invoke('observer_evidence',{reference:rows[selected].evidence,length:4096},controller.signal);
     if(source===observer.state.snapshot?.source&&detail==='Loading saved evidence…')detail=`${evidence.provenance} · ${evidence.partial?'partial':'saved'}${evidence.truncated?' · excerpt':''}\n${evidence.text}`;
    }catch{if(source===observer.state.snapshot?.source&&detail==='Loading saved evidence…')detail='Evidence unavailable. Retry after reconnecting.';}
   }
  }
  draw();
 };
 emitKeypressEvents(input);
 input.on('keypress',keypress);output.on?.('resize',draw);
 process.once('SIGINT',close);process.once('SIGTERM',close);
 try{
  input.setRawMode(true);input.resume();output.write('\x1b[?1049h\x1b[?25l');
  do{
   const source=observer.state.snapshot?.source;
   await observer.poll(controller.signal);
   if(source!==observer.state.snapshot?.source){selected=0;picker=null;detail=null;detailOffset=0;offset=0;activitySelected=0;}
   if(picker!==null)picker=Math.max(0,Math.min(picker,(observer.state.snapshot?.goals.length??0)-1));
   selected=Math.min(selected,Math.max(0,actorRows(observer.state).length-1));draw();
   await delay(pollMs,undefined,{signal:controller.signal}).catch(()=>{});
  }while(!controller.signal.aborted);
 }finally{
  input.removeListener('keypress',keypress);output.removeListener?.('resize',draw);
  process.removeListener('SIGINT',close);process.removeListener('SIGTERM',close);
  input.setRawMode(originalRaw);if(!wasFlowing)input.pause();
  output.write('\x1b[0m\x1b[?25h\x1b[?1049l');
 }
 return observer.state;
}
