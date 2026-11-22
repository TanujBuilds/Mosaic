import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert.equal(process.versions.node, '24.22.3');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.equal(process.argv.length, 3);
const directory = path.resolve(process.argv[2]);
const parse = async file => JSON.parse(await readFile(file, 'utf8'));
const candidate = await parse(path.join(directory, 'candidate.json'));
assert.equal(candidate.kind, 'mosaic-windows-beta-candidate');
assert.equal(candidate.platform, 'win32-x64');
assert.equal(candidate.sourceCommit, process.env.GITHUB_SHA);
assert.match(candidate.version, /^\d+\.\d+\.\d+-beta\.\d+$/);
assert.equal(candidate.archiveName, 'mosaic-beta-' + candidate.version + '-win-x64.zip');
for (const field of ['archiveSha256', 'bootstrapSha256', 'packageManifestSha256']) {
  assert.match(candidate[field], /^[a-f0-9]{64}$/);
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

const archive = path.join(directory, candidate.archiveName);
const bootstrap = path.join(directory, 'install.ps1');
assert.equal(await digest(archive), candidate.archiveSha256);
assert.equal(await digest(bootstrap), candidate.bootstrapSha256);
const home = path.resolve(process.env.USERPROFILE);
const root = path.join(process.env.LOCALAPPDATA, 'Mosaic Beta');
assert.equal(root.toLowerCase(), path.join(home, 'AppData', 'Local', 'Mosaic Beta').toLowerCase());
await assert.rejects(lstat(root), { code: 'ENOENT' });
await assert.rejects(lstat(path.join(process.env.LOCALAPPDATA, 'Mosaic')), { code: 'ENOENT' });
const launcher = path.join(root, 'bin', 'mosaic.exe');
const version = path.join(root, 'versions', candidate.version);
const state = path.join(root, 'state');
const system = path.join(process.env.SystemRoot, 'System32');
const powershell = path.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(?:PATH|PSMODULEPATH|NODE_OPTIONS|NODE_PATH)$/i.test(key)));
env.Path = [system, process.env.SystemRoot].join(';');
const exec = promisify(execFile);
const scratch = await mkdtemp(path.join(process.env.RUNNER_TEMP, 'Mosaic operator evidence '));

async function run(command, args, { expected = 0, timeout = 45_000 } = {}) {
  let result;
  try {
    result = { ...await exec(command, args, { cwd:scratch, env, timeout, windowsHide:true, maxBuffer:1024 * 1024 }), code:0 };
  } catch (error) {
    if (!Number.isInteger(error.code)) throw error;
    result = error;
  }
  const diagnostic = args[0] === 'support-bundle' ? result.stderr : result.stderr + '\n' + result.stdout;
  assert.equal(result.code, expected, path.basename(command) + ' ' + args[0] + ' failed\n' + diagnostic);
  return { stdout:result.stdout, stderr:result.stderr };
}
const mosaic = (args, options) => run(launcher, args, options);
const installed = relative => import(pathToFileURL(path.join(version, 'runtime', relative)).href);

try {
  await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', bootstrap, '-Version', candidate.version, '-Archive', archive,
    '-ArchiveSha256', candidate.archiveSha256, '-NoGuide'], { timeout:150_000 });
  const installation = await parse(path.join(root, 'config', 'installation.json'));
  assert.equal(installation.archiveSha256, candidate.archiveSha256);
  assert.equal(await digest(launcher), installation.launcherHash);
  assert.equal(await digest(path.join(version, 'package-manifest.json')), candidate.packageManifestSha256);
  await assert.rejects(lstat(path.join(state, 'connection.json')), { code: 'ENOENT' });
  console.log('Stock PowerShell installed the exact candidate and stable Mosaic Beta launcher.');

  const { locations } = await installed('src/beta/files.mjs');
  const { windowsFile } = await installed('src/beta/windows-files.mjs');
  const { setupPortable } = await installed('src/beta/portable-setup.mjs');
  const { readSettings } = await installed('src/beta/settings.mjs');
  const { readBundledNativeCheckRuntime } = await installed('src/beta/package-contract.mjs');
  const { client } = await installed('src/beta/client.mjs');
  const { stopForMaintenance } = await installed('src/beta/service.mjs');
  const { registration } = await installed('src/beta/windows-service.mjs');
  const paths = locations(home);
  assert.equal(paths.root, root);
  const nativeCheckRuntime = await readBundledNativeCheckRuntime();
  const execution = { backend:'windows-appcontainer', backendRevision:1,
    runtimeFingerprint:nativeCheckRuntime.artifactManifestSha256 };
  const settings = { schema:2, host:{id:'claude-code', options:{}}, providers:[],
    defaults:{workerId:null, plannerWorkerId:null, review:{source:'host', hostId:'claude-code'}},
    serviceMaxConcurrentTasks:1, capacityGroups:[], execution, nativeCheckRuntime };
  const prompts = [
    [/Run optional model discovery/u, 'n'],
    [/Run optional inference connectivity test/u, 'n'],
    [/Save this local setup and reviewed manual host instructions/u, 'y'],
  ];
  try {
    assert.equal(await setupPortable(paths, { settings,
      ask: async prompt => {
        const next = prompts.shift();
        assert.ok(next, 'Unexpected installed setup prompt: ' + prompt);
        assert.match(prompt, next[0]);
        return next[1];
      },
      output:{write() {}},
    }), true);
    assert.deepEqual(prompts, []);
    assert.deepEqual((await readSettings(paths)).providers, []);
    assert.equal((await registration(paths)).registered, true);

    const api = client(paths, { timeoutMs:6000 });
    const idle = await mosaic(['status', '--once']);
    assert.match(idle.stdout, /Start a Mosaic Beta goal in Claude Code/);
    const objective = 'Private Operator Fixture Marker';
    const draft = await api('goal_prepare', { idempotencyKey:'operator-fixture-draft', manifest:{
      submissionId:'installed-operator-fixture', mode:'codex_only', environment:'fixture',
      objective, acceptance:['Keep the existing Windows hold and preserve this saved draft.'],
    }});
    assert.equal(draft.status, 'draft');
    assert.match(draft.hash, /^[a-f0-9]{64}$/);
    const status = await mosaic(['status', '--once']);
    assert.match(status.stdout, /Mosaic Beta/);
    assert.match(status.stdout, new RegExp(objective));
    assert.match(status.stdout, /draft/i);
    const queue = await mosaic(['queue', draft.id]);
    assert.match(queue.stdout, /Mosaic queue/);
    assert.match(queue.stdout, new RegExp(objective));
    assert.match(queue.stdout, /Status draft/);
    assert.match(queue.stdout, /No saved assignments/);
    const morning = await mosaic(['morning-report', draft.id]);
    assert.match(morning.stdout, /Mosaic morning report/);
    assert.match(morning.stdout, new RegExp(objective));
    assert.match(morning.stdout, /0 verified integrations/);
    assert.match(morning.stdout, /0 recorded reservations/);
    console.log('Installed status, queue and morning report rendered a real saved draft.');

    async function doctor(argv, dispatch) {
      const { stdout } = await mosaic(argv, { expected:1 });
      assert.match(stdout, /OK  Package integrity/);
      assert.match(stdout, /OK  Settings .*Private setup saved/);
      assert.match(stdout, /OK  Coordinator/);
      assert.doesNotMatch(stdout, /CHECK  Setup/);
      assert.match(stdout, /CHECK  Protected checks .*Windows protected coding is in development/);
      assert.match(stdout, dispatch);
      assert.doesNotMatch(stdout, /(?:GET https?:|\/chat\/completions)/);
    }
    await doctor(['doctor'], /INFO  Dispatch .*Mosaic is on/);
    await mosaic(['off']);
    try {
      await doctor(['doctor','--providers'], /INFO  Dispatch .*Mosaic is off/);
    } finally {
      assert.match((await mosaic(['on'])).stdout, /Existing approval and execution guards still apply/);
    }
    console.log('Installed doctor verified the package and coordinator and reported the protected hold.');

    const outputDir = path.join(scratch, 'Private diagnostic export');
    await windowsFile('mkdir', outputDir);
    const bundlePath = path.join(outputDir, 'support.json');
    const command = ['support-bundle','--home',home];
    const [operator, viewer] = await Promise.all(['connection.json','viewer-connection.json']
      .map(file => parse(path.join(state, file))));
    for (const token of [operator.token, viewer.token]) {
      assert.ok(/^[a-f0-9]{64}$/.test(token), 'Expected a private connection token');
    }
    assert.ok(operator.token !== viewer.token, 'Viewer and operator connections require distinct credentials');
    const verifyBundle = stdout => {
      const bundle = JSON.parse(stdout);
      assert.equal(bundle.kind, 'mosaic-redacted-support');
      assert.deepEqual(bundle.collection, {status:'available', viewerCalls:2});
      assert.equal(bundle.local.settings.executionBackend, 'windows-appcontainer');
      assert.equal(bundle.snapshot.goals.byStatus.draft, 1);
      assert.equal(bundle.snapshot.tasks.processed, 0);
      assert.equal(bundle.usage.nativeTokens, null);
      assert.ok(bundle.diagnostics.includes('NATIVE_USAGE_UNKNOWN'));
      for (const privateValue of [objective, operator.token, viewer.token, home, operator.url]) {
        assert.ok(!stdout.includes(JSON.stringify(privateValue).slice(1, -1)),
          'Support bundle leaked a private fixture value');
      }
    };
    verifyBundle((await mosaic(command)).stdout);
    await assert.rejects(lstat(bundlePath), { code:'ENOENT' });
    const saved = await mosaic([...command, '--output', bundlePath]);
    verifyBundle(saved.stdout);
    const bytes = await windowsFile('read-private', bundlePath, { max:256 * 1024 });
    assert.equal(bytes.toString(), saved.stdout);
    const duplicate = await mosaic([...command, '--output', bundlePath], { expected:2 });
    assert.match(duplicate.stderr, /OUTPUT_EXISTS/);
    assert.deepEqual(await readFile(bundlePath), bytes);
    assert.deepEqual((await api('goal_get', {goalId:draft.id})).tasks, []);
    assert.equal((await api('goal_get', {goalId:draft.id})).status, 'draft');
    console.log('Installed support preview and private export redacted fixture data, with exact no-clobber behavior.');
    const report = JSON.stringify({source:candidate.sourceCommit, archiveSha256:candidate.archiveSha256,
      manifestSha256:candidate.packageManifestSha256, launcherSha256:installation.launcherHash,
      goalStatus:'draft', taskCount:0, providerCount:0, supportViewerCalls:2, supportSha256:await digest(bundlePath),
      commands:['status --once','queue','morning-report','doctor','doctor --providers','support-bundle']}, null, 2);
    console.log(report);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      '### Installed Windows Beta operator walk-through\n\n```json\n' + report + '\n```\n');
  } finally {
    if ((await registration(paths)).registered) await stopForMaintenance(paths, { recovering:true });
    assert.equal((await registration(paths)).registered, false);
  }
} finally {
  await rm(scratch, { recursive:true, force:true, maxRetries:4 });
}
