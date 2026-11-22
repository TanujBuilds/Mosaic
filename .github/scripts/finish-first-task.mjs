// This operates on the disposable repository created by installer.yml. Drive
// the same coordinator checks and approve only the comment created below.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile, realpath, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
const project = await realpath(path.join(process.env.RUNNER_TEMP, 'First Mosaic project'));
const runtime = path.resolve(path.dirname(process.execPath), '..');
const load = file => import(pathToFileURL(path.join(runtime, 'src/beta', file)));
const {client} = await load('client.mjs');
const {locations} = await load('files.mjs');
const paths = locations(os.homedir());
const invoke = client(paths);
const [goalId] = process.argv.slice(2);
assert.match(goalId, /^[a-f0-9-]{36}$/);
const goal = await invoke('goal_get', {goalId});
assert.equal(goal.status, 'draft');
assert.equal(goal.manifest.mode.id, 'codex_only');
assert.equal(await realpath(goal.manifest.project.repo), project);
assert.deepEqual(goal.manifest.project.writePaths, ['src/value.mjs']);

const mutate = (name, args) => invoke(name, {...args, idempotencyKey: 'first-install-' + name});
async function runOperation(name, args) {
  const operation = await mutate(name, args);
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const saved = await invoke('operation_get', {operationId: operation.id});
    if (saved.status === 'completed') return saved.result;
    if (['failed', 'uncertain'].includes(saved.status)) throw Error(name + ': ' + saved.error);
    await sleep(250);
  }
  throw Error(name + ' timed out');
}

await mutate('goal_activate', {goalId, hash: goal.hash});
const task = await mutate('task_submit', {goalId, task: {
  submissionId: 'document-value', actor: 'codex', kind: 'coding',
  objective: goal.manifest.objective, acceptance: goal.manifest.acceptance,
}});
const taskId = task.id;
const started = await runOperation('native_start', {taskId, layout: 'candidate_v1'});
const candidate = await realpath(started.native.worktree);
assert.ok(candidate.startsWith(await realpath(paths.state) + path.sep));
const file = path.join(candidate, 'src/value.mjs');
const original = 'export const value = 1;\n';
const updated = '// Default value returned by this example.\n' + original;
assert.equal(await readFile(file, 'utf8'), original);
await writeFile(file, updated);
await runOperation('native_finish', {taskId, summary: 'Documented the example value.'});

const inbox = await invoke('review_inbox', {goalId});
const item = inbox.items.find(entry => entry.taskId === taskId);
assert.ok(item, 'The first task must pass checks and reach review');
assert.equal(await readFile(file, 'utf8'), updated);
const ticket = await mutate('review_reserve', item.binding);
await mutate('review_submit', {ticketId: ticket.ticketId, ...item.binding, verdict: {
  decision: 'accept', feedback: 'Installer smoke test reviewed the expected example comment and passing check.', findings: [],
}});
const owner = await invoke('owner_action_context', {goalId, taskId});
const accepted = await runOperation('task_integrate', {taskId, expectedIntegrationBinding: owner.candidate.binding,
  feedback: 'Integrate the checked comment in the disposable smoke-test repository.'});
assert.equal(accepted.status, 'accepted');
assert.ok(accepted.integration.checks.length && accepted.integration.checks.every(check => check.passed));
assert.equal(execFileSync('/usr/bin/git', ['-C', project, 'show', accepted.integration.commit + ':src/value.mjs'],
  {encoding: 'utf8'}), updated);
console.log('First task accepted at commit', accepted.integration.commit);
