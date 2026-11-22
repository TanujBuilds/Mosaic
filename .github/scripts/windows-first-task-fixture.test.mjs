import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {createFirstTaskFixture, fixtureGit, fixFirstTaskFixture, verifyFirstTaskIntegration} from './windows-first-task-fixture.mjs';

test('the Windows first-task fixture starts with a real failing check and verifies one scoped Git commit', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mosaic-ci-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const repo = path.join(root, 'Mosaic Windows Pilot');
  const checkout = path.join(root, 'Integrated checkout');
  const {baseCommit} = createFirstTaskFixture(repo);
  fixtureGit(repo, 'worktree', 'add', '--quiet', '-b', 'mosaic-ci-integration', checkout);
  assert.throws(() => verifyFirstTaskIntegration(repo, checkout, baseCommit, baseCommit), /must create a commit/);
  fixFirstTaskFixture(checkout);
  fixtureGit(checkout, 'add', 'src/total.mjs');
  fixtureGit(checkout, 'commit', '--quiet', '-m', 'Include shipping');
  const commit = fixtureGit(checkout, 'rev-parse', 'HEAD');
  verifyFirstTaskIntegration(repo, checkout, baseCommit, commit);
});
