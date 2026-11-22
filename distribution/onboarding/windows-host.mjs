// This release companion runs with the archive's runtime/bin/node.exe. Read the
// selected host and connection receipt through that same release's private APIs.
import {execFile, spawn, spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {registerCodex} from './host.mjs';

const exec = promisify(execFile);
const serverName = 'mosaic-beta';
const deferred = Symbol('later');
const hosts = {
  codex: {
    name: 'Codex', installer: 'https://chatgpt.com/codex/install.ps1', download: 'https://github.com/openai/codex#installing-and-running-codex-cli',
    status: ['login', 'status'], login: ['login'],
    refresh: 'Open a new Codex session in the same profile. Use /mcp in the CLI or MCP Servers in Settings.'
  },
  'claude-code': {
    name: 'Claude Code', installer: 'https://claude.ai/install.ps1', download: 'https://code.claude.com/docs/en/setup#install-on-native-windows',
    status: ['auth', 'status', '--text'], login: ['auth', 'login'],
    refresh: 'Start Claude Code in your intended project and open /mcp. Check the selected server and its command.'
  },
  cursor: {
    name: 'Cursor', download: 'https://cursor.com/download',
    refresh: 'Restart Cursor and open Customize → MCPs. Check for a project-level entry that could take precedence.'
  },
  antigravity: {
    name: 'Antigravity', download: 'https://antigravity.google/download',
    refresh: 'Open Customizations → Installed → MCP Servers and refresh mosaic-beta. In the IDE, use the agent panel’s MCP Servers manager.'
  }
};

async function loadMosaic(home) {
  const beta = path.resolve(path.dirname(process.execPath), '../src/beta');
  const load = file => import(pathToFileURL(path.join(beta, file)).href);
  const [{locations}, {readSettings}, {getHost}, {hostConnectionIdentity, readHostConnection}] = await Promise.all([
    load('files.mjs'), load('settings.mjs'), load('hosts/index.mjs'), load('hosts/connection-evidence.mjs')
  ]);
  const paths = locations(home ?? os.homedir(), home !== undefined);
  const settings = await readSettings(paths);
  if (settings?.schema !== 2 || !Object.hasOwn(hosts, settings.host?.id ?? '')) {
    throw Error('Run mosaic setup to save your coding app first.');
  }
  const id = settings.host.id;
  const preview = getHost(id).previewRegistration({paths, launcher: paths.launcher});
  const identity = hostConnectionIdentity(settings);
  return {
    id, preview, home: paths.home, isolated: paths.isolated,
    checkSettings: async () => {
      if (hostConnectionIdentity(await readSettings(paths))?.settingsHash !== identity.settingsHash) {
        throw Error('Mosaic setup changed. Restart the guide to use the newly saved settings.');
      }
    },
    receipt: () => readHostConnection(paths)
  };
}

async function capture(file, args, options = {}) {
  try {
    const {stdout, stderr} = await exec(file, args, {encoding: 'utf8', timeout: 15000, maxBuffer: 256 * 1024, ...options});
    return {status: 0, stdout, stderr};
  } catch (error) {
    return {status: error.code, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '')};
  }
}

// Release the terminal between prompts so that vendor sign-in can own its TTY.
function terminalQuestion(question) {
  return new Promise((resolve, reject) => {
    const rl = createInterface({input: process.stdin, output: process.stdout, historySize: 0});
    rl.once('SIGINT', () => rl.close());
    rl.once('close', () => reject(Error('Terminal closed. Rerun this installer to resume.')));
    rl.question(question, value => { resolve(value); rl.close(); });
  });
}

async function choice(io, prompt, options) {
  for (;;) {
    const answer = (await io.ask(prompt + ' [' + [...options, 'later'].join('/') + '] ')).trim().toLowerCase();
    if (answer === 'later') throw deferred;
    if (options.includes(answer)) return answer;
    io.say('Type ' + [...options, 'later'].join(' or ') + ' and press Return.');
  }
}

function interactive(file, args) {
  return spawnSync(file, args, {stdio: 'inherit'}).status === 0;
}

function windowsPowerShell() {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function installCli(url) {
  const result = spawnSync(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    "$ErrorActionPreference = 'Stop'; Invoke-RestMethod -UseBasicParsing -Uri $env:MOSAIC_HOST_INSTALL_URL | Invoke-Expression"],
  {env: {...process.env, MOSAIC_HOST_INSTALL_URL: url}, stdio: 'inherit'});
  return result.status === 0;
}

async function openWindows(target, args = []) {
  if (path.isAbsolute(target)) {
    return new Promise(resolve => {
      const child = spawn(target, args, {stdio: 'ignore', detached: true, windowsHide: true});
      child.once('error', () => resolve(false));
      child.once('spawn', () => { child.unref(); resolve(true); });
    });
  }
  // Open the fixed vendor URL as data, without substituting it into a command.
  const result = await capture(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    'Start-Process -FilePath $env:MOSAIC_HOST_OPEN_TARGET -ErrorAction Stop'],
  {env: {...process.env, MOSAIC_HOST_OPEN_TARGET: target}, windowsHide: true});
  return result.status === 0;
}

async function findHost(context, host, io) {
  let offerInstall = host.installer && !context.isolated;
  for (;;) {
    const executable = await io.installed(host, context);
    if (executable) return executable;
    if (offerInstall) {
      offerInstall = false;
      io.say(host.name + ' CLI was not found. Mosaic can run the official Windows installer.');
      let answer;
      do {
        answer = (await io.ask('Install ' + host.name + ' CLI now? [y/N] ')).trim().toLowerCase();
      } while (!['y', 'yes', 'n', 'no', ''].includes(answer));
      if (answer === 'y' || answer === 'yes') {
        io.say('Installing ' + host.name + ' CLI…');
        if (await io.install(host.installer)) {
          const installed = await io.installed(host, context);
          if (installed) return installed;
        }
        io.say('Could not finish installing ' + host.name + ' CLI. You can install it manually below.');
      }
    }
    io.say(host.name + ' was not found. Install the official Windows version. ' + host.download);
    const response = await choice(io, 'Open the official Windows setup page, enter an executable path, or recheck?',
      ['open', 'location', 'recheck']);
    if (response === 'location') {
      const requested = (await io.ask('Absolute path to your installed ' + host.name + ' executable: ')).trim();
      const target = await io.executablePath(requested);
      if (!target) {
        io.say('Choose a local .exe outside a project’s node_modules\\.bin.');
        continue;
      }
      io.say('Mosaic will use this executable to connect: ' + JSON.stringify(target));
      if (await choice(io, 'Use this executable?', ['use', 'back']) === 'use') return target;
      continue;
    }
    if (response === 'open') {
      if (!await io.open(host.download)) io.say('The vendor setup page could not be opened. Use the address above.');
      await choice(io, 'After the Windows installation finishes, recheck here.', ['recheck']);
    }
  }
}

async function signIn(host, executable, io) {
  if (!host.status) {
    io.say('Open ' + host.name + ' and complete sign-in there if prompted.');
    const action = await choice(io, 'Open the app now, or continue if it is open?', ['open', 'continue']);
    if (action === 'open' && !await io.open(executable)) io.say('Open ' + host.name + ' from the Windows Start menu.');
    return;
  }
  for (;;) {
    if ((await io.capture(executable, host.status)).status === 0) return;
    io.say(host.name + ' did not confirm a signed-in account. Use its own sign-in window.');
    const action = await choice(io, 'Start sign-in, or recheck after signing in separately?', ['login', 'recheck']);
    if (action === 'login' && !io.interactive(executable, host.login)) io.say('Sign-in has not finished.');
  }
}

function sameCommand(entry, launcher) {
  return entry?.command === launcher && Array.isArray(entry.args) && entry.args.length === 1 && entry.args[0] === 'mcp';
}

function codexBinding(result, launcher) {
  if (result.status !== 0) {
    return result.status === 1 && result.stderr.trim() === "Error: No MCP server named 'mosaic-beta' found." ? 'missing' : 'unknown';
  }
  let entry;
  try { entry = JSON.parse(result.stdout); } catch { return 'unknown'; }
  const transport = entry?.transport;
  if (!sameCommand(transport, launcher) || entry.name !== serverName || entry.enabled !== true || transport.type !== 'stdio') return 'conflict';
  if (transport.env != null && Object.keys(transport.env).length || transport.env_vars?.length || transport.cwd != null ||
      entry.enabled_tools != null || entry.disabled_tools?.length || entry.disabled_reason != null) return 'conflict';
  return 'same';
}

async function manualEntry(context, io) {
  const {id, preview} = context;
  if (id === 'codex') {
    io.say('In Codex Settings → MCP Servers, add a custom stdio server named mosaic-beta only if that name is free.');
  } else if (id === 'claude-code') {
    io.say('In Claude Code, open /mcp and inspect mosaic-beta in the intended project.');
    io.say('If the name is free, rerun the guide and choose add.');
  } else {
    io.say(id === 'cursor'
      ? 'In Cursor, open the global MCP configuration (%USERPROFILE%\\.cursor\\mcp.json) under Customize → MCPs.'
      : 'Open Customizations → Installed → MCP Servers → Open MCP Config. In the IDE, use Manage MCP Servers → View raw config.');
    io.say('In an existing file, merge only the mosaic-beta member into mcpServers. An empty file takes the entire block.');
    io.say(JSON.stringify({mcpServers: {[serverName]: preview.entry}}, null, 2));
  }
  io.say('Expected executable: ' + JSON.stringify(preview.launcher) + '   Single argument: mcp');
  io.say('Keep a matching entry. If mosaic-beta points elsewhere or has extra arguments or environment settings, preserve it and resolve the name conflict in the app.');
  await choice(io, 'After the selected app shows the matching entry, confirm here.', ['confirmed']);
}

async function register(context, host, executable, io) {
  const {preview, id} = context;
  const launcher = preview.launcher;
  if (id === 'codex') {
    const check = async () => codexBinding(await io.capture(executable, ['mcp', 'get', '--json', serverName]), launcher);
    let state = await check();
    if (state === 'missing') {
      io.say('Mosaic can add a user MCP server named mosaic-beta to this Codex profile.');
      io.say('Executable: ' + JSON.stringify(launcher) + '   Argument: mcp');
      if (await choice(io, 'Save this registration in Codex, or use Settings yourself?', ['save', 'manual']) === 'save') {
        await context.checkSettings();
        const result = await io.registerCodex(executable, launcher);
        state = await check();
        if (result !== 'written' && state !== 'same') io.say('Codex could not confirm the guarded registration. Check the entry in Settings.');
      }
    }
    if (state === 'same') {
      io.say('Codex reports a saved, enabled Mosaic registration.');
      return;
    }
    if (state === 'conflict') io.say('Codex already has a different mosaic-beta registration. The guide preserved it.');
    for (;;) {
      await manualEntry(context, io);
      const confirmed = await check();
      if (confirmed === 'same') {
        io.say('Codex reports the matching saved registration.');
        return;
      }
      if (confirmed === 'unknown') {
        io.say('You confirmed the entry in Codex. This CLI version could not independently read it.');
        return;
      }
      io.say('The CLI still shows a missing or different entry. Check the Codex profile and its MCP settings.');
    }
  } else if (id === 'cursor') {
    io.say('Look for mosaic-beta in Cursor under Customize → MCPs in your intended project.');
    io.say('Expected executable: ' + JSON.stringify(launcher) + '   Single argument: mcp');
    const state = await choice(io, 'Is the name free, already a match, or in use by another entry?', ['free', 'match', 'conflict']);
    if (state === 'match') {
      io.say('You confirmed the existing entry in Cursor.');
      return;
    }
    if (state === 'free' && await choice(io, 'Open the Cursor install prompt, or enter the settings manually?', ['open', 'manual']) === 'open') {
      await context.checkSettings();
      const url = new URL('cursor://anysphere.cursor-deeplink/mcp/install');
      url.searchParams.set('name', serverName);
      url.searchParams.set('config', Buffer.from(JSON.stringify({command: launcher, args: ['mcp']})).toString('base64'));
      const opened = await io.open(executable, ['--open-url', '--', url.href]);
      if (opened) {
        io.say('Review the entry in Cursor and choose Install. If the name is now in use, cancel and preserve the existing entry.');
        await choice(io, 'After Cursor shows the matching entry, confirm here.', ['confirmed']);
        io.say('You confirmed the saved entry in Cursor.');
        return;
      }
      io.say('Cursor could not open the install prompt. Add it in MCP settings instead.');
    }
  } else if (id === 'claude-code') {
    // 'mcp get' can start a foreign server to health-check it. Let the vendor's
    // user-scope add reject duplicate names and inspect duplicates in the app.
    io.say('Claude Code can register mosaic-beta for your user account. Its add command refuses an existing name in that scope.');
    io.say('Executable: ' + JSON.stringify(launcher) + '   Argument: mcp');
    const action = await choice(io, 'Add this registration, or inspect the existing entry in /mcp?', ['add', 'inspect']);
    if (action === 'add') {
      await context.checkSettings();
      const result = await io.capture(executable, preview.argv);
      if (result.status === 0 && /^Added stdio MCP server mosaic-beta\b/im.test(result.stdout)) {
        io.say('Claude Code reports that it saved the Mosaic registration.');
        return;
      }
      io.say('Claude Code did not confirm a new entry. Check the existing registration in /mcp.');
    }
  }
  await manualEntry(context, io);
  io.say('You confirmed the saved entry in ' + host.name + '.');
}

export async function runHost(context, io) {
  try {
    const host = hosts[context.id];
    io.say('\nConnect ' + host.name + ' to Mosaic');
    const executable = await findHost(context, host, io);
    await signIn(host, executable, io);
    await context.checkSettings();
    await register(context, host, executable, io);
    const baseline = (await context.receipt())?.at ?? 0;
    const start = Date.now();
    io.say(host.refresh);
    io.say('In that app, check that mosaic-beta lists registry_list, then ask: “Call the mosaic-beta registry_list tool with {} and show whether it succeeds.”');
    io.say('The check starts no Mosaic work. Asking in a chat may use your app’s model.');
    for (;;) {
      await choice(io, 'After you see a successful tool result in ' + host.name + ', check its Mosaic receipt here.', ['check']);
      await context.checkSettings();
      const receipt = await context.receipt();
      if (receipt?.hostId === context.id && receipt.kind === 'registry_call' && receipt.at > baseline &&
          receipt.at >= start && receipt.at <= Date.now()) {
        io.say('Mosaic recorded a fresh registry call at ' + new Date(receipt.at).toISOString() +
          '. You confirmed the result in ' + host.name + '.');
        return 0;
      }
      io.say('Mosaic has yet to record a new registry call for these settings. Refresh the server, call registry_list again and recheck.');
    }
  } catch (error) {
    if (error !== deferred) throw error;
    io.say('Coding-app connection deferred. Re-run the installer to resume, or see mosaic connect.');
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== 'win32' || !process.stdin.isTTY) throw Error('Use interactive PowerShell on Windows to connect the coding app.');
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--home' || !path.isAbsolute(args[1]))) {
      throw Error('Invalid Mosaic onboarding arguments.');
    }
    const context = await loadMosaic(args[1]);
    // Keep the calling project's working directory and PATH out of vendor sign-in and setup.
    const bundledNode = path.dirname(process.execPath);
    const system = process.env.SystemRoot ?? 'C:\\Windows';
    process.env.PATH = [bundledNode, path.join(system, 'System32'), system].join(path.delimiter);
    process.chdir(context.home);
    if (context.isolated) {
      process.env.HOME = process.env.USERPROFILE = context.home;
      process.env.APPDATA = path.join(context.home, 'AppData', 'Roaming');
      process.env.LOCALAPPDATA = path.join(context.home, 'AppData', 'Local');
      process.env.CODEX_HOME = path.join(context.home, '.codex');
      process.env.CLAUDE_CONFIG_DIR = path.join(context.home, '.claude');
    }
    const detection = await import(pathToFileURL(path.resolve(bundledNode, '../src/beta/hosts/detection.mjs')).href);
    process.exitCode = await runHost(context, {
      ask: terminalQuestion, say: text => console.log(text), capture, interactive, registerCodex, install: installCli,
      installed: (_, selection) => detection.windowsHostExecutable(selection.id, selection),
      executablePath: detection.windowsExecutable, open: openWindows,
    });
  } catch (error) {
    console.error(error?.code === 'ERR_MODULE_NOT_FOUND' ? 'Run this guide with Mosaic’s bundled Node runtime.' :
      'Coding-app setup stopped. ' + (/^(?:Mosaic setup changed|Run mosaic setup|Use interactive PowerShell|Terminal closed)/u.test(error.message) ?
        error.message : 'Check the saved setup with mosaic connect and run the guide again.'));
    process.exitCode = 1;
  }
}
