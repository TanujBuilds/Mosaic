import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { initQueue, enqueue, queueStatus, runQueue, stopQueue, retryItem, cancelItem } from './task-queue.mjs';

import { isEntry } from './harness/entry.mjs';

const self = fileURLToPath(import.meta.url);
const common = ['data-dir', 'json'];
const flags = {
  init: ['fake', 'hours', 'max-jobs', 'max-reviews'], add: ['job', 'hash', 'priority'],
  status: [], run: ['once', 'background', 'worker', 'worker-token'], stop: [],
  retry: ['job', 'hash'], cancel: ['job'], help: [],
};
const bool = new Set(['json', 'fake', 'once', 'background', 'worker']);
function parse(argv) {
  const [action = 'help', ...args] = argv;
  if (!Object.hasOwn(flags, action)) throw new Error(`Unknown action: ${action}`);
  const allowed = new Set([...common, ...flags[action]]), options = {};
  while (args.length) {
    const raw = args.shift(), key = raw?.slice(2);
    if (!raw?.startsWith('--') || !allowed.has(key)) throw new Error(`Unsupported option for ${action}: ${raw}`);
    if (Object.hasOwn(options, key)) throw new Error(`Repeated option: ${raw}`);
    if (bool.has(key)) options[key] = true;
    else { const value = args.shift(); if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${raw}`); options[key] = value; }
  }
  if (options.worker && options.background || options['worker-token'] && !options.worker) throw new Error('Invalid worker options');
  return { action, options };
}
const help = `task-queue CLI
  init [--fake] [--hours N] [--max-jobs N] [--max-reviews N]
  add --job ID --hash HASH [--priority N]
  status
  run [--once] [--background]
  stop
  retry --job ID --hash HASH
  cancel --job ID
  help
All commands accept --data-dir ROOT and --json. ROOT contains coordinator jobs/artifacts.
Higher priority runs first; FIFO ties. Default run watches; --once drains available work.
Init preserves existing limits. Restart retains spent budgets. Fake mode is chosen at init.
${process.platform === 'win32' ? 'Windows' : 'Mac'} must remain powered on; background execution does not install a boot scheduler.`;
async function background(root, options) {
  const before = await queueStatus({ root });
  if (!before.initialized) throw new Error('Run init first');
  if (before.worker) throw new Error('Another queue worker owns the lease');
  const token = randomUUID(), logPath = path.join(path.dirname(before.report), 'worker.log');
  const log = await open(logPath, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [self, 'run', '--data-dir', root, '--worker', '--worker-token', token, '--json', ...(options.once ? ['--once'] : [])], {
      cwd: path.dirname(self), detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd], env: process.env,
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { await log.close(); }
  for (let n = 0; n < 50; n++) {
    await delay(100);
    const status = await queueStatus({ root });
    if (status.lastWorker?.token === token && status.lastWorker.pid === child.pid) return { ...status, pid: child.pid, log: logPath };
    try { process.kill(child.pid, 0); }
    catch (error) { if (error.code !== 'EPERM') throw new Error(`Worker exited before its own startup was confirmed; inspect ${logPath}`); }
  }
  return { status: 'starting', pid: child.pid, token, log: logPath, reason: 'Startup is not confirmed; inspect status' };
}
async function main() {
  const { action, options } = parse(process.argv[2] === '--help' && process.argv.length === 3 ? ['help'] : process.argv.slice(2));
  if (action === 'help') { console.log(help); return; }
  const root = path.resolve(options['data-dir'] ?? fileURLToPath(new URL('../.data', import.meta.url)));
  let result;
  if (action === 'init') result = await initQueue({ root, mode: options.fake ? 'fake' : 'live',
    ...(options.hours === undefined ? {} : { hours: Number(options.hours) }),
    ...(options['max-jobs'] === undefined ? {} : { maxJobs: Number(options['max-jobs']) }),
    ...(options['max-reviews'] === undefined ? {} : { maxReviews: Number(options['max-reviews']) }) });
  else if (action === 'add') result = await enqueue({ root, jobId: options.job, hash: options.hash, priority: Number(options.priority ?? 0) });
  else if (action === 'status') result = await queueStatus({ root });
  else if (action === 'stop') result = await stopQueue({ root });
  else if (action === 'retry') result = await retryItem({ root, jobId: options.job, hash: options.hash });
  else if (action === 'cancel') result = await cancelItem({ root, jobId: options.job });
  else if (options.background) result = await background(root, options);
  else {
    const controller = new AbortController(), cancel = () => controller.abort();
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    try { result = await runQueue({ root, once: Boolean(options.once), signal: controller.signal,
      ...(options['worker-token'] ? { workerToken: options['worker-token'] } : {}) }); }
    finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  }
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Queue: ${result.status ?? result.outcome ?? 'updated'}${result.mode ? ` (${result.mode === 'fake' ? 'SCRIPTED SIMULATION' : 'live'})` : ''}`);
    if (result.items) console.table(result.items.map(({ jobId, priority, status, reason }) => ({ jobId, priority, status, reason })));
    if (result.limits) console.log(`Jobs ${result.jobsUsed}/${result.limits.maxJobs}; review reservations ${result.reviewsUsed}/${result.limits.maxReviews}`);
    if (result.reason) console.log(result.reason);
    if (result.report) console.log(`Report: ${result.report}`);
  }
}
if (isEntry(import.meta.url)) main().catch(error => { console.error(JSON.stringify({ error: error.message, code: error.code ?? 'error' })); process.exitCode = 1; });
