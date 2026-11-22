import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { executionPolicyInputSchema } from '../src/harness/contracts.mjs';
import {
  assertExecutionAvailable,
  isNativeExecution,
  normalizeExecutionPolicy,
  sameExecutionBackend,
} from '../src/harness/execution.mjs';
import { ExecutionOwnership } from '../src/harness/execution-ownership.mjs';

const fingerprint = 'a'.repeat(64);
const windows = {
  version: 1,
  backend: 'windows-appcontainer',
  backendRevision: 1,
  runtimeFingerprint: fingerprint,
};
const darwin = {
  version: 1,
  backend: 'darwin-seatbelt',
  backendRevision: 2,
  runtimeFingerprint: fingerprint,
};

test('Windows dispatch requires its exact revision and fingerprint and keeps Darwin approvals distinct', () => {
  assert.deepEqual(normalizeExecutionPolicy(windows), windows);
  assert.ok(
    executionPolicyInputSchema.anyOf.some(
      (schema) =>
        schema.properties.backend.enum.includes(windows.backend) &&
        schema.required.includes('runtimeFingerprint'),
    ),
  );
  assert.equal(isNativeExecution({ executionPolicy: windows }), true);
  assert.equal(sameExecutionBackend({ executionPolicy: windows }, { executionPolicy: darwin }), false);
  for (const change of [
    { backendRevision: 0 },
    { backendRevision: 2 },
    { runtimeFingerprint: null },
    { runtimeFingerprint: 'A'.repeat(64) },
    { runtimeFingerprint: '1' },
    { executable: 'node.exe' },
  ])
    assert.throws(() => normalizeExecutionPolicy({ ...windows, ...change }), /execution policy/);
  assert.throws(
    () => assertExecutionAvailable({ executionPolicy: process.platform === 'win32' ? darwin : windows }),
    { code: 'isolation' },
  );
});

function manager(bootId) {
  const row = {
    id: randomUUID(),
    status: 'uncertain',
    goalId: 'g',
    helperPid: 20,
    leaderPid: 21,
    binding: { backend: { id: 'windows-appcontainer', revision: 1 } },
    bindingHash: fingerprint,
    bootId: 'win32:' + randomUUID(),
  };
  const rows = new Map([[row.id, structuredClone(row)]]);
  const c = {
    store: {
      tx: (fn) => fn(),
      get: (_type, key) => structuredClone(rows.get(key)),
      put: (_type, value) => rows.set(value.id, structuredClone(value)),
      all: () => [...rows.values()],
    },
    now: () => 100,
    emit: () => {},
  };
  return { row, owner: new ExecutionOwnership(c, { bootId }) };
}

test('Windows execution owner requires Windows Job quiescence with exact physical identity', () => {
  const { row, owner } = manager(null);
  const proof = {
    schema: 2,
    type: 'complete',
    requestId: row.id,
    bindingHash: fingerprint,
    helperPid: 20,
    leaderPid: 21,
    reason: 'exit',
    code: 0,
    termSignal: 0,
    activeProcesses: 0,
    leaderExited: true,
  };
  for (const patch of [
    { schema: 1, groupESRCH: true },
    { activeProcesses: 1 },
    { leaderPid: 999 },
    { bindingHash: 'b'.repeat(64) },
  ])
    assert.throws(() => owner.resolve(row, 'receipt', { ...proof, ...patch }), {
      executionOutcome: 'unknown',
    });
  assert.equal(owner.holds().length, 1);
  assert.equal(owner.resolve(row, 'receipt', proof).status, 'quiescent');
});

test('Windows reboot recovery accepts only two different kernel boot session identifiers', () => {
  const { row, owner } = manager(null);
  for (const unavailable of [
    null,
    row.bootId,
    'darwin:' + randomUUID(),
    'win32:unknown',
    'win32:',
    'win32:00000000-0000-0000-0000-000000000000',
  ]) {
    owner.bootId = unavailable;
    assert.throws(() => owner.resolve(row, 'new_boot'), /positively changed boot/i);
  }
  owner.bootId = 'win32:' + randomUUID();
  assert.equal(owner.resolve(row, 'new_boot').status, 'quiescent');
});

test('every protected Windows policy is held before a check can start', {skip:process.platform!=='win32'}, () => {
  for(const policy of [undefined,windows,{version:1,backend:'codex-sandbox',backendRevision:1}]) {
    assert.throws(()=>assertExecutionAvailable({executionPolicy:policy}), {code:'isolation',message:/filesystem isolation qualification/});
  }
});
