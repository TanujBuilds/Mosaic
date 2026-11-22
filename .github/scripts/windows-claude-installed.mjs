import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {appendFile, lstat, mkdir, readFile, realpath, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert.equal(process.versions.node, '24.22.3');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.equal(process.env.GITHUB_REF, 'refs/heads/codex/windows-claude-installed');
assert.equal(process.argv.length, 5);
const [home, vendor, bundle] = process.argv.slice(2);
assert.equal(path.dirname(home), process.env.RUNNER_TEMP);
assert.equal(path.dirname(bundle), process.env.RUNNER_TEMP);
assert.equal(vendor, path.join(home, '.local', 'bin', 'claude.exe'));

const exec = promisify(execFile);
const source = '97b7ae388f3e8d03f4eba132a24c57e3997d62df';
const archiveSha = 'bfcaf46c70228dea09b80746455233b89a6c3667c8e5549b24a8666d0cc4ddaf';
const manifestSha = 'ef7e57ef39cb25eb5a56e4b90b52a0c8bc5b1947eb066058ff948a616f2be21e';
const bootstrapSha = '6a1e53c0d9874ce6839cc7e65a2db5e6cd8992b3c6bc07b8757e325e828342e1';
const vendorSha = '5064e6e0572dca86257363ca04d48653eef20ef27f1bd04b504ed7199ed3fd13';
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
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
};
for (const dir of [env.APPDATA, env.TEMP, env.CLAUDE_CONFIG_DIR]) await mkdir(dir, {recursive:true});
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

async function run(command, args, {expected = 0, timeout = 45_000, inputEnv = env} = {}) {
  try {
    const {stdout} = await exec(command, args, {env:inputEnv, cwd:home, windowsHide:true,
      timeout, maxBuffer:512 * 1024});
    assert.equal(expected, 0, command + ' should exit ' + expected);
    return stdout.trim();
  } catch (error) {
    if (error.code === expected && expected !== 0) return error.stdout.trim();
    throw Error(path.basename(command) + ': ' + (error.stderr?.trim() || error.stdout?.trim() || error.message));
  }
}
const claude = (...args) => run(vendor, args);
const mosaic = (...args) => run(launcher, args);
const record = {source, archiveSha256:archiveSha, manifestSha256:manifestSha, artifactId:14742128055,
  vendor:{version:'2.1.323', sha256:vendorSha}, handshake:{}};
await absent(root);
assert.equal(await sha256(vendor), vendorSha);
assert.match(await claude('--version'), /^2\.1\.323 \(Claude Code\)$/);
const auth = JSON.parse(await run(vendor, ['auth', 'status'], {expected:1}));
assert.equal(auth.loggedIn, false);
assert.equal(auth.authMethod, 'none');
assert.equal((await realpath(auth.configDirectory)).toLowerCase(), (await realpath(env.CLAUDE_CONFIG_DIR)).toLowerCase());
record.vendor.signedIn = false;
console.log('Pinned Claude Code reported a signed-out disposable profile.');

const candidate = await json(path.join(bundle, 'candidate.json'));
assert.equal(candidate.kind, 'mosaic-windows-beta-candidate');
assert.equal(candidate.platform, 'win32-x64');
assert.equal(candidate.sourceCommit, source);
assert.equal(candidate.sourceTree, '88aef246de25262301203e1be9a60a681a0c201c');
assert.equal(candidate.version, '0.1.0-beta.229');
assert.equal(candidate.archiveName, 'mosaic-beta-0.1.0-beta.229-win-x64.zip');
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
const {readBundledNativeCheckRuntime} = await load('src/beta/package-contract.mjs');
const {readSettings} = await load('src/beta/settings.mjs');
const {client} = await load('src/beta/client.mjs');
const {readHostConnection} = await load('src/beta/hosts/connection-evidence.mjs');
const {stopForMaintenance} = await load('src/beta/service.mjs');
const {registration} = await load('src/beta/windows-service.mjs');

const paths = locations(home);
assert.equal(paths.launcher, launcher);
const preview = JSON.parse(await mosaic('host-preview', '--host', 'claude-code'));
assert.deepEqual(preview.argv, ['mcp','add','--transport','stdio','--scope','user',name,'--',launcher,'mcp']);
const other = path.join(home, 'Foreign registration', 'foreign.exe');
await absent(other);
await claude('mcp', 'add', '--transport', 'stdio', '--scope', 'user', foreign, '--', other, '--preserve');
const candidates = [path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'), path.join(home, '.claude.json')];
const configFiles = (await Promise.all(candidates.map(async file =>
  lstat(file).then(() => file, error => { if (error.code !== 'ENOENT') throw error; })
))).filter(Boolean);
assert.equal(configFiles.length, 1);
const configs = async () => (await json(configFiles[0])).mcpServers;
const unrelated = (await configs())[foreign];
assert.deepEqual(unrelated.args, ['--preserve']);
assert.equal(unrelated.command, other);
const settingsFile = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
const settingsBytes = Buffer.from('{"alwaysThinkingEnabled":false}\n');
await writeFile(settingsFile, settingsBytes, {flag:'wx'});
assert.match(await claude(...preview.argv), /^Added stdio MCP server mosaic-beta\b/im);
function unchanged(config) {
  assert.deepEqual(Object.keys(config).sort(), [name, foreign].sort());
  assert.deepEqual(config[foreign], unrelated);
  assert.equal(config[name].type, 'stdio');
  assert.equal(config[name].command, launcher);
  assert.deepEqual(config[name].args, ['mcp']);
}

async function handshake(stage, expected) {
  unchanged(await configs());
  const listing = (await claude('mcp', 'list')).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const lines = listing.split(/\r?\n/).map(line => line.trim());
  const observed = server => {
    const line = lines.find(value => value.startsWith(server + ':'));
    assert.ok(line, 'Missing Claude health status for ' + server);
    if (/Failed to connect\b/i.test(line)) return 'failed';
    if (/\bConnected\s*$/i.test(line)) return 'connected';
    throw Error('Unexpected Claude health status: ' + line);
  };
  assert.equal(observed(name), expected, listing);
  assert.equal(observed(foreign), 'failed', listing);
  unchanged(await configs());
  assert.deepEqual(await readFile(settingsFile), settingsBytes);
  record.handshake[stage] = expected;
  console.log('Claude MCP list ' + stage + ': ' + expected);
}

let stopped = false;
try {
  await absent(path.join(paths.state, 'connection.json'));
  await handshake('before_start', 'failed');
  const nativeCheckRuntime = await readBundledNativeCheckRuntime();
  const execution = {backend:'windows-appcontainer', backendRevision:1,
    runtimeFingerprint:nativeCheckRuntime.artifactManifestSha256};
  const prompts = [
    [/Choose host/u, String(HOST_IDS.indexOf('claude-code') + 1)],
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
  assert.equal(settings.host.id, 'claude-code');
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
    const entry = (await configs())[name];
    await sdk.connect(new StdioClientTransport({...entry, cwd:home, env}));
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
  await claude('mcp', 'remove', '--scope', 'user', name);
  assert.deepEqual(await configs(), {[foreign]:unrelated});
  assert.deepEqual(await readFile(settingsFile), settingsBytes);
  record.unrelatedRegistrationAndSettingsPreserved = true;
  record.configuredProviderCount = settings.providers.length;
  const report = JSON.stringify(record, null, 2);
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    '### Installed Claude Code handshake\n\n```json\n' + report + '\n```\n');
} finally {
  if (!stopped && (await registration(paths)).registered) await stopForMaintenance(paths, {recovering:true});
}
