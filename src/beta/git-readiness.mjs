import {execFile} from 'node:child_process';
import {constants} from 'node:fs';
import {access, stat} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {windowsGitProcess} from '../project/windows-git.mjs';

const exec = promisify(execFile);
export const gitRecovery = 'For coding tasks, install Apple Command Line Tools with xcode-select --install. When installation finishes, run ~/.local/bin/mosaic doctor.';
export const windowsGitRecovery = 'Install Git for Windows from https://git-scm.com/download/win, then run mosaic doctor.';

export async function windowsGitReady({inherited, resolveExecutable, run = exec} = {}) {
  try {
    const runtime = windowsGitProcess({inherited, resolveExecutable});
    if (!runtime) return false;
    const {stdout} = await run(runtime.executable, ['--version'], {
      cwd: runtime.cwd, env: runtime.env, windowsHide: true, timeout: 2500, maxBuffer: 4096
    });
    return /^git version \d+\.\d+\.\d+\.windows\.\d+$/iu.test(stdout.trim());
  } catch {
    return false;
  }
}

// The demo uses /usr/bin/git, which can open an installation dialog on a fresh
// Mac. Inspect the selected developer directory without launching the shim.
export async function macGitReady({platform = process.platform, run = exec} = {}) {
  if (platform !== 'darwin') return null;
  try {
    const {stdout} = await run('/usr/bin/xcode-select', ['--print-path'], {
      env: {PATH: '/usr/bin:/bin'}, timeout: 2500, maxBuffer: 4096
    });
    const selected = stdout.trim();
    if (!path.isAbsolute(selected)) return false;
    const git = path.join(selected, 'usr/bin/git');
    await access(git, constants.X_OK);
    return (await stat(git)).isFile();
  } catch {
    return false;
  }
}
