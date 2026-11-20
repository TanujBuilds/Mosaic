import path from 'node:path';
import { canonical, digest } from '../../harness/contracts.mjs';
import { jsonFile, localDirectory, saveJson, withLock } from '../files.mjs';
import { readSettings } from '../settings.mjs';

const receiptFile = paths => path.join(paths.configDir, 'last-host-connection.json');
const hostIdFor = settings => settings?.host?.id ?? 'codex';

export async function readHostConnection(paths) {
  await localDirectory(paths, paths.configDir, { create: false });
  const settings = await readSettings(paths);
  if (!settings) return null;
  const receipt = await jsonFile(receiptFile(paths), { privateFile: true, max: 4096 });
  if (receipt?.schema !== 1 || receipt.hostId !== hostIdFor(settings)
      || receipt.settingsHash !== digest(settings) || !Number.isSafeInteger(receipt.at)
      || receipt.at <= 0 || receipt.at > 8.64e15) return null;
  return { kind: 'registry_call', hostId: receipt.hostId, at: receipt.at };
}

export async function recordHostConnection(paths, expectedSettings) {
  if (!expectedSettings) return;
  await withLock(paths, async () => {
    const settings = await readSettings(paths);
    if (canonical(settings) !== canonical(expectedSettings)) return;
    await saveJson(receiptFile(paths), {
      schema: 1, hostId: hostIdFor(settings), settingsHash: digest(settings), at: Date.now()
    });
  });
}
