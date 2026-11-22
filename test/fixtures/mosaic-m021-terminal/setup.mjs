import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {locations, privateDirectories} from '../../../src/beta/files.mjs';
import {readSettings, setup} from '../../../src/beta/setup.mjs';

const home = await mkdtemp(path.join(os.tmpdir(), 'Mosaic setup PTY '));
const paths = locations(home, true);
const runtimeFingerprint = 'a'.repeat(64);
const result = {};
try {
  await privateDirectories(paths);
  await mkdir(path.dirname(paths.launcher), {recursive: true});
  await writeFile(paths.launcher, '#!/bin/sh\nexit 0\n', {mode: 0o755});
  try {
    result.saved = await setup(paths, {
      portable: true,
      execution: {backend: 'darwin-seatbelt', backendRevision: 2, runtimeFingerprint},
      nativeCheckRuntime: {
        schema: 1,
        artifactManifestPath: '/fixture/runtime/check-artifact/artifact-manifest.json',
        artifactManifestSha256: runtimeFingerprint
      },
      verifyExecution() {}
    });
  } catch (error) {
    result.error = error.message;
  }
  result.host = (await readSettings(paths))?.host.id;
  result.credentialsWritten = await readFile(paths.credentials).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  result.raw = !!process.stdin.isRaw;
} finally {
  await rm(home, {recursive: true, force: true});
}
process.stdout.write('\nMOSAIC_SETUP_RESULT ' + JSON.stringify(result) + '\n');
