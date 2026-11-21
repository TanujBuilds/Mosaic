import {macGitReady, gitRecovery} from './git-readiness.mjs';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {lstat, mkdtemp, realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {promisify, stripVTControlCharacters} from 'node:util';
import {readOutcomeSnapshot} from '../harness/outcomes/snapshot.mjs';
import {client} from './client.mjs';
import {entry} from './files.mjs';
import {getHost} from './hosts/index.mjs';
import {readHostConnection} from './hosts/connection-evidence.mjs';
import {configuredPolicies, readSettings} from './settings.mjs';

const usage = `Usage
  mosaic first-task [--repo PATH]
  mosaic first-task --demo
  mosaic first-task result --goal ID [--demo-run ID]
`;
const workflows = {
  collaborative: 'Collaborative',
  deepseek_only: 'API-worker-only (DeepSeek-only)',
  codex_only: 'Codex-only',
  overnight_review: 'Overnight review',
};
const modeHelp = {
  collaborative: 'Your coding app supervises and may implement alongside the API worker.',
  deepseek_only: 'The API worker plans and implements. Protected checks govern acceptance.',
  codex_only: 'Your coding app plans and implements without your API worker.',
  overnight_review: 'The API worker plans and implements. Review follows passing protected checks.',
};
const statuses = {
  draft: 'Prepared draft', active: 'Active', completed: 'Complete',
  ready_to_integrate: 'Ready to integrate', awaiting_review: 'Waiting for review',
  awaiting_legacy_review: 'Waiting for review', codex_ready: 'Ready in the coding app',
};
const reviewLabels = {
  host_review: 'coding app review', api_review: 'API review', codex_operator: 'operator review',
  codex_legacy: 'check-gated Codex review',
};
const demoPrefix = 'mosaic-first-task-';
const runProcess = promisify(execFile);
const id = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/;
const cancelled = Symbol('first task cancelled');
const display = value => stripVTControlCharacters(String(value ?? ''))
  .replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu, ' ');
const exact = value => JSON.stringify(value).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu,
  char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
const line = (output, text = '') => output.write(text + '\n');
const status = value => Object.hasOwn(statuses, value) ? statuses[value] : display(value).replaceAll('_', ' ');

function parseArgs(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return {action: 'help'};
  if (args.length === 1 && args[0] === '--demo') return {action: 'demo'};
  if (args[0] === 'result' && args[1] === '--goal' && id.test(args[2] ?? '')) {
    if (args.length === 3) return {action: 'result', goalId: args[2]};
    if (args.length === 5 && args[3] === '--demo-run' && /^[a-zA-Z0-9]{6}$/.test(args[4])) {
      return {action: 'result', goalId: args[2], demoRun: args[4]};
    }
  }
  if (!args.length) return {action: 'guide'};
  if (args.length === 2 && args[0] === '--repo' && args[1] && !args[1].startsWith('--')) {
    return {action: 'guide', repo: args[1]};
  }
  if (args.length === 1 && args[0] !== 'result' && !args[0].startsWith('-')) return {action: 'guide', repo: args[0]};
  throw Error(usage.trim());
}

async function currentRepository(cwd) {
  let dir = await realpath(cwd);
  while (!await entry(path.join(dir, '.git'))) {
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return dir;
}

async function withPrompts(input, output, work) {
  const rl = createInterface({input, output, terminal: !!input.isTTY && !!output.isTTY, historySize: 0});
  rl.once('SIGINT', () => rl.close());
  const iterator = rl[Symbol.asyncIterator]();
  try {
    return await work(async prompt => {
      output.write(prompt);
      const {done, value} = await iterator.next();
      if (done) throw cancelled;
      return value;
    });
  } finally {
    rl.close();
  }
}

function textList(text) {
  const list = text.startsWith('[') ? JSON.parse(text) : text.split(',').map(item => item.trim()).filter(Boolean);
  if (!Array.isArray(list) || list.some(item => typeof item !== 'string')) throw Error('Use a comma-separated list or a JSON list of strings.');
  return list;
}

function checkList(text) {
  if (!text) return [];
  if (!text.startsWith('[') && /["'\\|;&<>]/u.test(text)) {
    throw Error('Use JSON argument lists for quoted arguments or multiple commands. Checks do not run through a shell.');
  }
  const parsed = text.startsWith('[') ? JSON.parse(text) : text.split(/\s+/u);
  if (!Array.isArray(parsed) || !parsed.length) throw Error('Enter a check command or a JSON argument list.');
  const commands = Array.isArray(parsed[0]) ? parsed : [parsed];
  if (commands.some(command => !Array.isArray(command) || !command.length || command.some(arg => typeof arg !== 'string'))) {
    throw Error('Each check must have a literal executable and argument list.');
  }
  return commands.map((argv, index) => ({id: `check-${index + 1}`, argv}));
}

function showChecks(output, checks) {
  for (const {id, argv, ...options} of checks) {
    const details = Object.keys(options).length ? `  ${exact(options)}` : '';
    line(output, `  ${display(id)}  ${exact(argv)}${details}`);
  }
}

function showConnection(output, host, connection) {
  line(output, `Coding app: ${host.displayName} (saved selection)`);
  if (connection?.kind === 'registry_call' && connection.hostId === host.id) {
    line(output, `Last bridge registry call: ${new Date(connection.at).toISOString()}. Verify the current connection in ${host.displayName}.`);
  } else {
    line(output, `Coding-app connection unverified. Run mosaic connect for registration and a registry call in ${host.displayName}.`);
  }
}

function showDraft(output, goal, summary) {
  const {manifest} = goal;
  const {project} = manifest;
  const {limits} = summary;
  line(output);
  line(output, 'Review your saved draft');
  line(output, `Outcome: ${display(manifest.objective)}`);
  for (const criterion of manifest.acceptance) line(output, `  Acceptance: ${display(criterion)}`);
  line(output, `Workflow: ${workflows[manifest.mode.id]} (v${manifest.mode.version})`);
  if (manifest.reviewPolicy?.source === 'api') {
    line(output, `Review: API reviewer ${display(manifest.reviewPolicy.reviewer.id)} after protected checks pass.`);
  } else if (manifest.reviewPolicy?.source === 'host') {
    line(output, `Review: ${getHost(manifest.reviewPolicy.hostId).displayName} after protected checks pass.`);
  } else {
    line(output, `Review: ${display(summary.roles.description)}`);
  }
  if (manifest.providerPolicy) {
    const policy = manifest.providerPolicy;
    line(output, `Default worker: ${display(policy.defaultWorkerId)} · planner worker: ${display(policy.plannerWorkerId)}.`);
    if (manifest.routingPolicy) {
      line(output, `Routing fallback: ${display(manifest.routingPolicy.defaultWorkerId)}. The saved routing rules may choose another approved worker.`);
    }
    line(output, 'Worker connectivity and inference remain unverified.');
  }
  line(output, `Repository: ${display(project.repo)}`);
  line(output, `Committed base: ${project.baseCommit}`);
  line(output, `Read scope: ${exact(project.readPaths)}`);
  line(output, `Write scope: ${exact(project.writePaths)}`);
  line(output, 'Protected checks (literal executable and arguments)');
  showChecks(output, project.checks);
  line(output, `Goal limits: ${limits.hours} hour(s), ${limits.maxTasks} assignment(s), ${limits.reviewAgentRuns} separate reviewer run(s).`);
  const {seconds, attempts, modelCalls, reviews, questions} = limits.coding;
  line(output, `Per coding assignment: ${seconds}s, ${attempts} attempt(s), ${modelCalls} model request(s), ${reviews} review(s), ${questions} question(s).`);
  if (limits.overnight) {
    const {maxBatches, maxExchanges, maxCorrections, reconnectMs} = limits.overnight;
    line(output, `Overnight limits: ${maxBatches} batch(es), ${maxExchanges} exchange(s), ${maxCorrections} correction(s), ${reconnectMs}ms to reconnect.`);
    line(output, `Infrastructure preflight: ${exact(manifest.overnightPolicy.preflightCheckIds)}`);
    line(output, `Final-only checks: ${exact(manifest.overnightPolicy.finalOnlyCheckIds)}`);
  }
  line(output, `Goal ID: ${goal.id}`);
  line(output, `Approval hash: ${goal.hash}`);
}

function handoff(output, goal, host) {
  const overnight = !!goal.manifest.overnightPolicy;
  const approval = overnight
    ? 'Ask for explicit authorization before running overnight_preflight on this hash and before activation.'
    : 'Ask for my explicit approval before activating this hash or starting work.';
  const runAssignment = {
    deepseek_only: "let the coordinator's API-worker planner create the one allowed coding assignment after activation",
    overnight_review: "let the coordinator's overnight planner create the one allowed coding stage after preflight and activation",
  }[goal.manifest.mode.id] ?? 'run one coding assignment after activation using the saved workflow';
  line(output);
  line(output, `Paste into ${host.displayName} with mosaic-beta available`);
  line(output, `Open my Mosaic draft with mosaic-beta goal_get ${exact({goalId: goal.id})}. Confirm its status is draft and its approval hash is ${goal.hash}. Show me the scope, checks and limits. ${approval} After I approve activation and work, ${runAssignment} within the approved bounds. Follow the saved review policy and show the saved check, review, and integration state.`);
  line(output, `See saved result: mosaic first-task result --goal ${goal.id}`);
}

async function guidedTask(output, ask, {repo, settings, host, invoke, readPreset}) {
  const question = async prompt => (await ask(prompt)).trim();
  const policy = settings.schema === 2 ? configuredPolicies(settings).providerPolicy : null;
  const workerConfigured = !!(policy ?? settings.worker);
  const modeIds = workerConfigured ? Object.keys(workflows) : ['codex_only'];
  line(output, `Git project: ${display(repo)}`);
  let preset;
  try { preset = await readPreset?.(repo); }
  catch { line(output, 'Saved project suggestions are unavailable. Choose fresh settings for this draft.'); }
  if (preset?.mode && modeIds.includes(preset.mode)) line(output, `Saved workflow suggestion: ${workflows[preset.mode]}`);
  const suggestedWorker = policy?.workers.find(worker => worker.id === preset?.workerId);
  if (suggestedWorker) line(output, `Saved worker suggestion: ${display(suggestedWorker.id)}`);
  if (!workerConfigured) line(output, 'An API worker is needed for Collaborative, API-worker-only and Overnight review.');
  for (const [index, mode] of modeIds.entries()) {
    line(output, `  ${index + 1}. ${workflows[mode]} · ${modeHelp[mode]}`);
  }
  const modeChoice = await question('Choose a workflow, or type setup to return to worker setup: ');
  if (modeChoice.toLowerCase() === 'setup') {
    line(output, 'Run mosaic setup to configure an API worker, then return to mosaic first-task.');
    return 0;
  }
  const mode = modeIds[Number(modeChoice) - 1] ?? modeChoice.toLowerCase().replaceAll('-', '_');
  if (!modeIds.includes(mode)) {
    line(output, 'Choose a listed workflow explicitly and run mosaic first-task again.');
    return 1;
  }
  const objective = await question('What small coding task should Mosaic prepare? ');
  const criterion = await question('How will you know it is done? ');
  const readPaths = textList(await question('What may Mosaic read? Use comma-separated paths such as src/, checks/: '));
  const writePaths = textList(await question('What may Mosaic edit? Use comma-separated paths within the read scope: '));
  const savedChecks = preset?.checks ?? [];
  if (savedChecks.length) {
    line(output, `Saved protected check suggestions: ${savedChecks.map(check => display(check.id)).join(', ')}.`);
    line(output, 'Enter the commands to include in this draft.');
  }
  const checks = checkList(await question('Protected check command, e.g. npm test. Use JSON argument lists for spaces in an argument or multiple commands: '));
  let overnightPolicy;
  if (mode === 'overnight_review') {
    line(output, 'Choose checks that already pass on the committed base for infrastructure preflight.');
    showChecks(output, checks);
    overnightPolicy = {
      preflightCheckIds: textList(await question('Infrastructure preflight check IDs: ')),
      finalOnlyCheckIds: textList(await question('Final-only check IDs, or press Enter for none: ')),
    };
  }
  // The portable review service spends both the goal and assignment caps.
  const reviews = mode === 'deepseek_only' ? 0 : 1;
  const limits = {
    hours: 1, maxTasks: 1, reviewAgentRuns: reviews,
    taskLimits: {coding: {seconds: 1800, attempts: 2, modelCalls: mode === 'codex_only' ? 1 : 4, reviews, questions: 1}},
  };
  let providerPolicy, routingPolicy;
  if (mode !== 'codex_only' && suggestedWorker && suggestedWorker.id !== policy.defaultWorkerId &&
      /^y(es)?$/i.test(await question(`Use ${suggestedWorker.id} as the default worker for this draft? [y/N] `))) {
    providerPolicy = {...policy, defaultWorkerId: suggestedWorker.id};
    if (settings.defaults.routing) routingPolicy = {...settings.defaults.routing, defaultWorkerId: suggestedWorker.id};
  }
  const details = {
    objective, acceptance: criterion ? [criterion] : [], mode, project: {repo, readPaths, writePaths, checks}, limits,
    ...(overnightPolicy ? {overnightPolicy} : {}),
    ...(providerPolicy ? {providerPolicy} : {}),
    ...(routingPolicy ? {routingPolicy} : {}),
  };
  const submissionId = `first-task-${randomUUID()}`;
  const prepared = await invoke('assignment_prepare', {manifest: {submissionId, ...details}, idempotencyKey: submissionId});
  if (prepared.status === 'needs_input') {
    line(output, '\nDraft needs input');
    for (const issue of prepared.issues) line(output, `  ${display(issue.message)}`);
    return 1;
  }
  if (prepared.status !== 'prepared') throw Error('The coordinator did not return a prepared draft.');
  let goal;
  try { goal = await invoke('goal_get', {goalId: prepared.goalId}); }
  catch (error) {
    line(output, `The coordinator saved draft ${prepared.goalId}. To inspect it, run mosaic first-task result --goal ${prepared.goalId}.`);
    throw error;
  }
  if (goal.hash !== prepared.hash || goal.status !== 'draft') {
    line(output, `The saved goal changed after preparation. Inspect it with mosaic first-task result --goal ${goal.id}.`);
    return 1;
  }
  showDraft(output, goal, prepared.summary);
  line(output, 'Saved as a draft. No work was started.');
  handoff(output, goal, host);
  return 0;
}

function checkEvidence(output, label, results) {
  if (!results?.length) return line(output, `  ${label}: no saved check results.`);
  line(output, `  ${label}: ${results.map(check => `${display(check.id)} ${check.passed === true ? 'passed' : check.passed === false ? 'failed' : 'unknown'}`).join(', ')}`);
}

function showResult(output, goal, tasks) {
  line(output, `Goal: ${display(goal.manifest.objective)}`);
  line(output, `Goal ID: ${goal.id} · ${status(goal.status)}`);
  if (goal.status === 'draft') line(output, `Approval hash: ${goal.hash}`);
  const codingTasks = tasks.filter(task => task.spec.kind === 'coding');
  if (!codingTasks.length) line(output, 'No saved coding results yet.');
  for (const task of codingTasks) {
    line(output, `\n${display(task.spec.objective)} · ${status(task.status)}`);
    line(output, `  Task ID: ${task.id}`);
    const failures = task.checkpoint?.repairFailure?.checks;
    const checked = failures?.map(check => ({id: check.id, passed: false})) ?? task.result?.checks;
    checkEvidence(output, 'Candidate checks', checked);
    const review = task.integration?.review;
    const decision = task.legacyDecision?.decision ?? task.feedback?.findLast(event => ['accept', 'revise'].includes(event.decision))?.decision;
    if (review === 'none') line(output, '  Review: protected checks govern acceptance for this workflow.');
    else if (review === 'codex_native') line(output, '  Review: native completion recorded with protected checks.');
    else if (Object.hasOwn(reviewLabels, review)) line(output, `  Review: accepted (${reviewLabels[review]}).`);
    else if (task.reviewAcceptance || decision === 'accept') line(output, '  Review: acceptance saved.');
    else if (decision === 'revise') line(output, '  Review: revision requested.');
    else line(output, '  Review: no saved decision.');
    const candidate = task.native?.worktree ?? task.result?.worktree;
    const commit = task.integration?.candidateCommit ?? task.native?.commit;
    if (candidate) line(output, `  Candidate checkout: ${display(candidate)}`);
    if (commit) line(output, `  Candidate commit: ${display(commit)}`);
    if (task.integration?.commit) {
      checkEvidence(output, 'Integration checks', task.integration.checks);
      line(output, `  Integrated commit: ${display(task.integration.commit)}`);
      if (task.integration.worktree) line(output, `  Integration checkout: ${display(task.integration.worktree)}`);
    } else {
      line(output, '  Integration: no saved commit.');
    }
  }
}

async function demoResult(output, parent, run, goalId) {
  const root = path.join(parent, demoPrefix + run);
  for (const dir of [root, path.join(root, 'state')]) {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw Error('Unsafe first-task demo directory.');
  }
  const snapshot = readOutcomeSnapshot({stateRoot: path.join(root, 'state'), goalId});
  const goal = snapshot.goals.find(record => record.id === goalId);
  if (!goal || goal.manifest.environment !== 'fixture') throw Error('The demo goal is unavailable.');
  line(output, 'Scripted demo · saved fixture evidence · no live providers');
  showResult(output, goal, snapshot.tasks);
  if (!snapshot.coverage.complete) line(output, 'Some saved demo evidence was unavailable.');
}

async function runDemo(output, parent, gitReady = macGitReady) {
  if (await gitReady() === false) throw Error(gitRecovery);
  const root = await mkdtemp(path.join(parent, demoPrefix));
  const run = path.basename(root).slice(demoPrefix.length);
  // Keep the literal import visible to the installed package's source closure.
  const script = `import {createOutcomeDemo} from '../harness/outcomes/demo.mjs';
    const {goalId} = await createOutcomeDemo(process.argv[1], {firstTask: true});
    process.stdout.write(goalId);`;
  const {stdout: goalId} = await runProcess(process.execPath, ['--input-type=module', '--eval', script, root], {
    cwd: import.meta.dirname,
    env: {PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0'},
    timeout: 30_000, maxBuffer: 65_536,
  });
  if (!id.test(goalId)) throw Error('The first-task demo did not save a valid goal ID.');
  await demoResult(output, parent, run, goalId);
  line(output, `\nReopen saved demo: mosaic first-task result --goal ${goalId} --demo-run ${run}`);
}

export async function runFirstTask(paths, args = [], options = {}) {
  const {action, repo: explicitRepo, goalId, demoRun} = parseArgs(args);
  const {input = process.stdin, output = process.stdout, cwd = process.cwd(), demoParent = os.tmpdir(),
    invoke = client(paths), ask, readPreset, loadSettings = readSettings} = options;
  if (action === 'help') {
    output.write(usage);
    return 0;
  }
  if (action === 'demo' || demoRun) {
    const parent = await realpath(demoParent);
    if (demoRun) await demoResult(output, parent, demoRun, goalId);
    else await runDemo(output, parent, options.gitReady);
    return 0;
  }
  if (action === 'result') {
    const goal = await invoke('goal_get', {goalId});
    showResult(output, goal, goal.tasks);
    return 0;
  }

  const repo = explicitRepo
    ? path.isAbsolute(explicitRepo) ? explicitRepo : `${cwd}${path.sep}${explicitRepo}`
    : await currentRepository(cwd);
  if (!repo) {
    line(output, 'Open your Git project or use mosaic first-task --repo PATH. To try a sample, use mosaic first-task --demo.');
    return 1;
  }
  const settings = await loadSettings(paths);
  if (!settings) {
    line(output, 'Run mosaic setup to choose your coding app, or try mosaic first-task --demo.');
    return 1;
  }
  line(output, 'Prepare your first coding task');
  const host = getHost(settings.host?.id ?? 'codex');
  const connection = await readHostConnection(paths).catch(() => null);
  showConnection(output, host, connection);
  const guide = prompt => guidedTask(output, prompt, {repo, settings, host, invoke, readPreset});
  try {
    return await (ask ? guide(ask) : withPrompts(input, output, guide));
  } catch (error) {
    if (error !== cancelled) throw error;
    line(output, '\nFirst task setup ended.');
    return 1;
  }
}
