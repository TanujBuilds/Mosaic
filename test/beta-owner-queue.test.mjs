import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {lstat, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {locations} from '../src/beta/files.mjs';
import {readProjectPreset, runProjectPreset} from '../src/beta/project-presets.mjs';
import {runMorningReport, runQueue} from '../src/beta/queue.mjs';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';

const workerProfile = {displayName: 'Fixture', baseUrl: 'http://127.0.0.1:8989/v1',
 model: 'fixture', revision: 'r1', streaming: false};
const outputBuffer = () => ({text: '', write(value) { this.text += value; }});
const sandbox = async t => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'mosaic-owner-queue-'));
 t.after(() => rm(root, {recursive: true, force: true}));
 return root;
};

test('guided queue previews actual dependency order and requires consent before saving', async t => {
 const root = await sandbox(t);
 const c = new Coordinator({root, beta: true, workerProfile, now: () => 1000});
 t.after(() => c.close());
 const d = new Dispatcher({c, config: {beta: true}});
 const invoke = (name, input) => d.invoke(name, input);
 const goal = c.prepareGoal({submissionId: 'queue', objective: 'Review sample notes', acceptance: ['Record result'],
  mode: 'deepseek_only', environment: 'fixture', limits: {maxTasks: 3, hours: 4}}, 'prepare');
 c.activateGoal({goalId: goal.id, hash: goal.hash}, 'activate');
 const output = outputBuffer();
 const values = ['Read notes', 'consult', 'Read locally', 'background',
  'Summarize notes', 'consult', 'Summary saved', 'blocking', '1', ''];
 async function add(approved) {
  const choices = [...values];
  return runQueue({}, [goal.id, '--add'], {invoke, output, ask: async () => choices.shift(), confirm: async () => approved});
 }
 await add(false);
 assert.equal(c.getGoal(goal.id).tasks.length, 0);
 assert.match(output.text, /Depends on assignment-1/);
 await add(true);
 const actual = c.getGoal(goal.id);
 assert.equal(actual.tasks.length, 2);
 assert.equal(actual.deadline, 1000 + 4 * 3600000);
 assert.deepEqual(actual.tasks[1].spec.dependsOn, [actual.tasks[0].id]);
 await runQueue({}, [goal.id], {invoke, output});
 assert.match(output.text, /background → blocking/);
 assert.match(output.text, /unfinished dependent/);
 assert.match(output.text, new RegExp(actual.tasks[0].id));
 assert.equal(c.store.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0);
});

test('batch replay preserves task identity and morning report omits bulky saved task data', async t => {
 const root = await sandbox(t);
 const c = new Coordinator({root, beta: true, workerProfile, now: () => 5000});
 t.after(() => c.close());
 const d = new Dispatcher({c, config: {beta: true}});
 const invoke = (name, input) => d.invoke(name, input);
 const goal = c.prepareGoal({submissionId: 'replay', objective: 'Review sample notes', acceptance: ['Record result'],
  mode: 'deepseek_only', environment: 'fixture'}, 'prepare');
 c.activateGoal({goalId: goal.id, hash: goal.hash}, 'activate');
 const file = path.join(root, 'batch.json'), output = outputBuffer();
 await writeFile(file, JSON.stringify([{key: 'read', task: {kind: 'consult', objective: 'Read notes', acceptance: ['Notes read']}, dependsOnKeys: []}]));
 const options = {invoke, output, confirm: async () => true};
 await runQueue({}, [goal.id, '--preview', file], options);
 assert.equal(c.getGoal(goal.id).tasks.length, 0);
 await runQueue({}, [goal.id, '--submit', file], options);
 await runQueue({}, [goal.id, '--submit', file], options);
 const view = await invoke('owner_goal_view', {goalId: goal.id});
 assert.equal(view.tasks.length, 1);
 assert.equal(Object.hasOwn(view.tasks[0], 'result'), false);
 assert.equal(view.tasks[0].spec.objective, 'Read notes');
 await runMorningReport({}, [goal.id], options);
 assert.match(output.text, /0 verified integrations · 1 open assignments/);
 assert.match(output.text, /Worker and API reviewer usage · input unknown tokens/);
 assert.match(output.text, /Native host usage ·/);
});

test('project presets require confirmation and share suggestions between linked Git worktrees', async t => {
 const root = await sandbox(t), paths = locations(root, true), linked = path.join(root, 'linked');
 const repo = path.join(root, 'checkout');
 execFileSync('git', ['init', '--quiet', repo]);
 execFileSync('git', ['-C', repo, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Mosaic fixture',
  '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--allow-empty', '-m', 'Fixture']);
 execFileSync('git', ['-C', repo, 'worktree', 'add', '--quiet', '--detach', linked]);
 const scope = {repo, checkSuggestions: [{id: 'unit', definitionHash: 'e'.repeat(64)}]};
 const goal = {id: 'project-draft', manifest: {environment: 'live', mode: {id: 'codex_only'}, project: scope}};
 const options = {output: outputBuffer(), invoke: async name => {
  assert.equal(name, 'owner_goal_view');
  return goal;
 }};
 await runProjectPreset(paths, ['save', '--goal', goal.id], {...options, confirm: async () => false});
 assert.equal(await readProjectPreset(paths, linked), null);
 await runProjectPreset(paths, ['save', '--goal', goal.id], {...options, confirm: async () => true});
 assert.deepEqual(await readProjectPreset(paths, linked), {mode: 'codex_only', workerId: null, checks: scope.checkSuggestions});
 const [filename] = (await readdir(paths.configDir)).filter(name => name.startsWith('project-preset-'));
 const file = path.join(paths.configDir, filename);
 assert.equal((await lstat(file)).mode & 0o777, 0o600);
 assert.doesNotMatch(await readFile(file, 'utf8'), /checkout|approval|permissions|credential|baseCommit/);
 await runProjectPreset(paths, ['clear', '--repo', linked], {...options, confirm: async () => true});
 assert.equal(await readProjectPreset(paths, repo), null);
});
