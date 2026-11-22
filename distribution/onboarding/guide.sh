#!/bin/sh
# Invoked beside verified host.mjs after the original Beta .228 installer.
set -u

resume() {
  printf '%s\n' 'To resume onboarding, run the Mosaic install command again.' >&2
}

stop() {
  status=$1
  shift
  printf '\n%s\n' "$*" >&2
  resume
  exit "$status"
}

if [ ! -t 0 ] || [ ! -t 1 ]; then
  stop 2 'Mosaic is installed. Open a Terminal window to continue setup.'
fi

git_wait_pid=''
interrupt() {
  if [ -n "$git_wait_pid" ]; then
    kill -TERM "$git_wait_pid" 2>/dev/null || :
    wait "$git_wait_pid" 2>/dev/null || :
  fi
  stop "$1" 'Mosaic onboarding was interrupted.'
}
trap 'interrupt 129' HUP
trap 'interrupt 130' INT
trap 'interrupt 143' TERM

case "${HOME:-}" in
  /*) ;;
  *) stop 1 'Mosaic needs your user home to locate the installed launcher.' ;;
esac
original_directory=$(pwd -P) || stop 1 'Open Terminal from an accessible directory to continue.'
stage=$(CDPATH= cd -P -- "$(/usr/bin/dirname -- "$0")" && pwd -P) ||
  stop 1 'The verified Mosaic setup files are unavailable.'
launcher="$HOME/.local/bin/mosaic"
runtime="$HOME/Library/Application Support/Mosaic Beta/versions/0.1.0-beta.228/runtime"
node="$runtime/bin/node"
if [ ! -x "$launcher" ] || [ ! -x "$node" ] || [ ! -f "$stage/host.mjs" ]; then
  stop 1 'The Mosaic launcher, bundled runtime or setup files are unavailable.'
fi

# The current folder may be an untrusted checkout. The installed programs and
# probe imports use absolute paths. User-facing host lookup uses the user's home.
unset NODE_OPTIONS NODE_PATH
from_home() (
  CDPATH= cd -- "$HOME" && "$@"
)

probe() (
  cd / || exit 1
  exec "$node" --input-type=module - "$runtime" "$@" <<'NODE'
import {execFile} from 'node:child_process';
import {constants} from 'node:fs';
import {access, lstat, open, realpath, rename, rm, stat} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

const [runtime, action, candidate, expected, name, email] = process.argv.slice(2);
const load = file => import(pathToFileURL(path.join(runtime, 'src', file)).href);
const execute = promisify(execFile);
const system = {env: {PATH: '/usr/bin:/bin', LC_ALL: 'C'}, maxBuffer: 4096, killSignal: 'SIGKILL'};
const unsafePath = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

async function setupState() {
  const [{currentHome, entry, locations}, {readSettings, setupComplete}] = await Promise.all([
    load('beta/files.mjs'), load('beta/setup.mjs'),
  ]);
  const paths = locations(currentHome());
  const settings = await readSettings(paths);
  if (settings?.schema === 1 || await entry(path.join(paths.configDir, 'migration-intent.json'))) return 4;
  return settings && await setupComplete(paths) ? 0 : 3;
}

async function systemGitReady(deadline = performance.now() + 5000) {
  const {macGitReady} = await load('beta/git-readiness.mjs');
  // Check Apple's selected developer tools before calling the shim, which can
  // otherwise open the download dialog. Then verify the system Git actually runs.
  const run = (file, args, options) => execute(file, args, {
    ...system, timeout: Math.max(1, Math.min(options.timeout, Math.floor(deadline - performance.now()))),
  });
  try {
    if (!await macGitReady({run}) || performance.now() >= deadline) return false;
    const {stdout} = await run('/usr/bin/git', ['--version'], {timeout: 2500});
    return /^git version \d/u.test(stdout);
  } catch {
    return false;
  }
}

async function waitForGit() {
  const waitMs = 20 * 60_000;
  const deadline = performance.now() + waitMs;
  let nextUpdate = performance.now() + 60_000;
  while (performance.now() < deadline) {
    if (await systemGitReady(Math.min(deadline, performance.now() + 5000))) return 0;
    if (performance.now() >= nextUpdate) {
      console.log('Still waiting for Apple Command Line Tools…');
      nextUpdate += 60_000;
    }
    const remaining = deadline - performance.now();
    if (remaining > 0) await delay(Math.min(3000, remaining));
  }
  return 1;
}

async function findRepository(directory) {
  const {checkoutGit} = await load('project/git.mjs');
  const unreadable = 'Choose a readable folder inside an existing Git checkout.';
  let root, resolved;
  try {
    resolved = await realpath(directory);
    if (unsafePath.test(resolved) || !(await stat(resolved)).isDirectory()) throw Error();
    await access(resolved, constants.R_OK | constants.X_OK);
    for (root = resolved; ; root = path.dirname(root)) {
      const metadata = await lstat(path.join(root, '.git')).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (metadata) break;
      if (root === path.dirname(root)) throw Error();
    }
    const gitRoot = (await checkoutGit(root, ['rev-parse', '--show-toplevel'])).replace(/\n$/, '');
    if (await realpath(gitRoot) !== root) throw Error();
  } catch (error) {
    if (error.code === 'unsupported_git_filter' || error.code === 'unsupported_config') {
      throw Error('Choose a checkout with regular Git metadata and without Git config includes or custom filters.');
    }
    throw Error(unreadable);
  }
  let head;
  try {
    head = (await checkoutGit(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  } catch {
    throw Error('This checkout needs a readable, committed HEAD. Save the intended work in a commit or choose another checkout.');
  }
  if (!/^[0-9a-f]{40}$/u.test(head)) throw Error('Choose a checkout that uses 40-character Git commit IDs.');
  process.stdout.write(root);
  return 0;
}

async function loginXdgHome() {
  // The coordinator runs in the GUI launchd domain, which does not inherit
  // variables exported by a shell. Other contexts use the normal Git home.
  const launchctl = (...args) => execute('/bin/launchctl', args, {...system, timeout: 2000});
  try {
    const {stdout: manager} = await launchctl('managername');
    if (manager.trim() !== 'Aqua') return undefined;
    const {stdout} = await launchctl('getenv', 'XDG_CONFIG_HOME');
    const value = stdout.replace(/\r?\n$/u, '');
    return path.isAbsolute(value) && !unsafePath.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function missingIdentity(repo) {
  const [{currentHome}, {checkoutGit, gitInvocation}] = await Promise.all([
    load('beta/files.mjs'), load('project/git.mjs'),
  ]);
  async function read(query) {
    try { return (await query()).replace(/\0$/u, ''); }
    catch (error) {
      if (error.code === 1 && !error.stderr?.length) return null;
      throw error;
    }
  }
  const valid = value => Boolean(value?.trim()) && !unsafePath.test(value);
  const xdg = process.env.XDG_CONFIG_HOME;
  const shellXdg = xdg && path.isAbsolute(xdg) ? xdg : undefined;
  const missing = [];
  let loginProbe, differentEnvironments = false;
  for (const key of ['name', 'email']) {
    const query = ['--no-includes', '--null', '--get', 'user.' + key];
    // System and global config are suppressed by the packaged boundary.
    const local = await read(() => checkoutGit(repo, ['config', ...query]));
    if (local !== null) {
      if (!valid(local)) throw Error('Review your existing Git author identity in Git before continuing.');
      continue;
    }
    const global = gitInvocation(['config', '--global', ...query], {discover: false});
    async function readGlobal(xdgHome) {
      const env = {...global.env, HOME: currentHome(), ...(xdgHome ? {XDG_CONFIG_HOME: xdgHome} : {})};
      delete env.GIT_CONFIG_GLOBAL;
      return read(async () => (await execute(global.executable, global.args, {
        ...system, env, cwd: '/', timeout: 3000,
      })).stdout);
    }
    const loginXdg = await (loginProbe ??= loginXdgHome());
    const loginValue = await readGlobal(loginXdg);
    const shellValue = shellXdg === loginXdg ? loginValue : await readGlobal(shellXdg);
    if (loginValue !== shellValue) differentEnvironments = true;
    if (loginValue !== shellValue || !valid(loginValue)) missing.push(key);
  }
  return {missing, differentEnvironments};
}

async function saveIdentity(repo, expected, name, email) {
  const {gitInvocation, repositoryGitMetadata} = await load('project/git.mjs');
  const {fileBytes} = await load('beta/files.mjs');
  const config = path.join(repositoryGitMetadata(repo), 'config');
  const lockPath = config + '.lock';
  const fields = {name, email};
  let lock, committed = false, interrupted = false;
  const interrupt = () => { interrupted = true; };
  const signals = ['SIGINT', 'SIGHUP', 'SIGTERM'];
  for (const signal of signals) process.on(signal, interrupt);
  try {
    // Use Git's own lock so a concurrent git config writer cannot add values
    // between the missing-field check and the rename of the complete config.
    lock = await open(lockPath, 'wx', 0o600);
    const {missing} = await missingIdentity(repo);
    if (missing.length === 0 || missing.join(' ') !== expected) {
      throw Error('Git author settings changed. Review them before retrying.');
    }
    const before = await lstat(config, {bigint: true});
    if (!before.isFile() || before.uid !== BigInt(process.getuid()) || before.nlink !== 1n) {
      throw Error('Use Git to set author information for this checkout manually.');
    }
    const prior = await fileBytes(config);
    const entries = missing.map(key => {
      const value = fields[key];
      if (value !== value.trim() || !value || value.length > 256 || unsafePath.test(value) || /[<>]/u.test(value) ||
          key === 'email' && !/^[^\s@]+@[^\s@]+$/u.test(value)) {
        throw Error('Use a Git author name and an email address without control characters or angle brackets.');
      }
      return '	' + key + ' = "' + value.replace(/["\\]/gu, '\\$&') + '"\n';
    });
    await lock.writeFile(Buffer.concat([prior, Buffer.from('\n\n[user]\n' + entries.join(''))]));
    for (const key of missing) {
      const config = gitInvocation(['config', '--file', lockPath, '--no-includes', '--null', '--get', 'user.' + key], {discover: false});
      const {stdout} = await execute(config.executable, config.args, {...system, env: config.env, timeout: 3000});
      if (stdout !== fields[key] + '\0') throw Error('Could not verify the proposed Git author identity.');
    }
    await lock.chmod(Number(before.mode & 0o777n));
    await lock.sync();
    const now = await lstat(config, {bigint: true});
    const holder = await lstat(lockPath, {bigint: true});
    const owned = await lock.stat({bigint: true});
    if (interrupted || holder.dev !== owned.dev || holder.ino !== owned.ino ||
        ['dev', 'ino', 'ctimeNs', 'mtimeNs', 'size', 'mode'].some(key => before[key] !== now[key])) {
      throw Error('Git author setup was interrupted or the configuration changed. Review it before retrying.');
    }
    await rename(lockPath, config);
    committed = true;
  } finally {
    if (lock) {
      const owned = await lock.stat({bigint: true});
      await lock.close();
      if (!committed) {
        const holder = await lstat(lockPath, {bigint: true}).catch(() => null);
        if (holder?.dev === owned.dev && holder.ino === owned.ino) await rm(lockPath);
      }
    }
    for (const signal of signals) process.off(signal, interrupt);
  }
  if (interrupted) throw Error('Git author setup was interrupted. Review the saved Git settings before retrying.');
}

try {
  switch (action) {
    case 'setup': process.exitCode = await setupState(); break;
    case 'git': process.exitCode = await systemGitReady() ? 0 : 1; break;
    case 'git-wait': process.exitCode = await waitForGit(); break;
    case 'repo': process.exitCode = await findRepository(candidate); break;
    case 'identity': {
      const {missing, differentEnvironments} = await missingIdentity(candidate);
      if (differentEnvironments) console.error('Terminal and the Mosaic coordinator see different Git author settings.');
      process.stdout.write(missing.join(' '));
      break;
    }
    case 'identity-write': await saveIdentity(candidate, expected, name, email); break;
    default: process.exitCode = 1;
  }
} catch (error) {
  // Settings diagnostics must never expose private values. Repository errors
  // above supply fixed recovery text.
  if (action === 'identity' || action === 'identity-write') {
    console.error('Mosaic could not confirm Git author settings. Review Git configuration or use another checkout.');
  } else {
    console.error(action === 'repo' ? error.message : 'Mosaic could not read the saved setup.');
  }
  process.exitCode = 1;
}
NODE
)

probe setup
setup_status=$?
if [ "$setup_status" -eq 4 ]; then
  printf '\n%s\n' 'Your saved Mosaic settings need migration before this version can continue.'
  printf '%s' 'Open Mosaic to review the settings migration? [y/N] '
  IFS= read -r choice || choice=''
  case "$choice" in
    [Yy]|[Yy][Ee][Ss]) ;;
    *) stop 2 'Settings migration deferred. To review it directly, run ~/.local/bin/mosaic migrate.' ;;
  esac
  from_home "$launcher" migrate ||
    stop "$?" 'Settings migration could not finish. To review or resume it, run ~/.local/bin/mosaic migrate.'
  probe setup
  setup_status=$?
  case "$setup_status" in
    0|3) setup_status=3 ;;
    4) stop 2 'Settings migration is still pending. To reopen it directly, run ~/.local/bin/mosaic migrate.' ;;
  esac
fi

case "$setup_status" in
  0) printf '\n%s\n' 'Using your saved Mosaic setup.' ;;
  3)
    from_home "$launcher" setup ||
      stop "$?" 'Mosaic setup ended before it was ready. To open it directly, run ~/.local/bin/mosaic setup.'
    probe setup ||
      stop 1 'Mosaic setup is incomplete. To review it, run ~/.local/bin/mosaic setup.'
    ;;
  *) stop 1 'To review or recover your setup, run ~/.local/bin/mosaic setup.' ;;
esac

if ! probe git; then
  printf '\n%s\n' 'Git is required to prepare a coding task. Apple Command Line Tools provide it.'
  while :; do
    printf '%s' 'Open Apple’s Command Line Tools installer? [y/N] '
    IFS= read -r choice || stop 2 'Command Line Tools setup deferred.'
    case "$choice" in
      [Yy]|[Yy][Ee][Ss]) break ;;
      ''|[Nn]|[Nn][Oo])
        stop 2 'Command Line Tools setup deferred. To open the Apple installer later, run xcode-select --install.'
        ;;
    esac
  done
  if ! /usr/bin/xcode-select --install && ! probe git; then
    stop 1 'The Apple installer could not be opened. If it is already running, wait for it to finish. Otherwise retry xcode-select --install in Terminal.'
  fi
  probe git-wait &
  git_wait_pid=$!
  printf '%s\n' 'Finish the installation in Apple’s dialog. Checking for Git for up to 20 minutes. Press Control-C to leave onboarding.'
  wait "$git_wait_pid"
  git_status=$?
  git_wait_pid=''
  [ "$git_status" -eq 0 ] ||
    stop 1 'Git is still unavailable. Finish the Apple installation, or run xcode-select --install to reopen a cancelled installer.'
fi

from_home "$node" "$stage/host.mjs"
case $? in
  0) ;;
  2) stop 2 'Coding app connection deferred.' ;;
  *) stop "$?" 'The coding app connection needs attention before you prepare a task.' ;;
esac

# stdout is the new project path; interactive output stays on stderr.
clone_public_repo() (
    url=$1
    slug=${url#https://github.com/}
    owner=${slug%%/*}
    repo=${slug#*/}
    name=${repo%.git}
    case "$slug" in */*) ;; *) echo 'Enter a public GitHub repository URL.' >&2; return 1 ;; esac
    case "$owner" in ''|[-.]*|*[!A-Za-z0-9-]*) echo 'Enter a public GitHub repository URL.' >&2; return 1 ;; esac
    case "$name" in ''|[-.]*|*[!A-Za-z0-9._-]*) echo 'Use a repository URL such as https://github.com/owner/project.' >&2; return 1 ;; esac
    default="$HOME/$name"
    printf 'Clone %s into a new folder. Destination [%s], or type back: ' "$url" "$default" >&2
    IFS= read -r dest || return 2
    case "$dest" in back) return 1 ;; later) return 2 ;; '') dest=$default ;; '~/'*) dest="$HOME/${dest#\~/}" ;; esac
    case "$dest" in /*) ;; *) dest="$PWD/$dest" ;; esac
    case "$dest" in *[[:cntrl:]]*) echo 'Choose a folder name without control characters.' >&2; return 1 ;; esac
    # Reserve the destination before handing it to Git. A retry cannot overwrite
    # an existing directory, even if it is empty.
    (umask 077 && /bin/mkdir "$dest") || { echo 'Choose a new folder inside an existing directory.' >&2; return 1; }
    if ! /usr/bin/env -i HOME=/var/empty PATH=/usr/bin:/bin LC_ALL=C \
        GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=https \
        /usr/bin/git -c core.hooksPath=/dev/null -c credential.helper= -c http.followRedirects=false \
          -c http.lowSpeedLimit=1 -c http.lowSpeedTime=30 \
        clone --template= --no-recurse-submodules -- "$url" "$dest" >&2; then
        /bin/rmdir "$dest" 2>/dev/null || :
        echo 'Could not clone this public repository. Check the URL and network, or choose a local checkout.' >&2
        return 1
    fi
    printf '%s\n' "$dest"
)

default_repo=$(probe repo "$original_directory" 2>/dev/null) || default_repo=''
while :; do
  if [ -n "$default_repo" ]; then
    printf '\nCurrent Git project: %s\n' "$default_repo"
    printf '%s' 'Git project path or public GitHub URL (press Enter to use this project, or type q to finish later): '
  else
    printf '\n%s' 'Git project path or public GitHub URL (type q to finish later): '
  fi
  IFS= read -r choice || stop 2 'First coding task deferred.'
  case "$choice" in
    q) stop 2 'First coding task deferred.' ;;
    '') candidate=$default_repo ;;
    https://github.com/*)
      candidate=$(clone_public_repo "$choice")
      case $? in
        0) ;;
        2) stop 2 'First coding task deferred.' ;;
        *) continue ;;
      esac
      ;;
    '~/'*) candidate="$HOME/${choice#\~/}" ;;
    /*) candidate=$choice ;;
    *) candidate="$original_directory/$choice" ;;
  esac
  if [ -z "$candidate" ]; then
    printf '%s\n' 'Choose a readable folder inside an existing Git checkout.'
    continue
  fi
  if repo=$(probe repo "$candidate"); then
    break
  fi
done

missing=$(probe identity "$repo") ||
  stop 1 'Review your Git author identity before preparing a task.'
if [ -n "$missing" ]; then
  printf '\n%s\n' 'Git needs an author name and email to create commits.'
  printf 'Set the missing fields in this repository (%s)? [y/N] ' "$missing"
  IFS= read -r choice || choice=''
  case "$choice" in
    [Yy]|[Yy][Ee][Ss]) ;;
    *) stop 2 'Git author identity deferred. Set it using git config for this repository, then resume.' ;;
  esac
  name=''
  email=''
  case "$missing" in
    *name*)
      printf '%s' 'Git author name: '
      IFS= read -r name || stop 2 'Git author identity deferred.'
      ;;
  esac
  case "$missing" in
    *email*)
      printf '%s' 'Git author email (your GitHub noreply address also works): '
      IFS= read -r email || stop 2 'Git author identity deferred.'
      ;;
  esac
  printf '%s' 'Save these Git author values for this repository and its linked worktrees? [y/N] '
  IFS= read -r choice || choice=''
  case "$choice" in
    [Yy]|[Yy][Ee][Ss]) ;;
    *) stop 2 'Git author identity deferred.' ;;
  esac
  probe identity-write "$repo" "$missing" "$name" "$email" ||
    stop 1 'Set the missing Git author fields using git config for this repository, then resume.'
fi

from_home "$launcher" first-task --repo "$repo" ||
  stop "$?" 'The first-task guide ended. To reopen it directly, run ~/.local/bin/mosaic first-task from your Git project.'
