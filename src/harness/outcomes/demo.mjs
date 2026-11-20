import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Coordinator} from '../coordinator.mjs';
import {Goals} from '../goals.mjs';
import {Integration} from '../integration.mjs';
import {Worker} from '../worker.mjs';
import {command, git} from '../../project/process.mjs';

// Only the explicit CLI demo calls this. The supplied root must be disposable.
export async function createOutcomeDemo(root, {firstTask = false} = {}) {
  const repo = path.join(root, 'repo');
  const stateRoot = path.join(root, 'state');
  await mkdir(path.join(repo, 'src'), {recursive: true});
  await mkdir(path.join(repo, 'checks'));
  await writeFile(path.join(repo, 'src/value.mjs'), 'export const value = 0;\n');
  await writeFile(path.join(repo, 'checks/verify.mjs'),
    "import {value} from " + "'../src/value.mjs'; if (value !== 42) process.exit(1);\n");
  await git(repo, 'init', '-q');
  await git(repo, 'add', '.');
  await git(repo, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', 'commit', '-qm', 'Fixture baseline');
  const c = new Coordinator({root: stateRoot});
  try {
    const goal = c.prepareGoal({
      submissionId: 'demo-goal',
      objective: firstTask ? 'Change a sample project value from 0 to 42' : 'Demonstrate outcome measurement with disposable coding evidence',
      acceptance: ['Run the protected check'],
      mode: 'collaborative',
      environment: 'fixture',
      project: {
        repo,
        baseCommit: await git(repo, 'rev-parse', 'HEAD'),
        readPaths: ['src/', 'checks/'],
        writePaths: ['src/'],
        checks: [{id: 'verify', argv: [process.execPath, 'checks/verify.mjs']}],
        behavioralChecks: [{criterionId: 'fixture-value', description: 'Verify the fixture value', checkIds: ['verify']}],
      },
    }, 'demo-prepare');
    c.activateGoal({goalId: goal.id, hash: goal.hash}, 'demo-activate');
    const submit = (id, objective) => c.submitTask({
      goalId: goal.id, submissionId: id, kind: 'coding', objective, acceptance: ['Pass the protected check'],
    }, 'demo-submit-' + id);
    const candidate = submit('candidate', 'Change the fixture value to 42');
    const checksFactory = workspace => ({
      verify: async () => ({fixture: true}),
      run: checks => Promise.all(checks.map(async check => {
        const result = await command(check.argv, {cwd: workspace.root, env: {PATH: process.env.PATH}});
        return {...result, id: check.id, argv: check.argv, passed: result.code === 0, screenshots: []};
      })),
    });
    let calls = 0;
    const provider = {complete: async messages => {
      const input = JSON.parse(messages.at(-1).content);
      const file = input.files.find(entry => entry.path === 'src/value.mjs');
      return {
        model: 'fixture-model',
        content: JSON.stringify({
          type: 'submit_changes',
          paths: [],
          edits: [{path: file.path, action: 'write', baseHash: file.hash, content: 'export const value = 42;\n'}],
          summary: 'Set the fixture value',
        }),
        ...(++calls === 1 ? {usage: {prompt_tokens: 10, completion_tokens: 5}} : {}),
      };
    }};
    const worker = new Worker({c, provider, checksFactory, config: {environment: 'fixture'}});
    await worker.drain();
    if (!firstTask) {
      c.review({taskId: candidate.id, decision: 'revise', feedback: 'Confirm the value against the protected check'}, 'demo-revise');
      await worker.drain();
    }
    await new Integration({c, checksFactory}).accept(
      {taskId: candidate.id, feedback: 'Fixture operator accepted the candidate and protected checks'}, 'demo-integrate',
    );

    if (firstTask) {
      new Goals(c).finalize({goalId: goal.id, summary: 'The sample change passed its protected check and was integrated.'}, 'demo-finalize');
    } else {
      const blocked = submit('blocked', 'Demonstrate a blocked task after execution starts');
      if (c.claimNext('demo-owner')?.id !== blocked.id) throw Error('Demo did not claim the blocked fixture task');
      c.failTaskStep(blocked.id, 'demo-owner', 'Fixture prerequisite unavailable');
      submit('queued', 'Demonstrate a task that has never started');
    }

    return {stateRoot, goalId: goal.id};
  } finally {
    c.close();
  }
}
