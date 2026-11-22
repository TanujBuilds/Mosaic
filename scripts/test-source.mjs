#!/usr/bin/env node
import {readdir, stat, lstat, access} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

// Whole-file boundaries: mixed source/capability files stay in qualification.
// Review this inventory whenever a new test entry introduces a capability gate.
const separate = new Map();
function group(reason, names) {
  for (const name of names) separate.set(`test/${name}.test.mjs`, reason);
}
group('Darwin PTY or filesystem flags; mixed source and macOS checks', [
  'beta-install', 'beta-observer', 'beta-setup', 'mosaic-m019-terminal-width'
]);
group('Darwin arm64 downloader with system shell/Perl archive fixtures', ['download-bootstrap']);
group('Apple Silicon release installer and terminal onboarding; covered by the installer workflow', [
  'release-bootstrap', 'release-guide'
]);
group('Builds standalone runtime snapshots and needs exact-lock offline package inputs', [
  'harness-package', 'harness-research-review-package', 'harness-targeted-repair-package'
]);
group('Actual Darwin sandbox backend, including indirect fixture constructors', [
  'harness-overnight-v2', 'mosaic-flexibility-overnight', 'mosaic-pb15-backends',
  'harness-project-guidance-lifecycle', 'harness-workflow-recipes-cli',
  'mosaic-pb11-composition', 'mosaic-pb12-integration', 'mosaic-pb13-composition',
  'mosaic-second-coding-composition', 'mosaic-validation-coordinator',
  'mosaic-pb15-composition', 'mosaic-pb15-containment', 'mosaic-pb15-native-policy',
  'mosaic-pb15-native-supervisor', 'mosaic-pb15-native-v2', 'mosaic-pb15-seatbelt',
  'mosaic-codex-policy-compaction'
]);
group('Actual Darwin arm64 native runtime, browser, packaging or retained execution proof', [
  'mosaic-pb15-native-v2-composition', 'mosaic-pb16-coding-overlap',
  'mosaic-macos-installer', 'mosaic-pb16-package', 'mosaic-pb16-update', 'native-artifact', 'release-readiness'
]);
group('Extracted Darwin release lifecycle; requires independently inventoried archives', [
  'mosaic-m021-installed-setup', 'mosaic-m025-installed-diagnostics',
  'mosaic-m027-installed', 'mosaic-pb16-installed'
]);
group('Actual pinned Chromium executable and browser checks', ['mosaic-validation-browser']);
group('N1 actual native/browser capability proof and owned neutral parent', ['native-app-feasibility']);
group('W1 mandatory actual native three-worker fixture and owned neutral parent', ['mosaic-three-worker-rehearsal']);

const profiles = new Set(['portable', 'darwin-required']);
const capabilityKey = /^(?:MOSAIC_(?:REQUIRE_|NATIVE_|INSTALLED_|FEASIBILITY_|THREE_WORKER_)|PLAYWRIGHT_BROWSERS_PATH$)/;
const usage = 'node scripts/test-source.mjs <portable|darwin-required> [--list] [--test-name-pattern <regex>]';

function parse(args) {
  const profile = args.shift();
  if (!profiles.has(profile)) throw Error(`Choose portable or darwin-required. Usage: ${usage}`);
  let list = false, pattern;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--list' && !list) list = true;
    else if (arg === '--test-name-pattern' && pattern === undefined && args.length) {
      pattern = args.shift();
      if (pattern.startsWith('--')) throw Error('Missing --test-name-pattern value');
      new RegExp(pattern);
    } else throw Error(`Invalid or repeated option: ${arg}. Usage: ${usage}`);
  }
  if (profile === 'darwin-required' && pattern !== undefined) throw Error('darwin-required cannot filter out qualification checks');
  return {profile, list, pattern};
}

export async function selectTests(root, profile) {
  if (!profiles.has(profile)) throw Error(`Unknown profile: ${profile}`);
  const entries = [];
  for (const dir of ['test', 'test/project']) {
    let names;
    try {
      if (!(await lstat(path.join(root, dir))).isDirectory()) throw Error(`Test root ${dir} must be a real directory`);
      names = await readdir(path.join(root, dir), {withFileTypes: true});
    }
    catch (error) {if (error.code === 'ENOENT') continue; throw error;}
    for (const entry of names) {
      if (entry.isFile() && entry.name.endsWith('.test.mjs')) entries.push(`${dir}/${entry.name}`);
    }
  }
  entries.sort();
  return {
    profile,
    selected: entries.filter(file => profile === 'darwin-required' || !separate.has(file)),
    excluded: profile === 'darwin-required' ? [] : entries.filter(file => separate.has(file)).map(file => ({file, reason: separate.get(file)}))
  };
}

// Presence checks only. Existing required tests verify identity, policy and bytes.
export async function requiredProblems({env, platform, arch, root = process.cwd()}) {
  const problems = [];
  if (platform !== 'darwin' || arch !== 'arm64') problems.push('darwin-required needs Darwin arm64');
  async function input(label, value, directory = false, executable = false) {
    if (!value || !path.isAbsolute(value)) {problems.push(`${label} must name an absolute ${directory ? 'directory' : 'file'} path`); return;}
    try {
      const info = await stat(value);
      if (directory ? !info.isDirectory() : !info.isFile()) throw Error('wrong type');
      await access(value, executable ? constants.R_OK | constants.X_OK : constants.R_OK);
    } catch {problems.push(`${label} is missing, unreadable or has the wrong type`);}
  }
  await input('MOSAIC_NATIVE_TEST_NODE', env.MOSAIC_NATIVE_TEST_NODE, false, true);
  await input('MOSAIC_NATIVE_TEST_LICENSE (or runtime-relative LICENSE)', env.MOSAIC_NATIVE_TEST_LICENSE ||
    (env.MOSAIC_NATIVE_TEST_NODE && path.resolve(env.MOSAIC_NATIVE_TEST_NODE, '../../../LICENSE')));
  for (const key of ['MOSAIC_NATIVE_ARTIFACT_MANIFEST', 'MOSAIC_THREE_WORKER_NATIVE_MANIFEST',
    'MOSAIC_INSTALLED_ARCHIVE', 'MOSAIC_INSTALLED_UPDATE_ARCHIVE', 'MOSAIC_INSTALLED_DEMO_ARCHIVE']) await input(key, env[key]);
  for (const key of ['MOSAIC_NATIVE_ARTIFACT_SHA256', 'MOSAIC_THREE_WORKER_NATIVE_SHA256']) {
    if (!/^[a-f0-9]{64}$/.test(env[key] ?? '')) problems.push(`${key} must be a lowercase SHA256`);
  }
  for (const key of ['MOSAIC_INSTALLED_ROOT_PARENT', 'MOSAIC_FEASIBILITY_TEST_PARENT', 'MOSAIC_THREE_WORKER_TEST_PARENT']) await input(key, env[key], true);
  // Match the pinned N1/protected-check input, not Playwright's full browser
  // default or a user-global cache. Later qualification verifies its bytes.
  const chromium = path.join(root, 'node_modules/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell');
  await input('Chromium headless shell (prepare the pinned repository cache)', chromium, false, true);
  return problems;
}

export function buildChildEnvironment(profile, inherited = process.env) {
  if (!profiles.has(profile)) throw Error(`Unknown profile: ${profile}`);
  const env = {...inherited};
  // A CLI invoked by node:test must start a fresh runner, not inherit its
  // private child context (which silently suppresses nested test execution).
  delete env.NODE_TEST_CONTEXT;
  // Portable fixtures need no personal Git identity. Required qualification
  // preserves the caller environment for its strict Git-override guard.
  if (profile === 'portable') {
    env.GIT_AUTHOR_NAME ??= 'Mosaic source fixtures';
    env.GIT_AUTHOR_EMAIL ??= 'fixture@example.invalid';
    env.GIT_COMMITTER_NAME ??= 'Mosaic source fixtures';
    env.GIT_COMMITTER_EMAIL ??= 'fixture@example.invalid';
  }
  if (profile === 'darwin-required') env.MOSAIC_REQUIRE_NATIVE = env.MOSAIC_REQUIRE_BROWSER = env.MOSAIC_REQUIRE_INSTALLED = '1';
  return env;
}

export async function main(args = process.argv.slice(2)) {
  const {profile, list, pattern} = parse([...args]);
  const selection = await selectTests(process.cwd(), profile);
  if (list) {console.log(JSON.stringify(selection, null, 2)); return 0;}
  if (!selection.selected.length) throw Error('No test entries selected; refusing broad discovery');
  if (process.env.NODE_OPTIONS?.trim()) throw Error('Unset NODE_OPTIONS before running source checks; inherited flags can filter or alter the test process');
  const env = buildChildEnvironment(profile);
  if (profile === 'portable') {
    const inherited = Object.keys(env).filter(key => capabilityKey.test(key) && env[key]);
    if (inherited.length) throw Error(`portable requires a source-only environment; unset: ${inherited.join(', ')}`);
  } else {
    const problems = await requiredProblems({env, platform: process.platform, arch: process.arch});
    if (problems.length) throw Error(`Required qualification prerequisites:\n- ${problems.join('\n- ')}`);
  }
  console.error(`source-checks: ${profile}: ${selection.selected.length} entries; ${selection.excluded.length} separately qualified (inspect with --list)`);
  const argv = ['--test', '--test-concurrency=1', '--test-reporter=tap'];
  if (pattern !== undefined) argv.push('--test-name-pattern', pattern);
  argv.push(...selection.selected);
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {cwd: process.cwd(), env, stdio: 'inherit'});
    let requestedSignal;
    const forward = signal => {requestedSignal ??= signal; child.kill(signal);};
    const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    const clear = () => {process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);};
    child.once('error', error => {clear(); reject(error);});
    child.once('close', (code, signal) => {
      clear();
      // Node's test parent may translate SIGTERM into code 1 after stopping
      // its workers; retain the cancellation requested of this CLI.
      if (requestedSignal || signal) process.kill(process.pid, requestedSignal || signal);
      else resolve(code ?? 1);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => {process.exitCode = code;}).catch(error => {
    console.error(`source-checks: ${error.message}`);
    process.exitCode = 2;
  });
}
