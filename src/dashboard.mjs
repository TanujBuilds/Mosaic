import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatTimelineEvent } from './project/timeline.mjs';

import { isEntry } from './harness/entry.mjs';

const currentFile = fileURLToPath(import.meta.url);
const assets = path.join(path.dirname(currentFile), 'dashboard');
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const pngPattern = /^[a-zA-Z0-9_.-]+\.png$/;
const latest = (events, type) => events.findLast(event => event.type === type)?.data;

export function summarizeJob(id, events) {
  const manifest = latest(events, 'project.created');
  if (manifest) {
    const planIndex = events.findLastIndex(event => event.type === 'project.created');
    const approved = events.slice(planIndex + 1).some(event =>
      event.type === 'project.approved' && event.data.planVersion === manifest.planVersion);
    const run = events.findLast(event => ['run.started', 'run.finished'].includes(event.type));
    return {
      id, type: 'coding', mode: manifest.mode,
      title: manifest.plan.stages[0]?.objective ?? manifest.plan.summary,
      description: manifest.plan.summary,
      status: approved ? (run?.type === 'run.started' ? 'running' : run?.data.status ?? 'approved') : 'awaiting_approval',
      reason: run?.data.reason ?? null, updatedAt: events.at(-1)?.at ?? null,
      planVersion: manifest.planVersion, baseCommit: manifest.baseCommit,
      repo: manifest.repo, permissions: manifest.permissions, limits: manifest.limits,
      stages: manifest.plan.stages.map(stage => {
        const attempts = events.filter(event => event.type === 'attempt.started' && event.data.stageId === stage.id);
        const accepted = events.some(event => event.type === 'stage.accepted' && event.data.stageId === stage.id);
        return { ...stage, status: accepted ? 'accepted' : attempts.length ? 'in_progress' : 'pending',
          localAttempts: attempts.filter(event => event.data.role === 'local').length,
          codexReviews: events.filter(event => event.type === 'frontier.call' && event.data.kind === 'review' && event.data.stageId === stage.id).length };
      }),
    };
  }
  const goal = latest(events, 'job.created')?.goal;
  if (!goal) {
    // A coding job is visible while the planner is still working, before any manifest exists.
    const requested = latest(events, 'project.plan.requested');
    if (requested) {
      const fake = /fake/i.test(String(requested.source ?? ''));
      return { id, type: 'coding', mode: fake ? 'fake' : 'live',
        title: String(requested.input?.brief ?? 'Planning a coding job').slice(0, 130),
        description: 'A plan is being drafted; nothing is approved yet.',
        status: latest(events, 'project.plan.failed') ? 'planning_failed' : 'planning',
        reason: latest(events, 'project.plan.failed')?.reason ?? null,
        updatedAt: events.at(-1)?.at ?? null, planVersion: null, stages: [] };
    }
    return null;
  }
  const outcome = latest(events, 'job.finished');
  const plan = latest(events, 'plan.proposed')?.plan;
  const fake = events.some(event => /fake/i.test(event.data?.source ?? ''));
  return {
    id, type: 'text', mode: fake ? 'fake' : 'live', title: plan?.summary ?? goal.slice(0, 130),
    status: outcome?.status ?? (latest(events, 'plan.accepted') ? 'running' : plan ? 'awaiting_approval' : 'planning'),
    reason: outcome?.reason ?? null, updatedAt: events.at(-1)?.at ?? null,
    planVersion: latest(events, 'plan.proposed')?.planVersion ?? null,
    stages: plan?.steps?.map(step => ({ ...step, status: outcome?.status ?? 'pending' })) ?? [],
  };
}

export function describeEvent(event, mode) {
  const { type, data = {} } = event;
  const host = process.platform === 'win32' ? 'Windows' : 'Mac';
  if (type.startsWith('project.') || type.startsWith('run.') || type.startsWith('attempt.') ||
      type.startsWith('operation.') || type.startsWith('edits.') || type === 'stage.accepted' ||
      type === 'provider.waiting') {
    const line = formatTimelineEvent(event, { mode });
    if (line) return line.replace(/^.*?#\d+(?:  \[FAKE\])?  /, '');
    if (type === 'project.plan.requested') {
      const source = String(data.source ?? 'planner');
      const label = /codex/i.test(source) ? 'Codex' : /template/i.test(source) ? 'template plan' : /fake/i.test(source) ? 'fake planner' : 'DeepSeek';
      return `${host} → ${label}: plan requested`;
    }
    return null;
  }
  switch (type) {
    case 'frontier.call': return `Codex ${data.kind} call${data.stageId ? ` for ${data.stageId}` : ''}: ${data.decision ?? 'unknown'} (${data.durationMs ?? 0} ms)`;
    case 'stage.guidance': return `Codex guidance recorded for ${data.stageId}`;
    case 'job.created': return 'Brief recorded';
    case 'frontier.plan.requested': return `${host} → Codex: plan requested`;
    case 'plan.proposed': return `Codex → ${host}: focused plan proposed`;
    case 'plan.accepted': return 'You approved the plan';
    case 'assignment.sent': return 'Codex → DeepSeek: assignment ' + data.attempt;
    case 'local.result': return `DeepSeek → ${host}: answer ${data.attempt}`;
    case 'frontier.review.requested': return `${host} → Codex: answer sent for review`;
    case 'frontier.review': return `Codex → ${host}: ${data.review?.decision ?? 'review'}`;
    case 'provider.failed': return (data.stage ?? 'Provider') + ' failed: ' + (data.reason ?? 'unknown error');
    case 'job.finished': return 'Final status: ' + data.status;
    case 'job.paused': return 'Job paused';
    case 'sandbox.verified': return process.platform === 'win32' ? 'Sandbox verified' : 'Mac sandbox verified';
    case 'budget.started': return 'Job time budget started';
    default: return null;
  }
}

export function eventKind(event) {
  const key = event.data?.key ?? '';
  if (event.type === 'local.result' || (event.type === 'operation.completed' && /\/response-\d+$/.test(key))) return 'deepseek';
  if (event.type.startsWith('frontier.') || event.type === 'stage.guidance' || event.type === 'plan.proposed' ||
      (event.type === 'operation.completed' && /\/(assignment|review)$/.test(key))) return 'codex';
  if ((event.type === 'operation.completed' || event.type === 'operation.started') && key.endsWith('/checks')) return 'check';
  if (event.type === 'sandbox.verified') return 'check';
  if (event.type === 'operation.started' && key.endsWith('/review')) return 'codex';
  if (event.type.startsWith('edits.') || event.type === 'stage.accepted') return 'workspace';
  if (event.type === 'provider.waiting' || event.type === 'provider.failed') return 'warning';
  return 'system';
}

export async function readJob(dataDir, id) {
  if (!idPattern.test(id)) return null;
  let raw;
  try { raw = await readFile(path.join(dataDir, 'jobs', id + '.jsonl'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const complete = raw.slice(0, raw.lastIndexOf('\n') + 1);
  const events = complete.split('\n').filter(Boolean).map(JSON.parse);
  if (events.some((event, index) => event.jobId !== id || event.sequence !== index + 1)) {
    throw new Error('Job has an invalid event sequence');
  }
  const job = summarizeJob(id, events);
  if (!job) return null;
  return { job, events: events.map(event => ({
    ...event, label: describeEvent(event, job.mode), kind: eventKind(event),
  })).filter(event => event.label) };
}

function respond(response, code, body, type) {
  response.writeHead(code, {
    'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(body);
}

function dashboardUrl(request) {
  const { localPort, remoteAddress } = request.socket;
  const headers = request.headersDistinct;
  if (!localPort || !['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(remoteAddress) ||
      headers.host?.length !== 1 || headers.origin?.length > 1 ||
      Object.keys(headers).some(name => name === 'forwarded' || name === 'x-real-ip' || name.startsWith('x-forwarded-'))) {
    return null;
  }

  const authority = headers.host[0].toLowerCase();
  const hostname = ['127.0.0.1', 'localhost'].find(name =>
    authority === name + ':' + localPort || localPort === 80 && authority === name);
  if (!hostname) return null;

  const origin = 'http://' + hostname + (localPort === 80 ? '' : ':' + localPort);
  if ((headers.origin && headers.origin[0] !== origin) ||
      !request.url?.startsWith('/') || request.url.startsWith('//')) return null;
  const url = URL.parse(request.url, origin);
  return url?.origin === origin ? url : null;
}

export function createDashboardServer({ dataDir = path.resolve('.data') } = {}) {
  return createServer({ requireHostHeader: false }, async (request, response) => {
    try {
      const url = dashboardUrl(request);
      if (!url) return respond(response, 403, 'Forbidden', 'text/plain; charset=utf-8');
      if (request.method !== 'GET') return respond(response, 405, 'Method not allowed', 'text/plain; charset=utf-8');
      if (url.pathname === '/api/jobs') {
        const dir = path.join(dataDir, 'jobs');
        let names;
        try { names = await readdir(dir); }
        catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
        const candidates = await Promise.all(names.filter(name => name.endsWith('.jsonl') && idPattern.test(name.slice(0, -6)))
          .map(async name => ({ name, modified: (await stat(path.join(dir, name))).mtimeMs })));
        const jobs = (await Promise.all(candidates.sort((a, b) => b.modified - a.modified).slice(0, 50)
          .map(item => readJob(dataDir, item.name.slice(0, -6))))).filter(Boolean).map(item => item.job);
        return respond(response, 200, JSON.stringify({ jobs }), 'application/json; charset=utf-8');
      }
      const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname);
      if (jobMatch) {
        const result = await readJob(dataDir, jobMatch[1]);
        return respond(response, result ? 200 : 404, JSON.stringify(result ?? { error: 'Job not found' }), 'application/json; charset=utf-8');
      }
      const artifactMatch = /^\/api\/artifacts\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (artifactMatch) {
        const [, id, name] = artifactMatch;
        if (!idPattern.test(id) || !pngPattern.test(name)) return respond(response, 404, 'Not found', 'text/plain; charset=utf-8');
        const job = await readJob(dataDir, id);
        const listed = job?.events.some(event => event.type === 'operation.completed' &&
          event.data?.key?.endsWith('/checks') && event.data.value?.some(check =>
            check.screenshots?.some(file => path.win32.basename(file) === name)));
        if (!listed) return respond(response, 404, 'Not found', 'text/plain; charset=utf-8');
        return respond(response, 200, await readFile(path.join(dataDir, 'artifacts', id, name)), 'image/png');
      }
      const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
      const file = files[url.pathname];
      if (!file) return respond(response, 404, 'Not found', 'text/plain; charset=utf-8');
      return respond(response, 200, await readFile(path.join(assets, file[0])), file[1]);
    } catch (error) {
      console.error('Dashboard request failed: ' + error.message);
      return respond(response, 500, JSON.stringify({ error: 'Could not read local job data' }), 'application/json; charset=utf-8');
    }
  });
}

function options(args) {
  const out = { port: 4321, dataDir: path.resolve('.data'), job: null };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index], value = args[++index];
    if (!value) throw new Error('Missing value for ' + flag);
    if (flag === '--port') out.port = Number(value);
    else if (flag === '--data-dir') out.dataDir = path.resolve(value);
    else if (flag === '--job') out.job = value;
    else throw new Error('Unknown option: ' + flag);
  }
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) throw new Error('Port must be 0–65535');
  if (out.job && !idPattern.test(out.job)) throw new Error('Invalid job ID');
  return out;
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log('dashboard [--data-dir DIR] [--job ID] [--port PORT]');
    return;
  }
  const parsed = options(process.argv.slice(2));
  const server = createDashboardServer(parsed);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(parsed.port, '127.0.0.1', resolve); });
  const address = server.address();
  console.log('Mosaic dashboard: http://127.0.0.1:' + address.port + '/' + (parsed.job ? '?job=' + parsed.job : ''));
  console.log('Read-only local viewer. Press Ctrl-C to close it.');
}

if (isEntry(import.meta.url)) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
