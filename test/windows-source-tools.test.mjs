import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {appendFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const src = fileURLToPath(new URL('../src/', import.meta.url));
async function temporary(t) {
  const dir = await mkdtemp(path.join(await realpath(process.env.RUNNER_TEMP || os.tmpdir()), 'Mosaic source '));
  const children = [];
  t.after(async () => {
    try {await Promise.all(children.map(child => child.close()));}
    finally {await rm(dir, {recursive:true, force:true, maxRetries:5});}
  });
  return {dir, children};
}
function command(file, args, cwd) {
  return exec(process.execPath, [file, ...args], {cwd, windowsHide:true, timeout:15000});
}
async function start(fixture, file, args) {
  const cwd = fixture.dir;
  const child = spawn(process.execPath, [file, ...args], {cwd, windowsHide:true, stdio:['ignore','pipe','pipe']});
  const exited = once(child, 'exit');
  const lines = createInterface({input:child.stdout});
  let stderr = '';
  child.stderr.on('data', bytes => {stderr += bytes;});
  fixture.children.push({close: async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    lines.close();
  }});
  let timer;
  try {
    const line = await Promise.race([
      once(lines, 'line').then(([line]) => line),
      exited.then(() => {throw Error('Service exited before readiness: ' + stderr);}),
      new Promise((_,reject) => {timer=setTimeout(() => reject(Error('Timed out awaiting readiness')),15000);}),
    ]);
    return {line, exited};
  } finally {clearTimeout(timer);}
}

test('source demo, dashboard, project status and queue operate in a directory with spaces', async t => {
  const fixture = await temporary(t), cwd = fixture.dir;
  const data = path.join(cwd, '.data');
  const run = (entry, args) => command(path.join(src,entry), args, cwd);
  const demo = await run('demo.mjs', ['Write a fixture']);
  const jobId = /Job ([0-9a-f-]{36}): accepted/.exec(demo.stdout)?.[1];
  assert.ok(jobId, demo.stdout);
  const dashboard = await start(fixture, path.join(src,'dashboard.mjs'), ['--data-dir',data,'--port','0']);
  const url = /http:\/\/127\.0\.0\.1:\d+/.exec(dashboard.line)?.[0];
  assert.ok(url, dashboard.line);
  const response = await fetch(url + '/api/jobs/' + jobId);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).job.id, jobId);
  const page = await (await fetch(url + '/')).text();
  assert.match(page, /<title>Mosaic · Job timeline<\/title>/u);
  assert.doesNotMatch(page, /Mac coordinator|On this Mac|both Sparks/u);
  const log = path.join(data,'jobs',jobId+'.jsonl');
  const events = (await readFile(log,'utf8')).trim().split('\n');
  const screenshot = 'result.png';
  const check = {id:'screen',passed:true,screenshots:[path.win32.join('C:', 'saved', screenshot)]};
  await appendFile(log,JSON.stringify({jobId,sequence:events.length+1,type:'operation.completed',
    at:new Date().toISOString(),data:{key:'stage/attempt/checks',value:[check]}})+'\n');
  const artifacts = path.join(data,'artifacts',jobId);
  await mkdir(artifacts,{recursive:true});
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64');
  await writeFile(path.join(artifacts,screenshot),png);
  const attachment = await fetch(url+'/api/artifacts/'+jobId+'/'+screenshot);
  assert.equal(attachment.status,200);
  assert.deepEqual(Buffer.from(await attachment.arrayBuffer()),png);
  assert.equal((await fetch(url+'/api/artifacts/'+jobId+'/unlisted.png')).status,404);
  const project = randomUUID(), manifest = {mode:'fake',limits:{attempts:1},planVersion:1,plan:{stages:[]}};
  await writeFile(path.join(data,'jobs',project+'.jsonl'), JSON.stringify({
    jobId:project,sequence:1,type:'project.created',data:manifest,at:new Date().toISOString(),
  })+'\n');
  const status = await run('project-cli.mjs', ['status','--job',project,'--data-dir',data,'--json']);
  assert.equal(JSON.parse(status.stdout).status, 'awaiting_approval');
  for (const action of ['init','status']) {
    const args = [action,'--data-dir',data,'--json'];
    if (action === 'init') args.push('--fake');
    assert.equal(JSON.parse((await run('task-queue-cli.mjs',args)).stdout).mode, 'fake');
  }
});

test('Windows core creates and consumes private records with the packaged file helper', {
  skip:process.platform!=='win32', timeout:150000,
}, async t => {
  const fixture = await temporary(t), cwd = fixture.dir;
  const runtime = path.join(cwd,'fixture'), state = path.join(cwd,'state');
  const cli = path.join(runtime,'src','harness','cli.mjs');
  await cp(src, path.join(runtime,'src'), {recursive:true});
  await mkdir(path.join(runtime,'bin'));
  // A plain source checkout can display help, but cannot mint credentials using POSIX modes on Windows.
  assert.match((await command(cli,['--help'],cwd)).stdout,/Mosaic/);
  await assert.rejects(command(cli,['serve','--root',state,'--port','0'],cwd));
  await assert.rejects(readFile(path.join(state,'connection.json')), {code:'ENOENT'});
  const build = fileURLToPath(new URL('../distribution/win32-files/build.cmd',import.meta.url));
  const helper = path.join(runtime,'bin','mosaic-files.exe');
  await exec(process.env.ComSpec, ['/d','/s','/c','call "%MOSAIC_BUILD_SCRIPT%" "%MOSAIC_TEST_BINARY%"'], {
    cwd, windowsVerbatimArguments:true, windowsHide:true, timeout:60000,
    env:{...process.env,MOSAIC_BUILD_SCRIPT:build,MOSAIC_TEST_BINARY:helper},
  });
  const server = await start(fixture,cli,['serve','--root',state,'--port','0']);
  assert.equal(JSON.parse(server.line).status,'ready');
  const {readConnectionRecord,waitClient} = await import(pathToFileURL(path.join(runtime,'src','harness','wait-client.mjs')));
  const record = path.join(state,'connection.json');
  const {token,viewerToken} = await readConnectionRecord(record);
  assert.equal(token.length,64);
  assert.notEqual(viewerToken,token);
  assert.equal((await readConnectionRecord(path.join(state,'viewer-connection.json'))).token,viewerToken);
  await command(cli,['status','--root',state],cwd);
  await command(cli,['stop','--root',state],cwd);
  await server.exited;
  const icacls = path.join(process.env.SystemRoot,'System32','icacls.exe');
  await exec(icacls,[record,'/grant','*S-1-1-0:R']);
  await assert.rejects(readConnectionRecord(record),/Windows file operation failed/);
  await assert.rejects(waitClient(state)('task_get',{taskId:randomUUID()}),{waitReason:'invalid_connection'});
  await assert.rejects(command(cli,['status','--root',state],cwd),/Windows file operation failed/);
});
