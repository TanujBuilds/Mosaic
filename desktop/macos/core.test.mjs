import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {ensureCore, version} from './core.mjs';

async function fixture(t) {
  const home = await mkdtemp('/private/tmp/mosaic-core-test-');
  t.after(() => rm(home, {recursive:true, force:true}));
  return {home, isolated:true};
}

test('a foreign launcher or linked launcher directory is preserved', async t => {
  const context = await fixture(t);
  const bin = path.join(context.home, '.local/bin');
  const launcher = path.join(bin, 'mosaic');
  await mkdir(bin, {recursive:true, mode:0o700});
  await writeFile(launcher, 'other launcher');
  await assert.rejects(ensureCore(context), /foreign|changed/);
  assert.equal(await readFile(launcher,'utf8'), 'other launcher');
  await rm(bin, {recursive:true});
  await symlink(context.home, bin);
  await assert.rejects(ensureCore(context), /owned directories/);
});

test('a bad download leaves shared setup empty', async t => {
  const context = await fixture(t);
  const archivePath = path.join(context.home, 'bad.tar.gz');
  await writeFile(archivePath,'not a release');
  await assert.rejects(ensureCore({...context, archivePath}), /wrong size/);
  await assert.rejects(readFile(path.join(context.home,'.local/bin/mosaic')), {code:'ENOENT'});
});

test('fresh and already-installed setups select the same verified runtime',
  {skip:!process.env.MOSAIC_DESKTOP_TEST_ARCHIVE}, async t => {
    const context = await fixture(t);
    const first = await ensureCore({...context, archivePath:process.env.MOSAIC_DESKTOP_TEST_ARCHIVE});
    const second = await ensureCore({...context, archivePath:'/nonexistent'});
    assert.equal(first.version,version);
    assert.deepEqual(first,second);
    const launcher = path.join(context.home,'.local/bin/mosaic');
    await chmod(launcher, 0o600);
    await assert.rejects(ensureCore(context), /Restore the Mosaic launcher/);
  });
