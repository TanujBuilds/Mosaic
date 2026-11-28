import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,realpath,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

const run=promisify(execFile);
const app=process.env.MOSAIC_DESKTOP_TEST_APP;
const archive=process.env.MOSAIC_DESKTOP_TEST_ARCHIVE;
const packaged={skip:!app||!archive ? 'Set MOSAIC_DESKTOP_TEST_APP and MOSAIC_DESKTOP_TEST_ARCHIVE to test an actual macOS runtime and installer.' : false,timeout:160000};

const readJson=async file=>JSON.parse(await readFile(file,'utf8'));

function terminal(launcher,args,env,answers) {
  return new Promise((resolve,reject)=>{
    const child=execFile(launcher,args,{env,cwd:env.HOME,timeout:45000},(error,stdout)=>{
      if(error)reject(error);else resolve(stdout);
    });
    child.stdin.end(answers);
  });
}

test('desktop, terminal setup, host registration and coordinator use one portable installation',packaged,async t=>{
  const appPath=await realpath(app), runtimeRoot=path.join(appPath,'Contents','Resources','runtime');
  const mod=name=>import(pathToFileURL(path.join(runtimeRoot,name)));
  const {connectionAction}=await mod('desktop/macos/connections/index.mjs');
  const {setupPortable}=await mod('src/beta/portable-setup.mjs');
  const {launchAgent}=await mod('src/beta/service.mjs');
  const {client}=await mod('src/beta/client.mjs');
  const {locations,saveJson,hash}=await mod('src/beta/files.mjs');
  const {readSettings,readCredentials}=await mod('src/beta/settings.mjs');
  const {setupComplete}=await mod('src/beta/setup.mjs');
  const home=await realpath(await mkdtemp(path.join(tmpdir(),'mosaic-desktop-connections-')));
  const paths=locations(home,true),context={home,appPath,runtimeRoot,archivePath:archive,isolated:true};
  const env={HOME:home,CODEX_HOME:path.join(home,'.codex'),PATH:process.env.PATH,LANG:'C',DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
  const action=(method,payload={})=>connectionAction(method,payload,context);
  const secret=randomUUID(),reviewerSecret=randomUUID(),rotatedSecret=randomUUID(),unrelatedKey=randomUUID();
  const requests=[];
  const server=createServer((req,res)=>{
    requests.push([req.method,req.url,req.headers.authorization]);
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({data:[{id:'fixture-worker'}]}));
  });
  let service,host;
  const stop=async child=>{
    if(!child || child.exitCode!==null || child.signalCode!==null)return;
    const done=once(child,'exit');
    child.kill('SIGTERM');await done;
  };
  t.after(async()=>{
    await stop(host);await stop(service);
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(home,{recursive:true,force:true});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const baseUrl='http://127.0.0.1:'+server.address().port+'/v1';
  const fresh=await action('settings.get');
  assert.equal(fresh.configured,false);
  assert.deepEqual(await readdir(home),[],'Opening the desktop must not create its own store, login job or installation.');
  const draft={host:'codex',provider:'local',model:'fixture-worker',baseUrl,reviewTarget:'api',
    reviewerModel:'fixture-reviewer',reviewerBaseUrl:baseUrl,revision:fresh.revision};
  await assert.rejects(action('settings.save',{...draft,baseUrl:'https://fixture.invalid/?secret'}),/base URL/);
  assert.deepEqual(await readdir(home),[]);
  const first=await action('settings.save',{...draft,key:secret,reviewerKey:reviewerSecret});
  assert.ok(first.hasKey && first.reviewerHasKey && !first.readOnlyReason);
  assert.deepEqual(requests,[]);
  assert.equal(await setupComplete(paths),true);
  assert.equal((await stat(paths.credentials)).mode&0o777,0o600);
  const saved=await readSettings(paths);
  assert.ok(saved.nativeCheckRuntime.artifactManifestPath.startsWith(paths.versions+path.sep));
  assert.deepEqual(await (await mod('src/beta/package-contract.mjs')).readBundledNativeCheckRuntime(path.join(paths.versions,'0.1.0-beta.240','runtime')),saved.nativeCheckRuntime);
  assert.equal((await readJson(path.join(paths.configDir,'portable-binding.json'))).complete,true);
  assert.equal((await readJson(path.join(paths.configDir,'host-codex-binding.json'))).state,'complete');
  assert.ok(!JSON.stringify([first,saved]).includes(secret) && !JSON.stringify([first,saved]).includes(reviewerSecret));
  assert.equal((await action('worker.test')).ok,true);
  assert.deepEqual(requests,[['GET','/v1/models','Bearer '+secret]]);
  const guide=await terminal(paths.launcher,['connect'],env);
  assert.ok(guide.includes(first.registration));
  // Install a real Codex registration only in this disposable profile.
  await mkdir(env.CODEX_HOME,{recursive:true,mode:0o700});
  await run('codex',['mcp','add','mosaic-beta','--','/usr/bin/false'],{env,cwd:home});
  assert.match((await action('host.connect')).message,/different|disabled/);
  assert.equal(JSON.parse((await run('codex',['mcp','get','mosaic-beta','--json'],{env})).stdout).transport.command,'/usr/bin/false');
  await run('codex',['mcp','remove','mosaic-beta'],{env});
  assert.ok((await action('host.connect')).ok);
  const record=JSON.parse((await run('codex',['mcp','get','mosaic-beta','--json'],{env})).stdout);
  assert.equal(record.transport.command,paths.launcher);
  assert.deepEqual(record.transport.args,['mcp']);
  assert.deepEqual(record.transport.env??{},{});

  const credentials=await readCredentials(paths);
  await saveJson(paths.credentials,{schema:1,entries:{...credentials.entries,[saved.providers[0].credentialRef]:rotatedSecret,'other-private-key':unrelatedKey}});
  await assert.rejects(action('settings.save',{...draft,revision:first.revision}),/changed/);
  const rotated=await action('settings.get');
  assert.notEqual(rotated.revision,first.revision);
  assert.ok(!JSON.stringify(rotated).includes(rotatedSecret));
  // The original installed CLI, separate from the desktop overlay, edits its
  // real private configuration and portable receipts. It keeps existing keys.
  const configFile=path.join(home,'terminal-settings.json');
  const terminalSettings=structuredClone(saved);
  terminalSettings.providers[0].model='terminal-model';
  terminalSettings.providers[0].maxOutputTokens=7777;
  await saveJson(configFile,terminalSettings);
  const cliSave=await terminal(paths.launcher,['setup','--config',configFile],env,'n\nn\ny\n');
  assert.match(cliSave,/Setup saved/);
  const fromTerminal=await action('settings.get');
  assert.equal(fromTerminal.model,'terminal-model');
  await assert.rejects(action('settings.save',{...draft,revision:rotated.revision}),/changed/);
  const changed=await action('settings.save',{...draft,revision:fromTerminal.revision});
  assert.equal((await readSettings(paths)).providers[0].maxOutputTokens,7777);
  assert.equal((await readCredentials(paths)).entries['other-private-key'],unrelatedKey);
  assert.equal((await readCredentials(paths)).entries[saved.providers[0].credentialRef],rotatedSecret);
  assert.ok(changed.hasKey && changed.reviewerHasKey);

  // Start the exact installed service in the foreground in this fixture. A
  // registry call through the registered launcher must reach that same DB.
  service=spawn(paths.launcher,['serve'],{env,cwd:home,stdio:'ignore'});
  const invoke=client(paths,{viewer:true,timeoutMs:500});
  for(let i=0;i<90;i++){
    try{await invoke('tools_list');break;}catch{await delay(100);}
  }
  const ready=await action('settings.get');
  assert.ok(ready.serviceReady);
  assert.equal(ready.firstCallAt,null);
  host=spawn(record.transport.command,record.transport.args,{env,cwd:home,stdio:['pipe','pipe','ignore']});
  const replies=createInterface({input:host.stdout})[Symbol.asyncIterator]();
  let id=0;
  async function call(method,params) {
    host.stdin.write(JSON.stringify({jsonrpc:'2.0',id:++id,method,params})+'\n');
    const reply=JSON.parse((await replies.next()).value);
    assert.equal(reply.id,id);assert.equal(reply.error,undefined);return reply.result;
  }
  assert.equal((await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'packaged-test',version:'1'}})).serverInfo.name,'mosaic-beta');
  host.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  assert.equal((await call('tools/list',{})).tools.some(tool=>tool.name==='service_stop'),false);
  assert.equal((await call('tools/call',{name:'registry_list',arguments:{}})).isError??false,false);
  assert.ok((await action('settings.get')).firstCallAt);
  await stop(host);
  const exited=once(service,'exit');
  await client(paths)('service_stop',{idempotencyKey:randomUUID()});await exited;
  assert.equal((await action('settings.get')).serviceReady,false,'Reading settings never starts a service.');

  // A resumed or advanced terminal setup remains visible without flattening it.
  const advanced=structuredClone(await readSettings(paths));
  advanced.defaults.routing={version:1,defaultWorkerId:advanced.defaults.workerId,rules:[]};
  await saveJson(paths.config,advanced);
  const routed=await action('settings.get');
  assert.match(routed.readOnlyReason,/routing/);
  await assert.rejects(action('settings.save',{...draft,revision:routed.revision}),/Terminal/);
  assert.deepEqual(await readSettings(paths),advanced);
  const other=structuredClone(advanced);
  other.host.id='cursor';await saveJson(paths.config,other);
  const cursor=await action('settings.get');
  assert.equal(cursor.host,'cursor');assert.match(cursor.readOnlyReason,/Cursor/);
  assert.deepEqual(JSON.parse(cursor.registration).mcpServers['mosaic-beta'].args,['mcp']);
  await saveJson(paths.config,{schema:1,codexPath:'/usr/bin/false',worker:{apiKey:secret,profile:{displayName:'Old worker',revision:'r1',model:'legacy',baseUrl,streaming:false}}});
  const legacy=await action('settings.get');
  assert.match(legacy.readOnlyReason,/mosaic migrate/);
  assert.equal(legacy.model,'legacy');assert.ok(legacy.hasKey);assert.ok(!JSON.stringify(legacy).includes(secret));
  await assert.rejects(action('settings.save',{...draft,revision:legacy.revision}),/migrate/);
  assert.equal((await readJson(paths.config)).schema,1);

  // An earlier release may contain an endpoint its newer parser rejects.
  // Detect the release before parsing private identities; keep history visible.
  const oldReceipt=await readJson(paths.installation);
  const unparseable={schema:1,codexPath:'/usr/bin/false',worker:{apiKey:secret,profile:{displayName:'Old worker',
    revision:'r1',model:'legacy',baseUrl:'http://not-loopback.invalid/v1',streaming:false}}};
  await saveJson(paths.config,unparseable);
  await saveJson(paths.installation,{...oldReceipt,version:'0.1.0-beta.6'});
  const historical=path.join(home,'Library','Application Support','Mosaic','state');
  await mkdir(historical,{recursive:true,mode:0o700});
  await saveJson(path.join(historical,'viewer-connection.json'),{});
  const older=await action('settings.get');
  assert.ok(older.configured && older.installedAvailable);
  assert.match(older.readOnlyReason,/0\.1\.0-beta\.6.*0\.1\.0-beta\.240.*official Terminal installer/);
  assert.ok(!JSON.stringify(older).includes(secret));
  await assert.rejects(action('settings.save',{...draft,revision:older.revision}),/official Terminal installer/);
  assert.deepEqual(await readJson(paths.config),unparseable);
  await saveJson(paths.installation,oldReceipt);
  const damaged=await action('settings.get');
  assert.ok(damaged.configured && damaged.installedAvailable);
  assert.match(damaged.readOnlyReason,/mosaic doctor/);

  // Verify that production-style save stages a manual receipt and the exact
  // standard LaunchAgent. The private lifecycle writes only this fixture's
  // plist. It never invokes launchctl or registers another login job.
  await saveJson(paths.config,saved);
  const manual={...paths,isolated:false};
  let starts=0;
  const lifecycle={verifyLaunchAgent:async()=>false,stopForMaintenance:async()=>false,
    startLaunchAgent:async p=>{assert.equal(p.home,home);starts++;await mkdir(path.dirname(p.plist),{recursive:true});await writeFile(p.plist,launchAgent(p));}};
  const target=structuredClone(saved);target.host.id='claude-code';
  await setupPortable(manual,{settings:target,approvedChange:{previousSettings:saved,previousCredentials:await readCredentials(paths),entries:{}},lifecycle});
  assert.equal(starts,1);assert.ok((await readJson(paths.ownership)).complete);
  assert.equal((await readJson(paths.ownership)).launchAgentHash,hash(await readFile(paths.plist)));
  assert.ok((await readJson(path.join(paths.configDir,'portable-binding.json'))).manualHost);
  assert.equal((await readJson(path.join(paths.configDir,'host-claude-code-binding.json'))).state,'manual');
  const claude=await action('settings.get');
  assert.ok((await terminal(paths.launcher,['connect'],env)).includes(claude.registration));
  assert.match(claude.registration,/'claude' 'mcp' 'add' '--transport' 'stdio' '--scope' 'user' 'mosaic-beta' '--' .+ 'mcp'/);
  const osConfig=path.join(home,'.claude.json');
  await assert.rejects(stat(osConfig),{code:'ENOENT'});
  if(process.env.MOSAIC_DESKTOP_TEST_CLAUDE) {
    const cli=path.join(home,'.local','bin','claude');
    await symlink(process.env.MOSAIC_DESKTOP_TEST_CLAUDE,cli);
    const privateEnv={...env,PATH:path.dirname(cli)+':'+env.PATH};
    await run(cli,['mcp','add','--scope','user','mosaic-beta','--','/usr/bin/false'],{env:privateEnv,cwd:home});
    assert.equal((await action('host.connect')).ok,false);
    assert.equal((await readJson(osConfig)).mcpServers['mosaic-beta'].command,'/usr/bin/false');
    await run(cli,['mcp','remove','--scope','user','mosaic-beta'],{env:privateEnv,cwd:home});
    const added=await action('host.connect');
    assert.ok(added.ok,added.message);
    assert.ok((await action('host.connect')).ok);
    const entry=(await readJson(osConfig)).mcpServers['mosaic-beta'];
    assert.equal(entry.command,paths.launcher);assert.deepEqual(entry.args,['mcp']);
    await run(cli,['mcp','remove','--scope','user','mosaic-beta'],{env:privateEnv,cwd:home});
    await run('/bin/sh',['-c',claude.registration],{env:privateEnv,cwd:home});
    assert.deepEqual((await readJson(osConfig)).mcpServers['mosaic-beta'],entry);
  }
  assert.equal(requests.length,1);
  await assert.rejects(stat(path.join(home,'Library','Application Support','Mosaic Preview')),{code:'ENOENT'});
});
