#!/usr/bin/env node
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {startApi} from '../src/harness/api.mjs';
import {main as harnessCli} from '../src/harness/cli.mjs';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {isEntry} from '../src/harness/entry.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {command, git} from '../src/project/process.mjs';
import {assertNoGitRepositoryOverride} from './lib/git-environment.mjs';

const usage = [
  'list --root STATE_DIR',
  'inspect --root STATE_DIR --id RECIPE_ID --version VERSION',
  'preview --root STATE_DIR --input PREVIEW_JSON',
  'submit --root STATE_DIR --input SUBMIT_JSON --idempotency-key KEY',
  'demo --output NEW_DIRECTORY'
];
const options = {
  list: ['root'],
  inspect: ['root', 'id', 'version'],
  preview: ['root', 'input'],
  submit: ['root', 'input', 'idempotency-key'],
  demo: ['output']
};
const recipeCliPath = fileURLToPath(import.meta.url);
const harnessCliPath = fileURLToPath(new URL('../src/harness/cli.mjs', import.meta.url));

const encode = value => JSON.stringify(value, null, 2) + '\n';
function resultJson(result) {
  if (result.code !== 0) throw Error(result.stderr.trim() || 'Fixture CLI command failed');
  return JSON.parse(result.stdout);
}

async function demo(output) {
  // Git can target a different repository even when its working directory is the fixture.
  await assertNoGitRepositoryOverride('demo');
  await mkdir(output, {mode: 0o700}).catch(error => {
    if (error.code === 'EEXIST') throw Error('Demo output directory already exists');
    throw error;
  });
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'mosaic-workflow-recipes-'));
  let c, worker, api, dispatcher;
  try {
    const repo = path.join(scratch, 'repo');
    const root = path.join(scratch, 'state');
    await mkdir(path.join(repo, 'src'), {recursive: true});
    await mkdir(path.join(repo, 'checks'));
    const original = 'export const answer = 0;\n';
    const corrected = 'export const answer = 42;\n';
    await writeFile(path.join(repo, 'src/answer.mjs'), original);
    await writeFile(path.join(repo, 'src/unrelated.mjs'), 'export const unrelated = true;\n');
    await writeFile(path.join(repo, 'checks/verify.mjs'),
      "import assert from 'node:assert/strict';\nimport {answer} from '../src/answer.mjs';\nassert.equal(answer, 42);\n");
    for (const args of [
      ['init', '-q'], ['config', 'user.name', 'Recipe fixture'],
      ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['commit', '-qm', 'Fixture base']
    ]) await git(repo, ...args);
    const baseCommit = await git(repo, 'rev-parse', 'HEAD');

    const config = {environment: 'fixture'};
    c = new Coordinator({root});
    let fixtureReplies = 0;
    worker = new Worker({c, config, provider: {
      async complete(messages) {
        const {files} = JSON.parse(messages.at(-1).content);
        const file = files.find(entry => entry.path === 'src/answer.mjs');
        assert.ok(file, 'Fixture worker must receive the approved source file');
        fixtureReplies++;
        return {content: JSON.stringify({
          type: 'submit_changes',
          paths: [],
          edits: [{path: file.path, action: 'write', baseHash: file.hash, content: corrected}],
          summary: 'Fixture response supplies the scoped correction'
        })};
      }
    }});
    dispatcher = new Dispatcher({c, worker, config});
    const token = randomBytes(32).toString('hex');
    api = await startApi({dispatcher, token, headless: true});
    await writeFile(path.join(root, 'connection.json'), encode({url: api.url, token}), {mode: 0o600});
    const call = async (tool, input) => resultJson(await command([
      process.execPath, harnessCliPath, 'call', '--root', root, '--tool', tool,
      '--input-json', JSON.stringify(input)
    ]));
    const recipe = async (action, name, input, key) => {
      const file = path.join(scratch, name + '.json');
      await writeFile(file, encode(input), {mode: 0o600});
      return command([
        process.execPath, recipeCliPath, action, '--root', root, '--input', file,
        ...(key ? ['--idempotency-key', key] : [])
      ]);
    };
    const goal = await call('legacy_goal_prepare', {idempotencyKey: 'fixture-prepare', manifest: {
      submissionId: 'fixture-goal',
      objective: 'Verify a scoped recipe in a disposable repository',
      acceptance: ['Protected behavior check passes'],
      environment: 'fixture',
      mode: 'collaborative',
      project: {
        repo, baseCommit,
        readPaths: ['src/', 'checks/'],
        writePaths: ['src/'],
        checks: [{id: 'verify', argv: [process.execPath, 'checks/verify.mjs']}]
      }
    }});
    await call('goal_activate', {goalId: goal.id, hash: goal.hash, idempotencyKey: 'fixture-activate'});

    const parameters = {
      issue: 'Return 42 from the answer module',
      context: 'The fixture currently exports zero.',
      readPaths: ['src/answer.mjs', 'checks/verify.mjs'],
      writePaths: ['src/answer.mjs'],
      checks: ['verify']
    };
    const previewInput = {goalId: goal.id, recipeId: 'bugfix', version: 1, parameters};
    const preview = resultJson(await recipe('preview', 'preview', previewInput));
    assert.equal(preview.launchable, true, JSON.stringify(preview.diagnostics));
    const submission = {
      ...previewInput,
      expectedGoalHash: preview.goalHash,
      definitionDigest: preview.definitionDigest,
      parameterDigest: preview.parameterDigest,
      previewDigest: preview.previewDigest,
      submissionId: 'fixture-bugfix'
    };
    const taskCountBefore = (await call('goal_get', {goalId: goal.id})).tasks.length;
    const stale = await recipe('submit', 'stale', {
      ...submission, parameters: {...parameters, issue: 'Return 7 from the answer module'}
    }, 'fixture-stale');
    assert.equal(stale.code, 1, 'A stale recipe submission must fail');
    assert.match(stale.stderr, /parameter|preview/i);
    const taskCountAfter = (await call('goal_get', {goalId: goal.id})).tasks.length;
    assert.equal(taskCountAfter, taskCountBefore, 'Stale submission created work');

    const receipt = resultJson(await recipe('submit', 'submit', submission, 'fixture-submit'));
    const replay = resultJson(await recipe('submit', 'replay', submission, 'fixture-submit'));
    assert.deepEqual(replay, receipt);
    assert.equal(receipt.tasks.length, 1);
    const [taskId] = receipt.tasks;
    const submitted = await call('task_get', {taskId});
    assert.deepEqual(submitted.spec.permissions, {
      readPaths: parameters.readPaths,
      writePaths: parameters.writePaths,
      checks: parameters.checks
    });
    assert.equal(submitted.spec.context, parameters.context);
    await worker.drain({maxSteps: 30});
    const candidate = await call('task_get', {taskId});
    assert.equal(candidate.status, 'awaiting_review', candidate.reason);
    assert.equal(fixtureReplies, 1);
    assert.match(candidate.result.diff, /\+export const answer = 42;/);
    const checkSummary = checks => checks.map(({id, passed}) => ({id, passed}));
    const checks = checkSummary(candidate.result.checks);
    assert.deepEqual(checks, [{id: 'verify', passed: true}]);
    const operation = await call('task_integrate', {
      taskId,
      feedback: 'Fixture driver verified the expected diff and protected check.',
      idempotencyKey: 'fixture-integrate'
    });
    await dispatcher.whenIdle();
    const integration = await call('operation_get', {operationId: operation.id});
    assert.equal(integration.status, 'completed', integration.error);
    const accepted = await call('task_get', {taskId});
    const integratedChecks = checkSummary(accepted.integration.checks);
    assert.deepEqual(integratedChecks, [{id: 'verify', passed: true}]);
    assert.equal(accepted.status, 'accepted');
    assert.equal(await readFile(path.join(repo, 'src/answer.mjs'), 'utf8'), original);

    const research = resultJson(await recipe('preview', 'research', {
      goalId: goal.id, recipeId: 'research-comparison', version: 1, parameters: {
        question: 'Which fixture format is easier to audit?',
        alternatives: 'Line-delimited JSON and tab-separated values.',
        constraints: 'Use only evidence that can be independently checked.',
        asOf: '2026-11-10'
      }
    }));
    assert.equal(research.validTemplate, true, JSON.stringify(research.diagnostics));
    assert.equal(research.launchable, false);
    assert.deepEqual(research.resolvedDefinition.tasks.map(task => task.kind), ['research']);
    assert.match(JSON.stringify(research.diagnostics), /parked|gate/i);

    const sourceDirectory = path.dirname(recipeCliPath);
    const sourceRevision = await git(sourceDirectory, 'rev-parse', 'HEAD').catch(() => null);
    const sourceDirty = sourceRevision === null ? null :
      await git(sourceDirectory, 'status', '--porcelain').then(Boolean).catch(() => null);
    const evidence = path.join(output, 'demo.json');
    await writeFile(evidence, encode({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sourceRevision,
      sourceDirty,
      ...(sourceRevision === null || sourceDirty === null
        ? {sourceStateReason: 'Git checkout revision or status unavailable'} : {}),
      environment: 'fixture',
      evidence: 'A deterministic worker response and a fixture-driven review decision. Candidate and integration checks ran in the actual local sandbox.',
      coding: {
        preview, receipt, replayId: replay.id,
        task: {
          id: taskId, spec: submitted.spec, status: accepted.status, checks, integratedChecks,
          candidateCommit: accepted.integration.candidateCommit,
          integrationCommit: accepted.integration.commit
        }
      },
      stale: {error: stale.stderr.trim(), taskCountBefore, taskCountAfter},
      research
    }), {flag: 'wx', mode: 0o600});
    process.stdout.write(encode({evidence}));
  } finally {
    try {
      await api?.close();
      await dispatcher?.whenIdle();
    } finally {
      worker?.overnight.close();
      c?.close();
      await rm(scratch, {recursive: true, force: true});
    }
  }
}

async function main(argv = process.argv.slice(2)) {
  if (!argv.length || (argv.length === 1 && argv[0] === '--help')) {
    process.stdout.write('Mosaic workflow recipes\n\n' + usage.join('\n') + '\n');
    return;
  }
  const [action, ...args] = argv;
  if (!Object.hasOwn(options, action)) throw Error('Use list, inspect, preview, submit, or demo');
  const required = options[action];
  const {values, tokens} = parseArgs({
    args, options: Object.fromEntries(required.map(name => [name, {type: 'string'}])), tokens: true
  });
  for (const name of required) {
    if (!values[name]) throw Error('Provide --' + name);
    if (tokens.filter(token => token.name === name).length !== 1) throw Error('Duplicate --' + name);
  }
  if (action === 'demo') return demo(path.resolve(values.output));
  let input = {};
  if (action === 'inspect') {
    const version = Number(values.version);
    if (!/^[1-9][0-9]*$/.test(values.version) || !Number.isSafeInteger(version))
      throw Error('Provide a positive integer --version');
    input = {id: values.id, version};
  } else if (values.input) {
    input = JSON.parse(await readFile(values.input, 'utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Input must be a JSON object');
  }
  if (action === 'submit') {
    if (Object.hasOwn(input, 'idempotencyKey')) throw Error('Supply the idempotency key only with --idempotency-key');
    input.idempotencyKey = values['idempotency-key'];
  }
  await harnessCli([
    'call', '--root', values.root, '--tool', 'workflow_recipe_' + action,
    '--input-json', JSON.stringify(input)
  ]);
}

if (isEntry(import.meta.url)) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
