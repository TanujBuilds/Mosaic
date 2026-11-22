import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const source = 'src/total.mjs';
const check = 'checks/verify.mjs';
const original = 'export function invoiceTotal(subtotal, shipping) { return subtotal; }\n';
const fixed = 'export function invoiceTotal(subtotal, shipping) { return subtotal + shipping; }\n';
const evaluator = `import assert from 'node:assert/strict';
import {invoiceTotal} from '../src/total.mjs';

assert.equal(invoiceTotal(1250, 250), 1500, 'include shipping in the total');
assert.equal(invoiceTotal(1250, 0), 1250, 'keep zero shipping unchanged');
`;

export function fixtureGit(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', timeout: 15_000,
    env: {...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(cwd, '.mosaic-fixture-gitconfig')},
  }).trim();
}

function runCheck(cwd, node) {
  const result = spawnSync(node, [check], {cwd, encoding: 'utf8', timeout: 15_000});
  if (result.error) throw result.error;
  return result;
}

export function createFirstTaskFixture(repo, node = process.execPath) {
  mkdirSync(repo);
  mkdirSync(path.join(repo, 'src'));
  mkdirSync(path.join(repo, 'checks'));
  writeFileSync(path.join(repo, '.gitattributes'), '* text eol=lf\n');
  writeFileSync(path.join(repo, source), original);
  writeFileSync(path.join(repo, check), evaluator);
  fixtureGit(repo, 'init', '--quiet', '--template=', '--initial-branch=main');
  fixtureGit(repo, 'config', 'user.name', 'Mosaic CI');
  fixtureGit(repo, 'config', 'user.email', 'fixture@example.invalid');
  fixtureGit(repo, 'add', '.gitattributes', source, check);
  fixtureGit(repo, 'commit', '--quiet', '-m', 'Seed the invoice fixture');
  assert.equal(fixtureGit(repo, 'status', '--porcelain'), '');

  const baseline = runCheck(repo, node);
  assert.equal(baseline.status, 1, baseline.stderr);
  assert.match(baseline.stderr, /AssertionError.*include shipping in the total/);
  return {
    baseCommit: fixtureGit(repo, 'rev-parse', 'HEAD'),
    objective: 'Fix the invoice total so it includes shipping, preserving zero-shipping behavior.',
    acceptance: ['The invoice total includes shipping and keeps zero shipping unchanged.'],
    readPaths: ['src/', 'checks/'],
    writePaths: [source],
  };
}

export function fixFirstTaskFixture(candidate) {
  const file = path.join(candidate, source);
  assert.equal(readFileSync(file, 'utf8'), original);
  writeFileSync(file, fixed);
}

export function verifyFirstTaskIntegration(repo, checkout, baseCommit, commit, node = process.execPath) {
  assert.notEqual(commit, baseCommit, 'Integration must create a commit');
  assert.equal(fixtureGit(repo, 'rev-parse', 'main'), baseCommit);
  assert.equal(fixtureGit(checkout, 'rev-parse', 'HEAD'), commit);
  assert.equal(fixtureGit(checkout, 'rev-list', '--parents', '-n', '1', 'HEAD'), `${commit} ${baseCommit}`);
  assert.equal(fixtureGit(checkout, 'diff', '--name-only', baseCommit, commit), source);
  assert.equal(fixtureGit(checkout, 'status', '--porcelain'), '');
  assert.equal(readFileSync(path.join(checkout, check), 'utf8'), evaluator);
  const verified = runCheck(checkout, node);
  assert.equal(verified.status, 0, verified.stderr);
}
