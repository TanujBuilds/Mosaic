import { lstat, readFile, writeFile, mkdir, rename, unlink, cp, realpath, chmod } from 'node:fs/promises';
import path from 'node:path';
import { digest, relativePath, matches, protectedPath, secretPath, Pause, AttemptError } from './contracts.mjs';
import { git } from './process.mjs';

const generated = file => file.startsWith('.overnight-output/') || file.startsWith('dist/') || file.startsWith('node_modules/');
async function exists(file) { try { await lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
export class Workspace {
  constructor(manifest, journal) {
    this.manifest = manifest; this.journal = journal;
    this.root = path.join(journal.dir, 'worktree');
    this.branch = `orchestrator/${journal.id}`;
  }
  async initialize() {
    const { repo, baseCommit } = this.manifest;
    if (!await exists(path.join(this.root, '.git'))) {
      await git(repo, 'worktree', 'add', '-b', this.branch, this.root, baseCommit);
    }
    if (await git(this.root, 'branch', '--show-current') !== this.branch) throw new Pause('Worktree branch does not match job', 'workspace');
    if (!this.journal.last('workspace.created')) {
      if (await git(this.root, 'rev-parse', 'HEAD') !== baseCommit) throw new Pause('Unexpected worktree revision', 'workspace');
      const dependencies = path.join(repo, 'node_modules');
      if (await exists(dependencies)) {
        if ((await lstat(dependencies)).isSymbolicLink()) throw new Pause('Prepare dependencies inside the source repository', 'workspace');
        await cp(dependencies, path.join(this.root, 'node_modules'), { recursive: true });
      }
      await mkdir(path.join(this.root, '.overnight-output'), { recursive: true });
      await mkdir(path.join(this.root, 'dist'), { recursive: true });
      await this.journal.append('workspace.created', { root: this.root, branch: this.branch, snapshot: await this.snapshot() });
    }
  }
  async file(file) {
    relativePath(file);
    let current = this.root;
    for (const part of file.split('/')) {
      current = path.join(current, part);
      try { if ((await lstat(current)).isSymbolicLink()) throw new Pause(`Symlink access denied: ${file}`, 'scope'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return current;
  }
  async content(file) {
    const absolute = await this.file(file);
    try {
      const bytes = await readFile(absolute);
      if (bytes.includes(0)) throw new Pause(`Binary files are unsupported: ${file}`, 'scope');
      if (bytes.length > 128 * 1024) throw new Pause(`File exceeds context limit: ${file}`, 'context');
      return { path: file, hash: digest(bytes), content: bytes.toString('utf8') };
    } catch (e) { if (e.code === 'ENOENT') return { path: file, hash: null, content: null }; throw e; }
  }
  async fileMode(file) {
    try { const stat=await lstat(await this.file(file));if(!stat.isFile())throw new Pause('Expected a regular file: '+file,'scope');return stat.mode&0o100?'100755':'100644'; }
    catch(error){if(error.code==='ENOENT')return null;throw error;}
  }
  async readFiles(paths) {
    const files = [];
    for (const file of paths) {
      if (typeof file === 'string' && file.endsWith('/')) throw new AttemptError(`Request exact file paths, not a directory: ${file}`);
      relativePath(file);
      if (secretPath(file) || generated(file) || !matches(file, this.manifest.permissions.readPaths)) throw new Pause(`Read outside approved scope: ${file}`, 'scope');
      try {
        if ((await lstat(await this.file(file))).isDirectory()) throw new AttemptError(`Request exact file paths, not a directory: ${file}`);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      files.push(await this.content(file));
    }
    if (Buffer.byteLength(JSON.stringify(files)) > 512 * 1024) throw new Pause('Requested context exceeds 512 KiB; narrow the stage', 'context');
    return files;
  }
  async snapshot() {
    const listed = await git(this.root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard');
    const result = {};
    for (const file of [...new Set(listed.split('\0').filter(Boolean))].sort()) {
      if (generated(file)) continue;
      const absolute = await this.file(file);
      try { result[file] = digest(await readFile(absolute)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return result;
  }
  expectedSnapshot() {
    return this.journal.events.findLast(event => event.data.snapshot)?.data.snapshot;
  }
  async assertSnapshot(expected = this.expectedSnapshot()) {
    if (expected && digest(await this.snapshot()) !== digest(expected)) throw new Pause('Workspace changed outside the recorded transaction; inspect it before resuming', 'workspace_changed');
  }
  async inventory() {
    return Object.entries(await this.snapshot()).filter(([file]) =>
      !secretPath(file) && matches(file, this.manifest.permissions.readPaths)).map(([file, hash]) => ({ path: file, hash }));
  }
  async recover() {
    const head = await git(this.root, 'rev-parse', 'HEAD');
    const expected = this.journal.last('stage.accepted')?.commit ?? this.manifest.baseCommit;
    if (head !== expected) {
      // A crash can occur after commit succeeds but before its completion is logged.
      const pending = this.journal.events.findLast(event => event.type === 'operation.started' && event.data.key.endsWith('/checkpoint'));
      const stageId = pending?.data.key.split('/')[0];
      const ownCheckpoint = stageId && await git(this.root, 'log', '-1', '--format=%s') === `Orchestrator ${this.journal.id} stage ${stageId}` && await git(this.root, 'rev-parse', 'HEAD^') === expected;
      if (!ownCheckpoint) throw new Pause('Worktree HEAD changed outside the recorded checkpoints', 'workspace_changed');
    }
    const intents = this.journal.events.filter(event => event.type === 'edits.intent');
    for (const { data: intent } of intents) {
      if (!this.journal.events.some(event => event.type === 'edits.applied' && event.data.key === intent.key)) await this.applyIntent(intent);
    }
    await this.assertSnapshot();
  }
  async apply(key, stage, edits) {
    if (this.journal.events.some(event => event.type === 'edits.applied' && event.data.key === key)) return;
    await this.assertSnapshot();
    const changes = [];
    const seen = new Set();
    for (const edit of edits) {
      relativePath(edit.path);
      if (seen.has(edit.path)) throw new AttemptError('Duplicate edit path');
      seen.add(edit.path);
      if (generated(edit.path) || protectedPath(edit.path) ||
          !matches(edit.path, stage.writePaths) || !matches(edit.path, this.manifest.permissions.writePaths)) throw new Pause(`Write outside approved scope: ${edit.path}`, 'scope');
      let ignored = false;
      try {
        await git(this.root, 'check-ignore', '--quiet', '--', `./${edit.path}`);
        ignored = true;
      } catch (error) {
        if (error.code !== 1) throw new Pause(`Could not verify Git visibility for edit: ${error.message}`, 'workspace');
      }
      if (ignored) throw new Pause(`Ignored files cannot be reviewed or checkpointed: ${edit.path}`, 'scope');
      if (!['write', 'delete'].includes(edit.action)) throw new AttemptError('Edit action must be write or delete');
      const before = await this.content(edit.path);
      if (edit.baseHash !== before.hash) throw new AttemptError(`Stale edit hash for ${edit.path}; request current file`);
      if (edit.action === 'write' && (typeof edit.content !== 'string' || Buffer.byteLength(edit.content) > 128 * 1024 || edit.content.includes('\0'))) throw new AttemptError('Write must contain UTF-8 text up to 128 KiB');
      const beforeMode=await this.fileMode(edit.path),afterMode=edit.action==='delete'?null:edit.mode??beforeMode??'100644';
      if(afterMode!==null&&!['100644','100755'].includes(afterMode))throw new AttemptError('Invalid internal executable mode');
      changes.push({ path: edit.path, before: before.hash, after: edit.action === 'delete' ? null : digest(edit.content), content: edit.action === 'delete' ? null : edit.content, beforeMode, afterMode });
    }
    const intent = { key, changes, snapshotBefore: await this.snapshot() };
    await this.journal.append('edits.intent', intent);
    await this.applyIntent(intent);
  }
  async applyIntent(intent) {
    const current = await this.snapshot();
    const unchanged = { ...current }, before = { ...intent.snapshotBefore };
    for (const change of intent.changes) { delete unchanged[change.path]; delete before[change.path]; }
    if (digest(unchanged) !== digest(before)) throw new Pause('Unrelated files changed during edit transaction', 'workspace_changed');
    for (const change of intent.changes) {
      const actual = (await this.content(change.path)).hash;
      if (actual !== change.before && actual !== change.after) throw new Pause(`Cannot reconcile interrupted edit: ${change.path}`, 'workspace_changed');
      if(Object.hasOwn(change,'afterMode')){const mode=await this.fileMode(change.path);if(mode!==change.beforeMode&&mode!==change.afterMode)throw new Pause('Cannot reconcile interrupted executable mode: '+change.path,'workspace_changed');}
    }
    for (const change of intent.changes) {
      const file = await this.file(change.path);
      if ((await this.content(change.path)).hash === change.after) {
        if(change.afterMode)await chmod(file,change.afterMode==='100755'?0o700:0o600);
        continue;
      }
      if (change.content === null) await unlink(file);
      else {
        await mkdir(path.dirname(file), { recursive: true });
        // Staging lives outside the editable tree, so an interrupted temp file is not mistaken for user work.
        const temp = path.join(this.journal.dir, 'pending-edit');
        await writeFile(temp, change.content, { mode: change.afterMode==='100755'?0o700:0o600 });
        await rename(temp, file);
      }
    }
    await this.journal.append('edits.applied', { key: intent.key, snapshot: await this.snapshot() });
  }
  async evidence({ includeTrackedPaths = false } = {}) {
    const snapshot = await this.snapshot();
    const { readPaths, writePaths } = this.manifest.permissions;
    const writeScopes = writePaths.map(scope => scope.replace(/\/$/, ''));
    const diff = await git(this.root, 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', ...writeScopes);
    const untracked = (await git(this.root, 'ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean);
    const newFiles = await this.readFiles(untracked.filter(file => !generated(file) && matches(file, writePaths)));
    if (Buffer.byteLength(diff) > 512 * 1024) throw new Pause('Diff exceeds review context limit', 'context');
    const evidence = { diff, newFiles, snapshot: Object.fromEntries(Object.entries(snapshot).filter(([file]) => !secretPath(file) && matches(file, readPaths))) };
    if (includeTrackedPaths) {
      const tracked = await git(this.root, 'diff', '--no-renames', '--name-only', '-z', 'HEAD', '--', ...writeScopes);
      evidence.trackedPaths = tracked.split('\0').filter(file => file && !generated(file) && !secretPath(file) && matches(file, writePaths));
    }
    return evidence;
  }
  async acceptedDiffs({readPaths} = {}) {
    const scopes = (readPaths ?? this.manifest.permissions.writePaths).map(scope => scope.replace(/\/$/, ''));
    const commits = this.journal.events.filter(event => event.type === 'stage.accepted');
    const diffs = [];
    let bytes = 0;
    for (const event of commits) {
      if (!/^[a-f0-9]{40}$/.test(event.data.commit)) throw new Pause('Invalid accepted checkpoint commit', 'evidence');
      const diff = await git(this.root, 'show', '--format=', '--no-ext-diff', '--no-textconv', ...(readPaths ? ['--no-renames'] : []),
        event.data.commit, '--', ...scopes);
      bytes += Buffer.byteLength(diff);
      if (bytes > 512 * 1024) throw new Pause('Accepted stage diffs exceed review context limit', 'context');
      diffs.push({ stageId: event.data.stageId, commit: event.data.commit, diff });
    }
    return diffs;
  }
  async checkpoint(stage) {
    await this.assertSnapshot();
    const message = `Orchestrator ${this.journal.id} stage ${stage.id}`;
    if (await git(this.root, 'log', '-1', '--format=%s') !== message) {
      const files = (await git(this.root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')).split('\0').filter(file => file && matches(file, stage.writePaths) && !generated(file));
      if (files.length) await git(this.root, 'add', '-A', '--', ...new Set(files));
      const staged = (await git(this.root, 'diff', '--cached', '--name-only', '-z')).split('\0').filter(Boolean);
      if (staged.some(file => !matches(file, stage.writePaths) || protectedPath(file))) throw new Pause('Git index contains changes outside this stage', 'workspace_changed');
      await git(this.root, 'commit', '--allow-empty', '-m', message);
    }
    return { commit: await git(this.root, 'rev-parse', 'HEAD'), snapshot: await this.snapshot() };
  }
}

export async function inspectRepository(repo, permissions) {
  repo = await realpath(repo);
  if (await git(repo, 'rev-parse', '--show-toplevel') !== repo) throw new Error('Select the Git repository root');
  if (await git(repo, 'status', '--porcelain')) throw new Error('Source checkout must be clean; commit or stash changes first');
  const paths = (await git(repo, 'ls-files', '-z')).split('\0').filter(file => file && !secretPath(file) && matches(file, permissions.readPaths));
  const context = [];
  for (const file of paths) {
    // Validate every ancestor before reading approved source.
    let current = repo;
    for (const part of file.split('/')) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Source symlink is unsupported: ${file}`);
    }
    const bytes = await readFile(current);
    if (bytes.includes(0) || bytes.length > 128 * 1024) throw new Error(`Unsupported source context: ${file}`);
    context.push({ path: file, hash: digest(bytes), content: bytes.toString('utf8') });
  }
  if (Buffer.byteLength(JSON.stringify(context)) > 512 * 1024) throw new Error('Approved planning context exceeds 512 KiB; narrow readPaths');
  return { repo, baseCommit: await git(repo, 'rev-parse', 'HEAD'), context };
}
