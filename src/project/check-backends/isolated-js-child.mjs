import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {posix} from 'node:path';
import {parentPort, workerData} from 'node:worker_threads';
import {EvalFlags, QuickJS} from 'quickjs-wasi';

const sha256 = 'c0bd8f296e18cf074969f6401b9ecb72609a1323818ec2b9bf7a8f8d740d1363';
const data = await readFile(new URL(import.meta.resolve('quickjs-wasi/quickjs.wasm')));
if (createHash('sha256').update(data).digest('hex') !== sha256)
  throw new Error('Unexpected JavaScript check runtime bytes');
const {entry, modules, timeoutMs} = workerData;
const inventory = new Map(modules);
const deadline = performance.now() + timeoutMs;
let unhandled = false;
const vm = await QuickJS.create({
  wasm:data,
  memoryLimit:32 * 1024 * 1024,
  interruptHandler:() => performance.now() >= deadline,
  onUnhandledRejection:(_promise, _reason, isHandled) => { if (!isHandled) unhandled = true; },
  wasi:() => ({fd_write:() => 8}),
  moduleLoader:{
    normalize(base, specifier) {
      if (!specifier.startsWith('./') && !specifier.startsWith('../'))
        return '<unavailable>';
      return posix.join(posix.dirname(base), specifier);
    },
    load(name) {
      return inventory.get(name) ?? "throw 'Module is outside the approved input inventory';";
    },
  },
});
let status = 'failed';
try {
  const evaluation = vm.evalCode(inventory.get(entry), entry, EvalFlags.TYPE_MODULE);
  try {
    const result = await vm.resolvePromise(evaluation);
    if ('value' in result) {
      result.value.dispose();
      status = unhandled ? 'failed' : 'passed';
    } else {
      result.error.dispose();
    }
  } finally {
    evaluation.dispose();
  }
} finally {
  vm.dispose();
}
parentPort.postMessage(status);
