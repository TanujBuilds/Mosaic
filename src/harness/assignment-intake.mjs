import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { digest, goalDispatchInputSchema } from './contracts.mjs';
import { isOvernightV2 } from './overnight.mjs';
import { matches, protectedPath, relativePath, secretPath } from '../project/contracts.mjs';
import { assignmentSummary } from './assignment-summary.mjs';

export const assignmentManifestSchema = {
  type: 'object',
  description: 'Full or partial coding goal manifest. Provide submissionId, objective, acceptance, explicit mode, project repo/readPaths/writePaths/checks, and limits hours/maxTasks/reviewAgentRuns. The exact checked-out base may be omitted. Check environment overrides are unsupported.',
};

const versionsByMode = new Map([
  ['collaborative', [1]], ['deepseek_only', [1]], ['codex_only', [1]], ['overnight_review', [2, 1]],
]);
const sha = /^[0-9a-f]{40}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 20000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const list = (value, valid) => Array.isArray(value) && value.length <= 100 && value.every(valid);
const unique = value => new Set(value).size === value.length;
const issue = (code, field, message) => ({ code, field, message });

function sensitivePath(file) {
  return secretPath(file) || file.split('/').some(part =>
    /^(?:\.envrc|\.docker|\.gnupg|\.kube|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.?(?:secrets?|credentials?|tokens?)(?:\.(?:json|toml|ya?ml|ini|txt))?)$/i.test(part));
}

function validScope(scope) {
  if (!text(scope, 2000) || /[\x00-\x1f\x7f]/.test(scope)) return false;
  try { relativePath(scope.endsWith('/') ? scope.slice(0, -1) : scope); return true; }
  catch { return false; }
}

function inspectInput(raw, registry, c) {
  const issues = [];
  const need = (value, field, valid, message) => {
    if (value == null || value === '' || Array.isArray(value) && !value.length) issues.push(issue('missing_input', field, message));
    else if (!valid(value)) issues.push(issue('invalid_input', field, message));
  };
  const fields = (value, allowed, field) => {
    if (value !== undefined && (!object(value) || Object.keys(value).some(key => !allowed.includes(key)))) {
      issues.push(issue('invalid_input', field, 'Provide an object with only supported fields.'));
    }
  };
  fields(raw, Object.keys(goalDispatchInputSchema.properties), 'manifest');
  need(raw.submissionId, 'submissionId', value => text(value, 120) && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value), 'Provide a stable submission ID using letters, numbers, underscores or hyphens.');
  need(raw.objective, 'objective', text, 'Describe the coding outcome.');
  need(raw.acceptance, 'acceptance', value => list(value, item => text(item)) && unique(value), 'List the distinct conditions that will demonstrate acceptance.');
  need(raw.mode, 'mode', value => versionsByMode.has(value), 'Choose collaborative, deepseek_only, codex_only or overnight_review.');
  let mode;
  const versions = versionsByMode.get(raw.mode);
  if (versions) {
    try {
      const version = raw.modeVersion === undefined ? versions[0] : raw.modeVersion;
      if (!versions.includes(version)) throw Error();
      mode = registry.mode(raw.mode, version);
    } catch { issues.push(issue('invalid_input', 'modeVersion', 'Choose a built-in version of the selected mode.')); }
  }
  if (raw.researchPolicy !== undefined) issues.push(issue('unsupported_policy', 'researchPolicy', 'Assignment preparation covers coding.'));
  if (raw.environment !== undefined && !['live', 'fixture'].includes(raw.environment)) {
    issues.push(issue('invalid_input', 'environment', 'Choose live or fixture if specifying an execution environment.'));
  }

  const project = object(raw.project) ? raw.project : {};
  fields(raw.project, ['repo', 'baseCommit', 'readPaths', 'writePaths', 'checks', 'behavioralChecks'], 'project');
  need(project.repo, 'project.repo', value => text(value, 4096) && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value), 'Provide the absolute path of the intended Git checkout root.');
  if (project.baseCommit !== undefined && (typeof project.baseCommit !== 'string' || !sha.test(project.baseCommit))) {
    issues.push(issue('invalid_input', 'project.baseCommit', 'Provide the exact 40-character HEAD commit or omit this field.'));
  }
  for (const name of ['readPaths', 'writePaths']) {
    const scopes = project[name];
    need(scopes, `project.${name}`, value => list(value, validScope) && unique(value), 'List distinct repository-relative paths. End directory scopes with a slash.');
    if (!list(scopes, validScope)) continue;
    if (scopes.some(sensitivePath)) issues.push(issue('secret_path', `project.${name}`, 'Remove secret-like paths from the approved scope.'));
    if (name === 'writePaths' && scopes.some(protectedPath)) issues.push(issue('protected_path', 'project.writePaths', 'Remove protected paths from the editable scope.'));
  }
  if (list(project.readPaths, validScope) && project.readPaths.length && list(project.writePaths, validScope) && project.writePaths.some(scope => !matches(scope, project.readPaths))) {
    issues.push(issue('outside_read_scope', 'project.writePaths', 'Keep editable paths within the approved read scope.'));
  }
  need(project.checks, 'project.checks', value => list(value, object), 'List the explicitly approved checks by ID and literal argv.');
  if (list(project.checks, object)) {
    const ids = new Set();
    for (const [index, check] of project.checks.entries()) {
      const field = `project.checks.${index}`;
      if (Object.hasOwn(check, 'env')) issues.push(issue('check_env_unsupported', `${field}.env`, 'Supply checks without environment overrides.'));
      fields(check, ['id', 'argv', 'timeoutMs', 'screenshots', 'env'], field);
      need(check.id, `${field}.id`, value => text(value, 120) && /^[a-z0-9-]+$/.test(value) && !ids.has(value), 'Use a unique lowercase check ID with letters, numbers or hyphens.');
      ids.add(check.id);
      need(check.argv, `${field}.argv`, value => list(value, arg => typeof arg === 'string' && arg.length <= 40000 && !arg.includes('\0')) && text(value[0], 40000), 'Provide a literal argument array beginning with an executable.');
      if (check.timeoutMs !== undefined && (!Number.isInteger(check.timeoutMs) || check.timeoutMs < 100 || check.timeoutMs > 600000)) {
        issues.push(issue('invalid_input', `${field}.timeoutMs`, 'Set an integer check timeout between 100 and 600000 milliseconds.'));
      }
      if (check.screenshots !== undefined && !list(check.screenshots, file => validScope(file) && file.startsWith('.overnight-output/') && file.endsWith('.png'))) {
        issues.push(issue('invalid_input', `${field}.screenshots`, 'List repository-relative PNG paths under .overnight-output/.'));
      }
    }
  }

  const limits = object(raw.limits) ? raw.limits : {};
  fields(raw.limits, ['hours', 'maxTasks', 'reviewAgentRuns', 'taskLimits'], 'limits');
  const maxTasks = isOvernightV2({ mode }) ? 10 : 100;
  const maxReviewers = mode && mode.review !== 'operator' && !raw.reviewPolicy && !c?.selectedHost ? 0 : 10;
  for (const [name, min, max] of [['hours', 1, 24], ['maxTasks', 1, maxTasks], ['reviewAgentRuns', 0, maxReviewers]]) {
    need(limits[name], `limits.${name}`, value => Number.isInteger(value) && value >= min && value <= max, `Explicitly set ${name} to ${min === max ? min : `${min}–${max}`}.`);
  }
  if (isOvernightV2({ mode })) {
    const policy = object(raw.overnightPolicy) ? raw.overnightPolicy : {};
    need(policy.preflightCheckIds, 'overnightPolicy.preflightCheckIds', value => list(value, id => text(id)), 'Select at least one approved infrastructure preflight check.');
    if (!list(policy.finalOnlyCheckIds, id => text(id))) issues.push(issue('invalid_input', 'overnightPolicy.finalOnlyCheckIds', 'List approved final-only check IDs, or explicitly provide an empty list.'));
  } else if (mode && raw.overnightPolicy !== undefined) {
    issues.push(issue('unsupported_policy', 'overnightPolicy', 'Overnight policy requires overnight_review version 2.'));
  }
  return { issues, mode };
}

const runGit = promisify(execFile);
const gitSettings = [
  'core.fsmonitor=', 'core.untrackedCache=false', 'core.ignoreStat=false', 'core.hooksPath=/dev/null',
  'core.trustctime=true', 'core.filemode=true', 'core.checkStat=default',
  'core.attributesFile=/dev/null', 'core.excludesFile=/dev/null', 'submodule.recurse=false',
  'status.submoduleSummary=false', 'status.renames=false', 'protocol.allow=never',
];

function checkoutGit(repo, { discover = true } = {}) {
  const searchPath = (process.env.PATH ?? '').split(path.delimiter).filter(dir => path.isAbsolute(dir)).join(path.delimiter);
  // Whitelist the environment so Git cannot inherit alternate repository or config selectors.
  const env = {
    PATH: searchPath || '/usr/bin:/bin', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '',
    ...(discover ? {} : { GIT_DIR: '/dev/null' }),
  };
  const options = gitSettings.flatMap(setting => ['-c', setting]);
  return async (args, input) => {
    const pending = runGit('git', ['--no-pager', ...options, ...args], {
      cwd: repo, env, encoding: 'utf8', timeout: 3000, maxBuffer: 8 * 1024 * 1024,
    });
    if (input !== undefined) {
      pending.child.stdin.on('error', () => {});
      pending.child.stdin.end(input);
    }
    const { stdout } = await pending;
    return stdout;
  };
}

async function configNames(git, pattern, options = []) {
  try { return await git(['config', ...options, '--null', '--name-only', '--get-regexp', pattern]); }
  catch (error) { if (error.code === 1 && !error.stderr) return ''; throw error; }
}

async function metadataStat(file) {
  try { return await lstat(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function commonGitDir(gitDir) {
  let pointer;
  try { pointer = await open(path.join(gitDir, 'commondir'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return gitDir; throw error; }
  try {
    const stat = await pointer.stat();
    const buffer = Buffer.alloc(4097);
    if (!stat.isFile() || stat.size >= buffer.length) throw Error();
    const { bytesRead } = await pointer.read(buffer);
    const value = buffer.toString('utf8', 0, bytesRead).replace(/\r?\n$/, '');
    if (bytesRead !== stat.size || !value || value !== value.trim() || /[\x00-\x1f\x7f\ufffd]/.test(value)) throw Error();
    // Resolve the raw path so a symlink followed by .. has Git's meaning.
    return realpath(path.isAbsolute(value) ? value : `${gitDir}${path.sep}${value}`);
  } finally { await pointer.close(); }
}

async function safeGitMetadata(repo, dotGit) {
  const entry = await lstat(dotGit);
  if (!entry.isDirectory() && (!entry.isFile() || entry.size > 4096)) return false;
  // Ordinary Git discovery reads config includes before it processes its flags.
  // Resolve metadata and inspect explicit config files from outside the checkout.
  const git = checkoutGit(path.parse(repo).root, { discover: false });
  const resolved = (await git(['rev-parse', '--resolve-git-dir', dotGit])).replace(/\n$/, '');
  if (!path.isAbsolute(resolved)) return false;
  const gitDir = await realpath(resolved);
  const common = await commonGitDir(gitDir);
  const maxMetadataBytes = 1024 * 1024;
  const configs = [path.join(common, 'config'), path.join(gitDir, 'config.worktree')];
  for (const file of configs) {
    const stat = await metadataStat(file);
    if (!stat) continue;
    if (!stat.isFile() || stat.size > maxMetadataBytes) return false;
    if (await configNames(git, '^(include|includeif\\..*)\\.path$', ['--file', file, '--no-includes'])) return false;
  }
  for (const dir of new Set([common, gitDir])) {
    const info = path.join(dir, 'info');
    const stat = await metadataStat(info);
    if (!stat) continue;
    if (!stat.isDirectory()) return false;
    for (const name of ['attributes', 'exclude']) {
      const file = await metadataStat(path.join(info, name));
      if (file && (!file.isFile() || file.size > maxMetadataBytes)) return false;
    }
  }
  return common;
}

// Presets only need verified Git identity, so allow dirty checkouts here.
export async function repositoryCommonDirectory(value) {
  if (!path.isAbsolute(value) || /[\x00-\x1f\x7f]/u.test(value)) throw Error('Choose an absolute Git repository root.');
  try {
    const repo = await realpath(value);
    const common = await safeGitMetadata(repo, path.join(repo, '.git'));
    if (!common) throw Error();
    const root = (await checkoutGit(repo)(['rev-parse', '--show-toplevel'])).replace(/\n$/, '');
    if (await realpath(root) !== repo) throw Error();
    return common;
  } catch {
    throw Error('Choose an accessible Git worktree root with supported configuration.');
  }
}

async function inspectCheckout(project) {
  const failure = (code, message, field = 'project.repo') => ({ issue: issue(code, field, message) });
  let repo, git;
  try {
    repo = await realpath(project.repo);
  } catch { return failure('unresolved_repository', 'Select the exact root of an accessible Git worktree.'); }
  try {
    if (!await safeGitMetadata(repo, path.join(repo, '.git'))) throw Error();
  } catch (error) {
    if (error.code === 'ENOENT') return failure('unresolved_repository', 'Select the exact root of an accessible Git worktree.');
    return failure('unsupported_config', 'Select a checkout with regular Git config and info metadata, without config includes or symlinks.');
  }
  try {
    git = checkoutGit(repo);
    const root = (await git(['rev-parse', '--show-toplevel'])).replace(/\n$/, '');
    if (await realpath(root) !== repo) throw Error();
  } catch { return failure('unresolved_repository', 'Select the exact root of an accessible Git worktree.'); }

  const head = async () => (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  let baseCommit;
  try { baseCommit = await head(); }
  catch { return failure('missing_commit', 'The selected checkout has no resolvable committed HEAD. Review and save the intended work through your chosen commit workflow, or select a clean checkout with a committed HEAD, then prepare again.'); }
  if (!sha.test(baseCommit)) return failure('unsupported_commit', 'The selected checkout must use 40-character commit IDs.');
  if (project.baseCommit !== undefined && project.baseCommit !== baseCommit) {
    return failure('base_mismatch', 'The supplied base does not match the selected checkout HEAD. Review the current committed base and prepare again with that exact HEAD (or omit baseCommit); any new draft requires its own approval.', 'project.baseCommit');
  }

  try {
    const dirty = () => failure('dirty_repository', 'The selected checkout has staged, unstaged or untracked changes. Review and save the intended changes through your chosen workflow, or select a clean committed checkout, then prepare again.');
    const filter = () => failure('unsupported_git_filter', 'Choose a checkout without configured Git clean or process filters or tracked paths using filter attributes.');
    // The worktree probe ignores submodules to avoid entering other checkouts.
    // Compare the cached index separately so this cannot hide staged gitlinks.
    const staged = await git(['diff-index', '--cached', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', baseCommit]);
    if (staged) return dirty();
    // Git status can run clean/process filters when checking a changed stat.
    // Disabling a transforming filter could make a dirty checkout appear clean.
    const filters = await configNames(git, '^filter\\..*\\.(clean|process|required)$');
    if (filters) return filter();
    const index = (await git(['ls-files', '-v', '--stage', '-z'])).split('\0').filter(Boolean);
    if (index.some(entry => entry.includes('\ufffd') || !/^H (?:100644|100755|120000) [0-9a-f]{40} 0\t/.test(entry))) {
      return failure('unsupported_index', 'Use a checkout with a complete index and no submodules or hidden tracked changes.');
    }
    const tracked = new Map(index.map(entry => [entry.slice(entry.indexOf('\t') + 1), entry.slice(2, 8)]));
    // A repository attribute can select a driver from suppressed system/user config.
    // Use attribute names only, and fail closed even if the driver is unavailable here.
    if (tracked.size) {
      const attributes = await git(['check-attr', '--all', '--stdin', '-z'], [...tracked.keys()].join('\0') + '\0');
      if (attributes.split('\0').some((name, index) => index % 3 === 1 && name === 'filter')) return filter();
    }
    const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all']);
    if (status) return dirty();
    if (await head() !== baseCommit) return failure('base_changed', 'The checkout HEAD changed while preparation was reading it.');
    return { repo, baseCommit, tracked };
  } catch { return failure('checkout_unverified', 'Git could not verify the checkout using bounded read-only inspection.'); }
}

async function scopeProblem(repo, scope, tracked, write) {
  const directory = scope.endsWith('/');
  const file = directory ? scope.slice(0, -1) : scope;
  let entry, current = repo;
  try {
    for (const segment of file.split('/')) {
      current = path.join(current, segment);
      entry = await lstat(current);
      if (entry.isSymbolicLink()) return 'Approved paths must not pass through a symlink.';
    }
  } catch (error) {
    if (error.code === 'ENOENT') entry = undefined;
    else return 'The approved path could not be resolved within the checkout.';
  }
  if (entry && (directory ? !entry.isDirectory() : !entry.isFile())) return 'Use a trailing slash only for directory scopes.';
  const files = directory ? [...tracked.keys()].filter(candidate => candidate.startsWith(scope)) : tracked.has(file) ? [file] : [];
  if (entry && !files.length) return 'Existing approved paths must be part of the committed checkout.';
  if (files.some(sensitivePath)) return 'The selected directory includes a tracked secret-like path.';
  if (files.some(candidate => tracked.get(candidate) === '120000')) return 'The selected scope includes a tracked symlink.';
  if (write && files.some(protectedPath)) return 'The selected editable directory includes a tracked protected path.';
}

async function resolveAssignment(raw, c, {legacy=false}={}) {
  const { issues, mode } = inspectInput(raw, c.registry, c);
  const checkout = issues.some(item => ['project.repo', 'project.baseCommit'].includes(item.field))
    ? null : await inspectCheckout(raw.project);
  if (checkout?.issue) issues.push(checkout.issue);
  if (issues.length) return { issues };
  const { repo, baseCommit } = checkout;
  const manifest = { ...raw, modeVersion: mode.version, project: { ...raw.project, repo, baseCommit } };
  let expectedHash;
  try { expectedHash = digest(legacy?c.goalManifest(manifest,undefined,{historic:true}):c.goalManifest(c.reviewPreparation(manifest,{portable:true}))); }
  catch { return { issues: [issue('invalid_manifest', 'manifest', 'Check the remaining fields against the coding goal manifest contract.')] }; }
  for (const name of ['readPaths', 'writePaths']) {
    for (const [index, scope] of raw.project[name].entries()) {
      const problem = await scopeProblem(checkout.repo, scope, checkout.tracked, name === 'writePaths');
      if (problem) issues.push(issue('unsafe_scope', `project.${name}.${index}`, problem));
    }
  }
  return { issues, manifest, expectedHash };
}

export async function prepareAssignment(c, raw = {}, key, {legacy=false}={}) {
  if(legacy&&(c.beta||raw.providerPolicy||raw.reviewPolicy||raw.routingPolicy))throw Error('Legacy assignment cannot select portable policy');
  const command = { op: 'assignment.prepare', manifest: raw };
  const unresolved = Symbol();
  try {
    // Replay or reject changed input before reading a checkout that may have moved on.
    return c.store.command(key, command, () => { throw unresolved; });
  } catch (error) {
    if (error !== unresolved) throw error;
  }
  const { issues, manifest, expectedHash } = await resolveAssignment(raw, c, {legacy});
  try {
    return c.store.command(key, command, () => {
      if (issues.length) throw unresolved;
      const goal = (legacy?c.prepareLegacyGoal.bind(c):c.preparePortableGoal.bind(c))(manifest, `assignment-goal-${digest(key)}`);
      if (goal.status !== 'draft' || goal.hash !== expectedHash) {
        throw Error('Submission conflict: the existing goal is no longer the exact draft.');
      }
      return { status: 'prepared', goalId: goal.id, hash: goal.hash, summary: assignmentSummary(goal.manifest) };
    });
  } catch (error) {
    if (error !== unresolved) throw error;
    return { status: 'needs_input', issues };
  }
}
