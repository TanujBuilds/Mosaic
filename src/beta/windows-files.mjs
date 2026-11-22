import {execFile, spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// The package builder installs and inventories this executable beside node.exe.
const helper = fileURLToPath(new URL('../../bin/mosaic-files.exe', import.meta.url));
export function windowsFile(operation, file, {max = 1024 * 1024, optional = false} = {}) {
  const read = operation === 'read' || operation === 'read-private';
  const args = read ? [operation, file, String(max)] : [operation, file];
  return new Promise((resolve, reject) => {
    execFile(helper, args, {encoding: 'buffer', maxBuffer: Math.max(max, 4096), windowsHide: true},
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        if (optional && error.code === 2) return resolve(null);
        reject(new Error('Windows file operation failed (' + operation + '): ' +
          (stderr?.toString().trim() || error.code), {cause: error}));
      });
  });
}
export function windowsWrite(file, bytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, ['write', file], {windowsHide: true, stdio: ['pipe', 'ignore', 'pipe']});
    let message = '';
    child.stderr.on('data', chunk => { if (message.length < 2048) message += chunk; });
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error('Windows atomic write failed: ' + message.trim())));
    child.stdin.end(bytes);
  });
}

export function windowsFileSync(operation, file, {max = 1024 * 1024, optional = false} = {}) {
  const read = operation === 'read' || operation === 'read-private';
  const args = read ? [operation, file, String(max)] : [operation, file];
  const result = spawnSync(helper, args, {maxBuffer: Math.max(max, 4096), windowsHide: true});
  if (result.error) throw result.error;
  if (result.status === 0) return result.stdout;
  if (optional && result.status === 2) return null;
  throw new Error('Windows file operation failed (' + operation + '): ' + result.stderr.toString().trim());
}
