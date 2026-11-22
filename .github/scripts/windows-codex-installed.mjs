import {installedCandidate} from './windows-installed-input.mjs';
import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {appendFile, lstat, mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert.equal(process.versions.node, '24.22.3');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const {source, tree, archiveSha, manifestSha, bootstrapSha, artifactId, version:packageVersion='0.1.0-beta.229', javascriptFingerprint} = installedCandidate('codex');
assert.equal(process.argv.length, 5);
const [home, vendor, bundle] = process.argv.slice(2);
assert.equal(path.dirname(home), process.env.RUNNER_TEMP);
assert.equal(path.dirname(bundle), process.env.RUNNER_TEMP);
assert.equal(vendor, path.join(home, '.codex', 'packages', 'standalone', 'current', 'bin', 'codex.exe'));

const exec = promisify(execFile);
const vendorSha = 'cefea4ffee1fff04983a99c0dda99944d8b380e891e740a28b32f4b815a6e0b7';
const system = path.join(process.env.SystemRoot, 'System32');
const appData = process.env.LOCALAPPDATA;
const env = {
  OS: process.env.OS,
  SystemRoot: process.env.SystemRoot,
  WINDIR: process.env.SystemRoot,
  Path: system,
  HOME: home,
  USERPROFILE: home,
  LOCALAPPDATA: appData,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  TEMP: path.join(home, 'Temp'),
  TMP: path.join(home, 'Temp'),
  CODEX_HOME: path.join(home, '.codex'),
  CODEX_CI: '1',
};
for (const dir of [env.APPDATA, env.TEMP, env.CODEX_HOME]) await mkdir(dir, {recursive:true});
const root = path.join(appData, 'Mosaic Beta');
const launcher = path.join(root, 'bin', 'mosaic.exe');
const name = 'mosaic-beta';
const foreign = 'unrelated-fixture';
const absent = file => assert.rejects(lstat(file), {code:'ENOENT'});
const json = async file => JSON.parse(await readFile(file, 'utf8'));

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

async function run(command, args, {timeout = 45_000, inputEnv = env} = {}) {
  try {
    const {stdout} = await exec(command, args, {env:inputEnv, cwd:home, windowsHide:true,
      timeout, maxBuffer:512 * 1024});
    return stdout.trim();
  } catch (error) {
    throw Error(path.basename(command) + ': ' + (error.stderr?.trim() || error.stdout?.trim() || error.message));
  }
}
const codex = (...args) => run(vendor, args);
const mosaic = (...args) => run(launcher, args);
const record = {source, archiveSha256:archiveSha, manifestSha256:manifestSha, artifactId,
  vendor:{version:'0.171.0', sha256:vendorSha}, handshake:{}};
await absent(root);
assert.equal(await sha256(vendor), vendorSha);
assert.match(await codex('--version'), /^codex-cli 0\.171\.0$/);
const configFile = path.join(env.CODEX_HOME, 'config.toml');
const analytics = '[analytics]\nenabled = false';
await writeFile(configFile, analytics + '\n', {flag:'wx'});
await absent(path.join(env.CODEX_HOME, 'auth.json'));

const candidate = await json(path.join(bundle, 'candidate.json'));
assert.equal(candidate.kind, 'mosaic-windows-beta-candidate');
assert.equal(candidate.platform, 'win32-x64');
assert.equal(candidate.sourceCommit, source);
assert.equal(candidate.sourceTree, tree);
assert.equal(candidate.version, packageVersion);
assert.equal(candidate.javascriptFingerprint,javascriptFingerprint);
assert.equal(candidate.archiveName, 'mosaic-beta-'+packageVersion+'-win-x64.zip');
assert.equal(candidate.archiveSha256, archiveSha);
assert.equal(candidate.bootstrapSha256, bootstrapSha);
assert.equal(candidate.packageManifestSha256, manifestSha);
const archive = path.join(bundle, candidate.archiveName);
const bootstrap = path.join(bundle, 'install.ps1');
assert.equal(await sha256(archive), archiveSha);
assert.equal(await sha256(bootstrap), bootstrapSha);
const powershell = path.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const installEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(?:PATH|PSMODULEPATH|NODE_OPTIONS|NODE_PATH)$/i.test(key)));
installEnv.Path = [system, process.env.SystemRoot].join(';');
await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', bootstrap, '-Archive', archive, '-ArchiveSha256', archiveSha,
  '-Version', candidate.version, '-NoGuide'], {timeout:150_000, inputEnv:installEnv});
const version = path.join(root, 'versions', candidate.version);
const receipt = await json(path.join(root, 'config', 'installation.json'));
assert.equal(receipt.archiveSha256, archiveSha);
assert.equal(await sha256(launcher), receipt.launcherHash);
assert.equal(await sha256(path.join(version, 'package-manifest.json')), manifestSha);
record.launcherSha256 = receipt.launcherHash;
console.log('Verified exact installed Beta archive, private receipt, bundled inventory and stable launcher.');

const load = relative => import(pathToFileURL(path.join(version, 'runtime', relative)).href);
const {locations} = await load('src/beta/files.mjs');
const {HOST_IDS} = await load('src/beta/hosts/index.mjs');
const {setupPortable, portableSetupComplete} = await load('src/beta/portable-setup.mjs');
const {readBundledNativeCheckRuntime,readBundledJavaScriptCheckRuntime} = await load('src/beta/package-contract.mjs');
const {readSettings} = await load('src/beta/settings.mjs');
const {client} = await load('src/beta/client.mjs');
const {readHostConnection} = await load('src/beta/hosts/connection-evidence.mjs');
const {stopForMaintenance} = await load('src/beta/service.mjs');
const {registration} = await load('src/beta/windows-service.mjs');

const paths = locations(home);
assert.equal(paths.launcher, launcher);
const preview = JSON.parse(await mosaic('host-preview', '--host', 'codex'));
assert.deepEqual(preview.argv, ['mcp','add',name,'--',launcher,'mcp']);
const other = path.join(home, 'Foreign registration', 'foreign.exe');
await absent(other);
await codex('mcp', 'add', foreign, '--', other, '--preserve');
const configs = async () => Object.fromEntries(JSON.parse(await codex('mcp', 'list', '--json'))
  .map(config => [config.name, config]));
const unrelated = (await configs())[foreign];
assert.deepEqual(unrelated.transport.args, ['--preserve']);
assert.equal(unrelated.transport.command, other);
assert.match(await codex(...preview.argv), /Added global MCP server 'mosaic-beta'/);

async function unchanged(config) {
  assert.deepEqual(Object.keys(config).sort(), [name, foreign].sort());
  assert.deepEqual(config[foreign], unrelated);
  assert.equal(config[name].enabled, true);
  assert.deepEqual(config[name].transport, {
    type:'stdio', command:launcher, args:['mcp'], env:null, env_vars:[], cwd:null,
  });
  const settings = (await readFile(configFile, 'utf8')).replaceAll('\r\n', '\n');
  assert.ok(settings.includes(analytics));
  await absent(path.join(env.CODEX_HOME, 'auth.json'));
}

async function inspectAppServer() {
  const process = spawn(vendor, ['app-server', '--stdio'], {env, cwd:home, windowsHide:true,
    stdio:['pipe','pipe','pipe']});
  let startedError = null, stderr = '', id = 0;
  process.once('error', error => { startedError = error; });
  process.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
  process.stdin.on('error', () => {});
  const lines = createInterface({input:process.stdout});
  const read = lines[Symbol.asyncIterator]();
  const exited = new Promise(resolve => process.once('close', (code, signal) => resolve({code, signal})));
  const timeout = setTimeout(() => process.kill(), 30_000);
  const send = packet => process.stdin.write(JSON.stringify(packet) + '\n');
  async function request(method, params) {
    const key = ++id;
    send({id:key, method, params});
    while (true) {
      const {value, done} = await read.next();
      if (done) throw Error('Codex app-server ended during ' + method + ': ' + (startedError?.message || stderr));
      const result = JSON.parse(value);
      if (result.id !== key || !Object.hasOwn(result, 'result') && !Object.hasOwn(result, 'error')) continue;
      if (result.error) throw Error(method + ': ' + result.error.message);
      return result.result;
    }
  }
  try {
    await request('initialize', {clientInfo:{name:'mosaic-offline-qualification', version:'1'}});
    send({method:'initialized'});
    const account = await request('account/read', {refreshToken:false});
    assert.equal(account.account, null);
    assert.equal(account.userId ?? null, null);
    const list = await request('mcpServerStatus/list', {serverName:name, detail:'toolsAndAuthOnly', limit:1});
    assert.equal(list.data.length, 1);
    const [status] = list.data;
    assert.equal(status.name, name);
    return status;
  } finally {
    process.stdin.end();
    const result = await Promise.race([exited, delay(4000, null, {ref:false})]);
    if (result === null) {
      process.kill();
      await exited;
    }
    clearTimeout(timeout);
    lines.close();
  }
}

async function handshake(stage, expected) {
  await unchanged(await configs());
  const status = await inspectAppServer();
  if (expected === 'connected') {
    assert.equal(status.serverInfo?.name, name);
    assert.equal(status.toolsError, null);
    assert.ok(Object.hasOwn(status.tools, 'registry_list'));
  } else {
    assert.equal(status.serverInfo, null);
    assert.deepEqual(status.tools, {});
    assert.match(status.toolsError, /MCP startup failed|handshak/i);
  }
  record.vendor.signedIn = false;
  record.handshake[stage] = expected;
  console.log('Signed-out Codex app-server MCP discovery ' + stage + ': ' + expected);
}

let stopped = false;
try {
  await absent(path.join(paths.state, 'connection.json'));
  await handshake('before_start', 'failed');
  const nativeCheckRuntime = javascriptFingerprint
    ? await readBundledJavaScriptCheckRuntime(path.join(version,'runtime'), (await json(path.join(version,'package-manifest.json'))).javascriptCheckArtifact)
    : await readBundledNativeCheckRuntime();
  if (javascriptFingerprint) assert.equal(nativeCheckRuntime.artifactManifestSha256,javascriptFingerprint);
  const execution = {backend:javascriptFingerprint?'windows-isolated-js':'windows-appcontainer', backendRevision:1,
    runtimeFingerprint:nativeCheckRuntime.artifactManifestSha256};
  const prompts = [
    [/Choose host/u, String(HOST_IDS.indexOf('codex') + 1)],
    [/Choose worker setup/u, '4'],
    [/Show technical settings details/u, 'n'],
    [/Run optional model discovery/u, 'n'],
    [/Run optional inference connectivity test/u, 'n'],
    [/Save this local setup and reviewed manual host instructions/u, 'y'],
  ];
  let output = '';
  assert.equal(await setupPortable(paths, {execution, nativeCheckRuntime,
    ask:async prompt => {
      const next = prompts.shift();
      assert.ok(next, 'Unexpected setup prompt: ' + prompt);
      assert.match(prompt, next[0]);
      return next[1];
    },
    output:{write: chunk => { output += chunk; }},
  }), true);
  assert.deepEqual(prompts, []);
  assert.match(output, /zero provider requests/u);
  assert.equal(await portableSetupComplete(paths), true);
  const settings = await readSettings(paths);
  assert.equal(settings.host.id, 'codex');
  assert.deepEqual(settings.providers, []);
  const task = await registration(paths);
  assert.equal(task.owned && task.registered, true);
  const api = client(paths, {timeoutMs:3000});
  assert.ok((await api('tools_list')).some(tool => tool.name === 'registry_list'));

  await handshake('with_coordinator', 'connected');
  assert.equal(await readHostConnection(paths), null);
  record.vendor.registryCall = 'not_observed';
  const {Client} = await load('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const {StdioClientTransport} = await load('node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
  const sdk = new Client({name:'Mosaic scripted registry evidence', version:'1'});
  try {
    const {command, args} = (await configs())[name].transport;
    await sdk.connect(new StdioClientTransport({command, args, cwd:home, env}));
    assert.ok((await sdk.listTools()).tools.some(tool => tool.name === 'registry_list'));
    const reply = await sdk.callTool({name:'registry_list', arguments:{}}, undefined, {timeout:15_000});
    assert.ok(!reply.isError && reply.content?.some(item =>
      item.type === 'text' && item.text.includes('codex_only')));
    assert.equal((await readHostConnection(paths))?.kind, 'registry_call');
    record.scriptedRegistryCall = 'passed';
    console.log('Separate scripted SDK registry_list passed through the exact same installed stdio entry.');
  } finally { await sdk.close(); }

  await stopForMaintenance(paths);
  stopped = true;
  assert.equal((await registration(paths)).registered, false);
  await assert.rejects(api('tools_list'), /unavailable|disconnected/i);
  await handshake('after_stop', 'failed');
  await codex('mcp', 'remove', name);
  assert.deepEqual(await configs(), {[foreign]:unrelated});
  assert.match(await readFile(configFile, 'utf8'), /\[analytics\]\r?\nenabled = false/);
  await absent(path.join(env.CODEX_HOME, 'auth.json'));
  record.unrelatedRegistrationAndSettingsPreserved = true;
  record.configuredProviderCount = settings.providers.length;
  const report = JSON.stringify(record, null, 2);
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    '### Installed Codex app-server handshake\n\n```json\n' + report + '\n```\n');
} finally {
  if (!stopped && (await registration(paths)).registered) await stopForMaintenance(paths, {recovering:true});
}
