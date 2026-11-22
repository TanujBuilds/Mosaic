import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {access, cp, link, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {gitInvocation} from '../src/project/git.mjs';
import * as windowsGit from '../src/project/windows-git.mjs';
import * as readiness from '../src/beta/git-readiness.mjs';

const system = String.raw`C:\Windows`;
const local = String.raw`C:\Users\Mosaic Test\AppData\Local`;
const systemGit = String.raw`C:\Program Files\Git\cmd\git.exe`;
const localGit = local + String.raw`\Programs\Git\cmd\git.exe`;
const project = String.raw`D:\Untrusted Checkout`;
const inherited = {
  ProgramFiles: String.raw`C:\Program Files`, LOCALAPPDATA: local, SystemRoot: system,
  PATH: project, GIT_CONFIG_COUNT: '1', GIT_INDEX_FILE: project, GIT_EXEC_PATH: project,
};

test('Windows Git uses a known absolute executable after installation without inheriting PATH or repository overrides', () => {
  const invocation = gitInvocation(['status', '--porcelain'], {
    platform: 'win32', inherited,
    resolveExecutable: file => file === localGit ? localGit : null,
  });
  assert.equal(invocation.executable, localGit);
  assert.equal(invocation.env.PATH, [localGit.slice(0, -8), system + String.raw`\System32`, system].join(';'));
  assert.equal(invocation.env.SystemRoot, system);
  for (const key of ['GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_EXEC_PATH']) assert.equal(invocation.env[key], undefined);
  for (const flag of ['core.fsmonitor=', 'core.hooksPath=/dev/null', 'core.protectNTFS=true',
    'core.autocrlf=false', 'core.eol=lf', 'core.filemode=false']) assert.ok(invocation.args.includes(flag), flag);
  assert.equal(invocation.env.GIT_ALLOW_PROTOCOL, '');
});

test('Windows Git declines executable discovery redirected from a known location into the checkout', () => {
  assert.throws(() => gitInvocation(['status'], {
    platform: 'win32', inherited,
    resolveExecutable: file => file === systemGit ? project + String.raw`\git.exe` : null,
  }), /Git for Windows/);
});

test('Windows Git readiness verifies the selected local executable and its version', async () => {
  assert.equal(typeof readiness.windowsGitReady, 'function');
  const options = {inherited, resolveExecutable: file => file === systemGit ? systemGit : null};
  const ready = await readiness.windowsGitReady({...options, run: async (file, args, config) => {
    assert.equal(file, systemGit);
    assert.deepEqual(args, ['--version']);
    assert.equal(config.env.GIT_CONFIG_COUNT, undefined);
    return {stdout: 'git version 2.52.0.windows.1\r\n'};
  }});
  assert.equal(ready, true);
  assert.equal(await readiness.windowsGitReady({...options, run: async () => ({stdout: 'unrecognized\n'})}), false);
});

const indexRecord = (name, mode = '100644', stage = '0') => `${mode} ${'a'.repeat(40)} ${stage}\t${name}\0`;

test('Windows index modes preserve the committed Git executable bit and reject ambiguous checkout paths', () => {
  assert.equal(typeof windowsGit.parseWindowsIndexModes, 'function');
  assert.deepEqual(windowsGit.parseWindowsIndexModes(Buffer.from(indexRecord('src/a b.mjs') + indexRecord('scripts/run', '100755'))),
    new Map([['src/a b.mjs', '100644'], ['scripts/run', '100755']]));
  assert.throws(() => windowsGit.parseWindowsIndexModes(Buffer.from(indexRecord('Src/a') + indexRecord('src/b'))), /case/i);
  assert.throws(() => windowsGit.parseWindowsIndexModes(Buffer.from(indexRecord('src/ordinary:alternate'))), /Windows checkout path/);
  assert.throws(() => windowsGit.parseWindowsIndexModes(Buffer.from(indexRecord('src/LPT1.tmp'))), /Windows checkout path/);
  assert.throws(() => windowsGit.parseWindowsIndexModes(Buffer.from(indexRecord('src/not-merged', '100644', '2'))), /Git index/);
  assert.throws(() => windowsGit.parseWindowsIndexModes(Buffer.from(indexRecord('src/missing-end').slice(0, -1))), /Git index/);
});

test('the Windows checkpoint compares exact staged blob IDs and committed regular-file modes', () => {
  const blob = 'a'.repeat(40);
  const zero = '0'.repeat(40);
  assert.equal(typeof windowsGit.parseWindowsIndexEntries, 'function');
  assert.deepEqual(windowsGit.parseWindowsIndexEntries(Buffer.from(indexRecord('run', '100755'))),
    new Map([['run', {mode: '100755', blob}]]));
  const record = Buffer.from(`:100644 100755 ${blob} ${blob} M\0run\0:100644 000000 ${blob} ${zero} D\0old\0`);
  assert.deepEqual(windowsGit.parseWindowsCommitChanges(record), new Map([
    ['run', {mode: '100755', blob}], ['old', null],
  ]));
  assert.throws(() => windowsGit.parseWindowsCommitChanges(Buffer.from(`:100644 120000 ${blob} ${blob} T\0run\0`)),
    /unsupported Windows checkpoint/i);
});

test('native Windows Git binds exact checked bytes and executable modes through linked worktrees and recovery', {
  skip: process.platform !== 'win32',
}, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'Mosaic Git QA ')));
  t.after(() => rm(root, {recursive: true, force: true}));
  const runtime = path.join(root, 'runtime');
  const bin = path.join(runtime, 'bin');
  await mkdir(bin, {recursive: true});
  await cp(fileURLToPath(new URL('../src', import.meta.url)), path.join(runtime, 'src'), {recursive: true});
  const build = fileURLToPath(new URL('../distribution/win32-files/build.cmd', import.meta.url));
  const helper = path.join(bin, 'mosaic-files.exe');
  execFileSync(process.env.ComSpec, ['/d', '/s', '/c', 'call "%MOSAIC_BUILD_SCRIPT%" "%MOSAIC_TEST_BINARY%"'], {
    cwd: root, env: {...process.env, MOSAIC_BUILD_SCRIPT: build, MOSAIC_TEST_BINARY: helper},
    windowsVerbatimArguments: true, stdio: 'inherit',
  });
  const load = name => import(pathToFileURL(path.join(runtime, 'src', name)).href);
  const {git, gitBytes, gitSync, windowsIndexModes} = await load('project/git.mjs');
  const {Workspace} = await load('project/workspace.mjs');
  const {Journal} = await load('project/journal.mjs');
  const {readBehavioralFileModes} = await load('harness/behavioral-validation.mjs');
  const {Integration} = await load('harness/integration.mjs');
  const repo = path.join(root, 'Mosaic Project');
  await mkdir(repo);
  assert.equal(await readiness.windowsGitReady(), true);
  const installed = windowsGit.windowsGitProcess();
  const rawGit = (cwd, ...args) => execFileSync(installed.executable, ['-C', cwd, ...args], {
    cwd: installed.cwd, env: {...installed.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'},
    encoding: 'utf8', windowsHide: true,
  }).trim();
  await git(repo, 'init', '-q');
  rawGit(repo, 'config', 'core.autocrlf', 'true');
  rawGit(repo, 'config', 'core.eol', 'crlf');
  rawGit(repo, 'config', 'core.filemode', 'false');
  rawGit(repo, 'config', 'user.name', 'Windows Git Fixture');
  rawGit(repo, 'config', 'user.email', 'fixture@example.invalid');
  const hook = path.join(repo, '.git', 'hooks', 'post-commit');
  await mkdir(path.dirname(hook), {recursive: true});
  await writeFile(hook, '#!/bin/sh\nprintf hook > hook-ran\n');
  rawGit(repo, 'commit', '--allow-empty', '-qm', 'Confirm the hook fixture runs without protection');
  const marker = path.join(repo, 'hook-ran');
  assert.equal(await readFile(marker, 'utf8'), 'hook');
  await rm(marker);

  const target = 'value with spaces.mjs';
  const original = Buffer.from('export const result = 0;\n');
  const updated = Buffer.from('export const result = 1; // Δ\n\n');
  await writeFile(path.join(repo, target), original);
  await writeFile(path.join(repo, '.gitattributes'), '*.mjs text eol=lf\n');
  await git(repo, 'add', '--', target, '.gitattributes');
  await git(repo, 'commit', '-m', 'Approved base');
  await assert.rejects(access(marker), {code: 'ENOENT'});
  assert.equal(rawGit(repo, 'config', 'core.autocrlf'), 'true');
  const base = await git(repo, 'rev-parse', 'HEAD');
  assert.deepEqual(await gitBytes(repo, 'cat-file', 'blob', `${base}:${target}`), original);

  const tree = path.join(root, 'Candidate Tree');
  await git(repo, 'worktree', 'add', '-b', 'bounded-candidate', tree, base);
  assert.equal(await git(tree, 'rev-parse', '--show-toplevel'), await realpath(tree));
  assert.deepEqual(await readFile(path.join(tree, target)), original);
  assert.deepEqual(await windowsIndexModes(tree, [target]), new Map([[target, '100644']]));
  await writeFile(path.join(tree, target), updated);
  const workspace = {root: tree, file: file => Promise.resolve(path.join(tree, file))};
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const integration = new Integration({c: {}});
  assert.deepEqual(await integration.changes(workspace, base, [target]), [{
    path: target, action: 'write', content: updated.toString('utf8'),
    beforeHash: hash(original), afterHash: hash(updated), beforeMode: '100644', afterMode: '100644',
  }]);
  rawGit(tree, 'update-index', '--chmod=+x', '--', target);
  assert.deepEqual(await windowsIndexModes(tree, [target]), new Map([[target, '100755']]));
  const [modeChange] = await integration.changes(workspace, base, [target]);
  assert.equal(modeChange.afterMode, '100755');

  const extra = 'added script.mjs';
  const targets = [target, extra];
  const journal = await new Journal(path.join(root, 'Journal'), '00000000-0000-4000-8000-000000000001').load();
  const imported = new Workspace({repo, baseCommit: base, permissions: {readPaths: targets, writePaths: targets}}, journal);
  await imported.initialize();
  const stage = {id: 'checked', writePaths: targets};
  await integration.applyChanges(imported, [modeChange], 'import', targets);
  assert.equal(await imported.fileMode(target), '100755');

  const source = '// completed before interruption\n';
  const intent = {key: 'interrupted-write', snapshotBefore: await imported.snapshot(),
    changes: [{path: extra, before: null, after: hash(source), content: source, beforeMode: null, afterMode: '100755'}]};
  await journal.append('edits.intent', intent);
  await writeFile(path.join(imported.root, extra), source);
  await imported.recover();
  assert.equal(await imported.fileMode(extra), '100755');
  assert.deepEqual(await readBehavioralFileModes(imported, targets), new Map(targets.map(file => [file, '100755'])));

  const append = journal.append.bind(journal);
  journal.append = async (type, data) => {
    const event = await append(type, data);
    if (type === 'workspace.windows_checkpoint.intent') throw Error('Interrupted after recording checkpoint intent');
    return event;
  };
  await assert.rejects(imported.checkpoint(stage), /Interrupted after recording/);
  assert.equal(await git(imported.root, 'rev-parse', 'HEAD'), base);
  journal.append = append;
  const result = await imported.checkpoint(stage);
  assert.equal(await git(imported.root, 'rev-parse', 'HEAD^'), base);
  assert.deepEqual(await gitBytes(imported.root, 'cat-file', 'blob', `${result.commit}:${target}`), updated);
  assert.match(await git(imported.root, 'ls-tree', result.commit, '--', target), /^100755 blob /u);
  assert.match(await git(imported.root, 'ls-tree', result.commit, '--', extra), /^100755 blob /u);
  assert.deepEqual(await imported.checkpoint(stage), result);

  rawGit(imported.root, 'update-index', '--chmod=-x', '--', target);
  await assert.rejects(imported.checkpoint(stage), /executable modes differ/);
  assert.equal(await git(imported.root, 'rev-parse', 'HEAD'), result.commit);

  const normalizedJournal = await new Journal(path.join(root, 'Journal'), '00000000-0000-4000-8000-000000000002').load();
  const normalized = new Workspace(imported.manifest, normalizedJournal);
  await normalized.initialize();
  await normalized.apply('text-change', stage, [
    {path: target, action: 'write', content: original.toString().replaceAll('\n', '\r\n'), baseHash: hash(original)},
  ]);
  await assert.rejects(normalized.checkpoint(stage), /staged bytes or executable mode/);
  assert.equal(await git(normalized.root, 'rev-parse', 'HEAD'), base);

  const aliased = path.join(root, 'foreign-config');
  await link(path.join(repo, '.git', 'config'), aliased);
  assert.throws(() => gitSync(tree, 'status', '--porcelain'), {code: 'unsupported_config'});
});
