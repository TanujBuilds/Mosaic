import path from 'node:path';
import { digest } from '../../harness/contracts.mjs';
import { jsonFile, localDirectory, saveJson, withLock } from '../files.mjs';
import { readSettings } from '../settings.mjs';

const receiptFile = paths => path.join(paths.configDir, 'last-host-connection.json');
export function hostConnectionIdentity(settings) {
  if (settings?.schema !== 2) return null;
  return { hostId: settings.host.id, settingsHash: digest(settings) };
}

export async function readHostConnection(paths) {
  await localDirectory(paths, paths.configDir, { create: false });
  const identity = hostConnectionIdentity(await readSettings(paths));
  if (!identity) return null;
  const receipt = await jsonFile(receiptFile(paths), { privateFile: true, max: 4096 });
  if (receipt?.schema !== 1 || receipt.hostId !== identity.hostId
      || receipt.settingsHash !== identity.settingsHash || !Number.isSafeInteger(receipt.at)
      || receipt.at <= 0 || receipt.at > 8.64e15) return null;
  return { kind: 'registry_call', hostId: receipt.hostId, at: receipt.at };
}

export async function recordHostConnection(paths, expectedIdentity) {
  if (!expectedIdentity) return;
  await withLock(paths, async () => {
    const identity = hostConnectionIdentity(await readSettings(paths));
    if (identity?.settingsHash !== expectedIdentity.settingsHash) return;
    await saveJson(receiptFile(paths), {
      schema: 1, ...identity, at: Date.now()
    });
  });
}
