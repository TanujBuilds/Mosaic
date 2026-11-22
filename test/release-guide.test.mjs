import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const guide = fileURLToPath(new URL('../distribution/onboarding/guide.sh', import.meta.url));
const mac = process.platform === 'darwin';
const portable = mac || process.platform === 'linux';
const terminal = String.raw`
import errno, json, os, pty, select, signal, sys, time
answers = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execv('/bin/sh', ['/bin/sh', sys.argv[2]])
output = bytearray()
offset = 0
deadline = time.monotonic() + 12
while time.monotonic() < deadline:
    if select.select([fd], [], [], .05)[0]:
        try:
            output.extend(os.read(fd, 4096))
        except OSError as error:
            if error.errno != errno.EIO:
                raise
    if answers and answers[0][0].encode() in output[offset:]:
        prompt, answer = answers.pop(0)
        offset = output.rfind(prompt.encode()) + len(prompt)
        os.write(fd, answer.encode())
    child, status = os.waitpid(pid, os.WNOHANG)
    if child:
        sys.stdout.buffer.write(output)
        code = os.waitstatus_to_exitcode(status)
        sys.exit(code if code >= 0 else 128 - code)
os.killpg(pid, signal.SIGKILL)
os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
sys.exit(124)
`;

async function fixture(t, {state = 'saved', gitReady = true, skipGit = false, identity = true} = {}) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'Mosaic setup ')));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const home = path.join(dir, "User's home");
  const launcher = path.join(home, '.local/bin/mosaic');
  const runtime = path.join(home, 'Library/Application Support/Mosaic Beta/versions/0.1.0-beta.227/runtime');
  const stage = path.join(dir, 'staging area');
  const setupState = path.join(home, 'setup-state');
  const trace = path.join(dir, 'trace');
  const cwd = path.join(dir, 'Current checkout');
  const env = {HOME: home, PATH: `${cwd}:/usr/bin:/bin`, TRACE_FILE: trace, TERM: 'dumb', GIT_DIR: '/bad-git-dir'};
  for (const directory of [path.dirname(launcher), path.join(runtime, 'bin'), path.join(runtime, 'src/beta'), path.join(runtime, 'src/project'), stage, cwd]) {
    await mkdir(directory, {recursive: true});
  }
  await writeFile(setupState, state);
  await writeFile(trace, '');
  await symlink(process.execPath, path.join(runtime, 'bin/node'));
  await writeFile(path.join(runtime, 'src/beta/files.mjs'),
    "export {readFile as fileBytes} from 'node:fs/promises'; export const entry = () => null; export const currentHome = () => process.env.HOME; export const locations = home => ({home, configDir: home});\n");
  await writeFile(path.join(runtime, 'src/beta/setup.mjs'), `
import {readFile} from 'node:fs/promises';
const state = () => readFile(process.env.HOME + '/setup-state', 'utf8');
export const readSettings = async () => await state() === 'missing' ? null : {schema: await state() === 'legacy' ? 1 : 2};
export const setupComplete = async () => ['legacy', 'saved'].includes(await state());
`);
  await writeFile(path.join(runtime, 'src/beta/git-readiness.mjs'), `
import {existsSync} from 'node:fs';
export const macGitReady = async () => ${Boolean(gitReady)} || existsSync(process.env.HOME + '/git-ready');
`);
  await writeFile(path.join(runtime, 'src/project/git.mjs'), `
import {execFileSync} from 'node:child_process';
import path from 'node:path';
export const gitInvocation = args => ({
  args, executable: '/usr/bin/git', env: {PATH: '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1'},
});
export const checkoutGit = async (cwd, args) => {
  const {executable, env} = gitInvocation(args);
  try { return execFileSync(executable, args, {cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe']}); }
  catch (error) { error.code = error.status; throw error; }
};
export const repositoryGitMetadata = cwd => path.join(cwd, '.git');
`);
  await writeFile(path.join(stage, 'host.mjs'), `
import {appendFileSync} from 'node:fs';
appendFileSync(process.env.TRACE_FILE, 'host\\n');
if (process.argv.length !== 2 || !process.stdin.isTTY || !process.stdout.isTTY) process.exit(28);
process.exit(Number(process.env.HOST_STATUS || '0'));
`);
  await writeFile(launcher, `#!/bin/sh
[ -t 0 ] && [ -t 1 ] || exit 29
printf '%s\\n' "$@" >> "$TRACE_FILE"
case "$1" in
  setup)
    [ -z "$SETUP_STATUS" ] || exit "$SETUP_STATUS"
    printf saved > "$HOME/setup-state"
    ;;
  migrate)
    printf '%s' 'Approve the exact migration? '
    IFS= read -r migration_answer
    [ "$migration_answer" != y ] || printf saved > "$HOME/setup-state"
    ;;
  first-task) [ -z "$TASK_STATUS" ] || exit "$TASK_STATUS" ;;
  *) exit 30 ;;
esac
`, {mode: 0o755});
  for (const name of ['mosaic', 'node', 'git', 'xcode-select']) {
    await writeFile(path.join(cwd, name), '#!/bin/sh\nprintf "shadowed\\n" >> "$TRACE_FILE"\nexit 31\n', {mode: 0o755});
  }
  const script = path.join(stage, 'guide.sh');
  await writeFile(script, await readFile(guide, 'utf8'));
  function git(dir, ...args) {
    return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: {HOME: home, PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1'},
    }).trim();
  }
  async function repo(dir, committed) {
    await mkdir(dir, {recursive: true});
    git(dir, 'init', '--quiet', '--template=');
    if (identity) {
      git(dir, 'config', '--local', 'user.name', 'Mosaic Fixture');
      git(dir, 'config', '--local', 'user.email', 'fixture@example.invalid');
    }
    if (committed) git(dir, '-c', 'user.name=Mosaic fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'fixture');
  }
  if (!skipGit) await repo(cwd, true);
  function invoke(answers, override = {}) {
    const command = answers === null ? ['/bin/sh', [script]] :
      ['/usr/bin/python3', ['-c', terminal, JSON.stringify(answers), script]];
    const child = spawn(...command, {cwd, env: {...env, ...override}, stdio: ['ignore', 'pipe', 'pipe']});
    return new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { output += data; });
      child.once('error', reject);
      child.once('close', code => resolve({code, output, trace: readFile(trace, 'utf8')}));
    });
  }
  return {home, cwd, stage, script, repo, git, invoke};
}

function completed(code, result) {
  assert.equal(result.code, code, result.output);
}

test('noninteractive onboarding preserves the install without starting setup or host registration', {skip: !portable}, async t => {
  const result = await (await fixture(t, {state: 'missing', skipGit: true})).invoke(null);
  completed(2, result);
  assert.match(result.output, /terminal/i);
  assert.equal(await result.trace, '');
});

for (const state of ['missing', 'incomplete', 'saved']) {
  test(`onboarding with ${state} settings reaches first-task from the original directory`, {skip: !portable}, async t => {
    const f = await fixture(t, {state});
    const result = await f.invoke([['press Enter', '\n']]);
    completed(0, result);
    assert.equal(await result.trace, (state === 'saved' ? '' : 'setup\n') + `host\nfirst-task\n--repo\n${f.cwd}\n`);
  });
}

test('an unreadable location and unborn repository allow retry with a spaced path', {skip: !portable}, async t => {
  const f = await fixture(t, {skipGit: true});
  const unborn = path.join(f.home, 'Empty checkout');
  const target = path.join(f.home, "Existing friend's checkout");
  await f.repo(unborn, false);
  await f.repo(target, true);
  const result = await f.invoke([
    ['Git project path', 'missing folder\n'],
    ['Choose a readable', '~/Empty checkout\n'],
    ['committed HEAD', "~/Existing friend's checkout\n"],
  ]);
  completed(0, result);
  assert.equal(await result.trace, `host\nfirst-task\n--repo\n${target}\n`);
  assert.throws(() => execFileSync('/usr/bin/git', ['-C', unborn, 'rev-parse', '--verify', 'HEAD'], {stdio: 'ignore'}));
});

test('setup, host and first-task failures retain their status and stop onboarding', {skip: !portable}, async t => {
  for (const [state, override, code, trace] of [
    ['missing', {SETUP_STATUS: '7'}, 7, 'setup\n'],
    ['saved', {HOST_STATUS: '2'}, 2, 'host\n'],
    ['saved', {HOST_STATUS: '6'}, 6, 'host\n'],
    ['saved', {TASK_STATUS: '9'}, 9, null],
  ]) {
    const f = await fixture(t, {state});
    const result = await f.invoke([['press Enter', '\n']], override);
    completed(code, result);
    assert.match(result.output, /resume|run the Mosaic install command again/i);
    assert.equal(await result.trace, trace ?? `host\nfirst-task\n--repo\n${f.cwd}\n`);
  }
});

test('declining Command Line Tools leaves setup saved and defers the coding task', {skip: !portable}, async t => {
  const f = await fixture(t, {gitReady: false});
  const result = await f.invoke([['Open Apple', 'n\n']]);
  completed(2, result);
  assert.match(result.output, /xcode-select --install/);
  assert.equal(await result.trace, '');
});

test('author setup preserves configured values and saves only missing fields with consent', {skip: !portable}, async t => {
  const f = await fixture(t, {identity: false});
  const head = f.git(f.cwd, 'rev-parse', 'HEAD');
  f.git(f.cwd, 'config', '--local', 'user.email', 'existing@example.invalid');
  const before = await readFile(path.join(f.cwd, '.git/config'), 'utf8');
  const result = await f.invoke([
    ['press Enter', '\n'],
    ['this repository (name)', 'y\n'],
    ['Git author name', 'Mosaic "Quoted" \\ User\n'],
    ['Save these Git author values', 'y\n'],
  ]);
  completed(0, result);
  assert.equal(await result.trace, 'host\nfirst-task\n--repo\n' + f.cwd + '\n');
  assert.equal(f.git(f.cwd, 'config', '--local', '--get', 'user.name'), 'Mosaic "Quoted" \\ User');
  assert.equal(f.git(f.cwd, 'config', '--local', '--get', 'user.email'), 'existing@example.invalid');
  assert.equal(f.git(f.cwd, 'rev-parse', 'HEAD'), head);
  const config = await readFile(path.join(f.cwd, '.git/config'), 'utf8');
  assert.ok(config.startsWith(before));
  await assert.rejects(readFile(path.join(f.cwd, '.git/config.lock')), {code: 'ENOENT'});
});

test('declining author setup leaves repository configuration byte-for-byte intact', {skip: !portable}, async t => {
  const f = await fixture(t, {identity: false});
  const config = path.join(f.cwd, '.git/config');
  const before = await readFile(config);
  const result = await f.invoke([
    ['press Enter', '\n'],
    ['this repository (name email)', 'y\n'],
    ['Git author name', 'Example Author\n'],
    ['Git author email', 'author@example.invalid\n'],
    ['Save these Git author values', 'n\n'],
  ]);
  completed(2, result);
  assert.equal(await result.trace, 'host\n');
  assert.deepEqual(await readFile(config), before);
});

test('an existing global author profile is reused without writing local config', {skip: !portable}, async t => {
  const f = await fixture(t, {identity: false});
  const config = path.join(f.cwd, '.git/config');
  const before = await readFile(config);
  await writeFile(path.join(f.home, '.gitconfig'), '[user]\n  name = Existing User\n  email = user@example.invalid\n');
  const result = await f.invoke([['press Enter', '\n']]);
  completed(0, result);
  assert.equal(await result.trace, 'host\nfirst-task\n--repo\n' + f.cwd + '\n');
  assert.deepEqual(await readFile(config), before);
});

test('a concurrent Git config lock preserves existing repo configuration', {skip: !portable}, async t => {
  const f = await fixture(t, {identity: false});
  const config = path.join(f.cwd, '.git/config');
  const before = await readFile(config);
  await writeFile(config + '.lock', 'owned by a concurrent git config');
  const result = await f.invoke([
    ['press Enter', '\n'],
    ['this repository', 'y\n'],
    ['Git author name', 'Example Author\n'],
    ['Git author email', 'author@example.invalid\n'],
    ['Save these Git author values', 'y\n'],
  ]);
  completed(1, result);
  assert.equal(await result.trace, 'host\n');
  assert.deepEqual(await readFile(config), before);
  assert.equal(await readFile(config + '.lock', 'utf8'), 'owned by a concurrent git config');
});

test('malformed clone URLs and existing destinations return to repo selection', {skip: !portable}, async t => {
  const f = await fixture(t, {skipGit: true});
  const destination = path.join(f.home, 'project');
  await mkdir(destination);
  await writeFile(path.join(destination, 'keep'), 'original data');
  const result = await f.invoke([
    ['Git project path or public GitHub URL', 'https://github.com/owner/project?access_token=private\n'],
    ['Use a repository URL', 'https://github.com/owner/project\n'],
    ['Destination [', '\n'],
    ['Choose a new folder', 'q\n'],
  ]);
  completed(2, result);
  assert.doesNotMatch(result.output, /Clone https:\/\/github.com\/owner\/project\?/);
  assert.equal(await result.trace, 'host\n');
  assert.equal(await readFile(path.join(destination, 'keep'), 'utf8'), 'original data');
});

test('probes the actual system Git command before starting host setup', {skip: !portable}, async t => {
  const f = await fixture(t);
  const source = await readFile(f.script, 'utf8');
  // The bundled helper can find a tools directory while the Apple shim still fails.
  await writeFile(f.script, source.replace("run('/usr/bin/git', ['--version']", "run('/usr/bin/false', ['--version']"));
  const result = await f.invoke([['Open Apple', 'n\n']]);
  completed(2, result);
  assert.equal(await result.trace, '');
});

for (const outcome of ['ready', 'timeout', 'interrupted']) {
  test('Apple tools installer resumes safely when ' + outcome, {skip: !portable}, async t => {
    const f = await fixture(t, {gitReady: false});
    const fake = path.join(f.home, 'apple-install');
    await writeFile(fake, '#!/bin/sh\nprintf "apple %s\\n" "$@" >> "$TRACE_FILE"\n' +
      (outcome === 'ready' ? 'touch "$HOME/git-ready"\n' : ''), {mode: 0o755});
    let source = await readFile(f.script, 'utf8');
    // Replace only the system Apple dialog entry point and deadline in this disposable script.
    const fakeArg = "'" + fake.replaceAll("'", "'\\''") + "'";
    source = source.replace('/usr/bin/xcode-select --install', fakeArg + ' --install');
    if (outcome === 'timeout') source = source.replace('const waitMs = 20 * 60_000;', 'const waitMs = 25;');
    await writeFile(f.script, source);
    const answers = [['Open Apple', 'y\n']];
    if (outcome === 'ready') answers.push(['press Enter', '\n']);
    if (outcome === 'interrupted') answers.push(['Press Control-C', '\x03']);
    const result = await f.invoke(answers);
    completed({ready: 0, timeout: 1, interrupted: 130}[outcome], result);
    assert.equal(await result.trace, 'apple --install\n' +
      (outcome === 'ready' ? 'host\nfirst-task\n--repo\n' + f.cwd + '\n' : ''));
  });
}

test('legacy settings use the normal migration approval and refresh setup before host registration', {skip: !portable}, async t => {
  const f = await fixture(t, {state: 'legacy'});
  const result = await f.invoke([
    ['Open Mosaic to review', 'y\n'],
    ['Approve the exact migration', 'y\n'],
    ['press Enter', '\n'],
  ]);
  completed(0, result);
  assert.equal(await result.trace, 'migrate\nsetup\nhost\nfirst-task\n--repo\n' + f.cwd + '\n');
});

test('a declined legacy migration keeps the settings and does not open host registration', {skip: !portable}, async t => {
  const f = await fixture(t, {state: 'legacy'});
  const result = await f.invoke([
    ['Open Mosaic to review', 'y\n'],
    ['Approve the exact migration', 'n\n'],
  ]);
  completed(2, result);
  assert.equal(await result.trace, 'migrate\n');
  assert.equal(await readFile(path.join(f.home, 'setup-state'), 'utf8'), 'legacy');
});

test('existing worktree-level and XDG author settings are both reused', {skip: !portable}, async t => {
  const f = await fixture(t, {identity: false});
  const xdg = path.join(f.home, 'configuration');
  await mkdir(path.join(xdg, 'git'), {recursive: true});
  await writeFile(path.join(xdg, 'git/config'), '[user]\n  email = xdg@example.invalid\n');
  const config = path.join(f.cwd, '.git/config');
  f.git(f.cwd, 'config', 'extensions.worktreeConfig', 'true');
  f.git(f.cwd, 'config', '--worktree', 'user.name', 'Worktree User');
  const before = await readFile(config);
  const result = await f.invoke([['press Enter', '\n']], {XDG_CONFIG_HOME: xdg});
  completed(0, result);
  assert.equal(await result.trace, 'host\nfirst-task\n--repo\n' + f.cwd + '\n');
  assert.deepEqual(await readFile(config), before);
});
