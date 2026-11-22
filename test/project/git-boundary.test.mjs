import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {git, gitBytes} from '../../src/project/process.mjs';
import {gitInvocation, gitSync} from '../../src/project/git.mjs';
import {inspectRepository, Workspace} from '../../src/project/workspace.mjs';
import {Journal} from '../../src/project/journal.mjs';
import {overnightInputs} from '../../src/harness/overnight-preflight.mjs';

async function fixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'mosaic-git-boundary-'));
  t.after(() => rm(parent, {recursive: true, force: true}));
  const root = path.join(parent, 'source');
  await mkdir(root);
  const env = {PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'};
  const localGit = (...args) => execFileSync('/usr/bin/git', args, {cwd: root, env, encoding: 'utf8'}).trim();
  localGit('init', '-q');
  await writeFile(path.join(root, 'file.txt'), 'baseline\n');
  await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
  localGit('add', '--', '.gitignore', 'file.txt');
  localGit('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Baseline');
  return {parent, root, localGit, baseCommit: localGit('rev-parse', 'HEAD')};
}

test('source inspection rejects config includes even when they contain only ordinary settings', async t => {
  const {parent, root, localGit} = await fixture(t);
  const included = path.join(parent, 'ordinary.config');
  await writeFile(included, '[user]\n\tname = Ordinary Name\n');
  localGit('config', 'include.path', included);
  await assert.rejects(inspectRepository(root, {readPaths: ['file.txt']}), /unsupported Git config/i);
});

test('linked worktree Git checks configuration again when retained metadata changes', async t => {
  const {parent, root, localGit, baseCommit} = await fixture(t);
  const permissions = {readPaths: ['file.txt'], writePaths: ['file.txt']};
  const journal = await new Journal(parent, '00000000-0000-4000-8000-000000000001').load();
  const workspace = new Workspace({repo: root, baseCommit, permissions}, journal);
  await workspace.initialize();
  assert.equal(await git(workspace.root, 'branch', '--show-current'), workspace.branch);
  localGit('config', 'filter.example.required', 'false');
  await assert.rejects(workspace.snapshot(), /unsupported Git filter/i);
  assert.throws(() => gitSync(root, 'status', '--porcelain'), /unsupported Git filter/i);
});

test('execution preflight rejects configuration changes after an ordinary clean source check', async t => {
  const {parent, root, localGit, baseCommit} = await fixture(t);
  const manifest = {project: {repo: root, baseCommit, readPaths: ['file.txt']}};
  const verified = overnightInputs(manifest, process.execPath);
  assert.match(verified.inventoryHash, /^[a-f0-9]{64}$/);
  const included = path.join(parent, 'ordinary.config');
  await writeFile(included, '[user]\n\tname = Ordinary Name\n');
  localGit('config', 'include.path', included);
  assert.throws(() => overnightInputs(manifest, process.execPath), /unsupported Git config/i);
});

test('Git policy restricts executable, environment and command options', () => {
  const author = {GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'author@example.invalid'};
  const inherited = {...author, PATH: '/fixture/bin', GIT_INDEX_FILE: '/fixture/index', GIT_CONFIG_COUNT: '0',
    GIT_CONFIG_GLOBAL: '/fixture/config', GIT_EXTERNAL_DIFF: 'fixture', GIT_EXEC_PATH: '/fixture/bin'};
  const status = gitInvocation(['status', '--porcelain'], {inherited});
  assert.equal(status.executable, '/usr/bin/git');
  assert.equal(status.env.PATH, '/usr/bin:/bin');
  assert.equal(status.env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(status.env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(status.env.GIT_ALLOW_PROTOCOL, '');
  assert.equal(status.env.GIT_NO_LAZY_FETCH, '1');
  for (const name of ['GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_EXTERNAL_DIFF', 'GIT_EXEC_PATH', ...Object.keys(author)]) {
    assert.equal(Object.hasOwn(status.env, name), false, name);
  }
  const diff = gitInvocation(['diff', '--name-only', 'HEAD'], {inherited});
  for (const arg of ['--no-pager', '--no-ext-diff', '--no-textconv', 'core.fsmonitor=', 'core.hooksPath=/dev/null']) {
    assert.ok(diff.args.includes(arg), arg);
  }
  const commit = gitInvocation(['commit', '-m', 'Fixture'], {inherited});
  assert.equal(commit.env.GIT_AUTHOR_NAME, author.GIT_AUTHOR_NAME);
  assert.equal(commit.env.GIT_AUTHOR_EMAIL, author.GIT_AUTHOR_EMAIL);
  assert.ok(commit.args.includes('commit.gpgsign=false'));
  assert.throws(() => gitInvocation(['-c', 'status.short=true', 'status']), /unsupported Git command/i);
});

test('linked workspace checkpoints approved bytes and honors explicit commit identities', async t => {
  const {parent, root, baseCommit} = await fixture(t);
  const identities = {GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'author@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture Committer', GIT_COMMITTER_EMAIL: 'committer@example.invalid'};
  const original = Object.fromEntries(Object.keys(identities).map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  Object.assign(process.env, identities);
  const permissions = {readPaths: ['file.txt', 'ignored.txt'], writePaths: ['file.txt', 'ignored.txt']};
  const journal = await new Journal(parent, '00000000-0000-4000-8000-000000000001').load();
  const workspace = new Workspace({repo: root, baseCommit, permissions}, journal);
  await workspace.initialize();
  const stage = {id: 'one', writePaths: permissions.writePaths};
  const write = (file, content, baseHash) => ({path: file, action: 'write', content, baseHash});
  await assert.rejects(workspace.apply('ignored', stage, [write('ignored.txt', 'ignored\n', null)]), /ignored files/i);
  const replacement = '  updated 🧩\n\n';
  await workspace.apply('tracked', stage, [write('file.txt', replacement, (await workspace.content('file.txt')).hash)]);
  const {commit} = await workspace.checkpoint(stage);
  assert.equal(await git(workspace.root, 'rev-parse', 'HEAD^'), baseCommit);
  assert.equal(await git(workspace.root, 'log', '-1', '--format=%an <%ae> / %cn <%ce>'),
    'Fixture Author <author@example.invalid> / Fixture Committer <committer@example.invalid>');
  const blob = await git(workspace.root, 'rev-parse', `${commit}:file.txt`);
  assert.deepEqual(await gitBytes(workspace.root, 'cat-file', 'blob', blob), Buffer.from(replacement));
  assert.equal(await git(workspace.root, 'diff', '--cached', '--name-only'), '');
  assert.equal(await git(root, 'rev-parse', 'HEAD'), baseCommit);
});

test('commits can use ordinary Git user identity from the coordinator home', async t => {
  const {parent, root, localGit} = await fixture(t);
  const home = path.join(parent, 'home');
  await mkdir(home);
  await writeFile(path.join(home, '.gitconfig'), '[user]\n\tname = Home Name\n\temail = home@example.invalid\n');
  const env = {HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: '', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: '', GIT_COMMITTER_EMAIL: ''};
  const original = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  Object.assign(process.env, env);
  await git(root, 'commit', '--allow-empty', '-m', 'Global identity');
  assert.equal(localGit('log', '-1', '--format=%an <%ae> / %cn <%ce>'),
    'Home Name <home@example.invalid> / Home Name <home@example.invalid>');
  localGit('config', 'user.name', 'Repository Name');
  await git(root, 'commit', '--allow-empty', '-m', 'Repository identity');
  assert.equal(localGit('log', '-1', '--format=%an <%ae>'), 'Repository Name <home@example.invalid>');
});
