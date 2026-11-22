import { lstat, readFile, writeFile, mkdir, rename, unlink, cp, realpath, chmod } from 'node:fs/promises';
import { constants as bufferConstants } from 'node:buffer';
import path from 'node:path';
import { digest, relativePath, matches, protectedPath, secretPath, Pause, AttemptError } from './contracts.mjs';
import { git, gitBytes } from './process.mjs';
import { windowsIndexModes } from './git.mjs';
import { assertWindowsGitPaths, parseWindowsCommitChanges, parseWindowsIndexEntries, windowsGitBlobId, windowsGitFileMode } from './windows-git.mjs';

const isWindows = process.platform === 'win32';
const windowsFiles = isWindows ? await import('../beta/windows-files.mjs') : null;
const contextLimit = 128 * 1024;
const checkpointEntries = entries => [...entries].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
const indexedModeHash = (files, modes) => digest(files.map(file => [file, windowsGitFileMode(modes.get(file))]));
const generated = file => file.startsWith('.overnight-output/') || file.startsWith('dist/') || file.startsWith('node_modules/');
async function exists(file) { try { await lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function workspaceBytes(absolute, options) {
  if (isWindows) return windowsFiles.windowsFile('read', absolute, options);
  try { return await readFile(absolute); }
  catch (error) { if (options?.optional && error.code === 'ENOENT') return null; throw error; }
}
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
    if (isWindows) assertWindowsGitPaths([file]);
    let current = this.root;
    let existing = this.root;
    for (const part of file.split('/')) {
      current = path.join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Pause(`Symlink access denied: ${file}`, 'scope');
        existing = current;
      }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    if (isWindows && existing !== this.root) {
      const root = await realpath(this.root);
      if (path.relative(root, await realpath(existing)) !== path.relative(this.root, existing)) {
        throw new Pause(`Windows filesystem alias access denied: ${file}`, 'scope');
      }
    }
    return current;
  }
  async content(file) {
    const bytes = await workspaceBytes(await this.file(file), {max: contextLimit, optional: true});
    if (bytes === null) return { path: file, hash: null, content: null };
    if (bytes.includes(0)) throw new Pause(`Binary files are unsupported: ${file}`, 'scope');
    if (bytes.length > contextLimit) throw new Pause(`File exceeds context limit: ${file}`, 'context');
    const content = bytes.toString('utf8');
    if (isWindows && !bytes.equals(Buffer.from(content))) throw new Pause(`File must be valid UTF-8 text: ${file}`, 'scope');
    return { path: file, hash: digest(bytes), content };
  }
  async fileMode(file, index) {
    try {
      const stat = await lstat(await this.file(file));
      if (!stat.isFile()) throw new Pause('Expected a regular file: '+file, 'scope');
      if (isWindows) return windowsGitFileMode((index ?? await windowsIndexModes(this.root, [file])).get(file));
      return stat.mode & 0o100 ? '100755' : '100644';
    }
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
      const bytes = await workspaceBytes(await this.file(file), {max: bufferConstants.MAX_LENGTH - 1, optional: true});
      if (bytes !== null) result[file] = digest(bytes);
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
      if (edit.action === 'write' && (typeof edit.content !== 'string' || Buffer.byteLength(edit.content) > contextLimit || edit.content.includes('\0') ||
          isWindows && Buffer.from(edit.content).toString('utf8') !== edit.content)) throw new AttemptError('Write must contain UTF-8 text up to 128 KiB');
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
    const index = isWindows ? await windowsIndexModes(this.root, intent.changes.map(change => change.path)) : undefined;
    for (const change of intent.changes) {
      const actual = (await this.content(change.path)).hash;
      if (actual !== change.before && actual !== change.after) throw new Pause(`Cannot reconcile interrupted edit: ${change.path}`, 'workspace_changed');
      if (Object.hasOwn(change, 'afterMode')) {
        const mode = await this.fileMode(change.path, index);
        // On NTFS a new file can be on disk before its executable mode has
        // reached the index. Only the exact journaled bytes can be recovered.
        const unstagedNewFile = isWindows && change.before === null && actual === change.after && !index.has(change.path);
        if (mode !== change.beforeMode && mode !== change.afterMode && !unstagedNewFile) {
          throw new Pause('Cannot reconcile interrupted executable mode: '+change.path, 'workspace_changed');
        }
      }
    }
    for (const change of intent.changes) {
      const file = await this.file(change.path);
      const alreadyWritten = (await this.content(change.path)).hash === change.after;
      if (!alreadyWritten && change.content === null) await unlink(file);
      else if (!alreadyWritten) {
        if (isWindows) await windowsFiles.windowsFile('mkdir', path.dirname(file));
        else await mkdir(path.dirname(file), { recursive: true });
        // Staging lives outside the editable tree, so an interrupted temp file is not mistaken for user work.
        const temp = path.join(this.journal.dir, 'pending-edit');
        if (isWindows) await windowsFiles.windowsWrite(temp, change.content);
        else await writeFile(temp, change.content, { mode: change.afterMode==='100755'?0o700:0o600 });
        await rename(temp, file);
      }
      if (change.afterMode && isWindows) await this.applyWindowsMode(change);
      else if (change.afterMode && alreadyWritten) await chmod(file, change.afterMode==='100755'?0o700:0o600);
      if (isWindows && (await this.content(change.path)).hash !== change.after) {
        throw new Pause('Windows checkout differs from the journaled edit: '+change.path, 'workspace_changed');
      }
    }
    await this.journal.append('edits.applied', { key: intent.key, snapshot: await this.snapshot() });
  }
  async applyWindowsMode(change) {
    if (await this.fileMode(change.path) === change.afterMode) return;
    const flag = windowsGitFileMode(change.afterMode) === '100755' ? '+x' : '-x';
    if (await git(this.root, 'hash-object', '--', change.path) !== windowsGitBlobId(Buffer.from(change.content))) {
      throw new Pause('Git normalization would change the journaled bytes: '+change.path, 'workspace_changed');
    }
    await git(this.root, 'add', '--chmod='+flag, '--', change.path);
    if (await this.fileMode(change.path) !== change.afterMode) {
      throw new Pause('Git did not retain the journaled executable mode: '+change.path, 'workspace_changed');
    }
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
    let intent = isWindows ? this.journal.events.findLast(event =>
      event.type === 'workspace.windows_checkpoint.intent' && event.data.stageId === stage.id)?.data : null;
    if (await git(this.root, 'log', '-1', '--format=%s') !== message) {
      const listed = await git(this.root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard');
      const files = [...new Set(listed.split('\0').filter(file => file && !generated(file)))];
      if (isWindows) files.sort();
      const writable = files.filter(file => matches(file, stage.writePaths));
      const checked = isWindows ? files.filter(file => !secretPath(file)
        && (matches(file, this.manifest.permissions.readPaths) || matches(file, stage.writePaths))) : [];
      const windowsModes = isWindows ? await windowsIndexModes(this.root, checked) : null;
      if (isWindows) {
        for (let offset = 0; offset < writable.length; offset += 32) {
          await git(this.root, 'add', '-A', '--', ...writable.slice(offset, offset + 32));
        }
      } else if (writable.length) await git(this.root, 'add', '-A', '--', ...writable);
      const staged = (await git(this.root, 'diff', '--cached', ...(isWindows ? ['--no-renames'] : []), '--name-only', '-z')).split('\0').filter(Boolean);
      if (staged.some(file => !matches(file, stage.writePaths) || protectedPath(file))) throw new Pause('Git index contains changes outside this stage', 'workspace_changed');
      if (isWindows) {
        const snapshot = await this.snapshot();
        const modePaths = checked.filter(file => Object.hasOwn(snapshot, file));
        const candidate = {stageId: stage.id, parent: await git(this.root, 'rev-parse', 'HEAD'),
          snapshotHash: digest(snapshot), modePaths, modeHash: indexedModeHash(modePaths, windowsModes),
          changes: await this.windowsCheckpointChanges(checked, staged, windowsModes)};
        if (intent && digest(intent) !== digest(candidate)) throw new Pause('Windows Git checkpoint intent changed before commit', 'workspace_changed');
        if (!intent) await this.journal.append('workspace.windows_checkpoint.intent', candidate);
        intent = candidate;
        await this.assertSnapshot();
      }
      await git(this.root, 'commit', '--allow-empty', '-m', message);
    }
    const commit = await git(this.root, 'rev-parse', 'HEAD');
    const snapshot = await this.snapshot();
    if (isWindows) await this.verifyWindowsCheckpoint(commit, intent, snapshot);
    return { commit, snapshot };
  }
  async windowsCheckpointChanges(checked, staged, modes) {
    assertWindowsGitPaths(staged);
    const stagedPaths = new Set(staged);
    const paths = [...new Set([...checked, ...staged])];
    const changes = new Map();
    for (let offset = 0; offset < paths.length; offset += 32) {
      const batch = new Set(paths.slice(offset, offset + 32));
      const index = parseWindowsIndexEntries(await gitBytes(this.root, 'ls-files', '--stage', '-z', '--', ...batch));
      if ([...index.keys()].some(file => !batch.has(file))) throw new Pause('Windows Git staged a filesystem alias', 'workspace_changed');
      for (const file of batch) {
        const bytes = await workspaceBytes(await this.file(file), {max: bufferConstants.MAX_LENGTH - 1, optional: true});
        const expected = bytes === null ? null : {mode: windowsGitFileMode(modes.get(file)), blob: windowsGitBlobId(bytes)};
        if (digest(index.get(file) ?? null) !== digest(expected)) {
          throw new Pause('Windows Git staged bytes or executable mode that differ from the checkout: '+file, 'workspace_changed');
        }
        if (stagedPaths.has(file)) changes.set(file, expected);
      }
    }
    return checkpointEntries(changes);
  }
  async verifyWindowsCheckpoint(commit, intent, snapshot) {
    if (!intent || await git(this.root, 'rev-list', '--parents', '-1', commit) !== `${commit} ${intent.parent}`) {
      throw new Pause('Windows Git checkpoint does not have its recorded parent', 'workspace_changed');
    }
    const raw = await gitBytes(this.root, 'diff-tree', '-r', '--no-commit-id', '--raw', '--no-abbrev', '--no-renames',
      '--ignore-submodules=none', '-z', intent.parent, commit, '--');
    if (digest(checkpointEntries(parseWindowsCommitChanges(raw))) !== digest(intent.changes)) {
      throw new Pause('Windows Git commit differs from the recorded bytes or executable modes', 'workspace_changed');
    }
    if (digest(snapshot) !== intent.snapshotHash) {
      throw new Pause('Windows Git checkout differs from the recorded checkpoint', 'workspace_changed');
    }
    const index = await windowsIndexModes(this.root, intent.modePaths);
    if (indexedModeHash(intent.modePaths, index) !== intent.modeHash) {
      throw new Pause('Windows Git checkout executable modes differ from the recorded checkpoint', 'workspace_changed');
    }
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
    const bytes = await workspaceBytes(current, {max: contextLimit});
    const content = bytes.toString('utf8');
    if (bytes.includes(0) || bytes.length > contextLimit || isWindows && !bytes.equals(Buffer.from(content))) throw new Error(`Unsupported source context: ${file}`);
    context.push({ path: file, hash: digest(bytes), content });
  }
  if (Buffer.byteLength(JSON.stringify(context)) > 512 * 1024) throw new Error('Approved planning context exceeds 512 KiB; narrow readPaths');
  return { repo, baseCommit: await git(repo, 'rev-parse', 'HEAD'), context };
}
