import { cp, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, git } from './project/process.mjs';

// An explicit preparation command, never invoked by a model during an approved run.
const target = process.argv[2];
if (!target) throw new Error('Usage: npm run pilot -- /path/to/new-disposable-repository');
await mkdir(path.resolve(target)); // Refuse existing directories, even empty ones.
const repo = await realpath(target);
const template = fileURLToPath(new URL('../examples/web-ui-pilot', import.meta.url));
await cp(template, repo, { recursive: true, filter: source => !source.split(path.sep).some(part => ['node_modules', 'dist', '.overnight-output'].includes(part)) });
// The Windows Node distribution ships npm as a command wrapper and a JS CLI.
const npm = process.platform === 'win32'
  ? [process.execPath, path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
  : ['npm'];
for (const argv of [[...npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], [process.execPath, 'node_modules/playwright/cli.js', 'install', 'chromium'], [process.execPath, 'checks/build.mjs']]) {
  const result = await command(argv, { cwd: repo, timeoutMs: 600_000, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(repo, 'node_modules', '.cache', 'ms-playwright') } });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  if (result.code !== 0 || result.stopped) throw new Error(`Preparation failed at ${argv.join(' ')}; inspect ${repo}`);
}
await git(repo, 'init', '-q');
await git(repo, 'add', '.');
await git(repo, '-c', 'user.name=Frontier Pilot', '-c', 'user.email=pilot@example.invalid', 'commit', '-qm', 'Prepared web UI pilot and protected checks');
console.log(JSON.stringify({ repo, baseCommit: await git(repo, 'rev-parse', 'HEAD'), ready: true, note: 'Starter builds; feature checks intentionally fail until implemented.' }, null, 2));
