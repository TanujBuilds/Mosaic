import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Coordinator } from '../src/harness/coordinator.mjs';
import { Integration } from '../src/harness/integration.mjs';
import { digest } from '../src/harness/contracts.mjs';
import { Journal } from '../src/project/journal.mjs';
import { command, git } from '../src/project/process.mjs';

const originalMode = "export default 'normal';\n";
const compatibilityMode = "export default 'compatibility';\n";
const originalFormat = "export default 'plain';\n";
const compactFormat = "export default 'compact';\n";

async function fixture(t, { integrationFault, attributes, requireLf = false, requireExecutable = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mosaic-validation-integration-'));
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await mkdir(path.join(repo, 'checks'));
  await writeFile(path.join(repo, 'src/mode.mjs'), originalMode);
  await writeFile(path.join(repo, 'src/format.mjs'), originalFormat);
  if (attributes) await writeFile(path.join(repo, '.gitattributes'), attributes);
  await writeFile(path.join(repo, 'checks/export.mjs'), `
    import assert from 'node:assert/strict';
    import { readFileSync, statSync } from 'node:fs';
    import mode from '../src/mode.mjs';
    import format from '../src/format.mjs';
    assert.notEqual(mode + ':' + format, 'compatibility:compact', 'Combined settings break export');
    const source = new URL('../src/mode.mjs', import.meta.url);
    const bytes = readFileSync(source);
    console.log(bytes.includes('\\r\\n') ? 'Observed CRLF' : 'Observed LF');
    ${requireLf ? "assert.equal(bytes.includes('\\r\\n'), false, 'Export requires LF');" : ''}
    ${requireExecutable ? "assert.equal(statSync(source).mode & 0o100, 0o100, 'Export helper must be executable');" : ''}
  `);
  for (const args of [
    ['init', '-q'], ['config', 'user.email', 'fixture@example.invalid'],
    ['config', 'user.name', 'Fixture'], ['config', 'core.autocrlf', 'false'], ['config', 'core.eol', 'lf'],
    ['config', 'extensions.worktreeConfig', 'true'], ['add', '.'], ['commit', '-qm', 'base'],
  ]) await git(repo, ...args);

  const c = new Coordinator({ root: path.join(root, 'state') });
  t.after(async () => {
    c.close();
    await rm(root, { recursive: true, force: true });
  });
  const g = c.prepareGoal({
    submissionId: 'goal', objective: 'Export with both supported formats',
    acceptance: ['Combined settings preserve export'], mode: 'codex_only',
    environment: 'fixture',
    project: {
      repo, baseCommit: await git(repo, 'rev-parse', 'HEAD'),
      readPaths: ['src/', 'checks/'], writePaths: ['src/'],
      checks: [
        { id: 'build', argv: [process.execPath, '--check', 'src/format.mjs'] },
        { id: 'export', argv: [process.execPath, 'checks/export.mjs'] },
      ],
      behavioralChecks: [
        { criterionId: 'export', description: 'Combined settings preserve export', checkIds: ['export'] },
      ],
    },
  }, 'prepare');
  c.activateGoal({ goalId: g.id, hash: g.hash }, 'activate');
  // Execute the approved literal argv against actual disposable Git worktrees.
  // The test replaces the platform sandbox and uses an explicit minimal child env.
  const integration = new Integration({
    c,
    checksFactory: workspace => ({
      verify: async () => ({ fixture: true }),
      run: async (checks, key) => {
        const results = await Promise.all(checks.map(async check => {
          const result = await command(check.argv, {
            cwd: workspace.root, env: { PATH: '/usr/bin:/bin' },
          });
          return { ...result, id: check.id, argv: check.argv, passed: result.code === 0, screenshots: [] };
        }));
        return key.startsWith('integrate-') && integrationFault
          ? integrationFault(workspace, results)
          : results;
      },
    }),
  });
  return { c, g, integration };
}

async function startCandidate({ c, g, integration }, key, file, content, layout) {
  const task = c.submitTask({
    goalId: g.id, submissionId: key, kind: 'coding', actor: 'codex',
    objective: 'Change one export setting', acceptance: ['Export remains valid'],
    permissions: {
      readPaths: ['src/', 'checks/'], writePaths: [file], checks: ['build', 'export'],
    },
  }, `submit-${key}`);
  const active = await integration.startNative({ taskId: task.id, ...(layout ? { layout } : {}) }, `start-${key}`);
  await writeFile(path.join(active.native.worktree, file), content);
  return active;
}

async function prepareCandidate(f, key, file, content) {
  const task = await startCandidate(f, key, file, content, 'candidate_v1');
  const candidate = await f.integration.finishNative({ taskId: task.id, summary: 'Changed one setting' }, `finish-${key}`);
  assert.equal(candidate.status, 'awaiting_review');
  assert.deepEqual(candidate.result.checks.map(({ id, passed }) => ({ id, passed })), [
    { id: 'build', passed: true }, { id: 'export', passed: true },
  ]);
  return candidate;
}

function accept(f, task, key) {
  return f.integration.accept({ taskId: task.id, feedback: 'Reviewed actual candidate' }, key);
}

test('combined result reruns mapped checks even though both separately reviewed candidates passed', async t => {
  const f = await fixture(t);
  const a = await prepareCandidate(f, 'mode', 'src/mode.mjs', compatibilityMode);
  const b = await prepareCandidate(f, 'format', 'src/format.mjs', compactFormat);
  const first = await accept(f, a, 'accept-mode');
  assert.equal(first.status, 'accepted');
  assert.equal(first.integration.candidateCommit, a.native.commit);
  assert.equal(first.integration.candidateBehavioralEvidence.criteria[0].status, 'passed');
  assert.equal(first.integration.behavioralEvidence.criteria[0].status, 'passed');
  assert.equal(first.integration.commit, await git(first.integration.worktree, 'rev-parse', 'HEAD'));

  await assert.rejects(accept(f, b, 'accept-format'), /Integrated checks failed/);
  const journal = await new Journal(path.join(f.c.store.root, 'integration'), f.g.id).load();
  const failed = journal.last('integration.checks');
  assert.equal(failed.checks.find(check => check.id === 'build').passed, true);
  assert.match(failed.checks.find(check => check.id === 'export').stderr, /Combined settings break export/);
  assert.equal(failed.behavioralEvidence.criteria[0].status, 'failed');
  assert.equal(failed.behavioralEvidence.snapshotHash, digest(failed.snapshot));
  assert.equal(f.c.getTask(b.id).integration, undefined);

  const repaired = await f.integration.repair({
    taskId: b.id, reason: 'Restore exactly the failed import before correcting the candidate',
  }, 'repair-format');
  assert.equal(repaired.status, 'codex_ready');
  assert.equal(await git(first.integration.worktree, 'rev-parse', 'HEAD'), first.integration.commit);
  assert.equal(await readFile(path.join(first.integration.worktree, 'src/mode.mjs'), 'utf8'), compatibilityMode);
  assert.equal(await readFile(path.join(first.integration.worktree, 'src/format.mjs'), 'utf8'), originalFormat);
  assert.equal(f.c.getGoal(f.g.id).integrationPending, null);
});

test('a journaled candidate mutation cannot reuse an older passing native checkpoint', async t => {
  const f = await fixture(t);
  const candidate = await prepareCandidate(f, 'mode', 'src/mode.mjs', compatibilityMode);
  const { journal, workspace } = await f.integration.candidate(candidate);
  const release = await journal.lock();
  try {
    const file = await workspace.content('src/mode.mjs');
    await workspace.apply('changed-after-checks', { writePaths: ['src/mode.mjs'] }, [
      { path: file.path, action: 'write', baseHash: file.hash, content: originalMode },
    ]);
  } finally {
    await release();
  }
  await assert.rejects(accept(f, candidate, 'accept-stale'), /changed|snapshot/i);
  const saved = f.c.getTask(candidate.id);
  assert.equal(saved.status, 'awaiting_review');
  assert.equal(saved.reviews, 0);
  assert.equal(saved.integration, undefined);
  assert.equal(f.c.getGoal(f.g.id).integrationPending, undefined);
});

test('a passing build cannot make a missing mapped receipt eligible for combined acceptance', async t => {
  const f = await fixture(t, {
    integrationFault: (_workspace, results) => results.filter(check => check.id !== 'export'),
  });
  const candidate = await prepareCandidate(f, 'mode', 'src/mode.mjs', compatibilityMode);
  await assert.rejects(accept(f, candidate, 'accept-missing'), /behavior|receipt|missing/i);
  const journal = await new Journal(path.join(f.c.store.root, 'integration'), f.g.id).load();
  const failed = journal.last('integration.checks');
  assert.deepEqual(failed.checks.map(({ id }) => id), ['build']);
  assert.equal(failed.behavioralEvidence.criteria[0].status, 'not_run');
  assert.equal(f.c.getTask(candidate.id).integration, undefined);
  assert.equal(f.c.getGoal(f.g.id).integrationPending.taskId, candidate.id);
});

test('a combined snapshot changed after a check cannot be checkpointed with its passing receipt', async t => {
  const f = await fixture(t, {
    integrationFault: async (workspace, results) => {
      await writeFile(path.join(workspace.root, 'src/mode.mjs'), originalMode);
      return results;
    },
  });
  const candidate = await prepareCandidate(f, 'mode', 'src/mode.mjs', compatibilityMode);
  await assert.rejects(accept(f, candidate, 'accept-changed'), /changed|snapshot/i);
  const goal = f.c.getGoal(f.g.id);
  assert.equal(await git(goal.integration.worktree, 'rev-parse', 'HEAD'), f.g.manifest.project.baseCommit);
  assert.equal(f.c.getTask(candidate.id).integration, undefined);
  assert.equal(goal.integrationPending.taskId, candidate.id);
});

const crlfMode = compatibilityMode.replace('\n', '\r\n');

test('a normalized native candidate commit cannot inherit the CRLF worktree check receipt', async t => {
  const f = await fixture(t, { attributes: '*.mjs text eol=lf\n' });
  const candidate = await prepareCandidate(f, 'mode', 'src/mode.mjs', crlfMode);
  assert.match(candidate.result.checks.find(check => check.id === 'export').stdout, /Observed CRLF/);
  assert.equal(await git(candidate.native.worktree, 'show', candidate.native.commit + ':src/mode.mjs', '-z'), compatibilityMode);
  await assert.rejects(accept(f, candidate, 'accept-eol-candidate'), /commit.*checked|checked.*commit/i);
  assert.equal(f.c.getTask(candidate.id).integration, undefined);
  assert.equal(f.c.getGoal(f.g.id).integrationPending, undefined);
});

test('a normalized combined commit cannot inherit the CRLF import check receipt', async t => {
  let configureEol = true;
  const f = await fixture(t, {
    integrationFault: async (workspace, results) => {
      if (configureEol) await git(workspace.root, 'config', '--worktree', 'core.autocrlf', 'input');
      return results;
    },
  });
  const candidate = await prepareCandidate(f, 'mode', 'src/mode.mjs', crlfMode);
  assert.equal(await git(candidate.native.worktree, 'show', candidate.native.commit + ':src/mode.mjs', '-z'), crlfMode);
  await assert.rejects(accept(f, candidate, 'accept-eol-combined'), /commit.*checked|checked.*commit/i);
  const journal = await new Journal(path.join(f.c.store.root, 'integration'), f.g.id).load();
  assert.match(journal.last('integration.checks').checks.find(check => check.id === 'export').stdout, /Observed CRLF/);
  assert.equal(f.c.getTask(candidate.id).integration, undefined);
  const goal = f.c.getGoal(f.g.id);
  assert.equal(goal.integrationPending.taskId, candidate.id);
  assert.equal(await git(goal.integration.worktree, 'rev-parse', 'HEAD'), goal.manifest.project.baseCommit);

  configureEol = false;
  await git(goal.integration.worktree, 'config', '--worktree', 'core.autocrlf', 'false');
  const accepted = await accept(f, candidate, 'accept-eol-combined');
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.integration.behavioralEvidence.criteria[0].status, 'passed');
  assert.equal(await git(goal.integration.worktree, 'show', accepted.integration.commit + ':src/mode.mjs', '-z'), crlfMode);
});

test('direct native finish refuses to attach a worktree receipt to a normalized commit', async t => {
  const f = await fixture(t, { attributes: '*.mjs text eol=lf\n' });
  const task = await startCandidate(f, 'mode', 'src/mode.mjs', crlfMode);
  await assert.rejects(
    f.integration.finishNative({ taskId: task.id, summary: 'Changed one setting' }, 'finish-eol-native'),
    /commit.*checked|checked.*commit/i,
  );
  assert.equal(f.c.getTask(task.id).integration, undefined);
  assert.equal(f.c.getGoal(f.g.id).integrationOwner, task.id);
  assert.equal(await git(task.native.worktree, 'rev-parse', 'HEAD'), f.g.manifest.project.baseCommit);

  await writeFile(path.join(task.native.worktree, 'src/mode.mjs'), compatibilityMode);
  const accepted = await f.integration.finishNative({ taskId: task.id, summary: 'Changed one setting' }, 'finish-eol-native');
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.integration.behavioralEvidence.criteria[0].status, 'passed');
  assert.equal(await git(task.native.worktree, 'show', accepted.integration.commit + ':src/mode.mjs', '-z'), compatibilityMode);
});

test('the byte-parity precommit probe declines an unconfigured Git filter attribute', async t => {
  const f = await fixture(t, { attributes: 'src/mode.mjs filter=unspecified\n' });
  const task = await startCandidate(f, 'mode', 'src/mode.mjs', compatibilityMode);
  await assert.rejects(
    f.integration.finishNative({ taskId: task.id, summary: 'Changed one setting' }, 'finish-filter-native'),
    /Git filter attribute/i,
  );
  assert.equal(await git(task.native.worktree, 'rev-parse', 'HEAD'), f.g.manifest.project.baseCommit);
  assert.equal(f.c.getTask(task.id).integration, undefined);
});

test('checkout transforms cannot turn a checked LF file into CRLF after direct native finish', async t => {
  const f = await fixture(t, { attributes: 'src/mode.mjs text eol=crlf\n', requireLf: true });
  const task = await startCandidate(f, 'mode', 'src/mode.mjs', compatibilityMode);
  const materialized = await command(
    ['git', '-c', 'core.attributesFile=/dev/null', 'cat-file', '--filters', 'HEAD:src/mode.mjs'],
    { cwd: task.native.worktree, env: { PATH: '/usr/bin:/bin', GIT_ATTR_NOSYSTEM: '1' } },
  );
  assert.equal(materialized.code, 0, materialized.stderr);
  assert.equal(materialized.stdout, originalMode.replace('\n', '\r\n'));
  assert.equal(await readFile(path.join(task.native.worktree, 'src/mode.mjs'), 'utf8'), compatibilityMode);
  await assert.rejects(
    f.integration.finishNative({ taskId: task.id, summary: 'Changed one setting' }, 'finish-checkout-eol'),
    /checkout.*eol=crlf/i,
  );
  assert.equal(await git(task.native.worktree, 'rev-parse', 'HEAD'), f.g.manifest.project.baseCommit);
  assert.equal(f.c.getTask(task.id).integration, undefined);
});

test('checkout transforms configured on an already-committed native candidate prevent import', async t => {
  const f = await fixture(t, { requireLf: true });
  const task = await startCandidate(f, 'mode', 'src/mode.mjs', compatibilityMode, 'candidate_v1');
  await git(task.native.worktree, 'config', '--worktree', 'core.autocrlf', 'yes');
  const candidate = await f.integration.finishNative({ taskId: task.id, summary: 'Changed one setting' }, 'finish-checkout-autocrlf');
  assert.equal(candidate.result.checks.find(check => check.id === 'export').passed, true);
  assert.equal(await git(task.native.worktree, 'show', candidate.native.commit + ':src/mode.mjs', '-z'), compatibilityMode);
  await assert.rejects(accept(f, candidate, 'accept-checkout-autocrlf'), /checkout.*core\.autocrlf/i);
  assert.equal(f.c.getGoal(f.g.id).integrationPending, undefined);
});

test('checkout transforms on the combined worktree leave the target at its prior commit', async t => {
  let configureEol = true;
  const f = await fixture(t, {
    attributes: 'src/mode.mjs text\n',
    requireLf: true,
    integrationFault: async (workspace, results) => {
      if (configureEol) await git(workspace.root, 'config', '--worktree', 'core.eol', 'crlf');
      return results;
    },
  });
  const candidate = await prepareCandidate(f, 'mode', 'src/mode.mjs', compatibilityMode);
  await assert.rejects(accept(f, candidate, 'accept-checkout-core-eol'), /checkout.*core\.eol/i);
  const goal = f.c.getGoal(f.g.id);
  assert.equal(await git(goal.integration.worktree, 'rev-parse', 'HEAD'), f.g.manifest.project.baseCommit);
  assert.equal(f.c.getTask(candidate.id).integration, undefined);

  configureEol = false;
  await git(goal.integration.worktree, 'config', '--worktree', 'core.autocrlf', 'input');
  const accepted = await accept(f, candidate, 'accept-checkout-core-eol');
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.integration.behavioralEvidence.criteria[0].status, 'passed');
});

test('checkout transforms declared as ident or working-tree encoding are outside the evidence contract', async t => {
  for (const attribute of ['ident', 'working-tree-encoding=UTF-8']) {
    await t.test(attribute, async t => {
      const f = await fixture(t, { attributes: `src/mode.mjs ${attribute}\n` });
      const task = await startCandidate(f, 'mode', 'src/mode.mjs', compatibilityMode);
      await assert.rejects(
        f.integration.finishNative({ taskId: task.id, summary: 'Changed one setting' }, 'finish-checkout-attribute'),
        /Git checkout attribute/i,
      );
      assert.equal(await git(task.native.worktree, 'rev-parse', 'HEAD'), f.g.manifest.project.baseCommit);
      assert.equal(f.c.getTask(task.id).integration, undefined);
    });
  }
});

test('direct native finish refuses to drop the checked executable bit before committing', async t => {
  const f = await fixture(t, { requireExecutable: true });
  const task = await startCandidate(f, 'mode', 'src/mode.mjs', compatibilityMode);
  await chmod(path.join(task.native.worktree, 'src/mode.mjs'), 0o755);
  await git(task.native.worktree, 'config', '--worktree', 'core.filemode', 'false');
  const finish = () => f.integration.finishNative({ taskId: task.id, summary: 'Changed one setting' }, 'finish-exec-mode');
  await assert.rejects(finish(), /core\.filemode/i);
  assert.equal(await git(task.native.worktree, 'rev-parse', 'HEAD'), f.g.manifest.project.baseCommit);
  assert.equal(f.c.getTask(task.id).integration, undefined);

  await git(task.native.worktree, 'config', '--worktree', 'core.filemode', 'true');
  const accepted = await finish();
  assert.equal(accepted.status, 'accepted');
  assert.match(await git(task.native.worktree, 'ls-tree', accepted.integration.commit, '--', 'src/mode.mjs'), /^100755 blob /);
});

test('a native candidate with an executable bit missing from its commit cannot be imported', async t => {
  const f = await fixture(t, { requireExecutable: true });
  const task = await startCandidate(f, 'mode', 'src/mode.mjs', compatibilityMode, 'candidate_v1');
  await chmod(path.join(task.native.worktree, 'src/mode.mjs'), 0o755);
  await git(task.native.worktree, 'config', '--worktree', 'core.filemode', 'false');
  const candidate = await f.integration.finishNative({ taskId: task.id, summary: 'Changed one setting' }, 'finish-candidate-mode');
  assert.equal(candidate.result.checks.find(check => check.id === 'export').passed, true);
  assert.match(await git(task.native.worktree, 'ls-tree', candidate.native.commit, '--', 'src/mode.mjs'), /^100644 blob /);
  await assert.rejects(accept(f, candidate, 'accept-candidate-mode'), /commit.*executable bit/i);
  assert.equal(f.c.getGoal(f.g.id).integrationPending, undefined);
});

test('an executable bit changed during combined checks cannot inherit the passing receipt', async t => {
  const f = await fixture(t, {
    integrationFault: async (workspace, results) => {
      await chmod(path.join(workspace.root, 'src/mode.mjs'), 0o755);
      return results;
    },
  });
  const candidate = await prepareCandidate(f, 'mode', 'src/mode.mjs', compatibilityMode);
  await assert.rejects(accept(f, candidate, 'accept-changed-mode'), /executable bit.*changed/i);
  const goal = f.c.getGoal(f.g.id);
  assert.equal(await git(goal.integration.worktree, 'rev-parse', 'HEAD'), f.g.manifest.project.baseCommit);
  assert.equal(f.c.getTask(candidate.id).integration, undefined);
});
