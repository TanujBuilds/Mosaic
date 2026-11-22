import {execFile, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {command} from './command.mjs';
import {assertWindowsGitPaths, isLocalWindowsPath, parseWindowsIndexModes, windowsGitProcess, windowsGitRecords} from './windows-git.mjs';

const execute = promisify(execFile);
const systemPath = '/usr/bin:/bin';
const executable = '/usr/bin/git';
const isWindows = process.platform === 'win32';
const windowsFiles = isWindows ? await import('../beta/windows-files.mjs') : null;
const metadataLimit = 1024 * 1024;
const identityKeys = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
const userIdentityPattern = '^user\\.(name|email)$';
const settings = [
  'core.fsmonitor=', 'core.untrackedCache=false', 'core.ignoreStat=false', 'core.hooksPath=/dev/null',
  'core.trustctime=true', 'core.checkStat=default', 'core.attributesFile=/dev/null',
  'core.excludesFile=/dev/null', 'submodule.recurse=false', 'status.submoduleSummary=false',
  'status.renames=false', 'protocol.allow=never', 'commit.gpgsign=false', 'commit.verbose=false',
  'maintenance.auto=false', 'gc.auto=0', 'core.editor=/usr/bin/false',
];
const diffCommands = new Set(['diff', 'diff-index', 'diff-tree', 'log', 'show']);
const gitCommands = new Set(['add', 'branch', 'cat-file', 'check-attr', 'check-ignore', 'commit', 'config', 'diff',
  'diff-index', 'diff-tree', 'hash-object', 'init', 'log', 'ls-files', 'ls-tree', 'merge', 'merge-base', 'mv', 'rev-list', 'rev-parse',
  'show', 'status', 'worktree']);
const usesPathspec = new Set(['add', 'check-attr', 'check-ignore', 'diff', 'diff-index', 'diff-tree',
  'hash-object', 'log', 'ls-files', 'ls-tree', 'show', 'status']);

function commandIndex(args) {
  // The only global options accepted from callers are literal identity overrides.
  let index = 0;
  while (args[index] === '-c' && /^user\.(?:name|email)=/.test(args[index + 1])) index += 2;
  return index;
}

export function gitInvocation(args, {discover = true, intake = false, inherited = process.env, identity = [],
  platform = process.platform, resolveExecutable} = {}) {
  const index = commandIndex(args);
  const subcommand = args[index];
  const requested = args.slice(index + 1);
  if (!gitCommands.has(subcommand) || subcommand === 'merge' && requested[0] !== '--ff-only') throw Error('Unsupported Git command');
  const windows = platform === 'win32';
  const runtime = windows ? windowsGitProcess({inherited, resolveExecutable}) : {executable, env: {PATH: systemPath}};
  if (!runtime) throw Error('Git for Windows was not found. Install the official Windows Git client and retry.');
  const separator = requested.indexOf('--');
  if (windows && usesPathspec.has(subcommand) && separator !== -1) {
    assertWindowsGitPaths(requested.slice(separator + 1).map(file => file.replace(/^\.\//u, '').replace(/\/$/u, '')));
  }
  const policy = windows
    ? [...settings.slice(0, -1), 'core.editor=exit 1', 'core.protectNTFS=true', 'core.autocrlf=false', 'core.eol=lf', 'core.filemode=false']
    : settings;
  const flags = [];
  if (subcommand === 'init') flags.push('--template=');
  if (diffCommands.has(subcommand)) flags.push('--no-ext-diff', '--no-textconv');
  if ((subcommand === 'diff' || subcommand === 'diff-index' || subcommand === 'status') &&
      !requested.some(argument => argument.startsWith('--ignore-submodules='))) flags.push('--ignore-submodules=dirty');
  const env = {
    ...runtime.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '',
    ...(discover ? {} : {GIT_DIR: '/dev/null'}),
  };
  if (subcommand === 'commit') {
    for (const key of identityKeys) if (inherited[key]) env[key] = inherited[key];
  }
  return {
    executable: runtime.executable, env, subcommand,
    args: ['--no-pager', ...(subcommand === 'check-ignore' ? [] : ['--literal-pathspecs']),
      ...policy.flatMap(setting => ['-c', setting]), ...identity.flatMap(setting => ['-c', setting]),
      ...(!windows && (intake || subcommand === 'status') ? ['-c', 'core.filemode=true'] : []), ...args.slice(0, index), subcommand, ...flags, ...requested],
  };
}

function argumentsFor(cwd, args, {timeout = 60_000, ...policy} = {}) {
  const invocation = gitInvocation(args, policy);
  // Start Git from its installation directory on Windows, then let Git change
  // to the checkout. The checkout is not the process's initial DLL search cwd.
  const workingDirectory = isWindows ? path.dirname(invocation.executable) : cwd;
  const argv = isWindows && cwd ? ['-C', cwd, ...invocation.args] : invocation.args;
  return [invocation.executable, argv,
    {cwd: workingDirectory, env: invocation.env, encoding: 'buffer', timeout, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL'}];
}

async function invoke(cwd, args, {input, ...options} = {}) {
  const [file, argv, {env, timeout, maxBuffer}] = argumentsFor(cwd, args, options);
  const result = await command([file, ...argv], {cwd, env, timeoutMs: timeout, maxBuffer, input, raw: true});
  if (!result.stopped && result.code === 0) return checkedOutput(args, result.stdout);
  const stderr = result.stderr.toString('utf8').trim();
  const reason = result.stopped ? 'time or output limit reached' : stderr || 'no Git diagnostic';
  throw Object.assign(Error(`git ${args[commandIndex(args)]} failed: ${reason}`), {code: result.stopped ? undefined : result.code, stderr});
}

function invokeSync(cwd, args, {input, ...options} = {}) {
  const [file, argv, opts] = argumentsFor(cwd, args, options);
  const result = spawnSync(file, argv, {...opts, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']});
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = result.stderr.toString('utf8');
    throw Object.assign(Error(`git ${args[0]} failed: ${stderr.trim()}`), {code: result.status, stderr});
  }
  return checkedOutput(args, result.stdout);
}

function checkedOutput(args, bytes) {
  if (isWindows && args[commandIndex(args)] === 'ls-files' && args.includes('-z')) {
    const stage = args.includes('--stage') || args.includes('-s');
    const tagged = args.includes('-v') || args.includes('-t');
    const files = windowsGitRecords(bytes).map(record => stage ? record.slice(record.indexOf('\t') + 1)
      : tagged ? record.slice(2) : record);
    assertWindowsGitPaths(files);
  }
  return bytes;
}

function stat(file) {
  try { return lstatSync(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function unsupportedConfig() {
  return Object.assign(Error('Unsupported Git config or metadata. Use regular files without Git config includes or alternate worktree paths.'),
    {code: 'unsupported_config'});
}

function readMetadata(file, limit) {
  if (isWindows) return windowsFiles.windowsFileSync('read', file, {max: limit});
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const entry = fstatSync(fd);
    if (!entry.isFile() || entry.size > limit) throw unsupportedConfig();
    const bytes = Buffer.alloc(entry.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const n = readSync(fd, bytes, length, bytes.length - length, null);
      if (!n) break;
      length += n;
    }
    if (length !== entry.size) throw unsupportedConfig();
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}

function directoryPointer(file, prefix = '') {
  const raw = readMetadata(file, 4096).toString('utf8');
  const value = raw.slice(prefix.length).replace(/\r?\n$/, '');
  if (!raw.startsWith(prefix) || !value || value !== value.trim() || /[\x00-\x1f\x7f\ufffd]/.test(value)) throw unsupportedConfig();
  if (isWindows) {
    if (path.isAbsolute(value) ? !isLocalWindowsPath(value) : /^[a-z]:/i.test(value)) throw unsupportedConfig();
    const absolute = path.resolve(path.dirname(file), value);
    windowsFiles.windowsFileSync('directory', absolute);
    const canonical = realpathSync.native(absolute);
    if (canonical.toUpperCase() !== absolute.toUpperCase()) throw unsupportedConfig();
    return canonical;
  }
  // Keep the raw path until realpath so a symlink followed by .. is resolved as Git resolves it.
  return realpathSync.native(path.isAbsolute(value) ? value : `${path.dirname(file)}${path.sep}${value}`);
}

function repositoryLayout(cwd, {init = false} = {}) {
  const repo = realpathSync.native(cwd), dotGit = path.join(repo, '.git'), entry = stat(dotGit);
  if (!entry && init) return {repo, gitDir: null, common: null};
  if (!entry) throw Object.assign(Error('Select the exact root of an accessible Git worktree'), {code: 'ENOENT'});
  try {
    if (!entry.isDirectory() && !entry.isFile()) throw unsupportedConfig();
    const gitDir = entry.isDirectory() ? dotGit : directoryPointer(dotGit, 'gitdir: ');
    const commonPointer = path.join(gitDir, 'commondir');
    const common = stat(commonPointer) ? directoryPointer(commonPointer) : gitDir;
    if (![gitDir, common].every(dir => lstatSync(dir).isDirectory())) throw unsupportedConfig();
    if (isWindows) for (const dir of new Set([gitDir, common])) windowsFiles.windowsFileSync('directory', dir);
    return {repo, gitDir, common};
  } catch { throw unsupportedConfig(); }
}

export function repositoryGitCommonDirectory(cwd) {
  return repositoryLayout(cwd).common;
}

function metadataFiles(cwd, options) {
  const {repo, gitDir, common} = repositoryLayout(cwd, options);
  if (!gitDir) return {repo, configs: []};
  try {
    const configs = [path.join(common, 'config'), path.join(gitDir, 'config.worktree')]
      .filter(file => stat(file)).map(file => readMetadata(file, metadataLimit));
    for (const dir of new Set([common, gitDir])) {
      const info = path.join(dir, 'info'), entry = stat(info);
      if (!entry) continue;
      if (!entry.isDirectory()) throw unsupportedConfig();
      if (isWindows) windowsFiles.windowsFileSync('directory', info);
      for (const name of ['attributes', 'exclude']) {
        const target = path.join(info, name), file = stat(target);
        if (file && (!file.isFile() || file.size > metadataLimit)) throw unsupportedConfig();
        if (file && isWindows) readMetadata(target, metadataLimit);
      }
    }
    return {repo, common, configs};
  } catch { throw unsupportedConfig(); }
}

const configPattern = `^(include|includeif\\..*)\\.path$|^core\\.worktree$|^filter\\..*\\.(clean|smudge|process|required)$|${userIdentityPattern}`;
const configArgs = ['config', '--file', '-', '--no-includes', '--null', '--name-only', '--get-regexp', configPattern];
const configOptions = {discover: false, timeout: 3000};
const configResults = new Map();

function configResult(bytes) {
  const key = createHash('sha256').update(bytes).digest('hex');
  if (configResults.has(key)) return configResults.get(key);
  let names;
  try { names = invokeSync(isWindows ? undefined : '/', configArgs, {...configOptions, input: bytes}).toString('utf8'); }
  catch (error) {
    if (error.code !== 1 || error.stderr) throw unsupportedConfig();
    names = '';
  }
  const entries = names.split('\0').filter(Boolean);
  const result = {
    unsupported: entries.some(name => name.startsWith('include') || name === 'core.worktree'),
    filters: entries.some(name => name.startsWith('filter.')),
    identity: new Set(entries.filter(name => name.startsWith('user.'))),
  };
  if (configResults.size >= 64) configResults.delete(configResults.keys().next().value);
  configResults.set(key, result);
  return result;
}

function verifyMetadata(cwd, options = {}) {
  const metadata = metadataFiles(cwd, options);
  const identityKeys = new Set();
  for (const config of metadata.configs) {
    const result = configResult(config);
    if (result.unsupported) throw unsupportedConfig();
    if (result.filters && !options.allowFilters) {
      throw Object.assign(Error('Unsupported Git filter. Use a checkout without configured clean, smudge or process filters.'),
        {code: 'unsupported_git_filter'});
    }
    for (const name of result.identity) identityKeys.add(name);
  }
  return {...metadata, identityKeys};
}

export function repositoryGitMetadata(cwd, {allowFilters = false} = {}) {
  return verifyMetadata(cwd, {allowFilters}).common;
}

function launchMetadata(cwd, args, options) {
  const subcommand = args[commandIndex(args)];
  return verifyMetadata(cwd, {init: subcommand === 'init', allowFilters: options.identityOnly && subcommand === 'rev-parse'});
}

function missingCommitIdentity(local, args) {
  const explicit = args.slice(0, commandIndex(args));
  return ['name', 'email'].filter(key => !local.has(`user.${key}`) &&
    !explicit.some(option => option.startsWith(`user.${key}=`)) &&
    !(process.env[`GIT_AUTHOR_${key.toUpperCase()}`] && process.env[`GIT_COMMITTER_${key.toUpperCase()}`]));
}

async function commitIdentity(keys) {
  // Read only the owner's optional name/email from the usual global config in
  // a separate process. Repository operations still see no global config.
  const home = homedir(), xdg = process.env.XDG_CONFIG_HOME;
  if (!path.isAbsolute(home)) return [];
  const query = ['config', '--global', '--no-includes', '--null', '--get-regexp', userIdentityPattern];
  const [file, argv, options] = argumentsFor(isWindows ? undefined : '/', query, configOptions);
  const env = {...options.env, HOME: home, ...(isWindows ? {USERPROFILE: home} : {}),
    ...(xdg && path.isAbsolute(xdg) ? {XDG_CONFIG_HOME: xdg} : {})};
  delete env.GIT_CONFIG_GLOBAL;
  try {
    const {stdout} = await execute(file, argv, {...options, env});
    const values = new Map(stdout.toString('utf8').split('\0').filter(Boolean).map(entry => {
      const split = entry.indexOf('\n');
      return [entry.slice(0, split), entry.slice(split + 1)];
    }));
    return keys.map(key => `user.${key}`).filter(key => values.get(key)).map(key => `${key}=${values.get(key)}`);
  } catch { return []; }
}

export async function checkoutGit(cwd, args, options = {}) {
  const {repo} = launchMetadata(cwd, args, options);
  return (await invoke(repo, args, {...options, timeout: 3000})).toString('utf8');
}

export function gitSync(cwd, ...args) {
  const {repo} = launchMetadata(cwd, args, {});
  const stdout = invokeSync(repo, args, {timeout: 3000}).toString('utf8');
  return gitText(args, stdout);
}

export async function gitBytes(cwd, ...args) {
  const {repo, identityKeys} = launchMetadata(cwd, args, {});
  const missing = args[commandIndex(args)] === 'commit' ? missingCommitIdentity(identityKeys, args) : [];
  if (!missing.length) return invoke(repo, args);
  const fallback = await commitIdentity(missing);
  const current = launchMetadata(repo, args, {});
  const identity = fallback.filter(setting => !current.identityKeys.has(setting.slice(0, setting.indexOf('='))));
  return invoke(repo, args, {identity});
}

export async function windowsIndexModes(cwd, files) {
  const paths = [...files];
  assertWindowsGitPaths(paths);
  const modes = new Map();
  for (let offset = 0; offset < paths.length; offset += 32) {
    const batch = new Set(paths.slice(offset, offset + 32));
    const bytes = await gitBytes(cwd, 'ls-files', '--stage', '-z', '--', ...batch);
    for (const [file, mode] of parseWindowsIndexModes(bytes)) {
      if (!batch.has(file)) throw Error('Windows Git index path differs from the checked path: ' + JSON.stringify(file));
      modes.set(file, mode);
    }
  }
  return modes;
}

export async function git(cwd, ...args) {
  const stdout = (await gitBytes(cwd, ...args)).toString('utf8');
  return gitText(args, stdout);
}

function gitText(args, stdout) {
  if (isWindows && args[0] === 'rev-parse' && args[1] === '--show-toplevel' && args.length === 2) {
    return realpathSync.native(stdout.replace(/\r?\n$/u, ''));
  }
  return args.includes('-z') ? stdout : stdout.trim();
}
