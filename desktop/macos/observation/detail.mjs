import path from 'node:path';
import {realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {plain,stamp,validId} from '../board.mjs';

const exec = promisify(execFile);
const timelineLimit = 64;
const checkCount = 24;
const maxDiff = 48 * 1024;
const cap = 256 * 1024;
const modes = {codex_only:'Codex only',deepseek_only:'DeepSeek only',collaborative:'Collaborative',overnight_review:'Overnight review',collaborate:'Collaborative'};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const commit = /^[a-f0-9]{40}$/;
function label(text) {
  const cleaned = plain(text,120).replace(/[._]/g,' ').trim();
  return cleaned ? cleaned.charAt(0).toUpperCase()+cleaned.slice(1) : 'Activity';
}
async function history(invoke,id) {
  const tools = await invoke('tools_list',{});
  const recent = tools.find(t=>t.name==='observer_timeline')?.inputSchema?.properties?.recent;
  let page;
  if (recent) {
    page = await invoke('observer_timeline',{goalId:id,recent:true,limit:timelineLimit});
  } else {
    let after=0, events=[];
    for (let i=0;i<8;i++) {
      page=await invoke('observer_timeline',{goalId:id,after,limit:timelineLimit});
      events.push(...page.events);
      if (!page.hasMore || page.cursor<=after) break;
      after=page.cursor;
    }
    page={...page,hasMore:page.hasMore || events.length>timelineLimit,events:events.slice(-timelineLimit)};
  }
  const events=page.events.filter(e=>e.goalId===id).map(e=>({title:plain(e.summary,600) || label(e.type),
    detail:[e.displayName || (e.actor === 'codex' ? 'Codex' : e.actor === 'coordinator' ? 'Mosaic' : e.actor),label(e.type)].filter(Boolean).join(' · '),at:stamp(e.at)}));
  return {events,limited:!!page.hasMore || page.events.length>=timelineLimit};
}
async function evidence(invoke, task) {
  if (task.evidenceRef !== 'task-'+task.id) return null;
  let start=0, size, hash, parts=[];
  do {
    const page=await invoke('observer_evidence',{reference:task.evidenceRef,start,length:32768});
    if (page.totalBytes>cap || page.totalBytes<0 || !Number.isSafeInteger(page.nextStart) || page.nextStart<=start ||
        page.start!==start || page.nextStart>page.totalBytes || (start && (page.sha256!==hash || page.totalBytes!==size))) return null;
    size=page.totalBytes; hash=page.sha256; start=page.nextStart; parts.push(page.text);
  } while(start<size);
  const saved=JSON.parse(parts.join(''));
  return saved.id===task.id ? saved : null;
}
async function nativeDiff(task,state) {
  const candidate=task.candidate;
  if (!validId(task.id) || !commit.test(candidate?.baseCommit ?? '') || !commit.test(candidate?.commit ?? '')) return null;
  const dir=path.join(state,'native-candidates','artifacts',task.id,'worktree');
  try {
    if (await realpath(dir)!==dir) return null;
    const {stdout}=await exec('/usr/bin/git',['--no-pager','--no-optional-locks','--no-replace-objects','-C',dir,
      '-c','core.fsmonitor=false','diff','--no-ext-diff','--no-textconv','--no-color','--ignore-submodules=all',candidate.baseCommit,candidate.commit,'--'],
    {timeout:2500,maxBuffer:1024*1024,env:{PATH:'/usr/bin:/bin',LANG:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
    return stdout || null;
  } catch { return null; }
}
function fallbackCheck(task) {
  const summary=task.outcome?.checks;
  if (!summary?.total) return [];
  return [{name:plain(task.objective,90) || 'Protected checks',status:summary.passed===summary.total?'passed':'failed',
    output:summary.passed+' of '+summary.total+' protected checks passed. Individual output unavailable.'}];
}
async function taskEvidence(task,invoke,state) {
  const saved=await evidence(invoke,task).catch(()=>null);
  const checks=saved?.integration?.checks ?? saved?.result?.checks;
  const rows=Array.isArray(checks) ? checks.slice(0,checkCount).map(c=>({name:plain(c.id,140) || 'Protected check',
    status:c.passed===true?'passed':c.passed===false?'failed':'unknown',
    output:plain([c.stdout,c.stderr].filter(s=>typeof s==='string' && s).join('\n'),2000)})) : fallbackCheck(task);
  const diff=typeof saved?.result?.diff==='string'?saved.result.diff:await nativeDiff(task,state);
  return {rows,diff,limited:!saved || (checks?.length ?? 0)>checkCount || checks?.some(c=>(c.stdout?.length ?? 0)+(c.stderr?.length ?? 0)>2000) || (diff?.length ?? 0)>maxDiff ||
    (!diff && Boolean(task.outcome?.files?.length))};
}
export async function loadDetail(snapshot,card,invoke,state) {
  const goal=snapshot.goals.find(g=>g.id===card.id);
  const relevant=snapshot.tasks.filter(t=>t.goalId===goal.id).sort((a,b)=>(stamp(b.updatedAt ?? b.lastActivityAt) ?? 0)-(stamp(a.updatedAt ?? a.lastActivityAt) ?? 0));
  const tasks=relevant.filter(t=>t.outcome?.checks || t.candidate?.commit || t.outcome?.files?.length || ['accepted','failed','ready_to_integrate','awaiting_review','awaiting_legacy_review','partial','blocked'].includes(t.status));
  const [timeline,...results]=await Promise.all([history(invoke,card.id).catch(()=>({events:[],limited:true})),
    ...tasks.slice(0,4).map(t=>taskEvidence(t,invoke,state))]);
  const diffs=results.flatMap(r=>r.diff?[r.diff]:[]).join('\n');
  const rows=results.flatMap(r=>r.rows);
  const sessions=new Set((snapshot.agents ?? []).filter(a=>a.goalId===goal.id && a.role==='supervisor' && a.hostId==='codex' && uuid.test(a.hostAgentId ?? '')).map(a=>a.hostAgentId));
  const sessionId=sessions.size===1 ? [...sessions][0] : null;
  return {title:card.title,host:card.host,worker:card.worker,mode:modes[goal.mode] ?? label(goal.mode),status:card.status,
    events:timeline.events,checks:rows.slice(0,checkCount),diff:diffs?plain(diffs,maxDiff):null,
    followup:'Use Mosaic to inspect handoff '+card.id+' (“'+plain(card.title,180)+'”). Check its current status and saved evidence, then continue from the latest handoff.',
    limited:Boolean(timeline.limited || tasks.length>4 || results.some(r=>r.limited) || rows.length>checkCount || diffs.length>maxDiff || snapshot.overflow?.tasks || goal.taskCount>relevant.length),
    canOpenHost:!!sessionId,...(sessionId?{sessionId}:{})};
}
