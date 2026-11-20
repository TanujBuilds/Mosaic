import {createInterface} from 'node:readline/promises';
import {randomUUID} from 'node:crypto';
import {client} from './client.mjs';
import {terminalText} from '../harness/owner-inbox.mjs';
import {digest} from '../harness/contracts.mjs';

const controlStates={pause:['active'],stop:['active','paused'],resume:['paused','stopped']};
const controls=new Set(Object.keys(controlStates));
const changed=()=>Error('This item changed. Open Needs You again to review its current state.');
function display(value){
 return JSON.stringify(value,null,2).replace(/[\p{Cf}\u007f-\u009f\u2028\u2029]/gu,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));
}

export async function runOwnerAction(paths,args=[],options={}){
 const {input=process.stdin,output=process.stdout}=options;
 const invoke=options.invoke??client(paths);
 let prompt;
 const ask=text=>{
  if(!input.isTTY||!output.isTTY)throw Error('Open an interactive terminal to confirm an owner action.');
  if(options.ask)return options.ask(text);
  prompt??=createInterface({input,output});
  return prompt.question(text);
 };
 const write=line=>output.write(line+'\n');
 try{
  if(args.length>2||args.length===2&&!controls.has(args[0])||args.length===1&&controls.has(args[0]))throw Error('Use mosaic act [item ID] or mosaic act pause|stop|resume GOAL_ID.');
  let item,goal;
  if(args.length===2){
   const [action,goalId]=args;
   goal=await invoke('owner_action_context',{goalId});
   if(!controlStates[action].includes(goal.status))throw Error('This control is unavailable for the current goal state.');
   item={action,goalId,title:goal.objective,detail:'Current goal state: '+goal.status,binding:goal.controlBinding};
  }else{
   const inbox=await invoke('owner_inbox',args[0]?{itemId:args[0]}:{});
   let id=args[0];
   if(!id){
    write('Needs You');
    inbox.items.forEach((row,index)=>write((index+1)+'. '+terminalText(row.title)+' · '+terminalText(row.detail)+' ['+row.id+']'));
    if(inbox.hasMore)write('Showing the latest 50 items.');
    if(!inbox.items.length){write('No pending decisions.');return;}
    if(!input.isTTY||!output.isTTY)return;
    const choice=await ask('Choose an item number (Enter to exit): ');
    if(!choice)return;
    if(!/^\d+$/.test(choice)||!inbox.items[Number(choice)-1])throw Error('Choose a listed item.');
    id=inbox.items[Number(choice)-1].id;
   }
   const selected=inbox.items.find(row=>row.id===id);
   if(!selected)throw changed();
   const refreshed=await invoke('owner_inbox',{goalId:selected.goalId,itemId:id});
   item=refreshed.items.find(row=>row.id===id);
   if(!item||item.binding!==selected.binding||item.action!==selected.action)throw changed();
   write(terminalText(item.title)+' · '+terminalText(item.detail));
   if(!item.action)return;
   goal=await invoke('owner_action_context',{goalId:item.goalId,...(item.taskId?{taskId:item.taskId}:{})});
  }
  if(!item.binding)throw changed();
  const scope={goalId:goal.id,approvalHash:goal.hash,goalVersion:goal.version,status:goal.status,deadline:goal.deadline};
  let name,body;
  if(item.action==='activate'){
   if(goal.status!=='draft'||goal.hash!==item.binding||digest(goal.manifest)!==goal.hash)throw changed();
   write(display({...scope,manifest:goal.manifest}));
   name='goal_activate';body={goalId:goal.id,hash:item.binding};
  }else if(item.action==='answer'){
   const question=goal.question;
   if(question?.id!==item.binding)throw changed();
   write(display({...scope,taskId:item.taskId,objective:goal.taskObjective,question:question.text}));
   const answer=await ask('Your answer (Enter to cancel): ');
   if(!answer.trim())return;
   write(display({answer}));
   name='question_answer';body={taskId:item.taskId,expectedQuestionId:item.binding,expectedGoalHash:goal.hash,responder:'user',answer};
  }else if(item.action==='integrate'){
   if(goal.candidate?.binding!==item.binding)throw changed();
   write(display({...scope,taskId:item.taskId,objective:goal.taskObjective,candidate:goal.candidate}));
   name='task_integrate';body={taskId:item.taskId,expectedIntegrationBinding:item.binding,feedback:'Owner confirmed integration of the reviewed candidate.'};
  }else{
   if(!controls.has(item.action)||goal.controlBinding!==item.binding)throw changed();
   write(display({...scope,objective:goal.objective,action:item.action,limits:goal.limits}));
   name='work_control';body={goalId:goal.id,action:item.action,expectedControlBinding:item.binding};
  }
  if((await ask('Type yes to '+item.action+' (Enter to cancel): ')).trim().toLowerCase()!=='yes'){write('Cancelled.');return;}
  const result=await invoke(name,{...body,idempotencyKey:'owner-'+randomUUID()});
  if(name==='task_integrate')write('Integration operation '+terminalText(result.id)+' · '+terminalText(result.status));
  else write('Saved · '+terminalText(result.status));
  return {id:result.id,status:result.status};
 }finally{prompt?.close();}
}
