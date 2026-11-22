import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

const exec=promisify(execFile);
const source=fileURLToPath(new URL('../src/',import.meta.url));

test('Windows support bundle preserves private inputs and only publishes new redacted files', {
  skip:process.platform!=='win32',timeout:150000,
},async t=>{
  const base=await realpath(process.env.RUNNER_TEMP||os.tmpdir());
  const fixture=await mkdtemp(path.join(base,'Mosaic support '));
  t.after(()=>rm(fixture,{recursive:true,force:true,maxRetries:5}));
  const runtime=path.join(fixture,'runtime'),bin=path.join(runtime,'bin'),home=path.join(fixture,'home');
  await cp(source,path.join(runtime,'src'),{recursive:true});await mkdir(bin);
  const helper=path.join(bin,'mosaic-files.exe');
  const build=fileURLToPath(new URL('../distribution/win32-files/build.cmd',import.meta.url));
  await exec(process.env.ComSpec,['/d','/s','/c','call "%MOSAIC_BUILD_SCRIPT%" "%MOSAIC_TEST_BINARY%"'],{
    cwd:fixture,windowsHide:true,windowsVerbatimArguments:true,timeout:60000,
    env:{...process.env,MOSAIC_BUILD_SCRIPT:build,MOSAIC_TEST_BINARY:helper},
  });
  const {windowsWrite,windowsFile}=await import(pathToFileURL(path.join(runtime,'src','beta','windows-files.mjs')));
  const beta=path.join(home,'AppData','Local','Mosaic Beta'),config=path.join(beta,'config');
  const state=path.join(beta,'state'),dir=path.join(home,'output');
  for(const name of [home,config,state,dir])await windowsFile('mkdir',name);
  const settings=path.join(config,'settings.json');
  const contents=JSON.stringify({schema:2,host:{id:'codex'},execution:{backend:'windows-appcontainer',backendRevision:1},extra:'PRIVATE_SUPPORT_SENTINEL'});
  await windowsWrite(settings,contents);
  const calls=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const {name}=JSON.parse(Buffer.concat(chunks));
    calls.push({name,correctToken:req.headers.authorization==='Bearer '+'a'.repeat(64)});
    const reply=name==='observer_snapshot'?{version:1,goals:[],tasks:[],agents:[],detail:'PRIVATE_SUPPORT_SENTINEL'}:{events:[]};
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(reply));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const viewer=path.join(state,'viewer-connection.json');
  await windowsWrite(viewer,JSON.stringify({role:'viewer',url:'http://127.0.0.1:'+server.address().port,token:'a'.repeat(64)}));
  const cli=path.join(runtime,'src','beta','cli.mjs');
  const run=(...args)=>exec(process.execPath,[cli,'support-bundle','--home',home,...args],{
    cwd:fixture,timeout:18000,maxBuffer:512*1024,windowsHide:true,
  });
  const file=path.join(dir,'bundle.json'),first=await run('--output',file);
  const bundle=JSON.parse(first.stdout);
  assert.equal(bundle.local.settings.executionBackend,'windows-appcontainer');
  assert.equal(bundle.collection.status,'available');
  assert.deepEqual(calls.map(call=>call.name),['observer_snapshot','observer_timeline']);
  assert.ok(calls.every(call=>call.correctToken));
  assert.doesNotMatch(first.stdout,/PRIVATE_SUPPORT_SENTINEL|a{64}|127\.0\.0\.1/);
  assert.ok(!first.stdout.includes(home));
  assert.equal((await windowsFile('read-private',file)).toString(),first.stdout);
  const existing='keep previous output';await writeFile(file,existing);
  await assert.rejects(run('--output',file),error=>error.code===2&&error.stderr.includes('OUTPUT_EXISTS'));
  assert.equal(await readFile(file,'utf8'),existing);
  const concurrent=path.join(dir,'concurrent.json');
  const results=await Promise.allSettled([run('--output',concurrent),run('--output',concurrent)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected')?.reason.code,2);
  assert.match(results.find(r=>r.status==='rejected').reason.stderr,/OUTPUT_EXISTS/);
  assert.equal(await readFile(concurrent,'utf8'),results.find(r=>r.status==='fulfilled').value.stdout);
  const alias=path.join(home,'aliased-output');await symlink(dir,alias,'junction');
  await assert.rejects(run('--output',path.join(alias,'escape.json')),error=>error.code===2&&error.stderr.includes('OUTPUT_UNSAFE'));
  await assert.rejects(readFile(path.join(dir,'escape.json')),{code:'ENOENT'});
  const icacls=path.join(process.env.SystemRoot,'System32','icacls.exe');
  for(const name of [viewer,settings,dir])await exec(icacls,[name,'/grant','*S-1-1-0:R']);
  const bad=JSON.parse((await run()).stdout);
  assert.equal(bad.local.settings.state,'invalid');assert.equal(bad.collection.viewerCalls,0);
  assert.ok(bad.diagnostics.includes('VIEWER_CONNECTION_UNSAFE'));
  await assert.rejects(run('--output',path.join(dir,'unsafe.json')),error=>error.code===2&&error.stderr.includes('OUTPUT_UNSAFE'));
  assert.equal(await readFile(settings,'utf8'),contents);
});
