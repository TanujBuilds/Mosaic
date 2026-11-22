import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {runIsolatedJavaScript} from '../src/project/check-backends/isolated-js.mjs';

const qualified = process.env.MOSAIC_ISOLATED_JS_PROBE === '1';
const entry = 'checks/verify.mjs';
const source = 'src/total.mjs';
const check = `import {invoiceTotal} from '../src/total.mjs';
if (invoiceTotal(1250, 250) !== 1500) throw 'include shipping';
if (invoiceTotal(1250, 0) !== 1250) throw 'preserve zero shipping';
`;

test('the same approved check fails on the original Git commit and passes on the corrected commit', {skip:!qualified}, async t => {
  const repo = await mkdtemp(path.join(await realpath(os.tmpdir()), 'Mosaic invoice with spaces '));
  t.after(() => rm(repo, {recursive:true, force:true, maxRetries:5}));
  const gitBytes = (...args) => execFileSync('git', ['-C', repo, ...args], {
    windowsHide:true, env:{...process.env, GIT_CONFIG_NOSYSTEM:'1',
      GIT_CONFIG_GLOBAL:path.join(repo, 'test-global-config')},
  });
  const git = (...args) => gitBytes(...args).toString('utf8').trimEnd();
  const read = (commit, file) => gitBytes('show', commit + ':' + file);
  const evaluate = (commit) => runIsolatedJavaScript(entry, [entry,source].map(file =>
    [file, new TextDecoder('utf-8', {fatal:true}).decode(read(commit,file))]));
  await mkdir(path.join(repo,'checks'));
  await mkdir(path.join(repo,'src'));
  await writeFile(path.join(repo,'.gitattributes'), '* text eol=lf\n');
  await writeFile(path.join(repo,entry), check);
  await writeFile(path.join(repo,source), 'export function invoiceTotal(subtotal) { return subtotal; }\n');
  git('init','-q','--template=');
  git('add','--','.');
  git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Original');
  const base = git('rev-parse','HEAD');
  assert.deepEqual(read(base,entry), Buffer.from(check));
  assert.equal(await evaluate(base), 'failed');
  await writeFile(path.join(repo,source), 'export function invoiceTotal(subtotal, shipping) { return subtotal + shipping; }\n');
  git('add','--',source);
  git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Include shipping');
  const fixed = git('rev-parse','HEAD');
  assert.equal(git('rev-list','--parents','-1','HEAD'), fixed+' '+base);
  assert.equal(git('diff','--name-only',base,fixed), source);
  assert.deepEqual(read(fixed,entry), read(base,entry));
  assert.equal(await evaluate(fixed), 'passed');
});

test('guest receives only module bytes and cannot use host filesystem, network, process or secrets', {skip:!qualified}, async t => {
  const dir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'Mosaic boundary '));
  const hostFile = path.join(dir,'outside.mjs');
  await writeFile(hostFile, 'export default 42');
  t.after(() => rm(dir, {recursive:true, force:true, maxRetries:5}));
  let connected = false;
  const server = createServer(socket => {connected = true;socket.destroy();});
  await new Promise((resolve,reject) => server.once('error',reject).listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const guest = `
    import {value} from '../src/allowed.mjs';
    if (value !== 42) throw 'missing approved source';
    for (const name of ['process', 'require', 'fetch', 'WebSocket', 'Deno', 'Bun', 'std', 'os']) {
      if (globalThis[name] !== undefined) throw 'unexpected capability';
    }
  `;
  assert.equal(await runIsolatedJavaScript(entry, [[entry,guest],['src/allowed.mjs','export const value = 42;']]), 'passed');
  for (const name of ['node:fs','node:net','node:child_process','https://127.0.0.1:'+server.address().port,
    hostFile,'../outside.mjs','../src/ALLOWED.mjs','../src/allowed.mjs:stream']) {
    assert.equal(await runIsolatedJavaScript(entry, [[entry,'import ' + JSON.stringify(name) + ';']]), 'failed', name);
  }
  assert.equal(connected, false);
  assert.equal(await readFile(hostFile, 'utf8'), 'export default 42');
});

test('nonterminating work has a deadline and cancellation awaits termination', {skip:!qualified}, async () => {
  const forever = [[entry, 'while (true) {}']];
  assert.equal(await runIsolatedJavaScript(entry, forever, {timeoutMs:150}), 'timed_out');
  const controller = new AbortController();
  const running = runIsolatedJavaScript(entry, forever, {signal:controller.signal});
  controller.abort();
  assert.equal(await running, 'cancelled');
  assert.equal(await runIsolatedJavaScript(entry, [[entry,'export {};']]), 'passed');
});

test('asynchronous assertions and syntax errors cannot report a false pass', {skip:!qualified}, async () => {
  const run = source => runIsolatedJavaScript(entry, [[entry, source]]);
  assert.equal(await run("Promise.resolve(1).then(value => { if (value !== 2) throw 'wrong'; });"), 'failed');
  assert.equal(await run("if (await Promise.resolve(2) !== 2) throw 'wrong';"), 'passed');
  assert.equal(await run('await new Promise(() => {});'), 'failed');
  assert.equal(await run('const = 1;'), 'failed');
});

test('a check can prove expected promise rejection without hiding a later failure', {skip:!qualified}, async () => {
  const run = source => runIsolatedJavaScript(entry, [[entry, source]]);
  assert.equal(await run("if (await Promise.reject('expected').catch(() => 42) !== 42) throw 'wrong';"), 'passed');
  assert.equal(await run("let ok; try { await Promise.reject('expected'); } catch (reason) { ok = reason === 'expected'; } if (!ok) throw 'wrong';"), 'passed');
  assert.equal(await run("await Promise.reject('expected').catch(() => {}); Promise.reject('unexpected');"), 'failed');
});

test('module inventory rejects duplicate, invalid and oversized entries before starting', {skip:!qualified}, async () => {
  await assert.rejects(runIsolatedJavaScript(entry, [[entry,''],[entry,'']]), /inventory/i);
  await assert.rejects(runIsolatedJavaScript(entry, [[entry,''],['../outside.mjs','']]), /inventory/i);
  await assert.rejects(runIsolatedJavaScript(entry, [[entry,' '.repeat(2**21)]]), /inventory/i);
});

const supervisor = qualified && process.env.MOSAIC_TEST_JS_SUPERVISOR;
const hostProgram = String.raw`
  import {spawn} from 'node:child_process';
  import {createInterface} from 'node:readline';
  import {openSync, closeSync} from 'node:fs';
  const [supervisor, mode, diagnostics, ...args] = process.argv.slice(1);
  const log = openSync(diagnostics, 'wx');
  const child = spawn(supervisor, ['--isolated-js', ...args, String(process.pid)], {
    detached:true, windowsHide:true, stdio:['pipe','pipe',log],
  });
  closeSync(log);
  child.stdin.on('error', () => {});
  const lines = createInterface({input:child.stdout});
  lines.on('line', line => {
    const event = JSON.parse(line);
    process.stdout.write(line + '\n');
    if (event.type === 'prepared' && mode !== 'before-go') child.stdin.write('go\n');
  });
  child.on('close', code => { process.exitCode = code; });
`;

async function nativeTrial(t, {guest, crash, timeoutMs = 4000}) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'Mosaic JS Job '));
  t.after(() => rm(root, {recursive:true, force:true, maxRetries:8, retryDelay:200}));
  const stage = path.join(root, 'staging'), runtime = path.join(stage, 'runtime'), inputs = path.join(stage, 'inputs');
  const receipts = path.join(root, 'receipts'), completion = path.join(receipts, 'completion.json');
  await Promise.all([mkdir(path.join(runtime, 'node_modules'), {recursive:true}), mkdir(inputs, {recursive:true}),
    mkdir(path.join(stage, 'work', '.overnight-output', 'tmp'), {recursive:true}), mkdir(receipts)]);
  await Promise.all([
    copyFile(process.execPath, path.join(runtime, 'node.exe')),
    cp(path.dirname(fileURLToPath(import.meta.resolve('quickjs-wasi/package.json'))),
      path.join(runtime, 'node_modules', 'quickjs-wasi'), {recursive:true}),
    ...['isolated-js-program.mjs','isolated-js.mjs','isolated-js-child.mjs'].map(name =>
      copyFile(new URL('../src/project/check-backends/' + name, import.meta.url), path.join(runtime, name))),
  ]);
  const payload = JSON.stringify({entry, modules:[[entry,guest]], timeoutMs});
  await writeFile(path.join(inputs, 'check.json'), payload);
  const requestId = randomUUID(), bindingHash = createHash('sha256').update(payload).digest('hex');
  const controller = spawn(process.execPath, ['--input-type=module', '-e', hostProgram,
    supervisor, crash ?? 'none', path.join(root,'supervisor-errors.txt'), requestId, bindingHash, completion, String(timeoutMs + 2000), stage],
  {stdio:['ignore','pipe','pipe'], windowsHide:true});
  const closed = once(controller,'close');
  const lines = createInterface({input:controller.stdout});
  let prepared, stderr = '', stdout = '', guestErrors = '';
  controller.stderr.on('data', bytes => { stderr += bytes; });
  for await (const line of lines) {
    const event = JSON.parse(line);
    if (event.type === 'prepared') {
      prepared = event;
      if (crash === 'before-go') assert.ok(controller.kill());
    } else if (event.type === 'output' && event.stream === 'stdout') {
      stdout += Buffer.from(event.hex, 'hex').toString('utf8');
      if (crash === 'running' && stdout === 'ready\n') assert.ok(controller.kill());
    } else if (event.type === 'output') {
      guestErrors += Buffer.from(event.hex, 'hex').toString('utf8');
    }
  }
  const [code] = await closed;
  if (!crash) assert.equal(code,0,stderr);
  assert.ok(prepared,stderr);
  let receipt;
  const deadline = Date.now() + 12000;
  while (!receipt) {
    try { receipt = JSON.parse(await readFile(completion,'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT' || Date.now() >= deadline) {
        const diagnostics = await readFile(path.join(root,'supervisor-errors.txt'), 'utf8').catch(() => '');
        throw Error('Missing completion after ' + crash + ': ' + diagnostics + guestErrors, {cause:error});
      }
      await delay(50);
    }
  }
  assert.equal(receipt.requestId, requestId);
  assert.equal(receipt.bindingHash, bindingHash);
  assert.equal(receipt.helperPid, prepared.helperPid);
  assert.equal(receipt.leaderPid, prepared.leaderPid);
  assert.equal(receipt.activeProcesses, 0);
  assert.equal(receipt.leaderExited, true);
  return {receipt, stdout, guestErrors};
}

test('native Windows Job returns exact zero-process receipts for good and failed checks', {
  skip:!supervisor, timeout:90000,
}, async t => {
  const good = await nativeTrial(t,{guest:'export {};'});
  assert.equal(good.stdout, 'ready\npassed\n', JSON.stringify(good));
  assert.equal(good.receipt.code,0);
  assert.equal(good.receipt.reason,'exit');
  const bad = await nativeTrial(t,{guest:"throw 'Check failed';"});
  assert.equal(bad.stdout, 'ready\nfailed\n');
  assert.equal(bad.receipt.code,1);
  assert.equal(bad.receipt.reason,'exit');
});

test('native Windows Job records quiescence after real controller death before and after GO', {
  skip:!supervisor, timeout:90000,
}, async t => {
  for (const crash of ['before-go','running']) {
    const run = await nativeTrial(t,{guest:'while (true) {}', crash, timeoutMs:12000});
    assert.equal(run.receipt.reason,'control-eof');
    assert.equal(run.stdout, crash === 'running' ? 'ready\n' : '');
  }
});
