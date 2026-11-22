import {lstatSync, realpathSync} from 'node:fs';
import {win32 as paths} from 'node:path';
import {createHash} from 'node:crypto';

export function isLocalWindowsPath(value) {
  return typeof value === 'string' && /^[a-z]:[\\/]/i.test(value) && !/[\x00-\x1f\x7f:]/u.test(value.slice(2));
}

function regularExecutable(file) {
  try {
    const info = lstatSync(file);
    return info.isFile() ? realpathSync.native(file) : null;
  } catch {
    return null;
  }
}

function samePath(left, right) {
  return paths.normalize(left).toUpperCase() === paths.normalize(right).toUpperCase();
}

// Re-read known installation locations on every discovery. Neither PATH nor
// the current checkout gets to choose the executable, including on a rerun
// after Git for Windows was installed in another process.
export function windowsGitProcess({inherited = process.env, resolveExecutable = regularExecutable} = {}) {
  const system = isLocalWindowsPath(inherited.SystemRoot) ? paths.normalize(inherited.SystemRoot) : 'C:\\Windows';
  const drives = [inherited.ProgramW6432, inherited.ProgramFiles, inherited['ProgramFiles(x86)'],
    paths.join(paths.parse(system).root, 'Program Files')].filter(isLocalWindowsPath);
  if (isLocalWindowsPath(inherited.LOCALAPPDATA)) drives.push(paths.join(inherited.LOCALAPPDATA, 'Programs'));
  const candidates = new Set(drives.map(dir => paths.join(dir, 'Git', 'cmd', 'git.exe')));
  for (const candidate of candidates) {
    const executable = resolveExecutable(candidate);
    if (!isLocalWindowsPath(executable) || !samePath(executable, candidate)) continue;
    const cwd = paths.dirname(executable);
    const env = {PATH: [cwd, paths.join(system, 'System32'), system].join(paths.delimiter), SystemRoot: system, WINDIR: system};
    return {executable, cwd, env};
  }
  return null;
}

const deviceName = /^(?:con|conin\$|conout\$|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu;
export function assertWindowsGitPaths(files) {
  const prefixes = new Map();
  for (const file of files) {
    let prefix = '';
    for (const part of file.split('/')) {
      if (!part || /[<>:"\\|?*\x00-\x1f\x7f\ufffd]/u.test(part) || /[ .]$/u.test(part) || deviceName.test(part)) {
        throw Error('Unsupported Windows checkout path: ' + JSON.stringify(file));
      }
      prefix += '/' + part;
      const folded = prefix.toUpperCase();
      if (prefixes.has(folded) && prefixes.get(folded) !== prefix) {
        throw Error('Git paths differ only by Windows filename case: ' + JSON.stringify(file));
      }
      prefixes.set(folded, prefix);
    }
  }
}

export function windowsGitRecords(bytes) {
  const text = bytes.toString('utf8');
  if (!bytes.equals(Buffer.from(text)) || text.length && !text.endsWith('\0')) throw Error('Invalid Windows Git index output');
  return text ? text.slice(0, -1).split('\0') : [];
}

export function parseWindowsIndexEntries(bytes) {
  const entries = new Map();
  for (const record of windowsGitRecords(bytes)) {
    const match = /^(100644|100755|120000|160000) ([a-f0-9]{40}) 0\t(.+)$/su.exec(record);
    if (!match || entries.has(match[3])) throw Error('Unsupported Windows Git index entry');
    entries.set(match[3], {mode: match[1], blob: match[2]});
  }
  assertWindowsGitPaths(entries.keys());
  return entries;
}

export function parseWindowsIndexModes(bytes) {
  return new Map(Array.from(parseWindowsIndexEntries(bytes), ([file, entry]) => [file, entry.mode]));
}

export function windowsGitFileMode(mode = '100644') {
  if (mode !== '100644' && mode !== '100755') throw Error('Windows Git worktrees require regular files');
  return mode;
}

export function windowsGitBlobId(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export function parseWindowsCommitChanges(bytes) {
  const records = windowsGitRecords(bytes);
  const changes = new Map();
  if (records.length % 2) throw Error('Invalid Windows checkpoint diff');
  for (let index = 0; index < records.length; index += 2) {
    const match = /^:(000000|100644|100755) (000000|100644|100755) [a-f0-9]{40} ([a-f0-9]{40}) ([AMD])$/u.exec(records[index]);
    const file = records[index + 1];
    if (!match || changes.has(file) || (match[2] === '000000') !== (match[4] === 'D')) {
      throw Error('Unsupported Windows checkpoint change');
    }
    changes.set(file, match[2] === '000000' ? null : {mode: match[2], blob: match[3]});
  }
  assertWindowsGitPaths(changes.keys());
  return changes;
}
