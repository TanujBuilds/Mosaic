import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDashboardServer, readJob, summarizeJob, describeEvent } from '../src/dashboard.mjs';

test('coding job is visible while the planner is still working', async () => {
  const events = [{ jobId: 'x', sequence: 1, at: '2026-10-21T00:00:00.000Z', type: 'project.plan.requested',
    data: { input: { brief: 'Build a dashboard' }, source: 'deepseek-http/unresolved' } }];
  const job = summarizeJob('11111111-1111-4111-8111-111111111111', events);
  assert.equal(job.status, 'planning');
  assert.equal(job.type, 'coding');
  assert.match(describeEvent(events[0], 'live'), /DeepSeek.*plan requested/);
});

test('browser timeline reads only complete persisted events', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'frontier-dashboard-'));
  const id = '11111111-1111-4111-8111-111111111111';
  try {
    await mkdir(path.join(root, 'jobs'));
    const first = { jobId: id, sequence: 1, at: '2026-10-21T00:00:00.000Z',
      type: 'job.created', data: { goal: 'Design a repair cafe intake' } };
    const second = { jobId: id, sequence: 2, at: '2026-10-21T00:00:01.000Z',
      type: 'plan.proposed', data: { planVersion: 1, plan: {
        summary: 'Paper intake plan', steps: [{ objective: 'Write intake flow' }],
      } } };
    await writeFile(path.join(root, 'jobs', id + '.jsonl'),
      JSON.stringify(first) + '\n' + JSON.stringify(second).slice(0, 40));
    const unfinished = await readJob(root, id);
    assert.equal(unfinished.job.status, 'planning');
    assert.equal(unfinished.events.length, 1);

    await writeFile(path.join(root, 'jobs', id + '.jsonl'),
      JSON.stringify(first) + '\n' + JSON.stringify(second) + '\n');
    const finished = await readJob(root, id);
    assert.equal(finished.job.status, 'awaiting_approval');
    assert.equal(finished.events.length, 2);
    const host = process.platform === 'win32' ? 'Windows' : 'Mac';
    assert.equal(finished.events[1].label, `Codex → ${host}: focused plan proposed`);
    assert.equal(await readJob(root, '../../private'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('dashboard authorizes the local listening address before serving job data', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'frontier-dashboard-http-'));
  const server = createDashboardServer({ dataDir: root });
  t.after(async () => {
    try {
      if (server.listening) await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const id = '22222222-2222-4222-8222-222222222222';
  await mkdir(path.join(root, 'jobs'));
  await writeFile(path.join(root, 'jobs', id + '.jsonl'), JSON.stringify({
    jobId: id, sequence: 1, at: '2026-10-21T00:00:00.000Z',
    type: 'job.created', data: { goal: 'Private dashboard fixture' },
  }) + '\n');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  const numeric = '127.0.0.1:' + port;
  const localhost = 'localhost:' + port;
  const route = '/api/jobs/' + id;
  const get = (headers, target = route) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: target, headers,
      setHost: false, agent: false, timeout: 3000 }, response => {
      response.setEncoding('utf8');
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, body }));
    });
    req.once('timeout', () => req.destroy(new Error('Dashboard HTTP fixture timed out')));
    req.once('error', reject).end();
  });

  for (const authority of [numeric, localhost]) {
    for (const origin of [undefined, 'http://' + authority]) {
      const result = await get({ Host: authority, ...(origin ? { Origin: origin } : {}) });
      assert.equal(result.status, 200);
      assert.equal(JSON.parse(result.body).job.title, 'Private dashboard fixture');
    }
  }

  const wrongPort = port === 65535 ? port - 1 : port + 1;
  const refused = [
    [{ Host: 'example.invalid:' + port }],
    [{ Host: '127.0.0.1:' + wrongPort }],
    [{ Host: '127.0.0.1' }],
    [{}],
    [{ Host: numeric, Origin: 'https://example.invalid' }],
    [{ Host: numeric, Origin: 'http://' + localhost }],
    [{ Host: numeric, Origin: 'http://127.0.0.1:' + wrongPort }],
    [{ Host: numeric, Origin: 'null' }],
    [{ Host: numeric, Origin: '' }],
    [{ Host: numeric, Forwarded: 'host=' + numeric }],
    [{ Host: numeric, 'X-Forwarded-Host': numeric }],
    [{ Host: numeric, 'X-Forwarded-Port': String(port) }],
    [{ Host: numeric, 'X-Forwarded-For': '127.0.0.1' }],
    [{ Host: numeric, 'X-Real-IP': '127.0.0.1' }],
    [['Host', numeric, 'Host', numeric]],
    [['Host', numeric, 'Origin', 'http://' + numeric, 'Origin', 'http://' + numeric]],
    [{ Host: numeric }, 'http://example.invalid:' + port + route],
  ];
  for (const [headers, target] of refused) {
    assert.deepEqual(await get(headers, target), { status: 403, body: 'Forbidden' },
      JSON.stringify({ headers, target }));
  }
});
