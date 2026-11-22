import path from 'node:path';
import {preventWindowsSleep,windowsAlert} from './windows-desktop.mjs';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {command} from '../project/process.mjs';
import {Goals} from './goals.mjs';
import {digest} from './contracts.mjs';
import {isOvernightV2,overnightCompletionReady} from './overnight.mjs';
import {firstRecoveryBlocker,recoveryDetails,retainedProgress} from './recovery-diagnostics.mjs';

export function deriveOvernightState(g,tasks,planning,now){
 const first=predicate=>tasks.find(predicate);
 const state=(phase,t,reason,code=phase,details={})=>({phase,taskId:t?.id??null,reason,code,...details});
 if(g.status==='completed')return state('completed');
 if(g.status==='draft')return state('preparation');
 if(now>=g.deadline)return state('expired',null,'Original goal deadline reached','goal_deadline_expired',{deadline:g.deadline});
 const expired=first(t=>t.deadline&&now>=t.deadline&&!['accepted','failed','cancelled'].includes(t.status));
 if(expired)return state('expired',expired,'Original task deadline reached','task_deadline_expired',{deadline:expired.deadline});
 const uncertain=first(t=>t.status==='uncertain');
 if(uncertain||planning?.status==='uncertain'&&!planning.recoveryPending)return state('blocked',uncertain,uncertain?.reason??planning?.reason??'Saved execution outcome requires reconciliation','execution_uncertain');
 if(g.status==='paused')return state('paused');
 if(g.status==='stopped')return state('stopped');
 const stopped=first(t=>t.status==='stopped'||t.stopRequested);
 if(stopped)return state('stopped',stopped);
 const paused=first(t=>t.status==='paused'||t.pauseRequested);
 if(paused)return state('paused',paused);
 const q=first(t=>['awaiting_user','awaiting_supervisor'].includes(t.status));
 if(q)return state('waiting-answer',q,'An owner answer is required','owner_answer_required');
 const waiting=first(t=>t.providerWait&&['queued','running','suspended','blocked'].includes(t.status));
 const providerWait=waiting?.providerWait??(['queued','running','blocked'].includes(planning?.status)?planning.providerWait:null);
 if(providerWait){
  if(now>=providerWait.until)return state('blocked',waiting,'Original provider reconnect window exhausted','provider_reconnect_expired',{providerWait});
  if(!waiting&&planning.status==='blocked')return state('blocked',null,'Original planning request budget exhausted','provider_budget_exhausted',{providerWait});
  if(!waiting||['queued','running','suspended'].includes(waiting.status)&&!providerWait.readyOwner){
   return state(waiting?'implementation':'planning',waiting,'Provider unavailable; bounded reconnect window','provider_unavailable',{providerWait});
  }
 }
 if(g.integrationPending){
  const integrating=first(t=>t.id===g.integrationPending.taskId);
  if(g.status==='active'&&integrating?.status==='ready_to_integrate'&&integrating.goalVersion===g.version&&
   (g.manifest.reviewPolicy?!!integrating.reviewAcceptance:integrating.legacyDecision?.decision==='accept')&&!integrating.owner&&!g.integrationOwner&&!g.integrationSealed){
   return state('integration',integrating,'Reviewed candidate import is pending protected verification');
  }
  return state('blocked',integrating,integrating?.reason??'Pending integration requires verified recovery','integration_pending');
 }
 const blocked=first(t=>['blocked','partial','failed'].includes(t.status));
 if(blocked||planning?.status==='blocked')return state('blocked',blocked,blocked?.reason??blocked?.legacyDecision?.feedback??(planning?.status==='blocked'?planning.reason:undefined)??'Saved execution needs attention');
 const portableReview=g.manifest.reviewPolicy?first(t=>t.status==='awaiting_review'):null;
 if(portableReview)return state('review',portableReview,g.manifest.reviewPolicy.source==='host'?'Waiting for the selected host to return and pull the saved review inbox':'Waiting for the approved API reviewer; failed requests remain spent',g.manifest.reviewPolicy.source==='host'?'waiting_host_review':'waiting_api_review');
 const review=first(t=>['awaiting_legacy_review','legacy_reviewing'].includes(t.status));
 if(review)return state('review',review);
 const integrating=first(t=>t.status==='ready_to_integrate');
 if(integrating)return state('integration',integrating);
 if(!tasks.length)return state('planning');
 const runnable=first(t=>t.owner||['queued','suspended','running'].includes(t.status)&&t.spec.dependsOn.every(id=>tasks.some(d=>d.id===id&&d.status==='accepted'&&d.integration)));
 if(runnable)return state('implementation',runnable);
 if(tasks.every(t=>t.status==='accepted'&&t.integration))return state('integration');
 return state('blocked',null,'No eligible stage; inspect dependencies and saved ownership');
}
export class IdleSleepAssertion{
 constructor({platform=process.platform,spawnProcess=spawn}={}){this.platform=platform;this.spawn=spawnProcess;this.child=null;this.until=0;}
 sync(active,deadline){if(!active||deadline<=Date.now()){this.close();return;}if(!['darwin','win32'].includes(this.platform))return;if(this.child&&this.until===deadline)return;this.close();this.until=deadline;const child=this.child=this.platform==='win32'?preventWindowsSleep(this.spawn,deadline):this.spawn('/usr/bin/caffeinate',['-i','-t',String(Math.max(1,Math.ceil((deadline-Date.now())/1000))),'-w',String(process.pid)],{stdio:'ignore'});child.once('error',()=>{if(this.child===child)this.child=null;});child.once('exit',()=>{if(this.child===child)this.child=null;});}
 close(){if(this.child){this.child.kill('SIGTERM');this.child=null;}this.until=0;}
}
const alertText={completion:'Mosaic overnight work is complete. Open Mosaic for the saved report.',blocker:'Mosaic overnight work needs attention. Open Mosaic for the saved blocker and evidence.',decision:'Mosaic overnight work needs your answer. Open Mosaic to review the question.'};
export async function localOvernightAlert(kind){const text=alertText[kind];if(!text)throw Error('Unsupported alert');if(process.platform==='win32')return windowsAlert(text);if(process.platform!=='darwin')throw Error('Local alerts unavailable');const script='on run argv\ndisplay notification (item 1 of argv) with title "Mosaic"\nend run';const result=await command(['/usr/bin/osascript','-e',script,text],{timeoutMs:10000});if(result.code!==0||result.stopped)throw Error('macOS notification delivery failed');return {status:'submitted',visibility:'OS controls presentation; saved report authoritative'};}
async function atomic(file,content){await mkdir(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.pending';await writeFile(tmp,content,{mode:0o600});await rename(tmp,file);}
function renderMarkdown(report){
 const checkpoint=report.retainedProgress.lastVerifiedCheckpoint;
 return [
  '# Mosaic Overnight report',`Result: ${report.result}`,`Goal: ${report.goalId}`,
  `Branch: ${report.branch??'not integrated'}`,`Worktree: ${report.worktree??'not integrated'}`,
  `Current reason: ${report.reason??'none'}`,
  ...(report.recovery.outcome?[`Request outcome: ${report.recovery.outcome}`]:[]),
  `First blocker: ${report.firstBlocker?.reason??'none'}`,
  `Next step: ${report.continuation}`,
  `Last verified checkpoint: ${checkpoint?[checkpoint.kind,checkpoint.taskId,checkpoint.requestId].filter(Boolean).join(' '):'none'}`,
  `Receipt: ${report.receiptHash??'not finalized'}`,'',
  ...report.tasks.map(t=>`- ${t.objective}: ${t.status}; attempts ${t.attempts}; reviews ${t.reviews}; model requests ${t.spent.model}; checks ${t.checks.map(r=>r.id+':'+(r.passed?'pass':'fail')).join(', ')}${t.integration?.commit?'; integrated commit '+t.integration.commit:''}`),
  '','Machine-readable evidence: report.json','',
 ].join('\n');
}
export class OvernightLifecycle{
 constructor({c,notify=localOvernightAlert,power=new IdleSleepAssertion()}={}){
  this.c=c;this.notify=notify;this.power=power;this.inflight=null;this.powerDeadline=0;this.blockerCursors=new Map();
 }
 tick(){if(this.inflight)return this.inflight;this.inflight=this.update().finally(()=>{this.inflight=null;});return this.inflight;}
 async update(){
  const c=this.c,startedAt=c.now(),goals=c.store.all('goal').filter(g=>isOvernightV2(g.manifest));
  let deadline=0,nextAt=Infinity;
  const tasksByGoal=new Map(goals.map(g=>[g.id,[]]));
  if(goals.length)for(const task of c.store.all('task'))tasksByGoal.get(task.goalId)?.push(task);
  const eventSeq=goals.length?Number(c.store.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM events').get().n):0;
  for(const saved of goals){
   let g=c.store.get('goal',saved.id);
   const tasks=tasksByGoal.get(g.id),planning=c.store.maybe('planning',g.id);
   let state=deriveOvernightState(g,tasks,planning,c.now());
   if(g.deadline>startedAt&&!['draft','completed'].includes(g.status))nextAt=Math.min(nextAt,g.deadline);
   for(const at of [state.providerWait?.until,...tasks.filter(t=>!['accepted','failed','cancelled'].includes(t.status)).map(t=>t.deadline)]){
    if(at>startedAt)nextAt=Math.min(nextAt,at);
   }
   if(g.status==='active'&&state.phase==='integration'&&overnightCompletionReady(c,g,tasks)){
    new Goals(c).finalize({goalId:g.id,summary:'All Overnight v2 stages independently reviewed, integrated, and final protected suite passed.'},`overnight-finalize-${g.id}`);
    g=c.store.get('goal',g.id);state=deriveOvernightState(g,tasks,planning,c.now());
   }
   const old=c.store.maybe('overnight_run',g.id),attention=['blocked','waiting-answer','expired'].includes(state.phase);
   const firstBlocker=firstRecoveryBlocker(c.store,g,tasks,planning,state,old?.firstBlocker,this.blockerCursors.get(g.id)??0,eventSeq,c.now());
   const recovery=recoveryDetails(c.store,g,tasks,planning,state);
   const retained=retainedProgress(c.store,g,tasks);
   const reportPath=path.join(c.store.root,'overnight-reports',g.id,'report.json'),markdownPath=path.join(c.store.root,'overnight-reports',g.id,'report.md');
   const run={id:g.id,schema:1,goalId:g.id,approvalHash:g.hash,phase:state.phase,taskId:state.taskId,reason:recovery.reason,firstBlocker,recovery,deadline:g.deadline,reportPath,markdownPath,receiptHash:g.receiptHash??null};
   const report={
    schema:1,goalId:g.id,approvalHash:g.hash,result:state.phase,reason:run.reason,firstBlocker,recovery,retainedProgress:retained.summary,
    deadline:g.deadline,branch:g.integration?.branch??null,worktree:g.integration?.worktree??null,
    launchInstructions:g.manifest.acceptance.filter(line=>/^launch:/i.test(line)),
    launchNote:'Use only approved project launch instructions. No launch/deployment was inferred or executed.',
    limits:g.manifest.limits,planning:{status:planning?.status??null,spent:c.store.spent(g.id).model??0,limit:3},
    tasks:tasks.map(t=>{
     const checkpoint=retained.byTask.get(t.id)??null;
     return {
      id:t.id,status:t.status,objective:t.spec.objective,role:t.spec.role,attempts:t.attempts,reviews:t.reviews,
      spent:c.getTask(t.id).spent,limits:t.spec.limits,deadline:t.deadline,checks:t.integration?.checks??t.result?.checks??checkpoint?.checks??[],
      integration:t.integration??null,review:t.reviewAcceptance??t.legacyDecision??null,
      evidence:{
       journalRoot:t.result?.journalRoot??checkpoint?.journalRoot??null,resultHash:digest(t.result),
       candidateWorktree:t.result?.worktree??checkpoint?.candidateWorktree??null,lastVerifiedCheckpoint:checkpoint,
      },
      providerWait:t.providerWait??null,
     };
    }),
    nativeUsage:'Host token accounting unavailable',receiptHash:g.receiptHash??null,continuation:recovery.nextStep.instruction,
   };
   const reportHash=digest(report);run.reportHash=reportHash;
   const reportChanged=old?.reportHash!==reportHash||old.reportPath!==reportPath||old.markdownPath!==markdownPath;
   if(reportChanged){
    await atomic(reportPath,JSON.stringify(report,null,2)+'\n');
    await atomic(markdownPath,renderMarkdown(report));
   }
   if(reportChanged||old.taskId!==run.taskId){
    const at=c.now();
    c.store.tx(()=>c.store.put('overnight_run',{...run,updatedAt:at,serviceObservedAt:at,servicePid:process.pid}));
   }
   this.blockerCursors.set(g.id,eventSeq);
   if(attention&&!c.store.all('notification').some(n=>n.goalId===g.id&&['blocker','decision'].includes(n.kind)&&!n.resolved)){
    c.emit('overnight.attention',g.id,state.taskId,{phase:state.phase,reason:run.reason});
   }
   const executing=['planning','implementation','review','integration'].includes(state.phase)&&g.status==='active';
   if(executing)deadline=Math.max(deadline,g.deadline);
  }
  this.powerDeadline=deadline;
  this.refreshPower();
  for(const n of c.store.all('notification').filter(n=>isOvernightV2(c.store.maybe('goal',n.goalId)?.manifest)&&['completion','blocker','decision'].includes(n.kind)&&!c.store.maybe('notification_delivery',n.id))){
   // Reserve BEFORE OS delivery: a crash leaves an honest uncertain attempt, never a duplicate alert.
   const delivery={id:n.id,goalId:n.goalId,status:'uncertain',reservedAt:c.now()};c.store.tx(()=>c.store.put('notification_delivery',delivery));
   try{const result=await this.notify(n.kind);delivery.status='submitted';delivery.result=result??null;}catch{delivery.status='failed';delivery.reason='Local alert delivery failed; saved report remains authoritative';}delivery.finishedAt=c.now();c.store.tx(()=>c.store.put('notification_delivery',delivery));
  }
  return nextAt;
 }
 refreshPower(){this.power.sync(this.powerDeadline>0,this.powerDeadline);}
 close(){this.power.close();}
}
