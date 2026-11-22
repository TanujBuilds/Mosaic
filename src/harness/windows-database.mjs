import path from 'node:path';
import {windowsFileSync} from '../beta/windows-files.mjs';
import {createPrivateFileSync} from '../beta/windows-support.mjs';

const walSuffixes = ['-wal', '-shm'];
const sidecarSuffixes = [...walSuffixes, '-journal'];
const empty = Buffer.alloc(0);

function checkPath(operation, file, options) {
  try {
    return windowsFileSync(operation, file, options);
  } catch (error) {
    throw Error('Unsafe Windows SQLite path ' + file + ': ' + error.message, {cause: error});
  }
}

function readInventory(file) {
  checkPath('private-directory', path.dirname(file));
  const present = new Set();
  for (const suffix of ['', ...sidecarSuffixes]) {
    if (checkPath('private-file', file + suffix, {optional: true}) !== null) {
      if (suffix && !present.has('')) {
        throw Error('Retained Windows SQLite sidecar ' + file + suffix + ' has a missing database');
      }
      present.add(suffix);
    }
  }
  return present;
}

// Check existing files before SQLite can load or recover a retained journal.
// The native helper rejects reparse points, shared access and multiple links.
export function assertWindowsDatabaseFiles(file) {
  return readInventory(file).has('');
}

// The default prepares a rollback-mode database, such as the maintenance lock.
// For WAL readers of existing state, create=false prohibits a new main file.
export function prepareWindowsDatabase(file, {wal = false, create = true} = {}) {
  if (create) checkPath('mkdir', path.dirname(file));
  const present = readInventory(file);
  if (!create && !present.has('')) return false;

  // SQLite opens by pathname under the user's token. On an elevated token the
  // default owner may be Administrators, so initialize absent names with an
  // explicit user owner and ACL. A collision is inspected without replacement.
  const required = wal ? ['', ...walSuffixes] : [''];
  const missing = required.filter(suffix => !present.has(suffix));
  for (const suffix of missing) {
    const target = file + suffix;
    try {
      createPrivateFileSync(target, empty);
    } catch (error) {
      if (error.code !== 'EEXIST') throw Error('Cannot create private Windows SQLite file ' + target, {cause: error});
    }
  }
  if (missing.length) {
    const created = readInventory(file);
    for (const suffix of required) {
      if (!created.has(suffix)) throw Error('Missing Windows SQLite file at ' + file + suffix);
    }
  }
  return true;
}
