import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cp, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const names = ['harness.sqlite3', 'harness.sqlite3-wal', 'harness.sqlite3-shm', 'harness.sqlite3-journal'];

async function stage(t) {
  const parent = await realpath(process.env.RUNNER_TEMP ?? tmpdir());
  const root = await realpath(await mkdtemp(path.join(parent, 'Mosaic SQLite ')));
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 5}));
  const runtime = path.join(root, 'runtime');
  const bin = path.join(runtime, 'bin');
  await mkdir(bin, {recursive: true});
  await cp(path.join(source, 'src'), path.join(runtime, 'src'), {recursive: true});
  const helper = path.join(bin, 'mosaic-files.exe');
  execFileSync(process.env.ComSpec, ['/d', '/s', '/c', 'call "%MOSAIC_BUILD_SCRIPT%" "%MOSAIC_TEST_BINARY%"'], {
    cwd: root,
    env: {
      ...process.env,
      MOSAIC_BUILD_SCRIPT: path.join(source, 'distribution', 'win32-files', 'build.cmd'),
      MOSAIC_TEST_BINARY: helper,
    },
    windowsVerbatimArguments: true,
    stdio: 'inherit',
  });
  const {Store} = await import(pathToFileURL(path.join(runtime, 'src', 'harness', 'store.mjs')).href);
  const helperCall = (op, file, input) => execFileSync(helper, [
    op, file, ...(input ? [String(input.length)] : []),
  ], {input, stdio: ['pipe', 'pipe', 'pipe']});
  return {root, Store, helperCall};
}

function share(file) {
  const icacls = path.join(process.env.SystemRoot, 'System32', 'icacls.exe');
  execFileSync(icacls, [file, '/grant', '*S-1-1-0:R']);
}

function refusal(Store, root, name, reason) {
  assert.throws(() => {
    const unexpected = new Store(root);
    unexpected.close();
  }, error => error.message.includes(name) && reason.test(error.message), name);
}

function saveSample(Store, root) {
  const store = new Store(root);
  try {
    store.tx(() => store.put('sample', {id: 'canary', value: 'durable'}));
  } finally {
    store.close();
  }
}

test('Windows Store verifies the private database root and all SQLite files before use', {
  skip: process.platform !== 'win32',
  timeout: 120_000,
}, async t => {
  const {root, Store, helperCall} = await stage(t);
  await t.test('a new private Store persists data across two concurrent connections and reopen', async () => {
    const state = path.join(root, 'fresh', 'private state');
    const first = new Store(state);
    try {
      first.tx(() => first.put('sample', {id: 'canary', value: 'durable'}));
      helperCall('private-directory', state);
      for (const name of names.slice(0, 3)) helperCall('private-file', path.join(state, name));
      const second = new Store(state);
      try {
        assert.equal(second.get('sample', 'canary').value, 'durable');
      } finally {
        second.close();
      }
    } finally {
      first.close();
    }
    const reopened = new Store(state);
    try {
      assert.equal(reopened.get('sample', 'canary').value, 'durable');
    } finally {
      reopened.close();
    }
  });

  await t.test('a shared directory is refused without creating a database', async () => {
    const state = path.join(root, 'directory with shared ACL');
    helperCall('mkdir', state);
    share(state);
    refusal(Store, state, path.basename(state), /private path|private ACL/i);
    await assert.rejects(readFile(path.join(state, names[0])), {code: 'ENOENT'});
  });

  for (const [index, name] of names.entries()) {
    await t.test(name + ' retained with a shared ACL, hard link, or reparse point', async () => {
      for (const variant of ['shared ACL', 'hard link', 'reparse point']) {
        const state = path.join(root, String(index) + ' ' + variant);
        if (index !== 0 || variant !== 'reparse point') saveSample(Store, state);
        else helperCall('mkdir', state);
        const database = path.join(state, names[0]);
        const databaseBefore = index === 0 ? null : await readFile(database);
        const candidate = path.join(state, name);
        const canary = Buffer.from('retained sidecar evidence');
        if (variant === 'reparse point') {
          const elsewhere = path.join(root, String(index) + ' junction target');
          await mkdir(elsewhere);
          const sentinel = path.join(elsewhere, 'canary');
          await writeFile(sentinel, canary);
          await symlink(elsewhere, candidate, 'junction');
          refusal(Store, state, name, /reparse points/i);
          assert.deepEqual(await readFile(path.join(candidate, 'canary')), canary);
        } else {
          if (index !== 0) helperCall('write', candidate, canary);
          const before = await readFile(candidate);
          if (variant === 'shared ACL') {
            share(candidate);
            refusal(Store, state, name, /private path|private ACL/i);
          } else {
            const alias = path.join(state, 'second link');
            await link(candidate, alias);
            refusal(Store, state, name, /single-link file/i);
            assert.deepEqual(await readFile(alias), before);
          }
          assert.deepEqual(await readFile(candidate), before);
        }
        if (databaseBefore) assert.deepEqual(await readFile(database), databaseBefore);
      }
    });
  }

  await t.test('an orphaned private SQLite journal is preserved without creating a database', async () => {
    const state = path.join(root, 'orphan journal');
    helperCall('mkdir', state);
    const journal = path.join(state, names[3]);
    const content = Buffer.from('retained private orphan');
    helperCall('write', journal, content);
    refusal(Store, state, names[3], /missing database/i);
    assert.deepEqual(await readFile(journal), content);
    await assert.rejects(readFile(path.join(state, names[0])), {code: 'ENOENT'});
  });
});
