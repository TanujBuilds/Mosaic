import {stripVTControlCharacters} from 'node:util';
import {digest,identifier} from './contracts.mjs';

export function terminalText(value){
 return stripVTControlCharacters(String(value)).replace(/[\p{Cc}\p{Cf}]/gu,' ');
}

export function integrationBinding(goal,task){
 if(task.status!=='ready_to_integrate'||task.spec.kind!=='coding'||task.goalVersion!==goal.version||
    !task.reviewed||task.owner||task.native?.writerActive||!task.result||
    !(task.reviewAcceptance||task.feedback?.at(-1)?.decision==='accept'||task.legacyDecision?.decision==='accept'))return null;
 return digest({goalId:goal.id,goalHash:goal.hash,goalVersion:goal.version,taskId:task.id,taskHash:task.hash,
  result:task.result,native:task.native??null,review:task.reviewAcceptance??task.legacyDecision??task.feedback.at(-1)});
}

export function controlBinding(store,goal,task=null){
 const seq=store.db.prepare("SELECT MAX(seq) AS seq FROM events WHERE goal_id=? AND type='work.control'").get(goal.id).seq;
 return digest({goalId:goal.id,goalHash:goal.hash,version:goal.version,status:goal.status,seq,
  task:task?{id:task.id,status:task.status,hash:task.hash,paused:!!task.pauseRequested,stopped:!!task.stopRequested}:null});
}

function inboxItem(kind,goal,task,detail,action=null,binding=null){
 return {id:kind+'-'+(task?.id??goal.id),kind,goalId:goal.id,taskId:task?.id??null,
  title:terminalText(task?.spec.objective??goal.manifest.objective).slice(0,240),
  detail:terminalText(detail).slice(0,500),action,binding};
}

export function actionContext(c,{goalId,taskId}){
 const goal=c.store.get('goal',goalId);
 const scope={id:goal.id,hash:goal.hash,version:goal.version,status:goal.status,deadline:goal.deadline,
  objective:goal.manifest.objective,limits:goal.manifest.limits,controlBinding:controlBinding(c.store,goal)};
 if(goal.status==='draft')scope.manifest=goal.manifest;
 if(!taskId)return scope;
 const task=c.store.get('task',taskId);
 if(task.goalId!==goal.id)throw Error('Task belongs to a different goal.');
 const question=task.questions?.at(-1);
 if(['awaiting_user','awaiting_supervisor'].includes(task.status)&&question)
  scope.question={id:question.id,text:question.text};
 const binding=integrationBinding(goal,task);
 if(binding){
  if(goal.manifest.reviewPolicy)c.reviewService.assertAccepted(task);
  const {changes,newFiles,trackedPaths,diff}=task.result;
  const changedFiles=[...new Set([...(trackedPaths??[]),...[...(changes??[]),...(newFiles??[])].map(file=>file.path)])];
  scope.candidate={binding,permissions:task.spec.permissions,base:task.native?.baseCommit??task.result.baseCommit,
   commit:task.native?.commit,changedFiles,...(trackedPaths===undefined&&diff?{changedFilesComplete:false}:{}),
   checks:task.result.checks?.map(({id,passed,code})=>({id,passed,code})),
   review:task.reviewAcceptance??task.legacyDecision??task.feedback?.at(-1)};
 }
 scope.taskObjective=task.spec.objective;
 return scope;
}

export function ownerInbox(c,{goalId=null,actor=null,itemId=null}={}){
 if(goalId!==null)identifier(goalId,'goal ID');
 const selected=itemId?.match(/^(approval|control|question|review|integration|blocker)-(.+)$/u);
 if(itemId!==null&&!selected)throw Error('Invalid inbox item ID.');
 const subjectId=selected?identifier(selected[2],'item subject ID'):null;
 const {db}=c.store;
 const rows=db.prepare(`SELECT rowid,kind FROM records WHERE
  (? IS NULL OR id=?) AND ((kind='goal' AND (? IS NULL OR id=?) AND json_extract(data,'$.status') IN ('draft','paused','stopped'))
  OR (kind='task' AND (? IS NULL OR json_extract(data,'$.goalId')=?) AND (? IS NULL OR COALESCE(json_extract(data,'$.executionActor'),json_extract(data,'$.spec.actor'))=?)
    AND json_extract(data,'$.status') IN ('awaiting_user','awaiting_supervisor','awaiting_review','awaiting_legacy_review','ready_to_integrate','blocked','uncertain')))
  ORDER BY rowid DESC LIMIT 51`).all(subjectId,subjectId,goalId,goalId,goalId,goalId,actor,actor);
 const record=db.prepare('SELECT data FROM records WHERE rowid=?');
 const items=rows.slice(0,50).map(({rowid,kind})=>{
  const value=JSON.parse(record.get(rowid).data);
  if(kind==='goal'){
   if(value.status==='draft')return inboxItem('approval',value,null,'Review the prepared goal, scope and limits.','activate',value.hash);
   return inboxItem('control',value,null,'Goal is '+value.status+'. Resume within its original limits.','resume',controlBinding(c.store,value));
  }
  const task=value,goal=c.store.get('goal',task.goalId),live=goal.status==='active'&&task.goalVersion===goal.version;
  if(['awaiting_user','awaiting_supervisor'].includes(task.status)){
   const question=task.questions?.at(-1);
   return inboxItem('question',goal,task,question?.text??'Question unavailable.',live&&question?'answer':null,question?.id??null);
  }
  if(task.status==='ready_to_integrate'){
   let binding=live?integrationBinding(goal,task):null;
   if(binding&&goal.manifest.reviewPolicy){
    try{c.reviewService.assertAccepted(task);}catch{binding=null;}
   }
   return inboxItem('integration',goal,task,binding?'Reviewed candidate is ready for protected integration.':'Coordinator integration pending.',binding?'integrate':null,binding);
  }
  if(['awaiting_review','awaiting_legacy_review'].includes(task.status)){
   const reviewer=goal.manifest.reviewPolicy;
   return inboxItem('review',goal,task,reviewer?.source==='api'?'Waiting for the assigned API reviewer.':reviewer?.source==='host'?'Continue review in '+reviewer.hostId+'.':'Continue with the assigned reviewer.');
  }
  return inboxItem('blocker',goal,task,task.status==='uncertain'?'Execution ownership is uncertain. Inspect saved evidence before recovery.':'Work is blocked. Inspect the saved task evidence.');
 });
 return {items:itemId?items.filter(row=>row.id===itemId):items,hasMore:rows.length>50};
}

// A terminal summary should remain readable even if a candidate saved a large patch.
export function ownerGoalView(c, goalId){
 const goal=c.store.get('goal',identifier(goalId,'goal ID'));
 const {mode,limits,project,providerPolicy,environment,objective}=goal.manifest;
 const worker=providerPolicy?.workers.find(item=>item.id===providerPolicy.defaultWorkerId);
 const maxScopeBytes=128*1024;
 const checks=project?.checks.map(check=>check.id);
 const scopeComplete=!!project&&Buffer.byteLength(JSON.stringify([project.readPaths,project.writePaths,checks]))<=maxScopeBytes;
 const tasks=c.store.db.prepare("SELECT id FROM records WHERE kind='task' AND json_extract(data,'$.goalId')=? ORDER BY rowid LIMIT 101")
  .all(goal.id).map(({id})=>{
   const task=c.getTask(id);
   return {id,status:task.status,priority:task.priority,deadline:task.deadline,spent:task.spent,
    reason:terminalText(task.reason??'').slice(0,500),
    spec:{objective:terminalText(task.spec.objective).slice(0,500),kind:task.spec.kind,
     priority:task.spec.priority,dependsOn:task.spec.dependsOn,limits:task.spec.limits},
    candidateCommit:task.native?.commit??task.result?.candidate?.commit??null,
    integration:task.integration?{commit:task.integration.commit}:null};
  });
 const checkSuggestions=project?.checks.filter(check=>!Object.hasOwn(check,'env')&&/^[a-z0-9-]{1,120}$/u.test(check.id))
  .slice(0,50).map(check=>({id:check.id,definitionHash:digest(check)}));
 return {id:goal.id,status:goal.status,hash:goal.hash,version:goal.version,deadline:goal.deadline,
  manifest:{mode,limits,environment,objective:terminalText(objective).slice(0,500),
   workerDefault:worker?{id:worker.id,revision:worker.revision,profileHash:digest(worker)}:null,
   project:project?{repo:project.repo,scopeComplete,checkSuggestions,
    ...(scopeComplete?{readPaths:project.readPaths,writePaths:project.writePaths,checks}: {})}:null},
  ...(goal.manifest.reviewPolicy?{reviewBudget:c.reviewService.budget(goal)}:{}),
  tasks:tasks.slice(0,100),overflow:tasks.length>100};
}
