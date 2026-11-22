import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const locations = {
  codex: { commands: ['codex'], apps: [
    'ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    'Codex.app/Contents/Info.plist'
  ] },
  'claude-code': { commands: ['claude'], apps: [] },
  cursor: { commands: ['cursor-agent', 'cursor'], apps: ['Cursor.app/Contents/Info.plist'] },
  antigravity: { commands: ['agy', 'antigravity'], apps: ['Antigravity.app/Contents/Info.plist'] }
};

async function isFile(candidate, mode = constants.F_OK) {
  try {
    await access(candidate, mode);
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

const {win32} = path;
const windowsIds = ['claude-code', 'codex', 'cursor', 'antigravity'];
const localPath = value => typeof value === 'string' && /^[a-z]:[\\/]/i.test(value)
  && !/[\u0000-\u001f\u007f:]/u.test(value.slice(2));
const samePath = (left, right) => win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();

export async function windowsExecutable(file) {
  if (!localPath(file) || win32.extname(file).toLowerCase() !== '.exe') return null;
  try {
    const target = await realpath(file);
    if (!localPath(target) || win32.extname(target).toLowerCase() !== '.exe'
        || [file, target].some(value => /[\\/]node_modules[\\/]\.bin[\\/]/iu.test(value))) return null;
    return (await stat(target)).isFile() ? target : null;
  } catch {
    return null;
  }
}

export async function windowsHostExecutable(id, {home, isolated, env = process.env, resolveExecutable = windowsExecutable}) {
  if (!localPath(home)) return null;
  const local = !isolated && localPath(env.LOCALAPPDATA) ? env.LOCALAPPDATA : win32.join(home, 'AppData', 'Local');
  const programDirs = [win32.join(local, 'Programs')];
  if (!isolated) programDirs.push(...[env.ProgramFiles, env['ProgramFiles(x86)']].filter(localPath));
  const codexHome = !isolated && localPath(env.CODEX_HOME) ? env.CODEX_HOME : win32.join(home, '.codex');
  const codexCurrent = win32.join(codexHome, 'packages', 'standalone', 'current');
  const claudeVersions = win32.join(home, '.local', 'share', 'claude', 'versions');
  const winget = win32.join(local, 'Microsoft', 'WinGet');
  const appNames = {
    'claude-code': ['ClaudeCode\\claude.exe', 'Anthropic\\ClaudeCode\\claude.exe'],
    codex: ['OpenAI\\Codex\\bin\\codex.exe', 'Codex\\codex.exe'],
    cursor: ['cursor\\Cursor.exe'],
    antigravity: ['Antigravity\\Antigravity.exe', 'Antigravity IDE\\Antigravity IDE.exe',
      'Google\\Antigravity\\Antigravity.exe', 'Google\\Antigravity IDE\\Antigravity IDE.exe'],
  };
  if (!Object.hasOwn(appNames, id)) return null;
  const candidates = programDirs.flatMap(dir => appNames[id].map(relative => win32.join(dir, relative)));
  if (id === 'claude-code') {
    candidates.unshift(win32.join(home, '.local', 'bin', 'claude.exe'));
    candidates.push(win32.join(winget, 'Links', 'claude.exe'));
  }
  if (id === 'codex') candidates.push(win32.join(codexCurrent, 'bin', 'codex.exe'),
    win32.join(codexCurrent, 'codex.exe'), win32.join(winget, 'Links', 'codex.exe'));
  for (const file of [...new Set(candidates)]) {
    const target = await resolveExecutable(file);
    if (!localPath(target) || win32.extname(target).toLowerCase() !== '.exe') continue;
    if (samePath(file, target)) return target;
    const relativeTo = root => win32.relative(root, target).toLowerCase();
    if (id === 'claude-code' && samePath(file, win32.join(home, '.local', 'bin', 'claude.exe'))
        && /^[^\\.][^\\]*\.exe$/u.test(relativeTo(claudeVersions))) return target;
    if (id === 'codex' && [win32.join(codexCurrent, 'bin', 'codex.exe'), win32.join(codexCurrent, 'codex.exe')].some(candidate => samePath(file, candidate))
        && /^[a-z0-9._-]+\\(?:bin\\)?codex\.exe$/u.test(relativeTo(win32.join(codexHome, 'packages', 'standalone', 'releases')))) return target;
    if (samePath(file, win32.join(winget, 'Links', id === 'codex' ? 'codex.exe' : 'claude.exe'))) {
      const relative = relativeTo(win32.join(winget, 'Packages'));
      const packageName = id === 'codex' ? 'openai.codex' : 'anthropic.claudecode';
      const [packageDir, ...rest] = relative.split('\\');
      if (packageDir.startsWith(packageName + '_') && rest.length && rest.at(-1) === win32.basename(file).toLowerCase()) return target;
    }
  }
  return null;
}

// Check only known file locations. Selection and the MCP connection are separate.
export async function detectCodingApps({ home, isolated }, {platform = process.platform, env = process.env, resolveExecutable} = {}) {
  if (platform === 'win32') {
    const found = await Promise.all(windowsIds.map(async id =>
      await windowsHostExecutable(id, {home, isolated, env, resolveExecutable}) ? id : null));
    return found.filter(Boolean);
  }
  const bins = [path.join(home, '.local', 'bin')];
  const applicationDirs = [path.join(home, 'Applications')];
  if (!isolated) {
    bins.unshift(...(process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute));
    bins.push('/opt/homebrew/bin', '/usr/local/bin');
    applicationDirs.push('/Applications');
  }
  const found = await Promise.all(Object.entries(locations).map(async ([id, { commands, apps }]) => {
    const checks = [...new Set(bins)].flatMap(dir => commands.map(name => isFile(path.join(dir, name), constants.X_OK)));
    checks.push(...applicationDirs.flatMap(dir => apps.map(file => isFile(path.join(dir, file)))));
    return (await Promise.all(checks)).some(Boolean) ? id : null;
  }));
  return found.filter(Boolean);
}
