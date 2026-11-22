// The existing priority propagation remains authoritative. Stable sequence order
// ensures contenders with equal priority have deterministic admission.
export function orderedCandidates(c,tasks){
 const priorities=c.effectivePriorities(tasks);
 return tasks.filter(t=>['queued','suspended'].includes(t.status)&&t.spec.actor==='deepseek'&&t.executionActor!=='codex'&&c.eligible(t)).sort((a,b)=>priorities.get(b.id)-priorities.get(a.id)||a.sequence-b.sequence||a.id.localeCompare(b.id));
}
