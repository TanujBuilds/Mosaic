import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Workspace } from '../../../src/project/workspace.mjs';
import { git } from '../../../src/project/process.mjs';
import { createPolicy } from '../../../src/project/check-backends/contracts.mjs';
import { createCodexSandboxBackend } from '../../../src/project/check-backends/codex-sandbox.mjs';

export function legacyConfig(permissions) {
  const fs = { ':root': permissions.filesystem.default, ':minimal': permissions.filesystem.minimal };
  for (const rule of permissions.filesystem.rules) fs[rule.path] = rule.access;
  return `permissions.overnight={filesystem={${Object.entries(fs).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',')}},network={enabled=false}}`;
}

export function configEntries(config) {
  assert.ok(config.startsWith('permissions.overnight={filesystem={'));
  return [...config.matchAll(/("(?:[^"\\]|\\.)*")=("(?:[^"\\]|\\.)*")/g)].map(([, key, value]) => [JSON.parse(key), JSON.parse(value)]);
}

export async function fixture({ count = 710, names, readPaths, journalDir, proofBase } = {}) {
  const prefix = proofBase ? path.join(proofBase, 'r3 proof-') : path.join(await realpath(tmpdir()), 'mosaic-r3-');
  if (proofBase) {
    assert.equal(await realpath(proofBase), proofBase);
    // mkdtemp adds a six-character suffix and creates the parent exclusively.
    assert.ok(Buffer.byteLength(prefix) + 8 <= 132);
  }
  const parent = await realpath(await mkdtemp(prefix));
  await chmod(parent, 0o700);
  const padding = 132 - Buffer.byteLength(parent) - 1;
  assert.ok(padding > 0);
  const root = path.join(parent, 'w'.repeat(padding));
  await mkdir(root, { mode: 0o700 });
  const journal = { dir: journalDir ?? path.join(parent, 'state') };
  await mkdir(journal.dir, { mode: 0o700 });
  const approved = readPaths ?? ['test/coordinator.test.mjs', ...Array.from({ length: 13 }, (_, i) => `approved/item-${i}.txt`)];
  const tracked = names ?? [...approved, 'denied/neighbor.txt', 'denied/neighbor.txt-extra', 'denied/token.key',
    ...Array.from({ length: count - approved.length - 3 }, (_, i) => `denied/group-${Math.floor(i / 100)}/file-${String(i).padStart(4, '0')}.txt`)];
  for (const file of tracked) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), `synthetic:${file}\n`, { mode: 0o600 });
  }
  await mkdir(path.join(root, '.overnight-output'), { mode: 0o700 });
  await mkdir(path.join(root, 'dist'), { mode: 0o700 });
  await git(root, 'init', '--quiet');
  await git(root, 'add', '--force', '--', ...tracked);
  // Keep dependency/output exclusions in local Git metadata, not the inventory.
  await mkdir(path.join(root, '.git/info'), { recursive: true });
  await writeFile(path.join(root, '.git/info/exclude'), 'node_modules/\n.overnight-output/\ndist/\nignored-after-snapshot.txt\n');
  await writeFile(path.join(root, 'untracked-private.txt'), 'synthetic untracked canary\n', { mode: 0o600 });
  const workspace = new Workspace({ permissions: { readPaths: approved } }, journal);
  workspace.root = root;
  const admission = { parent, root, rootUtf8Bytes: Buffer.byteLength(root), uid: process.getuid(),
    parentMode: (await lstat(parent)).mode & 0o777, rootMode: (await lstat(root)).mode & 0o777,
    canonical: await realpath(root) === root, tracked: tracked.length };
  assert.equal(admission.rootUtf8Bytes, 132);
  assert.equal(admission.parentMode, 0o700);
  assert.equal(admission.rootMode, 0o700);
  assert.equal((await lstat(root)).uid, process.getuid());
  assert.equal(admission.canonical, true);
  return { parent, root, journal, workspace, tracked, approved, admission };
}

export async function capture(f, permissions = undefined) {
  const executable = path.join(f.parent, 'capture-codex.mjs');
  await rm(path.join(f.parent, 'capture-ran'), { force: true });
  await writeFile(executable, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(path.join(f.parent, 'capture-ran'))},'yes');\nconsole.log(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),env:process.env}));\n`);
  await chmod(executable, 0o700);
  const backend = createCodexSandboxBackend({ workspace: f.workspace, options: { codex: executable } });
  const policy = permissions ?? await createPolicy(f.workspace);
  const request = { argv: [process.execPath, '-e', '0'], cwd: f.root, env: { ONLY: 'literal' }, timeoutMs: 5000, permissions: policy };
  const run = await backend.execute(request);
  assert.equal(run.code, 0, run.stderr);
  const output = JSON.parse(run.stdout);
  return { ...output, policy, request, config: output.argv[4], entries: configEntries(output.argv[4]) };
}
