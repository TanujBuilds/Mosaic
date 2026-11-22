import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {
  connectScriptedMcp, createWorkflowRepository, loopbackSetupProvider,
  stageWindowsSource, startWorkflowService, workerModel,
} from '../test-support/windows-workflows.mjs';

const cases = [
  {host: 'codex', mode: 'collaborative', version: 1, planner: 'codex', actors: ['codex', 'deepseek']},
  {host: 'claude-code', mode: 'codex_only', version: 1, planner: 'codex', actors: ['codex']},
  {host: 'cursor', mode: 'deepseek_only', version: 1, planner: 'deepseek', actors: ['deepseek']},
  {host: 'antigravity', mode: 'overnight_review', version: 2, planner: 'deepseek', actors: ['deepseek']},
];

test('workflow qualification provider is loopback-only and rejects task prompts', async t => {
  const provider = await loopbackSetupProvider(t);
  assert.equal(new URL(provider.url).hostname, '127.0.0.1');
  const list = await fetch(provider.url + '/models');
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).data, [{id: workerModel}]);
  const response = await fetch(provider.url + '/chat/completions', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      model: workerModel, max_tokens: 16, messages: [{role: 'user', content: 'Private task canary'}],
    }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(provider.requests.map(call => call.method), ['GET', 'POST']);
});

function assertProviderTraffic(provider, hasWorker) {
  const requests = provider.requests;
  assert.deepEqual(requests.map(request => [request.method, request.path]), hasWorker ? [
    ['GET', '/v1/models'], ['POST', '/v1/chat/completions'],
  ] : []);
  if (!hasWorker) return;
  assert.equal(requests[0].body, '');
  assert.ok(requests.every(request => request.authorization === undefined));
  const completion = JSON.parse(requests[1].body);
  assert.equal(completion.model, workerModel);
  assert.equal(completion.max_tokens, 16);
  assert.deepEqual(completion.messages, [
    {role: 'user', content: 'Mosaic setup connectivity probe. Reply with setup ok.'},
  ]);
}

async function configure(stage, paths, host, provider, hasWorker) {
  const {HOST_IDS, getHost} = await stage.load('beta/hosts/index.mjs');
  const {setupPortable, portableSetupComplete} = await stage.load('beta/portable-setup.mjs');
  const {readSettings} = await stage.load('beta/settings.mjs');
  const {jsonFile, localDirectory, saveJson} = await stage.load('beta/files.mjs');
  const adapter = getHost(host);
  const preview = adapter.previewRegistration({paths, launcher: paths.launcher});
  await localDirectory(paths, path.dirname(preview.target));
  await saveJson(preview.target, {unrelatedFixtureSetting: 'preserve me'});

  const prompts = [
    [/Choose host/u, String(HOST_IDS.indexOf(host) + 1)],
    [/Choose worker setup/u, hasWorker ? '1' : '4'],
    ...(hasWorker ? [
      [/API base URL/u, provider.url],
      [/Model ID/u, workerModel],
      [/require an API bearer key/u, 'n'],
    ] : []),
    [/Show technical settings details/u, 'n'],
    [/Run optional model discovery/u, 'y'],
    [/Run optional inference connectivity test/u, 'y'],
    [/Apply this exact setup and managed host binding/u, 'y'],
  ];
  let output = '';
  assert.equal(await setupPortable(paths, {
    execution: stage.execution,
    nativeCheckRuntime: stage.nativeCheckRuntime,
    ask: async prompt => {
      const next = prompts.shift();
      assert.ok(next, 'unexpected setup question: ' + prompt);
      assert.match(prompt, next[0]);
      return next[1];
    },
    output: {write: chunk => { output += chunk; }},
  }), true);
  assert.deepEqual(prompts, []);
  assert.equal(await portableSetupComplete(paths), true);
  assert.ok(output.includes(adapter.displayName + ' saved'));
  assert.match(output, /actual host registration is unverified/u);
  if (!hasWorker) assert.match(output, /zero provider requests/u);

  const settings = await readSettings(paths);
  assert.equal(settings.host.id, host);
  assert.deepEqual(settings.defaults.review, {source: 'host', hostId: host});
  assert.deepEqual(settings.execution, stage.execution);
  assert.deepEqual(settings.nativeCheckRuntime, stage.nativeCheckRuntime);
  assert.equal(settings.providers.length, hasWorker ? 1 : 0);
  if (hasWorker) {
    assert.equal(settings.providers[0].baseUrl, provider.url);
    assert.equal(settings.providers[0].model, workerModel);
  }

  const config = await jsonFile(preview.target);
  const binding = host === 'codex' ? config.registration.transport : config.mcpServers['mosaic-beta'];
  assert.equal(config.unrelatedFixtureSetting, 'preserve me');
  assert.equal(binding.command, paths.launcher);
  assert.deepEqual(binding.args, ['mcp']);
}

function workflowManifest(stage, fixture, scenario) {
  return {
    submissionId: 'windows-' + scenario.mode.replaceAll('_', '-'),
    objective: 'Keep the workflow qualification sample stable.',
    acceptance: ['The project manifest binds the clean, committed sample and the exact check argv.'],
    mode: scenario.mode,
    modeVersion: scenario.version,
    project: {
      repo: fixture.repo,
      baseCommit: fixture.baseCommit,
      readPaths: ['src/', 'checks/'],
      writePaths: ['src/'],
      checks: [{id: 'sample-check', argv: [stage.checkNode, 'checks/verify.mjs']}],
    },
    limits: {hours: 1, maxTasks: 1, reviewAgentRuns: scenario.mode === 'deepseek_only' ? 0 : 1},
    ...(scenario.version === 2 ? {
      overnightPolicy: {preflightCheckIds: ['sample-check'], finalOnlyCheckIds: []},
    } : {}),
  };
}

function assertNoWork(paths) {
  const db = new DatabaseSync(path.join(paths.state, 'harness.sqlite3'), {readOnly: true});
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM requests').get().n, 0);
    assert.equal(db.prepare(`
      SELECT count(*) AS n FROM records
      WHERE kind IN ('native_preflight', 'task', 'planning', 'review_ticket')
    `).get().n, 0);
  } finally {
    db.close();
  }
}

// Scope: real Windows source-built file helper and foreground coordinator, Git for
// Windows, pinned runtime inventory, and real MCP stdio through a scripted client.
// Host entries are isolated fixtures. The provider serves only opted-in setup
// diagnostics. Package installation, signed-in hosts and workload preflight,
// planning, task execution, review and integration require separate qualification.
test('Windows source coordinator qualifies four selected host configurations and workflow drafts', {
  skip: process.platform !== 'win32',
  timeout: 240_000,
}, async t => {
  const stage = await stageWindowsSource(t);
  const {locations, privateDirectories} = await stage.load('beta/files.mjs');
  const fixture = await createWorkflowRepository(stage);

  for (const scenario of cases) await t.test(scenario.host + ' / ' + scenario.mode, async caseTest => {
    const {host, mode} = scenario;
    const hasWorker = mode !== 'codex_only';
    const home = path.join(stage.root, host + ' disposable profile');
    await mkdir(home);
    const paths = locations(home, true);
    await privateDirectories(paths);
    const provider = await loopbackSetupProvider(caseTest);
    await configure(stage, paths, host, provider, hasWorker);
    assertProviderTraffic(provider, hasWorker);

    const stop = await startWorkflowService(caseTest, stage, paths);
    const {readHostConnection} = await stage.load('beta/hosts/connection-evidence.mjs');
    assert.equal(await readHostConnection(paths), null);
    const {client, call} = await connectScriptedMcp(caseTest, stage, paths);
    const {tools} = await client.listTools();
    const names = new Set(tools.map(tool => tool.name));
    for (const name of ['registry_list', 'assignment_prepare', 'review_inbox']) assert.ok(names.has(name), name);
    assert.equal(names.has('service_stop'), false);
    assert.equal(await readHostConnection(paths), null, 'tool listing alone is insufficient connection evidence');

    const registry = await call('registry_list');
    assert.deepEqual(new Set(registry.modes.map(entry => entry.id)), new Set(cases.map(entry => entry.mode)));
    assert.ok(registry.modes.some(entry => entry.id === mode && entry.version === scenario.version));
    const connection = await readHostConnection(paths);
    assert.equal(connection?.kind, 'registry_call');
    assert.equal(connection.hostId, host);
    assert.ok(connection.at <= Date.now());

    const manifest = workflowManifest(stage, fixture, scenario);
    const input = {manifest, idempotencyKey: randomUUID()};
    const prepared = await call('assignment_prepare', input);
    assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
    assert.match(prepared.hash, /^[a-f0-9]{64}$/u);
    assert.deepEqual(await call('assignment_prepare', input), prepared);
    const {goalId} = prepared;
    const goal = await call('goal_get', {goalId});
    assert.equal(goal.hash, prepared.hash);
    assert.equal(goal.status, 'draft');
    assert.equal(goal.manifest.environment, 'live');
    assert.deepEqual(goal.manifest.executionPolicy, {version: 1, ...stage.execution});
    assert.equal(goal.manifest.mode.id, mode);
    assert.equal(goal.manifest.mode.version, scenario.version);
    assert.equal(goal.manifest.mode.planner, scenario.planner);
    assert.deepEqual(goal.manifest.mode.actors, scenario.actors);
    assert.equal(goal.manifest.project.repo, fixture.repo);
    assert.equal(goal.manifest.project.baseCommit, fixture.baseCommit);
    assert.deepEqual(goal.manifest.project.checks[0].argv, manifest.project.checks[0].argv);

    if (hasWorker) {
      assert.equal(goal.manifest.providerPolicy.defaultWorkerId, 'worker-1');
      assert.deepEqual(goal.manifest.providerPolicy.workers.map(profile => [profile.baseUrl, profile.model]),
        [[provider.url, workerModel]]);
    } else {
      assert.equal(goal.manifest.providerPolicy, undefined);
      assert.equal(registry.workerProfile, null);
    }
    if (mode === 'deepseek_only') {
      assert.equal(goal.manifest.reviewPolicy, undefined);
      assert.equal(goal.manifest.mode.review, 'checks');
    } else {
      assert.deepEqual(goal.manifest.reviewPolicy, {version: 1, source: 'host', hostId: host, fallback: 'wait'});
    }
    if (scenario.version === 2) {
      assert.deepEqual(goal.manifest.overnightPolicy.preflightCheckIds, ['sample-check']);
      // The observer may already have materialized the draft preparation report.
      if(goal.overnightRun){
        assert.equal(goal.overnightRun.phase,'preparation');
        assert.equal(goal.overnightRun.approvalHash,prepared.hash);
        assert.equal(goal.overnightRun.deadline,null);
        assert.equal(goal.overnightRun.taskId,null);
      }
    }

    assert.equal(goal.planning, null);
    assert.deepEqual(goal.tasks, []);
    assert.deepEqual((await call('review_inbox', {goalId})).items, []);
    // Probe the dispatch guard with a mismatched approval. Do not attempt to
    // run or simulate the still-unqualified Windows protected workload.
    const invalid = await call('goal_activate', {
      goalId, hash: '0'.repeat(64), idempotencyKey: randomUUID(),
    }, {error: true});
    assert.match(invalid.error, /Exact goal or draft revision approval hash required for native preflight/u);
    assert.equal((await call('goal_get', {goalId})).status, 'draft');

    assert.equal((await call('work_control', {
      goalId, action: 'stop', idempotencyKey: randomUUID(),
    })).status, 'stopped');
    const receipt = await call('goal_finalize', {
      goalId, summary: 'Qualification ended at the unactivated draft.', partial: true, idempotencyKey: randomUUID(),
    });
    assert.equal(receipt.status, 'partial');
    assert.equal(receipt.receipt.approvalHash, prepared.hash);
    assert.equal(receipt.receipt.spending.model, 0);
    assert.deepEqual(receipt.receipt.tasks, []);
    await client.close();
    await stop();
    assertNoWork(paths);
    assertProviderTraffic(provider, hasWorker);
    assert.equal((await fixture.git(fixture.repo, 'rev-parse', 'HEAD')).trim(), fixture.baseCommit);
    assert.equal(await fixture.git(fixture.repo, 'status', '--porcelain'), '');
  });
});

test('Windows Beta app-only consult uses host review and cannot grant project or worker authority', {
  skip: process.platform !== 'win32', timeout: 120000,
}, async t => {
  const stage = await stageWindowsSource(t);
  // Re-open a pre-consult draft with the exact historical capability inventory.
  const {Coordinator} = await stage.load('harness/coordinator.mjs');
  const {normalizeGoal, digest} = await stage.load('harness/contracts.mjs');
  const {Goals} = await stage.load('harness/goals.mjs');
  let now = Date.now();
  const old = new Coordinator({root:path.join(stage.root,'old consult drafts'),beta:true,selectedHost:'claude-code',now:()=>now});
  try {
    const raw = {submissionId:'historical-consult',mode:'codex_only',objective:'Explain the total.',
      acceptance:['Include shipping.']};
    const historical = normalizeGoal(old.reviewPreparation(raw,{portable:true}),old.registry);
    historical.mode = {...historical.mode,capabilities:historical.mode.capabilities.filter(id=>id!=='research')};
    historical.capabilities = historical.capabilities.filter(cap=>cap.id!=='research');
    assert.ok(historical.mode.capabilities.includes('coding'));
    const hash=digest(historical);
    const saved=old.store.command('original-key',{op:'goal.prepare',manifest:historical},()=>
      old.store.submission('goal','',raw.submissionId,hash,id=>({id,manifest:historical,hash,version:1,
        status:'draft',createdAt:old.now(),activatedAt:null,deadline:null})));
    for(const key of ['original-key','fresh-key']){
      const retry=old.preparePortableGoal(raw,key);
      assert.equal(retry.id,saved.id);
      assert.equal(retry.hash,hash);
    }
    assert.throws(()=>old.preparePortableGoal({...raw,objective:'Changed objective'},'changed'),/Submission conflict/);
    assert.throws(()=>old.activateGoal({goalId:saved.id,hash},'try-old-approval'),/Windows protected coding/);
    for(const action of ['stop','expire']){
      const draft=old.preparePortableGoal({...raw,submissionId:action},action+'-prepare');
      old.activateGoal({goalId:draft.id,hash:draft.hash},action+'-activate');
      const task=old.submitTask({goalId:draft.id,kind:'consult',actor:'codex',submissionId:action,
        objective:raw.objective,acceptance:raw.acceptance},action+'-submit');
      const active=old.startNativeText({taskId:task.id},action+'-start');
      if(action==='stop'){
        old.control({taskId:task.id,action:'pause'},'pause-text');
        assert.throws(()=>old.finishNativeText({taskId:task.id,content:'late answer'},'late-paused'));
        assert.equal(old.control({taskId:task.id,action:'resume'},'resume-text').status,'codex_ready');
        const restarted=old.startNativeText({taskId:task.id},'restart-text');
        assert.equal(restarted.deadline,active.deadline);
        assert.notEqual(restarted.nativeTextFinish.idempotencyKey,active.nativeTextFinish.idempotencyKey);
        assert.throws(()=>old.finishNativeText({taskId:task.id,content:'stale answer'},active.nativeTextFinish.idempotencyKey),/current native_text_start/);
        old.control({goalId:draft.id,action:'stop'},'stop-text');
      }else{
        now=active.deadline;
        old.expireQuiescent();
        assert.equal(old.getTask(task.id).status,'partial');
      }
      assert.throws(()=>old.finishNativeText({taskId:task.id,content:'late answer'},action+'-late'));
      const finished=new Goals(old).finalize({goalId:draft.id,partial:true,summary:action},action+'-receipt');
      assert.equal(finished.status,'partial');
      assert.equal(finished.receipt.tasks[0].deadline,active.deadline);
    }
  } finally {old.close();}
  const {locations, privateDirectories} = await stage.load('beta/files.mjs');
  const home = path.join(stage.root, 'consult profile');
  await mkdir(home);
  const paths = locations(home, true);
  await privateDirectories(paths);
  const provider = await loopbackSetupProvider(t);
  await configure(stage, paths, 'claude-code', provider, false);
  const stop = await startWorkflowService(t, stage, paths);
  const {client,call} = await connectScriptedMcp(t, stage, paths);
  try {
    await call('registry_list');
    const mutate = (name, input, options) => call(name, {...input, idempotencyKey: randomUUID()}, options);
    const manifest = {submissionId:'text-consult', objective:'Explain the invoice total in words.',
      acceptance:['State both amounts.'], mode:'codex_only', limits:{hours:1,maxTasks:1,reviewAgentRuns:1}};
    const prepare = {manifest, idempotencyKey:randomUUID()};
    const draft = await call('goal_prepare', prepare);
    assert.deepEqual(await call('goal_prepare', prepare), draft);
    assert.equal(draft.manifest.project, null);
    assert.deepEqual(draft.manifest.capabilities.map(item => item.id), ['consult']);
    const goalId = draft.id;
    await mutate('goal_activate', {goalId, hash:'0'.repeat(64)}, {error:true});
    const goal = await mutate('goal_activate', {goalId, hash:draft.hash});
    const fixture = await createWorkflowRepository(stage);
    const coding = workflowManifest(stage,fixture,cases[1]);
    const revision = await mutate('goal_revision_prepare',{goalId,expectedHash:draft.hash,
      manifest:{...manifest, executionPolicy:draft.manifest.executionPolicy, project:coding.project}});
    const blocked = await mutate('goal_revision_activate',{revisionId:revision.id,hash:revision.hash},{error:true});
    assert.match(blocked.error,/Windows protected coding is in development/);
    assert.equal((await call('goal_get',{goalId})).hash,draft.hash);
    const spec = {submissionId:'explain', objective:manifest.objective, acceptance:manifest.acceptance, actor:'codex'};
    for (const kind of ['coding','research','learning']) {
      const refused = await mutate('task_submit', {goalId, task:{...spec, kind}}, {error:true});
      assert.match(refused.error, /capability|prohibit|parked/i);
    }
    const scoped = await mutate('task_submit', {goalId, task:{...spec, kind:'consult',
      permissions:{readPaths:['src/'],writePaths:['src/'],checks:[]}}}, {error:true});
    assert.match(scoped.error, /Non-coding task cannot grant file write scope/);
    const task = await mutate('task_submit', {goalId, task:{...spec, kind:'consult'}});
    assert.deepEqual(task.spec.permissions, {readPaths:[],writePaths:[],checks:[]});
    const active = await mutate('native_text_start', {taskId:task.id});
    await call('native_text_finish', {taskId:task.id, content:'1250 plus 250 is 1500.',
      idempotencyKey:active.nativeTextFinish.idempotencyKey});
    const {binding} = (await call('review_inbox', {goalId})).items[0];
    const ticket = await mutate('review_reserve', binding);
    const result = await mutate('review_submit', {...binding, ticketId:ticket.ticketId,
      verdict:{decision:'accept', feedback:'Both amounts and their sum are present.', findings:[]}});
    assert.equal(result.status,'accepted');
    assert.equal(result.spent.model,0);
    assert.equal((await call('goal_get',{goalId})).deadline,goal.deadline);
    assertProviderTraffic(provider,false);
    const db = new DatabaseSync(path.join(paths.state,'harness.sqlite3'), {readOnly:true});
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM requests').get().n,0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM records WHERE kind IN ('native_preflight','execution_owner')").get().n,0);
    } finally { db.close(); }
  } finally {
    try { await client.close(); } finally { await stop(); }
  }
});
