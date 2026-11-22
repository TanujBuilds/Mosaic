import { spawn } from 'node:child_process';

export function command(argv, { cwd, env = process.env, timeoutMs = 60_000, signal, input, raw = false, maxBuffer = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Interrupted'));
    const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: process.platform !== 'win32', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stopped = false, forceTimer, closed = false, exitCode, escalated = false;
    const captured = {stdout: [], stderr: []};
    let bytes = 0;
    if (input !== undefined) child.stdin.on('error', () => {}).end(input);
    const kill = signalName => {
      try { process.kill(-child.pid, signalName); } catch { child.kill(signalName); }
    };
    const finish = () => {
      if (!closed || stopped && !escalated) return;
      clean();
      const stdout = Buffer.concat(captured.stdout), stderr = Buffer.concat(captured.stderr);
      resolve({ code: exitCode, stdout: raw ? stdout : stdout.toString('utf8'), stderr: raw ? stderr : stderr.toString('utf8'), stopped });
    };
    const stop = () => {
      if (stopped) return;
      stopped = true; kill('SIGTERM');
      // A parent may exit while ignored-stdio descendants still own the group.
      // Retain escalation through parent close and wait for it before returning.
      // Descendants which create another session remain outside this guarantee.
      forceTimer = setTimeout(() => {
        kill('SIGKILL');
        const deadline = Date.now() + 2000;
        const groupExited = () => {
          if (process.platform !== 'win32') {
            try { process.kill(-child.pid, 0); }
            catch (error) {
              if (error.code === 'ESRCH') { escalated = true; finish(); return; }
              // Darwin can report EPERM while a dying group's membership is
              // being removed. It is not proof of exit: retry, then fail closed.
              if (!['EPERM', 'EACCES'].includes(error.code)) { clean(); reject(error); return; }
            }
            if (Date.now() >= deadline) { clean(); reject(new Error('Stopped command process group did not exit after SIGKILL')); return; }
            forceTimer = setTimeout(groupExited, 10); return;
          }
          escalated = true; finish();
        };
        groupExited();
      }, 2000);
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    const collect = field => chunk => {
      const available = maxBuffer - bytes;
      if (available > 0) {
        const retained = chunk.subarray(0, available);
        captured[field].push(retained);
        bytes += retained.length;
      }
      if (chunk.length > available) stop();
    };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    const clean = () => { clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', stop); };
    child.once('error', error => { clean(); reject(error); });
    child.once('close', code => { closed = true; exitCode = code; finish(); });
  });
}
