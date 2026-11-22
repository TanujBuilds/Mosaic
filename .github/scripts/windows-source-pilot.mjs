import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
const exec = promisify(execFile);
const source = fileURLToPath(new URL('../../', import.meta.url));
const root = await mkdtemp(path.join(process.env.RUNNER_TEMP, 'Mosaic source pilot '));
const repo = path.join(root, 'prepared project');
const brief = path.join(root, 'approved brief.txt');
const node = process.execPath;
const npm = path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const pilot = () => exec(node, [npm, 'run', '--silent', 'pilot', '--', repo], {
  cwd:source, timeout:600000, maxBuffer:8 * 1024 * 1024,
});

try {
  const {stdout} = await pilot();
  const head = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  const result = JSON.parse(stdout.slice(stdout.lastIndexOf('\n{')));
  assert.equal(result.ready, true);
  assert.equal(result.baseCommit, head);
  assert.equal((await exec('git', ['-C', repo, 'rev-list', '--count', 'HEAD'])).stdout.trim(), '1');
  assert.equal((await exec('git', ['-C', repo, 'status', '--porcelain'])).stdout.trim(), '');
  assert.ok((await stat(path.join(repo, 'dist', 'index.html'))).size > 0);
  await assert.rejects(pilot(), error => error.stderr.includes('EEXIST'));

  await writeFile(brief, 'Design a small invoice total helper.');
  const run = execFile(node, [path.join(source, 'src', 'live.mjs'), '--brief', brief, '--fake'], {
    cwd:root, timeout:30000, windowsHide:true,
  });
  const output = await new Promise((resolve, reject) => {
    let stdout = '', stderr = '', approved = false;
    run.on('error', reject);
    run.stdin.on('error', reject);
    run.stdout.on('data', bytes => {
      stdout += bytes;
      if (!approved && stdout.includes('[y/N]')) {
        approved = true;
        run.stdin.end('y\n');
      }
    });
    run.stderr.on('data', bytes => { stderr += bytes; });
    run.on('close', code => code === 0 ? resolve(stdout) : reject(Error(stderr || stdout)));
  });
  assert.match(output, /FAKE MODE/);
  assert.match(output, /Final status: accepted/);
  const jobId = /Job ID: ([0-9a-f-]{36})/.exec(output)?.[1];
  assert.ok(jobId);
  const events = (await readFile(path.join(root, '.data', 'jobs', jobId + '.jsonl'), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line));
  for (const type of ['local.result', 'frontier.review']) assert.ok(events.some(event => event.type === type));
  console.log(JSON.stringify({platform:process.platform, architecture:process.arch, node:process.version,
    pilotCommit:head, cleanCheckout:true, existingTargetRefused:true, builtIndex:true,
    simulatedJob:jobId, simulatedReview:true}));
} finally {
  await rm(root, {recursive:true, force:true, maxRetries:5});
}
