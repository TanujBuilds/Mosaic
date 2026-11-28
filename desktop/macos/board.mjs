import path from 'node:path';
import {readProjectIndex} from './observation/project-index.mjs';
import {loadDetail} from './observation/detail.mjs';

const hosts = {codex:'Codex', 'claude-code':'Claude Code', cursor:'Cursor', antigravity:'Antigravity'};
const statuses = {
  completed:'Completed', accepted:'Accepted', failed:'Failed', cancelled:'Cancelled', stopped:'Stopped',
  partial:'Partial result', paused:'Paused', draft:'Prepared', active:'Active', queued:'Queued',
  awaiting_review:'Awaiting review', awaiting_legacy_review:'Awaiting review', awaiting_user:'Needs an answer',
  awaiting_supervisor:'Needs an answer', ready_to_integrate:'Ready to integrate', blocked:'Blocked',
  uncertain:'Needs inspection', running:'Working', codex_active:'Working', codex_ready:'Ready for host',
  suspended:'Suspended', revision_requested:'Revision requested'
};
const attention = ['failed','blocked','uncertain','awaiting_user','awaiting_supervisor','awaiting_review','awaiting_legacy_review','ready_to_integrate','paused','suspended'];
const ended = ['completed','accepted','cancelled','stopped','partial'];
export function plain(value, limit = 600) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').slice(0,limit);
}
export function stamp(value) {
  if (value == null || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 && ms <= 8640000000000000 ? ms : null;
}
function lastTime(...values) {
  return Math.max(0,...values.map(v=>stamp(v) ?? 0)) || null;
}
export function hostFor(goal, agents) {
  const origin = agents.find(a=>a.goalId === goal.id && ['supervisor','planner'].includes(a.role) && hosts[a.hostId]);
  // Older core released only the Codex host. A separate reviewer or a worker
  // registration is not evidence of the originating chat.
  return hosts[origin?.hostId] || hosts[goal.hostId] || (goal.mode === 'codex_only' ? 'Codex' : 'Host unrecorded');
}
function workerFor(goal, tasks) {
  const workers = new Set();
  for (const t of tasks) {
    const name = t.worker?.reportedModel || t.model?.resolved || t.worker?.requestedModel || t.workerProfile?.displayName ||
      (t.actor === 'codex' ? hosts[t.hostId || goal.hostId] || 'Codex' : t.actor === 'deepseek' ? goal.workerProfile?.displayName || 'DeepSeek' : '');
    if (name) workers.add(plain(name,100));
  }
  return [...workers].join(', ') || plain(goal.workerProfile?.displayName,100) || 'Unassigned';
}
function cardFor(goal, snapshot, metadata) {
  const tasks = (snapshot.tasks ?? []).filter(t=>t.goalId === goal.id);
  const project = metadata.get(goal.id)?.project ?? {id:'unassigned',name:'Unassigned'};
  const goalState = goal.status;
  const taskState = [...attention,'partial'].find(s=>tasks.some(t=>t.status === s));
  const running = tasks.find(t=>['codex_active','running','queued','codex_ready'].includes(t.status));
  const state = ended.includes(goalState) || attention.includes(goalState) ? goalState : taskState ?? running?.status ?? goalState;
  const lane = ended.includes(goalState) ? 'finished' : attention.includes(state) || state==='partial' ? 'attention' : 'working';
  const items = snapshot.needsYou?.items ?? [];
  const reasons = [...items.filter(i=>i.goalId === goal.id).map(i=>i.detail ?? i.summary ?? i.reason),...tasks.map(t=>t.routingWait?.reason)];
  const connection = metadata.get(goal.id)?.connectionIssue || reasons.some(r=> /credential|api key|unauthori[sz]ed|authentication|provider configuration|worker connection/i.test(r ?? ''));
  const updatedAt = lastTime(metadata.get(goal.id)?.updatedAt,goal.updatedAt,goal.createdAt,...tasks.map(t=>lastTime(t.updatedAt,t.lastActivityAt)),...(snapshot.agents ?? []).filter(a=>a.goalId === goal.id).map(a=>a.lastReport?.at));
  return {project, card:{id:goal.id,projectId:project.id,title:plain(goal.objective,400) || 'Untitled handoff',lane,
    status:goalState==='partial' ? 'Ended early' : lane==='attention' && connection ? 'Check provider connection' : statuses[state] || plain(state,60).replaceAll('_',' ') || 'Unknown',
    host:hostFor(goal,snapshot.agents ?? []),worker:workerFor(goal,tasks),updatedAt,
    ...(lane==='attention'?{action:connection?'connection':'host'}:{})}};
}
export function projectBoard(snapshot, metadata = new Map()) {
  const projects = new Map(), cards = [];
  for (const goal of snapshot.goals ?? []) {
    const {project,card} = cardFor(goal,snapshot,metadata);
    cards.push(card);
    projects.set(project.id,project);
  }
  cards.sort((a,b)=>(b.updatedAt ?? 0)-(a.updatedAt ?? 0));
  const allProjects=[...projects.values()];
  const labels=allProjects.map(({id,name,parent,history})=>{
    const group=history ? {history:true} : {};
    const peers=allProjects.filter(p=>p.name===name);
    if (peers.length===1) return {id,name,...group};
    const suffix=parent && !peers.some(p=>p.id!==id && p.parent===parent) ? parent : id.slice(0,6);
    return {id,name:name+' · '+suffix,...group};
  });
  return {projects:labels.sort((a,b)=>a.name.localeCompare(b.name)),cards,
    latest:cards[0]?.updatedAt ? {title:cards[0].title,at:cards[0].updatedAt} : null,
    truncated:Boolean(snapshot.overflow?.tasks || snapshot.goals?.length >= (snapshot.limits?.goals ?? Infinity))};
}
export const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
export async function observerAction(method, payload, context) {
  const sources = {preview:'Mosaic Beta', installed:'Mosaic', legacy:'Mosaic Preview'};
  if (typeof payload.source !== 'string' || !Object.hasOwn(sources,payload.source) || !['observer.board','observer.detail'].includes(method)) throw Error('Choose a Mosaic source.');
  const detail = method === 'observer.detail';
  if (detail && !validId(payload.id)) throw Error('Choose a saved handoff.');
  const {client} = await import('../../src/beta/client.mjs');
  const state = path.join(context.home,'Library','Application Support',sources[payload.source],'state');
  const invoke = client({home:context.home,state},{viewer:true,timeoutMs:6500});
  let snapshot;
  try { snapshot = await invoke('observer_snapshot',detail?{goalId:payload.id}:{}); }
  catch { throw Error(detail?'This handoff is unavailable. Refresh its board.':'Coordinator unavailable. Check the source in Connections and retry.'); }
  if (detail && !snapshot.goals.some(g=>g.id === payload.id)) throw Error('Handoff unavailable in this source.');
  const metadata = await readProjectIndex(state,snapshot.goals.map(g=>g.id),snapshot.tasks);
  const board = projectBoard(snapshot,metadata);
  if (!detail) return board;
  return loadDetail(snapshot, board.cards.find(c=>c.id===payload.id), invoke, state);
}
