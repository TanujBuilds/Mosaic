import path from 'node:path';
import { spawn } from 'node:child_process';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { digest, matches, Pause, secretPath } from '../contracts.mjs';
import { createPolicy, validateExecution } from './contracts.mjs';

export const WINDOWS_BACKEND = Object.freeze({ id: 'windows-appcontainer', revision: 1 });
const outputs = ['.overnight-output', 'dist'];
const isolation = (message) => new Pause(message, 'isolation');
const unknown = (message) => Object.assign(isolation(message), { executionOutcome: 'unknown' });
const sha = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const uuid = (value) =>
  typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const exact = (obj, fields) =>
  obj &&
  typeof obj === 'object' &&
  !Array.isArray(obj) &&
  Object.keys(obj).length === fields.length &&
  fields.every((field) => Object.hasOwn(obj, field));
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const inTree = (root, file) => {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
  );
};
const maxFile = 128 * 1024 * 1024;
const maxTree = 512 * 1024 * 1024;
const maxOutput = 256 * 1024;

export function windowsRelativePath(file) {
  if (typeof file !== 'string' || !file || file.length > 4096 || file !== file.normalize('NFC'))
    throw isolation('Invalid Windows input path');
  for (const part of file.split('/')) {
    if (
      !part ||
      part.length > 255 ||
      /[<>:"\\|?*\x00-\x1f\x7f]/u.test(part) ||
      /[. ]$/.test(part) ||
      /~\d/.test(part) ||
      /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[0-9¹²³])(?:\.|$)/iu.test(part)
    )
      throw isolation('Unsafe Windows path component');
  }
  return file;
}

function canonical(file, directory = false) {
  if (typeof file !== 'string' || !/^[A-Za-z]:\\/.test(file) || path.win32.normalize(file) !== file)
    throw isolation('A canonical drive-local Windows path is required');
  const root = path.parse(file).root;
  const parts = file.slice(root.length).split('\\').filter(Boolean);
  if (parts.length) windowsRelativePath(parts.join('/'));
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const s = lstatSync(current, { bigint: true });
    if (
      s.isSymbolicLink() ||
      (index < parts.length - 1 || directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1n)
    )
      throw isolation('Windows path is aliased or has an unexpected file type');
  }
  if (realpathSync.native(file).toLowerCase() !== file.toLowerCase())
    throw isolation('Windows path resolves through an alias');
  return lstatSync(file, { bigint: true });
}

function bytes(file, limit = maxFile) {
  const before = canonical(file);
  if (before.size > BigInt(limit)) throw isolation('Windows input exceeds its byte limit');
  const fd = openSync(file, 'r');
  try {
    const stable = (s) =>
      ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].every((key) => s[key] === before[key]);
    if (!stable(fstatSync(fd, { bigint: true }))) throw isolation('Windows input changed before reading');
    const data = readFileSync(fd);
    if (
      data.length !== Number(before.size) ||
      !stable(fstatSync(fd, { bigint: true })) ||
      !stable(canonical(file))
    )
      throw isolation('Windows input changed while reading');
    return data;
  } finally {
    closeSync(fd);
  }
}

export function validateWindowsRuntime(config, expected) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw isolation('Windows protected checks require Windows x64');
  if (
    !exact(config, ['schema', 'artifactManifestPath', 'artifactManifestSha256']) ||
    config.schema !== 1 ||
    !sha(config.artifactManifestSha256) ||
    (expected !== undefined && expected !== config.artifactManifestSha256)
  )
    throw isolation('Windows native runtime fingerprint mismatch');
  const file = config.artifactManifestPath,
    root = path.dirname(file);
  if (path.basename(file) !== 'artifact-manifest.json')
    throw isolation('Unexpected Windows native artifact manifest path');
  const data = bytes(file, 128 * 1024);
  if (digest(data) !== config.artifactManifestSha256)
    throw isolation('Windows native artifact manifest bytes changed');
  const manifest = JSON.parse(data),
    names = ['node.exe', 'mosaic-windows-supervisor.exe'];
  const source = readFileSync(new URL('windows-supervisor.cpp', import.meta.url));
  if (
    !exact(manifest, [
      'schema',
      'platform',
      'arch',
      'backend',
      'nodeVersion',
      'files',
      'supervisorSourceSha256',
    ]) ||
    manifest.schema !== 1 ||
    manifest.platform !== 'win32' ||
    manifest.arch !== 'x64' ||
    manifest.nodeVersion !== '24.22.3' ||
    !exact(manifest.backend, ['id', 'revision']) ||
    manifest.backend.id !== WINDOWS_BACKEND.id ||
    manifest.backend.revision !== 1 ||
    manifest.supervisorSourceSha256 !== digest(source) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== names.length
  )
    throw isolation('Unsupported Windows native artifact or supervisor source');
  if (readdirSync(root).sort().join('|') !== [...names, 'artifact-manifest.json'].sort().join('|'))
    throw isolation('Unexpected file in pinned Windows check artifact directory');
  const verified = new Map();
  for (const entry of manifest.files) {
    if (
      !exact(entry, ['path', 'sha256', 'bytes']) ||
      !names.includes(entry.path) ||
      verified.has(entry.path) ||
      !sha(entry.sha256) ||
      !positive(entry.bytes) ||
      entry.bytes > maxTree
    )
      throw isolation('Invalid Windows runtime inventory');
    const executable = path.join(root, entry.path),
      content = bytes(executable, maxTree);
    if (content.length !== entry.bytes || digest(content) !== entry.sha256)
      throw isolation('Pinned Windows runtime bytes changed');
    verified.set(entry.path, { executable, sha256: entry.sha256 });
  }
  return {
    platform: 'win32',
    arch: 'x64',
    nodeVersion: manifest.nodeVersion,
    root,
    manifestPath: file,
    manifest,
    fingerprint: config.artifactManifestSha256,
    runtime: verified.get(names[0]),
    supervisor: { ...verified.get(names[1]), protocol: 1 },
    implementationHash: digest([digest(source), digest(readFileSync(new URL(import.meta.url)))]),
  };
}

// Inventory the portable on-disk bytes. NTFS links, junctions and case aliases
// cannot be represented as ordinary staged inputs and are rejected.
export function windowsDependencyInventory(root) {
  canonical(path.dirname(root), true);
  try {
    lstatSync(root);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const value = { schema: 1, present: false, entries: [] };
    return { ...value, hash: digest(value) };
  }
  canonical(root, true);
  const entries = [];
  let total = 0;
  function walk(dir, prefix) {
    const names = new Set();
    for (const name of readdirSync(dir).sort()) {
      const relative = windowsRelativePath(prefix + name),
        lower = name.toUpperCase();
      if (names.has(lower) || entries.length >= 100000)
        throw isolation('Windows dependency inventory collides or exceeds its bound');
      names.add(lower);
      const file = path.join(dir, name),
        stat = lstatSync(file);
      if (stat.isDirectory()) {
        canonical(file, true);
        entries.push({ path: relative, kind: 'directory' });
        walk(file, relative + '/');
      } else {
        const data = bytes(file);
        total += data.length;
        if (total > maxTree) throw isolation('Windows dependency inventory exceeds its byte limit');
        entries.push({ path: relative, kind: 'file', hash: digest(data), bytes: data.length });
      }
    }
  }
  walk(root, '');
  const value = { schema: 1, present: true, entries };
  return { ...value, hash: digest(value) };
}

export function validateWindowsQuiescenceReceipt(receipt, expected) {
  const keys = [
    'schema',
    'type',
    'requestId',
    'bindingHash',
    'helperPid',
    'leaderPid',
    'reason',
    'code',
    'termSignal',
    'activeProcesses',
    'leaderExited',
  ];
  if (
    !exact(receipt, keys) ||
    receipt.schema !== 2 ||
    receipt.type !== 'complete' ||
    !uuid(expected?.requestId) ||
    !sha(expected?.bindingHash) ||
    !positive(expected?.helperPid) ||
    !positive(expected?.leaderPid) ||
    expected.helperPid === expected.leaderPid ||
    !['requestId', 'bindingHash', 'helperPid', 'leaderPid'].every((k) => receipt[k] === expected[k]) ||
    !['exit', 'timeout', 'cancel', 'control-eof', 'output-limit', 'startup-cancel'].includes(
      receipt.reason,
    ) ||
    !Number.isSafeInteger(receipt.code) ||
    receipt.code < 0 ||
    receipt.code > 0xffffffff ||
    receipt.termSignal !== 0 ||
    receipt.activeProcesses !== 0 ||
    receipt.leaderExited !== true
  )
    throw unknown('Windows supervisor did not prove exact Job Object quiescence');
  return receipt;
}

async function inputs(workspace) {
  canonical(workspace.root, true);
  const entries = await workspace.inventory(),
    seen = new Map();
  if (!Array.isArray(entries) || entries.length > 10000)
    throw isolation('Invalid Windows approved input inventory');
  let total = 0;
  for (const item of entries) {
    const name = windowsRelativePath(item.path),
      parts = name.split('/');
    if (
      secretPath(name) ||
      !matches(name, workspace.manifest.permissions.readPaths) ||
      outputs.includes(parts[0].toLowerCase()) ||
      !sha(item.hash)
    )
      throw isolation('Unexpected Windows staged input');
    let prefix = '';
    for (const part of parts) {
      prefix += part;
      const folded = prefix.toUpperCase();
      if (seen.has(folded) && seen.get(folded) !== prefix) throw isolation('Windows approved paths collide');
      seen.set(folded, prefix);
      prefix += '/';
    }
    const file = path.join(workspace.root, name),
      content = bytes(file);
    total += content.length;
    if (total > maxTree || digest(content) !== item.hash)
      throw isolation('Approved Windows input bytes changed or exceeded their bound');
  }
  return entries.map(({ path, hash }) => ({ path, hash }));
}

function preparedEvent(event, owner, binding, pid) {
  return (
    exact(event, ['schema', 'type', 'requestId', 'bindingHash', 'helperPid', 'leaderPid']) &&
    event.type === 'prepared' &&
    event.schema === 1 &&
    event.requestId === owner.requestId &&
    event.bindingHash === binding.bindingHash &&
    event.helperPid === pid &&
    positive(event.leaderPid) &&
    event.leaderPid !== pid
  );
}

async function supervise({ runtime, stage, owner, binding, timeoutMs, signal, revalidate }) {
  if (
    !uuid(owner?.requestId) ||
    !['prepared', 'authorizeGo', 'complete', 'uncertain'].every((k) => typeof owner[k] === 'function') ||
    path.basename(owner.receiptPath) !== 'completion.json' ||
    inTree(stage, owner.receiptPath) ||
    inTree(binding.cwd, owner.receiptPath)
  )
    throw unknown('A private Windows execution owner is required');
  canonical(path.dirname(owner.receiptPath), true);
  try {
    await lstat(owner.receiptPath);
    throw unknown('Windows receipt path must be fresh');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const child = spawn(
    runtime.supervisor.executable,
    [
      owner.requestId,
      binding.bindingHash,
      owner.receiptPath,
      String(timeoutMs),
      stage,
      ...binding.argv.slice(1),
    ],
    {
      cwd: runtime.root,
      windowsHide: true,
      // CreateProcessW resolves an AppContainer's per-user profile from the
      // trusted launcher's LOCALAPPDATA. The supervisor builds an independent
      // environment for the check, using its package storage and staged temp.
      env: { SystemRoot: process.env.SystemRoot, LOCALAPPDATA: process.env.LOCALAPPDATA },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let pending = '',
    diagnostics = '',
    prepared,
    complete,
    failure,
    outputBytes = 0;
  const out = { stdout: [], stderr: [] };
  const cancel = () => {
    if (child.stdin.writable) child.stdin.write('cancel\n');
  };
  child.stdin.on('error', () => {});
  signal?.addEventListener('abort', cancel, { once: true });
  child.stderr.on('data', (chunk) => {
    if (diagnostics.length < 4096) diagnostics += chunk.toString().slice(0, 4096 - diagnostics.length);
  });
  const watchdog = setTimeout(() => {
    child.stdin.destroy();
    child.kill();
  }, timeoutMs + 30000);
  let chain = Promise.resolve();
  async function consume(line) {
    const event = JSON.parse(line);
    if (event.type === 'prepared') {
      if (prepared || !preparedEvent(event, owner, binding, child.pid))
        throw unknown('Windows prepared event identity mismatch');
      prepared = event;
      await owner.prepared(event);
      await revalidate();
      if (signal?.aborted) {
        cancel();
        return;
      }
      const authorization = owner.authorizeGo();
      if (authorization && typeof authorization.then === 'function')
        throw unknown('Windows GO authority must be synchronous');
      child.stdin.write('go\n');
      return;
    }
    if (!prepared || complete) throw unknown('Unexpected Windows supervisor event order');
    if (event.type === 'output') {
      if (
        !exact(event, ['type', 'stream', 'hex']) ||
        !Object.hasOwn(out, event.stream) ||
        typeof event.hex !== 'string' ||
        !/^(?:[0-9a-f]{2}){1,4096}$/.test(event.hex)
      )
        throw unknown('Malformed Windows output event');
      const chunk = Buffer.from(event.hex, 'hex');
      outputBytes += chunk.length;
      if (outputBytes > maxOutput) throw unknown('Windows supervisor exceeded its output limit');
      out[event.stream].push(chunk);
      return;
    }
    validateWindowsQuiescenceReceipt(event, prepared);
    if (digest(JSON.parse(bytes(owner.receiptPath, 4096))) !== digest(event))
      throw unknown('Durable Windows receipt differs from control channel');
    complete = event;
    await owner.complete(event);
  }
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    let pos;
    while ((pos = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, pos);
      pending = pending.slice(pos + 1);
      chain = chain
        .then(() => {
          if (!failure) return consume(line);
        })
        .catch((error) => {
          failure = error;
          child.stdin.end();
        });
    }
    if (pending.length > 12288) {
      failure = unknown('Malformed Windows protocol frame');
      child.stdin.destroy();
    }
  });
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    await chain;
    if (failure) throw failure;
    if (code !== 0 || pending || !complete)
      throw unknown('Windows supervisor exited without proof: ' + diagnostics.trim().slice(-400));
    return {
      code: complete.code,
      stopped: complete.reason !== 'exit',
      quiescence: complete,
      stdout: Buffer.concat(out.stdout).toString(),
      stderr: Buffer.concat(out.stderr).toString(),
    };
  } finally {
    clearTimeout(watchdog);
    signal?.removeEventListener('abort', cancel);
    child.stdin.destroy();
  }
}

export function createWindowsBackend({ workspace, options = {} }) {
  const { nativeCheckRuntime, expectedRuntimeFingerprint, expectedDependencyHash, ownership } = options;
  const runtime = validateWindowsRuntime(nativeCheckRuntime, expectedRuntimeFingerprint);
  const identity = { ...WINDOWS_BACKEND, executable: runtime.supervisor.executable, runtime };
  return {
    identity: () => structuredClone(identity),
    async execute(request) {
      validateExecution(request, workspace);
      if (
        request.argv[0] !== runtime.runtime.executable ||
        !sha(expectedDependencyHash) ||
        typeof ownership?.begin !== 'function'
      )
        throw isolation('Windows checks require exact approved Node, dependency hash and durable ownership');
      const approvedPolicy = await createPolicy(workspace);
      if (digest(approvedPolicy) !== digest(request.permissions))
        throw isolation('Windows execution requires the fresh coordinator policy');
      const inventory = await inputs(workspace),
        depRoot = path.join(workspace.root, 'node_modules'),
        deps = windowsDependencyInventory(depRoot);
      if (deps.hash !== expectedDependencyHash)
        throw isolation('Windows dependencies differ from approved preflight');
      const journal = workspace.journal.dir;
      canonical(journal, true);
      if (
        inTree(workspace.root, journal) ||
        inTree(runtime.root, journal) ||
        inTree(workspace.root, runtime.root) ||
        inTree(runtime.root, workspace.root)
      )
        throw isolation('Windows staging must be separate from the workspace and runtime');
      const stage = await mkdtemp(path.join(journal, 'windows-check-')),
        work = path.join(stage, 'work');
      let owner,
        safeToRemove = true;
      try {
        await mkdir(work);
        await mkdir(path.join(stage, 'inputs'));
        await mkdir(path.join(stage, 'runtime'));
        await copyFile(runtime.runtime.executable, path.join(stage, 'runtime', 'node.exe'));
        for (const name of outputs) await mkdir(path.join(work, name));
        await mkdir(path.join(work, '.overnight-output', 'tmp'));
        const staged = [{ file: path.join(stage, 'runtime', 'node.exe'), hash: runtime.runtime.sha256 }];
        async function put(relative, hash) {
          const destination = path.join(work, relative);
          await mkdir(path.dirname(destination), { recursive: true });
          const data = bytes(path.join(workspace.root, relative));
          if (digest(data) !== hash) throw isolation('Windows source changed during staging');
          await writeFile(destination, data, { flag: 'wx' });
          staged.push({ file: destination, hash });
        }
        for (const file of inventory) {
          await put(file.path, file.hash);
          const view = path.join(stage, 'inputs', file.path);
          await mkdir(path.dirname(view), { recursive: true });
          await copyFile(path.join(work, file.path), view);
          staged.push({ file: view, hash: file.hash });
        }
        if (deps.present) {
          await mkdir(path.join(work, 'node_modules'));
          for (const item of deps.entries) {
            const relative = 'node_modules/' + item.path;
            if (item.kind === 'directory') await mkdir(path.join(work, relative));
            else await put(relative, item.hash);
          }
        }
        const fields = {
          schema: 1,
          backend: { ...WINDOWS_BACKEND },
          argv: [...request.argv],
          cwd: workspace.root,
          profileHash: digest({ policy: approvedPolicy, implementation: runtime.implementationHash }),
          inputInventoryHash: digest(inventory),
          dependencyInventoryHash: deps.hash,
          runtimeFingerprint: runtime.fingerprint,
          runtimeHash: runtime.runtime.sha256,
          supervisorHash: runtime.supervisor.sha256,
        };
        const binding = { ...fields, bindingHash: digest(fields) };
        async function revalidate() {
          if (
            digest(validateWindowsRuntime(nativeCheckRuntime, expectedRuntimeFingerprint)) !==
              digest(runtime) ||
            digest(await inputs(workspace)) !== fields.inputInventoryHash ||
            windowsDependencyInventory(depRoot).hash !== deps.hash ||
            digest(await createPolicy(workspace)) !== digest(approvedPolicy)
          )
            throw isolation('Windows approved execution inputs changed');
          for (const item of staged) {
            if (digest(bytes(item.file, maxTree)) !== item.hash)
              throw isolation('Staged Windows approved bytes changed');
          }
        }
        await revalidate();
        owner = await ownership.begin(binding);
        safeToRemove = false;
        let result;
        try {
          result = await supervise({
            runtime,
            stage,
            owner,
            binding,
            timeoutMs: request.timeoutMs ?? 60000,
            signal: request.signal,
            revalidate,
          });
        } catch (error) {
          await owner.uncertain(String(error.message));
          throw unknown(error.message);
        }
        safeToRemove = true;
        await revalidate();
        if (result.code === 0 && !result.stopped) {
          const check = workspace.manifest.permissions.checks?.find(
            (check) => digest(check.argv) === digest(request.argv),
          );
          for (const relative of check?.screenshots ?? []) {
            windowsRelativePath(relative);
            if (!relative.startsWith('.overnight-output/') || !relative.endsWith('.png'))
              throw isolation('Invalid Windows screenshot path');
            const content = bytes(path.join(work, relative), 16 * 1024 * 1024);
            const dest = await workspace.file(relative);
            canonical(path.dirname(dest), true);
            await writeFile(dest, content, { flag: 'wx' });
          }
        }
        return {
          ...result,
          provenance: {
            ...fields,
            requestId: owner.requestId,
            bindingHash: binding.bindingHash,
            resolvedExecutable: runtime.runtime.executable,
          },
        };
      } finally {
        if (safeToRemove) await rm(stage, { recursive: true, force: true });
      }
    },
  };
}
