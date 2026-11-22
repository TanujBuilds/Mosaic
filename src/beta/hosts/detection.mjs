import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
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

// Check only known file locations. Selection and the MCP connection are separate.
export async function detectCodingApps({ home, isolated }) {
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
