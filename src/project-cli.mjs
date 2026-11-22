import { readFile, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Journal } from './project/journal.mjs';
import { ProjectFrontier, ProjectLocal } from './project/providers.mjs';
import { FakeProjectFrontier, FakeProjectLocal } from './project/fake.mjs';
import { createProject, reviseProject, approveProject, prepareResume, projectStatus, stopProject, guideStage, templatePlanner } from './project/service.mjs';
import { runProject } from './project/runner.mjs';
import { digest } from './project/contracts.mjs';
import { formatTimelineEvent, watchJournal } from './project/timeline.mjs';
import { setTimeout as delay } from 'node:timers/promises';

import { isEntry } from './harness/entry.mjs';

function parse(args) {
  const action = args.shift(), options = {};
  while (args.length) {
    const key = args.shift();
    if (!/^--[\w-]+$/.test(key)) throw new Error(`Invalid option: ${key}`);
    if (['--json', '--fake', '--background', '--worker', '--once', '--full', '--template'].includes(key)) options[key.slice(2)] = true;
    else {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
      options[key.slice(2)] = value;
    }
  }
  return { action, options };
}
function display(result, json) {
  if (json) return console.log(JSON.stringify(result, null, 2));
  console.log(`Job ${result.jobId}: ${result.status}`);
  if (result.reason) console.log(result.reason);
  if (result.manifest) console.log(JSON.stringify(result.manifest, null, 2));
  if (result.planHash) console.log(`Approval hash: ${result.planHash}`);
  if (result.stages) console.table(result.stages.map(({ id, status, localAttempts, codexReviews }) => ({ stage: id, status, localAttempts, codexReviews })));
  if (result.codexCalls !== undefined) console.log(`Codex calls: ${result.codexCalls}`);
  if (result.guidance) console.log(`Stage guidance: ${result.guidance}`);
  if (result.worktree) console.log(`Worktree: ${result.worktree}`);
  if (result.report) console.log(`Report: ${result.report}`);
  if (result.pid) console.log(`Runner PID: ${result.pid}`);
}
function plannerFor({ fake, planner }) {
  if (fake) return new FakeProjectFrontier();
  if (planner === 'template') return templatePlanner;
  if (planner === 'codex') return new ProjectFrontier({ model: process.env.FRONTIER_MODEL_ID });
  if (planner !== undefined && planner !== 'deepseek') throw new Error('Planner must be deepseek, codex, or template');
  return new ProjectLocal({ baseUrl: process.env.DEEPSEEK_BASE_URL, model: process.env.DEEPSEEK_MODEL_ID });
}
async function background(journal, options) {
  const release = await journal.lock();
  try {
    if (journal.last('project.approved')?.hash !== digest(journal.last('project.created'))) throw new Error('Approve the exact plan before starting the runner');
    if (journal.last('run.finished')?.status === 'accepted') return projectStatus(journal);
  } finally { await release(); }
  const sequence = journal.events.length;
  const log = await open(path.join(journal.dir, 'runner.log'), 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run', '--job', journal.id, '--data-dir', journal.root, '--worker', '--json'], {
      cwd: path.dirname(fileURLToPath(import.meta.url)), detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd], env: process.env,
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { await log.close(); }
  for (let n = 0; n < 50; n++) {
    await delay(100);
    await journal.load();
    if (journal.events.some(e => e.sequence > sequence && ['run.started', 'run.finished'].includes(e.type))) return { ...await projectStatus(journal), log: path.join(journal.dir, 'runner.log') };
    try { process.kill(child.pid, 0); } catch { throw new Error(`Runner exited before starting; inspect ${path.join(journal.dir, 'runner.log')}`); }
  }
  return { jobId: journal.id, status: 'starting', pid: child.pid, log: path.join(journal.dir, 'runner.log'), reason: 'Startup is not yet confirmed; check status' };
}
async function main() {
  if (process.argv.length === 3 && ['help', '--help'].includes(process.argv[2])) {
    console.log('project plan --repo DIR --brief FILE --permissions FILE [--fake | --template]\nproject approve --job ID --hash HASH\nproject run|resume|watch|status|stop|guide --job ID\nUse --data-dir DIR to select the job store.');
    return;
  }
  const { action, options } = parse(process.argv.slice(2));
  const root = path.resolve(options['data-dir'] ?? fileURLToPath(new URL('../.data', import.meta.url)));
  let result;
  if (action === 'plan') {
    const journal = options.job ? await new Journal(root, options.job).load() : null;
    const existing = journal?.last('project.created');
    const planner = existing?.mode === 'fake'
      ? new FakeProjectFrontier()
      : plannerFor({ fake: options.fake, planner: options.template ? 'template' : options.planner });
    result = await (journal ? reviseProject : createProject)({
      journal,
      root, repo: options.repo, brief: await readFile(options.brief, 'utf8'),
      permissions: JSON.parse(await readFile(options.permissions, 'utf8')),
      planner,
      hours: Number(options.hours ?? 8), mode: options.fake ? 'fake' : 'live',
    });
  } else {
    const journal = await new Journal(root, options.job).load();
    if (!journal.last('project.created')) throw new Error('Project job not found');
    if (action === 'watch') {
      const controller = new AbortController();
      const interrupt = () => controller.abort();
      process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
      try {
        for await (const event of watchJournal(journal.file, { once: options.once, signal: controller.signal })) {
          if (options.json || options.full) console.log(JSON.stringify(event));
          else {
            const line = formatTimelineEvent(event, { mode: journal.last('project.created').mode });
            if (line) console.log(line);
          }
        }
      } catch (error) { if (!controller.signal.aborted) throw error; }
      finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
      return;
    }
    if (action === 'approve') result = await approveProject(journal, options.hash);
    else if (action === 'guide') result = await guideStage({ journal, stageId: options.stage,
      frontier: journal.last('project.created').mode === 'fake' ? new FakeProjectFrontier() : new ProjectFrontier({ model: process.env.FRONTIER_MODEL_ID }) });
    else if (action === 'status') result = await projectStatus(journal);
    else if (action === 'stop') result = await stopProject(journal);
    else if (action === 'run' || action === 'resume') {
      if (action === 'resume') await prepareResume(journal,
        options['extend-hours'] === undefined ? undefined : Number(options['extend-hours']),
        options['extend-attempts'] === undefined ? undefined : Number(options['extend-attempts']));
      if (options.background) result = await background(journal, options);
      else {
        const fake = journal.last('project.created').mode === 'fake';
        const controller = new AbortController();
        const interrupt = () => controller.abort();
        process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
        try {
          let liveLocal;
          result = await runProject(journal, {
            frontier: fake ? new FakeProjectFrontier() : new ProjectFrontier({ model: process.env.FRONTIER_MODEL_ID }),
            local: fake ? new FakeProjectLocal() : { reply: (input, signal) => {
              liveLocal ??= new ProjectLocal({ baseUrl: process.env.DEEPSEEK_BASE_URL, model: process.env.DEEPSEEK_MODEL_ID });
              return liveLocal.reply(input, signal);
            } },
            signal: controller.signal,
          });
        } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
      }
    } else throw new Error('Use plan, approve, guide, run, watch, status, stop, or resume');
  }
  display(result, options.json);
  if (['failed', 'paused', 'needs_review', 'blocked', 'interrupted'].includes(result.status)) process.exitCode = result.status === 'failed' ? 1 : 2;
}
if (isEntry(import.meta.url)) main().catch(error => { console.error(JSON.stringify({ error: error.message, code: error.code ?? 'error', ...(error.jobId ? { jobId: error.jobId } : {}) })); process.exitCode = 1; });
