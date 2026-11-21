import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,lstat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const project=fileURLToPath(new URL('../',import.meta.url));
const run=(bin,args,input)=>spawnSync(bin,args,{cwd:project,encoding:'utf8',input,timeout:80000});
test('standalone installer verifies integrity, is idempotent and refuses a foreign launcher',async t=>{
 const fixture=await mkdtemp(path.join(os.tmpdir(),'Mosaic beta fixture '));
 t.after(()=>rm(fixture,{recursive:true,force:true}));
 const home=path.join(fixture,'Test User'),dest=path.join(fixture,'package');
 await mkdir(home);
 const built=run(process.execPath,['scripts/package-beta.mjs','--version','0.1.0-beta.98','--output',dest,'--node',process.execPath,'--node-license',path.join(project,'LICENSE'),'--offline','--fixture']);
 assert.equal(built.status,0,built.stderr);
 const stem='mosaic-beta-0.1.0-beta.98-darwin-arm64';
 const archive=path.join(dest,stem+'.tar.gz');
 const listing=run('/usr/bin/tar',['-tzf',archive]);
 assert.equal(listing.status,0,listing.stderr);
 assert.doesNotMatch(listing.stdout,/dashboard|harness_rpc\.py|playwright/);
 const extracted=run('/usr/bin/tar',['-xzf',archive,'-C',fixture]);
 assert.equal(extracted.status,0,extracted.stderr);
 const installer=path.join(fixture,stem,'install'),installArgs=['--home',home,'--no-path'];
 const install=()=>run(installer,installArgs);
 const launcher=path.join(home,'.local','bin','mosaic');
 await mkdir(path.dirname(launcher),{recursive:true});
 await writeFile(launcher,'foreign\n',{mode:0o755});
 const foreign=install();
 assert.notEqual(foreign.status,0);
 assert.match(foreign.stderr,/foreign|existing/i);
 assert.equal(await readFile(launcher,'utf8'),'foreign\n');
 await rm(launcher);
 const first=install();
 assert.equal(first.status,0,first.stderr);
 const plain=`Mosaic Beta 0.1.0-beta.98 installed.\nRun '${launcher}' setup\n`;
 assert.equal(first.stdout,plain);
 const terminalInstall=(columns,{term='xterm-256color',noColor=false}={})=>{
  const env={...process.env,TERM:term};
  delete env.NO_COLOR;
  if(noColor)env.NO_COLOR='';
  const terminal=spawnSync('/usr/bin/script',['-q','/dev/null','/bin/sh','-c',
   '/bin/stty cols "$1" rows 28; shift; exec "$@"','mosaic-install-test',String(columns),installer,...installArgs],
   {cwd:project,encoding:'utf8',env,timeout:80000,stdio:['ignore','pipe','pipe']});
  assert.equal(terminal.status,0,terminal.stdout+terminal.stderr);
  return terminal.stdout.replaceAll('\r\n','\n');
 };
 const receiptOutput=terminalInstall(80);
 assert.match(receiptOutput,/\x1b\[1;94m.*Mosaic Beta/);
 assert.match(receiptOutput,/Installed.*0\.1\.0-beta\.98/);
 const installLocation=path.join(home,'Library','Application Support','Mosaic Beta');
 assert.ok(receiptOutput.includes(installLocation));
 assert.ok(receiptOutput.includes(`'${launcher}' setup\n`));
 for(const fallback of [terminalInstall(30),terminalInstall(80,{term:'dumb'}),terminalInstall(80,{noColor:true})]){
  assert.doesNotMatch(fallback,/\x1b/);
  assert.ok(fallback.endsWith(plain),fallback);
 }
 const again=install();
 assert.equal(again.status,0,again.stderr);
 const help=run(launcher,['--help']);
 assert.equal(help.status,0,help.stderr);
 assert.match(help.stdout,/Mosaic Beta/);
 const setup=run(launcher,['setup']);
 assert.match(setup.stdout+setup.stderr,/Codex CLI|codex login/i);
 assert.match((await lstat(path.join(home,'Library','Application Support','Mosaic Beta'))).mode.toString(8),/700$/);
 const installedVersion=path.join(home,'Library','Application Support','Mosaic Beta','versions','0.1.0-beta.98');
 await rm(installedVersion,{recursive:true});
 const repaired=install();
 assert.equal(repaired.status,0,repaired.stderr);
 assert.equal(run(launcher,['--help']).status,0,'reinstall restores the launcher runtime');
 const codex=path.join(home,'.local','bin','codex');
 await writeFile(codex,'#!/bin/sh\nexit 11\n',{mode:0o755});
 const root=path.join(home,'Library','Application Support','Mosaic Beta'),config=path.join(root,'config','settings.json');
 const reg=path.join(root,'config','isolated-mcp.json');
 const foreignMcp=JSON.stringify({name:'mosaic-beta',enabled:true,transport:{type:'stdio',command:launcher,args:['mcp']}});
 await writeFile(reg,foreignMcp,{mode:0o600});
 const denied=run(launcher,['setup'],'1\ny\n');
 assert.notEqual(denied.status,0);
 assert.match(denied.stderr,/foreign/);
 assert.equal(await readFile(reg,'utf8'),foreignMcp);
 await rm(reg);
 const interrupted=run(launcher,['setup'],'1\n');
 assert.notEqual(interrupted.status,0);
 await assert.rejects(readFile(config),{code:'ENOENT'});
 const configured=run(launcher,['setup'],'1\ny\n');
 assert.equal(configured.status,0,configured.stderr);
 assert.equal((await lstat(config)).mode&0o777,0o600);
 const service=spawn(launcher,['serve'],{stdio:['ignore','pipe','pipe']});
 const closed=once(service,'exit');
 t.after(async()=>{if(service.exitCode===null&&service.signalCode===null){service.kill();await closed;}});
 const connectionPath=path.join(root,'state','connection.json');
 let connection;
 for(let attempt=0;attempt<50;attempt++){
  try{connection=JSON.parse(await readFile(connectionPath,'utf8'));break;}catch{await delay(20);}
 }
 assert.ok(connection);
 assert.equal((await fetch(connection.url+'/observer')).status,404);
 assert.equal((await fetch(connection.url+'/api/invoke',{method:'POST'})).status,401);
 const observer=run(launcher,['status','--once']);
 assert.equal(observer.status,0,observer.stderr);
 assert.match(observer.stdout,/Idle/);
 assert.doesNotMatch(observer.stdout,/\x1b/);
 assert.equal(run(launcher,['doctor']).status,0);
 const mcp=new Client({name:'isolated-beta-test',version:'1'});
 const transport=new StdioClientTransport({command:launcher,args:['mcp'],stderr:'pipe'});
 try{
  await mcp.connect(transport);
  const {tools}=await mcp.listTools();
  assert.ok(tools.some(tool=>tool.name==='goal_prepare'));
  assert.ok(!tools.some(tool=>tool.name.startsWith('research_')));
  const response=await mcp.callTool({name:'goal_prepare',arguments:{idempotencyKey:'fixture-prepare',manifest:{submissionId:'fixture-goal',objective:'Fixture approval',acceptance:['Dry run']}}});
  assert.equal(response.isError,undefined);
  const goal=JSON.parse(response.content[0].text);
  assert.equal(goal.status,'draft');
  assert.equal(goal.manifest.mode.id,'codex_only');
  const block=await fetch(connection.url+'/api/invoke',{method:'POST',headers:{authorization:'Bearer '+connection.token,'content-type':'application/json'},body:JSON.stringify({name:'service_stop',input:{idempotencyKey:'fixture-stop'}})});
  assert.equal(block.status,400);
  assert.match((await block.json()).error,/prepared|active/);
  await mcp.callTool({name:'work_control',arguments:{idempotencyKey:'fixture-stop-goal',goalId:goal.id,action:'stop'}});
 }finally{await mcp.close();}
 service.kill();await closed;
 const oldLauncher=await readFile(launcher,'utf8'),receipt=path.join(root,'config','installation.json');
 const nextStem='mosaic-beta-0.1.0-beta.99-darwin-arm64';
 const next=run(process.execPath,['scripts/package-beta.mjs','--version','0.1.0-beta.99','--output',dest,'--node',process.execPath,'--node-license',path.join(project,'LICENSE'),'--offline','--fixture']);
 assert.equal(next.status,0,next.stderr);
 assert.equal(run('/usr/bin/tar',['-xzf',path.join(dest,nextStem+'.tar.gz'),'-C',fixture]).status,0);
 assert.equal(run('/usr/bin/chflags',['uchg',receipt]).status,0);
 try{
  const failed=run(path.join(fixture,nextStem,'install'),['--home',home,'--no-path']);
  assert.notEqual(failed.status,0);
  assert.equal(await readFile(launcher,'utf8'),oldLauncher);
  await assert.rejects(lstat(path.join(root,'versions','0.1.0-beta.99')),{code:'ENOENT'});
 }finally{assert.equal(run('/usr/bin/chflags',['nouchg',receipt]).status,0);}
 const installed=path.join(home,'Library','Application Support','Mosaic Beta','versions','0.1.0-beta.98','runtime','src','beta','cli.mjs');
 await writeFile(installed,'// tampered\n',{flag:'a'});
 const tampered=install();
 assert.notEqual(tampered.status,0);
 assert.match(tampered.stderr,/checksum|integrity/i);
 assert.equal(run(launcher,['uninstall']).status,0);
 await assert.rejects(lstat(launcher),{code:'ENOENT'});
 assert.ok(await lstat(config));
 assert.ok(await lstat(path.join(root,'state','harness.sqlite3')));
});
