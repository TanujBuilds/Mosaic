import {createInterface} from 'node:readline/promises';
import {identifier} from '../harness/contracts.mjs';

export const terminalText = value => String(value ?? '').replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ');
export const deadlineLabel = time => Number.isFinite(time) && Math.abs(time) <= 8.64e15 ? new Date(time).toISOString() : 'Unavailable';

export async function chooseGoal(invoke, goalId, {active = false} = {}) {
 if (!goalId) {
  const {goals, truncated} = await invoke('goal_get');
  const eligible = active ? goals.filter(goal => goal.status === 'active') : goals;
  if (truncated || eligible.length !== 1) {
   const rows = eligible.map(goal => `  ${goal.id}  ${goal.status} · ${terminalText(goal.objective)}`);
   throw Error(['Provide a Mosaic goal ID.', ...rows].join('\n'));
  }
  goalId = eligible[0].id;
 }
 identifier(goalId, 'goal ID');
 const goal = await invoke('owner_goal_view', {goalId});
 if (goal.id !== goalId) throw Error('Mosaic returned a different goal.');
 if (active && goal.status !== 'active') throw Error('Select an active approved Mosaic goal.');
 return goal;
}

export async function confirmTerminal(message, {input = process.stdin, output = process.stdout, confirm} = {}) {
 if (confirm) return await confirm(message) === true;
 if (!input.isTTY || !output.isTTY) throw Error('This change needs confirmation in an interactive terminal.');
 const reader = createInterface({input, output});
 try {
  return /^y(?:es)?$/iu.test((await reader.question(message + ' [y/N] ')).trim());
 } finally { reader.close(); }
}
