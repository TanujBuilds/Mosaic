import os from 'node:os';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {setTimeout as wait} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {client} from '../../runtime/src/beta/client.mjs';
import {entry, locations} from '../../runtime/src/beta/files.mjs';
import {readSettings} from '../../runtime/src/beta/settings.mjs';
import {setupComplete} from '../../runtime/src/beta/setup.mjs';
import {assertMaintenanceIdle, startLaunchAgent, stopForMaintenance} from '../../runtime/src/beta/service.mjs';

const paths = locations(os.homedir());

async function assertCurrentVersion() {
  const version = path.basename(path.resolve(fileURLToPath(new URL('../../', import.meta.url))));
  if (await readFile(path.join(paths.root, 'current-version.txt'), 'utf8') !== version + '\n' ||
      await entry(path.join(paths.root, 'install-intent.json'))) {
    throw Error('The selected Mosaic version changed. Run the verified command again to resume.');
  }
}

async function ensureReady() {
  await assertCurrentVersion();
  if (!await readSettings(paths) || !await setupComplete(paths)) return 3;
  const viewer = client(paths, {viewer: true, timeoutMs: 1_000});
  const check = async () => {
    try {
      const tools = await viewer('tools_list');
      return Array.isArray(tools) && tools.some(tool => tool.name === 'observer_snapshot');
    } catch { return false; }
  };
  if (await check()) return 0;
  await startLaunchAgent(paths);
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    if (await check()) return 0;
    await wait(250);
  }
  throw Error('Mosaic is installed, but its authenticated coordinator did not become ready. Rerun setup or the verified install.');
}

try {
  if (process.argv.length !== 3) throw Error('Invalid installation lifecycle command');
  switch (process.argv[2]) {
    case 'prepare-update':
    case 'prepare-uninstall':
      await assertMaintenanceIdle(paths, {settingsChange: process.argv[2] === 'prepare-update'});
      await stopForMaintenance(paths, {recovering: true});
      await assertMaintenanceIdle(paths, {offline: true});
      break;
    case 'setup-state': {
      await assertCurrentVersion();
      const settings = await readSettings(paths);
      process.exitCode = settings?.schema === 1 || await entry(path.join(paths.configDir, 'migration-intent.json')) ? 4 :
        settings && await setupComplete(paths) ? 0 : 3;
      break;
    }
    case 'coding-status': {
      const {windowsCodingHold}=await import('../../runtime/src/project/check-backends/platform-native-runtime.mjs');
      if(windowsCodingHold){process.stdout.write(windowsCodingHold+'\n');process.exitCode=3;}
      break;
    }
    case 'ensure-ready':
      process.exitCode = await ensureReady();
      break;
    default:
      throw Error('Invalid installation lifecycle command');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
