import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
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

test('module inventory rejects duplicate, invalid and oversized entries before starting', {skip:!qualified}, async () => {
  await assert.rejects(runIsolatedJavaScript(entry, [[entry,''],[entry,'']]), /inventory/i);
  await assert.rejects(runIsolatedJavaScript(entry, [[entry,''],['../outside.mjs','']]), /inventory/i);
  await assert.rejects(runIsolatedJavaScript(entry, [[entry,' '.repeat(2**21)]]), /inventory/i);
});
