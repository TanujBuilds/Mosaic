import {open} from 'node:fs/promises';
import {runIsolatedJavaScript} from './isolated-js.mjs';

const maxPayload = 13 * 1024 * 1024;
try {
  const file = await open(new URL('../inputs/check.json', import.meta.url), 'r');
  let payload;
  try {
    const {size} = await file.stat();
    if (size > maxPayload) throw new Error('Oversized input');
    payload = JSON.parse(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
  // This line is emitted by the pinned host program, independently of guest JS.
  process.stdout.write('ready\n');
  const result = await runIsolatedJavaScript(payload.entry, payload.modules, {timeoutMs:payload.timeoutMs});
  process.stdout.write(result + '\n');
  process.exitCode = result === 'passed' ? 0 : 1;
} catch {
  process.stderr.write('Protected JavaScript runner failed to initialize or finish.\n');
  process.exitCode = 2;
}
