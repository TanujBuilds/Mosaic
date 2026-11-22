import {Worker} from 'node:worker_threads';

const maxBytes = 2 * 1024 * 1024;
const modulePath = /^(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.m?js$/u;

export async function runIsolatedJavaScript(entry, modules, {signal, timeoutMs = 5000} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new Error('Invalid JavaScript check deadline');
  if (!Array.isArray(modules) || modules.length > 128) throw new Error('Invalid JavaScript check inventory');
  const names = new Set();
  let bytes = 0;
  for (const [name, source] of modules) {
    if (typeof name !== 'string' || !modulePath.test(name) || names.has(name.toLowerCase()) ||
        typeof source !== 'string' || source.includes('\0'))
      throw new Error('Invalid JavaScript check inventory entry');
    names.add(name.toLowerCase());
    bytes += Buffer.byteLength(name) + Buffer.byteLength(source);
  }
  if (bytes > maxBytes || !modules.some(([name]) => name === entry))
    throw new Error('JavaScript check entry is missing or inventory exceeds its size limit');
  if (signal?.aborted) return 'cancelled';

  const worker = new Worker(new URL('./isolated-js-child.mjs', import.meta.url), {
    workerData:{entry, modules, timeoutMs},
    execArgv:[],
    env:{},
    resourceLimits:{maxOldGenerationSizeMb:64, stackSizeMb:4},
  });
  return new Promise((resolve, reject) => {
    let result, error;
    const stop = outcome => {
      if (result === 'timed_out' || result === 'cancelled') return;
      result = outcome;
      worker.terminate().catch(failure => { error = failure; });
    };
    const cancel = () => stop('cancelled');
    const timer = setTimeout(() => stop('timed_out'), timeoutMs);
    signal?.addEventListener('abort', cancel, {once:true});
    worker.on('message', outcome => {
      if (!result && ['passed','failed'].includes(outcome)) result = outcome;
    });
    worker.once('error', failure => { error = failure; });
    worker.once('exit', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (error) return reject(error);
      if (result === 'timed_out' || result === 'cancelled' || (result && code === 0)) return resolve(result);
      reject(new Error('Isolated JavaScript runner did not return a valid result'));
    });
  });
}
