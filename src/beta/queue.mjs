import path from 'node:path';
import {createInterface} from 'node:readline/promises';
import {client} from './client.mjs';
import {jsonFile} from './files.mjs';
import {digest} from '../harness/contracts.mjs';
import {MAX_BACKLOG_ITEMS, validateBacklogInput} from '../harness/backlog/contract.mjs';
import {chooseGoal, confirmTerminal, deadlineLabel, terminalText as clean} from './owner-terminal.mjs';

const goalLabel = goal => `${clean(goal.manifest.objective)} [${goal.id}]`;
const duration = ms => Number.isFinite(ms) ? `${Math.floor(ms / 3600000)}h ${Math.floor(ms / 60000) % 60}m ${Math.floor(ms / 1000) % 60}s` : 'unavailable';
const priority = row => {
 const value = row.priority ?? row.spec?.priority;
 const effective = row.effectivePriority;
 return effective && effective !== value ? `${value} → ${effective}` : value ?? 'unspecified';
};
const checkResult = row => row?.outcome?.checks
 ? `${row.outcome.checks.passed}/${row.outcome.checks.total} passed`
 : row?.lastCheck?.status ?? 'no saved check verdict';
const reviewResult = row => row?.review?.decision ? row.outcome.review : row?.review?.status ?? row?.outcome?.review ?? 'no saved reviewer verdict';

function showQueue(goal, backlog, groupOnly) {
 const lines = [
  'Mosaic queue', goalLabel(goal),
  `Status ${goal.status} · approval v${goal.version} · deadline ${deadlineLabel(goal.deadline)}`,
  `Assignments ${goal.tasks.length}/${goal.manifest.limits.maxTasks} · original window ${goal.manifest.limits.hours}h`,
 ];
 const grouped = new Set();
 const tasks = new Map(goal.tasks.map(task => [task.id, task]));
 for (const group of backlog.groups) {
  lines.push('', `${clean(group.submissionId)} [${group.id}] · ${group.status}`, clean(group.explanation));
  for (const item of group.items) {
   grouped.add(item.taskId);
   const dependencies = tasks.get(item.taskId)?.spec.dependsOn;
   lines.push(`  ${clean(item.key)} · ${item.status} · priority ${priority(item)}`,
    `    ${clean(item.objective)} [${item.taskId}]`,
    `    ${clean(item.explanation)}`);
   if (dependencies?.length) lines.push(`    Depends on ${dependencies.join(', ')}`);
   if (item.priorityExplanation) lines.push(`    ${clean(item.priorityExplanation)}`);
  }
 }
 const other = groupOnly ? [] : goal.tasks.filter(task => !grouped.has(task.id));
 if (other.length) {
  lines.push('', backlog.nextCursor ? 'Other assignments in this display' : 'Other saved assignments');
  for (const task of other) {
   lines.push(`  ${clean(task.spec.objective)} [${task.id}] · ${task.status} · ${priority(task)}`);
   if (task.reason) lines.push(`    ${clean(task.reason)}`);
   if (task.spec.dependsOn.length) lines.push(`    Depends on ${task.spec.dependsOn.join(', ')}`);
  }
 }
 if (backlog.nextCursor) lines.push(`Older groups · mosaic queue ${goal.id} --next ${backlog.nextCursor}`);
 if (goal.overflow) lines.push('Some assignments are outside this bounded view.');
 if (!goal.tasks.length) lines.push('No saved assignments.');
 return lines.join('\n') + '\n';
}

async function guidedBatch(goal, {input = process.stdin, output, ask}) {
 if (!ask && (!input.isTTY || !output.isTTY)) throw Error('Open an interactive terminal, or use --preview BATCH.json.');
 const slots = Math.min(MAX_BACKLOG_ITEMS, goal.manifest.limits.maxTasks - goal.tasks.length);
 if (slots <= 0) throw Error('The selected goal has no approved assignment slots remaining.');
 if (goal.manifest.mode.id === 'overnight_review' && goal.manifest.mode.version === 2) {
  throw Error('This goal uses its approved planner graph. Open the saved queue to see its stages.');
 }
 const kinds = goal.manifest.mode.capabilities.filter(kind =>
  ['coding', 'consult', 'learning'].includes(kind) && (kind !== 'coding' || goal.manifest.project));
 if (!kinds.length) throw Error('This goal has no supported assignment types.');
 const reader = ask ? null : createInterface({input, output});
 const prompt = async message => (await (ask ? ask(message) : reader.question(message))).trim();
 const items = [];
 try {
  output.write(`Add to ${goalLabel(goal)} · up to ${slots} assignments within the existing approval\n`);
  for (let number = 1; number <= slots; number++) {
   const objective = await prompt(`Assignment ${number} objective (Enter to finish the draft)  `);
   if (!objective) break;
   const kind = (await prompt(`Type [${kinds.join('/')}] (${kinds[0]})  `)) || kinds[0];
   if (!kinds.includes(kind)) throw Error('Choose a supported assignment type.');
   const acceptance = await prompt('What has to be true when it is done?  ');
   if (!acceptance) throw Error('Give each assignment an acceptance criterion.');
   const priority = (await prompt('Priority [normal/blocking/background] (normal)  ')) || 'normal';
   if (!['normal', 'blocking', 'background'].includes(priority)) throw Error('Choose a listed priority.');
   const dependencies = number > 1 ? await prompt(`Depends on assignment numbers 1–${number - 1}, separated by commas (Enter for none)  `) : '';
   const dependsOnKeys = dependencies ? dependencies.split(',').map(value => {
    const index = value.trim();
    if (!/^[1-9][0-9]*$/u.test(index) || Number(index) >= number) throw Error('Dependencies must be earlier assignment numbers.');
    return 'assignment-' + index;
   }) : [];
   items.push({key: 'assignment-' + number, task: {kind, objective, acceptance: [acceptance], priority}, dependsOnKeys});
  }
  return items;
 } finally { reader?.close(); }
}

export async function runQueue(paths, args = [], options = {}) {
 const [goalId, action, file, ...extra] = args;
 const invoke = options.invoke ?? client(paths);
 const output = options.output ?? process.stdout;
 if (extra.length || action && !(action === '--add' && !file || ['--preview', '--submit', '--group', '--next'].includes(action) && file)) {
  throw Error('Use mosaic queue [GOAL_ID] [--add | --preview BATCH.json | --submit BATCH.json | --group GROUP_ID | --next CURSOR].');
 }
 const isBatch = ['--preview', '--submit', '--add'].includes(action);
 const goal = await chooseGoal(invoke, goalId, {active: isBatch});
 if (!isBatch) {
  const backlog = await invoke('backlog_inspect', {goalId: goal.id, limit: 20, ...(action === '--group' ? {groupId: file} : action === '--next' ? {cursor: file} : {})});
  if (action === '--group' && !backlog.groups.length) throw Error('No matching saved group in this goal.');
  output.write(showQueue(goal, backlog, !!action));
  return 0;
 }
 const items = action === '--add' ? await guidedBatch(goal, {...options, output})
  : await jsonFile(path.resolve(file), {max: 256 * 1024});
 if (action === '--add' && !items.length) {
  output.write('No assignments added.\n');
  return 0;
 }
 const submissionId = 'mosaic-batch-' + digest([goal.id, goal.version, goal.hash, items]);
 const batch = {goalId: goal.id, expectedGoalHash: goal.hash, expectedGoalVersion: goal.version, submissionId, items};
 const ordered = validateBacklogInput(batch);
 const preview = await invoke('backlog_preview', batch);
 output.write(`Mosaic batch preview · ${goalLabel(goal)}\nApproval v${goal.version} · deadline ${deadlineLabel(goal.deadline)}\n`);
 if (!preview.valid) {
  for (const issue of preview.errors) output.write(clean(issue.message) + '\n');
  return 1;
 }
 if (preview.goalId !== goal.id || preview.goalHash !== goal.hash || preview.goalVersion !== goal.version) {
  throw Error('The approval changed. Review a fresh preview.');
 }
 for (const {key, task, dependsOnKeys} of ordered) {
  const route = preview.routes?.find(row => row.key === key)?.route;
  if (task.kind === 'coding' && !task.permissions && !goal.manifest.project?.scopeComplete) {
   throw Error('The project scope is too large to display. Provide an explicit narrower read, write and check scope for each coding assignment.');
  }
  const permissions = task.permissions ?? (task.kind === 'coding' ? goal.manifest.project : null);
  output.write(`  ${key} · ${task.kind} · ${task.priority ?? 'normal'} · ${clean(task.objective)}\n`);
  for (const criterion of task.acceptance) output.write(`    Accept when ${clean(criterion)}\n`);
  if (dependsOnKeys.length) output.write(`    Depends on ${dependsOnKeys.join(', ')}\n`);
  if (permissions) {
   output.write(`    Reads ${clean(permissions.readPaths.join(', '))} · writes ${clean(permissions.writePaths.join(', '))}\n`);
   output.write(`    Checks ${clean(permissions.checks.join(', '))}\n`);
  }
  for (const field of ['actor', 'context', 'limits', 'routing', 'scope', 'role']) {
   if (task[field] !== undefined) output.write(`    ${field} ${clean(typeof task[field] === 'string' ? task[field] : JSON.stringify(task[field]))}\n`);
  }
  if (route) output.write(`    Routing ${clean(route.explanation ?? route.status)}\n`);
 }
 if (action === '--preview') return 0;
 if (!await confirmTerminal('Submit these exact assignments to the active goal? The existing scheduler may start eligible work', {...options, output})) {
  output.write('Batch declined.\n');
  return 0;
 }
 const receipt = await invoke('backlog_submit', {...batch, idempotencyKey: submissionId});
 output.write(`Saved ${receipt.items.length} assignments in group ${receipt.id}.\n`);
 return 0;
}

export async function runMorningReport(paths, args = [], options = {}) {
 if (args.length > 1) throw Error('Use mosaic morning-report [GOAL_ID].');
 const invoke = options.invoke ?? client(paths);
 const output = options.output ?? process.stdout;
 const goal = await chooseGoal(invoke, args[0]);
 const [report, snapshot] = await Promise.all([
  invoke('outcomes_report', {goalId: goal.id, limit: 100}),
  invoke('observer_snapshot', {goalId: goal.id}),
 ]);
 const rows = new Map(snapshot.tasks.map(task => [task.id, task]));
 const durations = new Map(report.timing.tasks.map(row => [row.id, row.wallElapsedMs]));
 const summedUsage = kind => {
  const field = report.usage[kind];
  return `${field.knownTokens ?? 'unknown'} tokens · recorded for ${field.knownRequests} of ${field.eligibleRequests} completed requests`;
 };
 const lines = [
  'Mosaic morning report', goalLabel(goal), `As of ${clean(report.generatedAt)}`,
  `${goal.status} · ${report.counts.acceptedCoding} verified integrations · ${report.counts.nonterminal} open assignments`,
  `Elapsed ${duration(report.timing.goals.find(row => row.id === goal.id)?.wallElapsedMs)} · deadline ${deadlineLabel(goal.deadline)}`,
  `Assignments ${goal.tasks.length}/${goal.manifest.limits.maxTasks} · ${Math.max(0, goal.manifest.limits.maxTasks - goal.tasks.length)} approval slots remaining`,
  '',
  `Worker and API reviewer usage · input ${summedUsage('input')} · output ${summedUsage('output')}`,
  `${report.usage.reservations} recorded reservations · ${report.usage.uncertainRequests} uncertain requests`,
  `Native host usage · ${clean(report.usage.nativeHost.reason)}`,
 ];
 if (goal.reviewBudget) lines.push(`Assigned review reservations · ${goal.reviewBudget.spent}/${goal.reviewBudget.limit} used · ${goal.reviewBudget.remaining} remaining`);
 if (!report.coverage.complete || snapshot.overflow?.tasks || goal.overflow) lines.push('Evidence coverage is partial. Usage and outcomes describe the saved scope shown.');
 lines.push('', 'Assignments');
 for (const task of goal.tasks) {
  const row = rows.get(task.id);
  const commit = task.integration?.commit ?? row?.candidate?.commit ?? task.candidateCommit;
  lines.push(`  ${clean(task.spec.objective)} [${task.id}] · ${task.status} · ${duration(durations.get(task.id))}`);
  if (task.spec.kind === 'coding') lines.push(`    Checks ${checkResult(row)} · assigned review ${reviewResult(row)}`);
  if (commit) lines.push(`    ${task.integration?.commit ? 'Integrated commit' : 'Candidate commit'} ${clean(commit)}`);
  if (task.reason) lines.push(`    ${clean(task.reason)}`);
  if (row?.evidenceRef) lines.push(`    Saved evidence ${clean(row.evidenceRef)}`);
  if (task.spec.limits?.modelCalls !== undefined) {
   const remaining = Math.max(0, task.spec.limits.modelCalls - task.spent.model);
   lines.push(`    Model call reservations ${task.spent.model}/${task.spec.limits.modelCalls} · ${remaining} remaining · deadline ${deadlineLabel(task.deadline)}`);
  }
 }
 lines.push('', 'Needs you');
 for (const item of snapshot.needsYou?.items ?? []) lines.push(`  ${clean(item.title)} [${item.id}] · ${clean(item.detail)}`);
 if (snapshot.needsYou?.hasMore) lines.push('  More saved decisions are available in Needs You.');
 if (!snapshot.needsYou?.items?.length) lines.push(snapshot.needsYou ? '  No saved decisions.' : '  Inbox unavailable.');
 output.write(lines.join('\n') + '\n');
 return 0;
}
