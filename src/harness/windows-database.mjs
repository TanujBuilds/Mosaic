import {closeSync, openSync} from 'node:fs';
import path from 'node:path';
import {windowsFileSync} from '../beta/windows-files.mjs';

const sidecarSuffixes = ['-wal', '-shm', '-journal'];

function checkPath(operation, file, options) {
  try {
    return windowsFileSync(operation, file, options);
  } catch (error) {
    throw Error('Unsafe Windows SQLite path ' + file + ': ' + error.message, {cause: error});
  }
}

// Check existing files before SQLite can load or recover a retained journal.
// The native helper rejects reparse points, shared access and multiple links.
export function assertWindowsDatabaseFiles(file) {
  checkPath('private-directory', path.dirname(file));
  const exists = checkPath('private-file', file, {optional: true}) !== null;
  for (const suffix of sidecarSuffixes) {
    const sidecar = file + suffix;
    if (checkPath('private-file', sidecar, {optional: true}) !== null && !exists) {
      throw Error('Retained Windows SQLite sidecar ' + sidecar + ' has a missing database');
    }
  }
  return exists;
}

export function prepareWindowsDatabase(file) {
  checkPath('mkdir', path.dirname(file));
  if (assertWindowsDatabaseFiles(file)) return;

  // Create an empty file exclusively inside the private directory. Verify its
  // inherited ACL before any database content is written.
  try {
    closeSync(openSync(file, 'wx', 0o600));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (!assertWindowsDatabaseFiles(file)) throw Error('Missing Windows SQLite database at ' + file);
}
