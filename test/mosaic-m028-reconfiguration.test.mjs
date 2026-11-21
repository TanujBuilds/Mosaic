import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {Readable,Writable,PassThrough} from 'node:stream';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {locations,privateDirectories,saveJson} from '../src/beta/files.mjs';
import {normalizeSettings,readSettings} from '../src/beta/settings.mjs';
import {doctor,setup,setupComplete} from '../src/beta/setup.mjs';
import {setupPortable} from '../src/beta/portable-setup.mjs';
import {Coordinator} from '../src/harness/coordinator.mjs';

// Disposable registration, executable and provider identities are fixtures only.
const fingerprint='a'.repeat(64);
const runtime={execution:{backend:'darwin-seatbelt',backendRevision:2,runtimeFingerprint:fingerprint},nativeCheckRuntime:{schema:1,artifactManifestPath:'/fixture/retained-version/check-artifact/artifact-manifest.json',artifactManifestSha256:fingerprint}};
function profile(id='worker',credentialRef='worker-key'){
 return {schema:1,id,revision:'r1',displayName:'Fixture worker',transport:'openai-chat',baseUrl:'http://127.0.0.1:1/v1',model:'fixture-model',roles:['worker'],capabilities:{workerProtocol:'mosaic-structured-v1',transports:['json'],modelDiscovery:'manual',taskKinds:['coding','consult']},maxContextTokens:null,maxOutputTokens:12000,concurrency:1,capacityGroup:id,credentialRef,streaming:false};
}
function settings({native=false,workers=true}={}){
 return normalizeSettings({schema:2,host:{id:'cursor',options:{}},providers:workers?[profile()]:[],defaults:{workerId:workers?'worker':null,plannerWorkerId:workers?'worker':null,review:{source:'host',hostId:'cursor'}},...(native?runtime:{execution:{backend:'codex-sandbox',backendRevision:1},codexPath:process.execPath}),serviceMaxConcurrentTasks:1,capacityGroups:workers?[{id:'worker',limit:1}]:[]});
}
async function fixture(t,{native=true}={}){
 const home=await mkdtemp(path.join(os.tmpdir(),'Mosaic wave01 reconfiguration '));t.after(()=>rm(home,{recursive:true,force:true}));
 const paths=locations(home,true);await privateDirectories(paths);await mkdir(path.dirname(paths.launcher),{recursive:true});await writeFile(paths.launcher,'#!/bin/sh\nexit 0\n',{mode:0o755});
 const old=settings({native});await writeFile(paths.config,'  '+JSON.stringify(old)+'\n\n',{mode:0o600});await writeFile(paths.credentials,' '+JSON.stringify({schema:1,entries:{'worker-key':'dummy-original-wave01',retained:'dummy-unrelated-wave01'}})+'\n\n',{mode:0o600});
 const host=path.join(home,'.cursor','mcp.json');await mkdir(path.dirname(host),{recursive:true});await writeFile(host,'{ "theme": "dark", "mcpServers": {"unrelated": {"command": "keep"}} }\n',{mode:0o600});
 return {paths,old,host};
}
const bytes=files=>Promise.all(files.map(file=>readFile(file)));
async function noIntent(paths){for(const file of [paths.setupIntent,path.join(paths.configDir,'setup-credentials.json')])await assert.rejects(readFile(file),{code:'ENOENT'});}
function advanced({key='n',secret='dummy-replacement-wave01',apply='y',model='replacement-model',url='http://127.0.0.1:1/v1',onAsk=async()=>{}}={}){
 let text='',questions=0;
 return {output:{write:value=>{text+=value;}},text:()=>text,ask:async(prompt,options)=>{
  text+=prompt;await onAsk(prompt,++questions);
  if(/Choose host/.test(prompt))return '3';if(/Number of already-running/.test(prompt))return '1';if(/Profile 1 identifier/.test(prompt))return 'worker';if(/Display name/.test(prompt))return 'Fixture worker';if(/API base URL/.test(prompt))return url;if(/Model ID/.test(prompt))return model;if(/require an API bearer key/.test(prompt))return key;if(options?.secret)return secret;
  if(/separately configured/.test(prompt))return 'n';if(/Service maximum/.test(prompt))return '1';if(/optional model discovery|optional inference/.test(prompt))return 'n';if(/Apply this exact|Save this local/.test(prompt))return apply;throw Error('Unexpected fixture question: '+prompt);
 }};
}
const run=(paths,io,options={})=>setupPortable(paths,{...io,...runtime,verifyExecution:()=>{},...options});

for(const kind of ['credentials','settings'])test(`early ${kind} rotation during configuration aborts before preflight or stale summary`,async t=>{
 const {paths,old,host}=await fixture(t),beforeHost=await readFile(host),beforeConfig=await readFile(paths.config);let rotated;
 const io=advanced({key:'y',onAsk:async prompt=>{if(/Model ID/.test(prompt)){
  rotated=kind==='credentials'?{schema:1,entries:{'worker-key':'dummy-concurrent-wave01',retained:'dummy-unrelated-wave01'}}:{...old,serviceMaxConcurrentTasks:2};
  await saveJson(kind==='credentials'?paths.credentials:paths.config,rotated);
 }}});let preflight=false;
 await assert.rejects(run(paths,io,{execution:old.execution,nativeCheckRuntime:old.nativeCheckRuntime,verifyExecution:()=>{preflight=true;}}),/Settings or credentials changed while preview was open/);
 assert.equal(preflight,false);assert.deepEqual(JSON.parse(await readFile(kind==='credentials'?paths.credentials:paths.config)),rotated);assert.deepEqual(await readFile(host),beforeHost);if(kind==='credentials')assert.deepEqual(await readFile(paths.config),beforeConfig);
 assert.doesNotMatch(io.text(),/Mosaic setup summary|Exact private setup preview|optional model discovery/);await noIntent(paths);
});

for(const key of ['','k'])test(`explicit ${key?'keep':'empty replacement'} key choice cannot silently remove or reuse the wrong key`,async t=>{
 const {paths,old,host}=await fixture(t),before=await bytes([paths.config,paths.credentials,host]),io=advanced({key:key?'k':'y',secret:'',url:key?'http://127.0.0.1:2/v1':old.providers[0].baseUrl});
 await assert.rejects(run(paths,io,{execution:old.execution}),key?/same profile.*(?:URL|endpoint)/i:/empty|credential|key/i);
 assert.deepEqual(await bytes([paths.config,paths.credentials,host]),before);await noIntent(paths);
});

for(const key of ['k','y'])test(`${key==='k'?'keeping':'rotating'} one saved key preserves unrelated credentials and exact execution identity`,async t=>{
 const {paths,old,host}=await fixture(t,{native:true}),io=advanced({key}),other=JSON.parse(await readFile(host)).mcpServers.unrelated;
 assert.equal(await run(paths,io,{execution:old.execution,nativeCheckRuntime:old.nativeCheckRuntime}),true);
 const saved=await readSettings(paths),credentials=JSON.parse(await readFile(paths.credentials));assert.equal(saved.providers[0].credentialRef,'worker-key');assert.equal(credentials.entries['worker-key'],key==='k'?'dummy-original-wave01':'dummy-replacement-wave01');assert.equal(credentials.entries.retained,'dummy-unrelated-wave01');assert.deepEqual(saved.execution,old.execution);assert.deepEqual(saved.nativeCheckRuntime,old.nativeCheckRuntime);assert.deepEqual(JSON.parse(await readFile(host)).mcpServers.unrelated,other);assert.doesNotMatch(io.text(),/dummy-(?:original|replacement|unrelated)-wave01/);await noIntent(paths);
});

for(const native of [true,false])test(`interactive revisit retains exact ${native?'native artifact':'Codex executable'} defaults`,async t=>{
 const {paths,old}=await fixture(t,{native}),answers=['3','1','worker','Fixture worker','http://127.0.0.1:1/v1','replacement-model','n','n','1','n','n','y'];let text='';
 assert.equal(await setup(paths,{input:Readable.from([answers.join('\n')+'\n']),output:new Writable({write(c,e,cb){text+=c;cb();}}),verifyExecution:()=>{}}),true);
 const saved=await readSettings(paths);assert.deepEqual(saved.execution,old.execution);assert.deepEqual(saved.nativeCheckRuntime,old.nativeCheckRuntime);assert.equal(saved.codexPath,old.codexPath);assert.equal(saved.providers[0].model,'replacement-model');assert.equal(await setupComplete(paths),true);await noIntent(paths);
});

for(const cancel of ['decline','eof','ctrl-c'])test(`public setup ${cancel} preserves last-good files byte for byte`,async t=>{
 const {paths,old,host}=await fixture(t),files=[paths.config,paths.credentials,host],before=await bytes(files);
 if(cancel==='ctrl-c'){
  const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};const out=new Writable({write(c,e,cb){cb();}});out.isTTY=true;
  const pending=setup(paths,{input,output:out,execution:old.execution,verifyExecution:()=>{}});setTimeout(()=>input.write('\x03'),25);await assert.rejects(pending,/interrupted/);input.destroy();
 }else{
  const answers=cancel==='decline'?'3\n0\n1\nn\nn\nn\n':'3\n',options={input:Readable.from([answers]),output:new Writable({write(c,e,cb){cb();}}),execution:old.execution,verifyExecution:()=>{}};
  if(cancel==='decline')assert.equal(await setup(paths,options),false);else await assert.rejects(setup(paths,options),/interrupted/);
 }
 assert.deepEqual(await bytes(files),before);await noIntent(paths);
});

for(const status of ['draft','active','stopped','retained-owner'])test(`${status} prevents conflicting replacement and preserves approval state`,async t=>{
 const {paths,old,host}=await fixture(t),c=new Coordinator({root:paths.state});
 try{if(status!=='retained-owner'){
  const goal=c.prepareGoal({submissionId:'fixture-pin',objective:'Preserve fixture approval',acceptance:['Retain pins'],mode:'codex_only',environment:'fixture'},'fixture-pin');
  if(status==='active')c.activateGoal({goalId:goal.id,hash:goal.hash},'fixture-active');
  if(status==='stopped')c.control({goalId:goal.id,action:'stop'},'fixture-stop');
 }
  if(status==='retained-owner')c.store.db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?)').run('execution_owner','fixture-owner',JSON.stringify({status:'uncertain'}));
 }finally{c.close();}
 const files=[paths.config,paths.credentials,host,path.join(paths.state,'harness.sqlite3')],before=await bytes(files),io=advanced();
 await assert.rejects(run(paths,io,{execution:old.execution}),/Resolve.*host|resume and finish|finalize.*partial/i);assert.deepEqual(await bytes(files),before);await noIntent(paths);
});

test('harmless exact configuration reapply preserves handformatted settings and credential bytes',async t=>{
 const {paths,old,host}=await fixture(t),before=await bytes([paths.config,paths.credentials]);
 assert.equal(await setupPortable(paths,{settings:old,ask:async prompt=>/Apply this exact/.test(prompt)?'y':'n',output:{write(){}},verifyExecution:()=>{}}),true);
 assert.deepEqual(await bytes([paths.config,paths.credentials]),before);assert.equal(JSON.parse(await readFile(host)).mcpServers.unrelated.command,'keep');await noIntent(paths);
});

test('resume refuses a fixture host entry customized after completed-write interruption',async t=>{
 const {paths,old,host}=await fixture(t),io=advanced();
 await assert.rejects(run(paths,io,{execution:old.execution,afterStep:step=>{if(step==='complete')throw Error('fixture interruption');}}),/fixture interruption/);
 const changed=JSON.parse(await readFile(host));changed.mcpServers['mosaic-beta'].command='/fixture/customized-launcher';await saveJson(host,changed);const before=await bytes([paths.config,paths.credentials,host,paths.setupIntent]);
 await assert.rejects(run(paths,{ask:()=>assert.fail('resume must not ask'),output:{write(){}}}),/host.*(?:changed|customized)|binding.*changed/i);
 assert.deepEqual(await bytes([paths.config,paths.credentials,host,paths.setupIntent]),before);assert.equal(await setupComplete(paths),false);
});

test('public CLI setup cancellation retains exit one and the exact saved configuration',async t=>{
 const {paths,old}=await fixture(t,{native:false}),before=await bytes([paths.config,paths.credentials]);
 const child=spawn(process.execPath,[new URL('../src/beta/cli.mjs',import.meta.url).pathname,'--home',paths.home,'setup'],{stdio:['pipe','pipe','pipe'],timeout:5000});let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.stdin.end('3\n0\n1\nn\nn\nn\n');
 const code=await new Promise(resolve=>child.once('close',resolve));assert.equal(code,1,stderr);assert.match(stdout,/Apply this exact/);assert.deepEqual(await bytes([paths.config,paths.credentials]),before);assert.deepEqual((await readSettings(paths)).execution,old.execution);await noIntent(paths);
});

for(const kind of ['credentials','settings'])test(`resume fences ${kind} changed during awaited execution preflight`,async t=>{
 const {paths,old,host}=await fixture(t),io=advanced({key:'y'});
 await assert.rejects(run(paths,io,{execution:old.execution,afterStep:step=>{if(step==='intent')throw Error('fixture interrupted intent');}}),/fixture interrupted intent/);
 let changed;const otherFiles=[host,paths.setupIntent],before=await bytes(otherFiles);
 await assert.rejects(run(paths,{ask:()=>assert.fail('resume must not ask'),output:{write(){}}},{verifyExecution:async()=>{
  changed=kind==='credentials'?{schema:1,entries:{'worker-key':'dummy-newer-resume-wave01'}}:{...old,serviceMaxConcurrentTasks:2};
  await saveJson(kind==='credentials'?paths.credentials:paths.config,changed);
 }}),/changed|newer/i);
 assert.deepEqual(JSON.parse(await readFile(kind==='credentials'?paths.credentials:paths.config)),changed);assert.deepEqual(await bytes(otherFiles),before);
});

// Real PTY around the public source CLI; all host/provider data is a fixture.
const ptyDriver=String.raw`
import errno, json, os, pty, select, signal, sys, time
config=json.load(sys.stdin)
steps=config['steps']; cursor=0; data=bytearray(); status=None
pid,fd=pty.fork()
if pid==0: os.execv(config['argv'][0],config['argv'])
try:
    deadline=time.monotonic()+10
    while time.monotonic()<deadline:
        if select.select([fd],[],[],.02)[0]:
            try: data.extend(os.read(fd,65536))
            except OSError as e:
                if e.errno!=errno.EIO: raise
        while steps:
            at=data.find(steps[0][0].encode(),cursor)
            if at<0: break
            prompt,answer=steps.pop(0); cursor=at+len(prompt)
            os.write(fd,(answer+'\r').encode())
        child,result=os.waitpid(pid,os.WNOHANG)
        if child: status=result; break
finally:
    if status is None:
        os.killpg(pid,signal.SIGKILL); _,status=os.waitpid(pid,0)
    os.close(fd)
sys.stdout.buffer.write(data)
sys.exit(124 if steps else os.waitstatus_to_exitcode(status))
`;
test('public CLI PTY rotates one key, explicitly replaces a model and retains the other profile',async t=>{
 const {paths,host}=await fixture(t,{native:false}),calls=[];
 const server=http.createServer((req,res)=>{calls.push(req.method);res.end('{}');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));const url=`http://127.0.0.1:${server.address().port}/v1`;
 const old=settings(),first={...profile('first','custom-first-key'),displayName:'First fixture',baseUrl:url},second={...profile('second','custom-second-key'),displayName:'Second fixture',baseUrl:url,capacityGroup:'first'};
 old.providers=[first,second];old.defaults={workerId:'first',plannerWorkerId:'second',review:{source:'host',hostId:'cursor'},routing:{version:1,rules:[],defaultWorkerId:'first'}};old.capacityGroups=[{id:'first',limit:1}];await saveJson(paths.config,old);await saveJson(paths.credentials,{schema:1,entries:{'custom-first-key':'dummy-first-before-wave01','custom-second-key':'dummy-second-retained-wave01',retained:'dummy-unrelated-wave01'}});
 const steps=[['Choose host [3]: ',''],['Number of already-running API worker profiles [0]: ','2']];
 for(const [i,p] of [first,second].entries())steps.push([`Profile ${i+1} identifier: `,p.id],['Display name: ',p.displayName],['Already-running server API base URL (local or explicit remote): ',url],['Model ID (manual, no discovery required): ',i===0?'explicit-new-model':'fixture-model'],['Does this endpoint require an API bearer key?',i===0?'y':'k'],...(i===0?[['Bearer key (hidden): ','dummy-first-after-wave01']]:[]));
 steps.push(['Default worker identifier (Enter for first worker): ','first'],['Planner worker identifier (Enter for default worker): ','second'],['Add an explicit specialty route? [y/N] ','n'],['Use a separately configured API reviewer instead of the selected host? [y/N] ','n'],['Service maximum concurrent tasks [1]: ','1'],['Run optional model discovery check? [y/N] ','n'],['Run optional inference connectivity test with that fixed setup-only message? [y/N] ','n'],['Apply this exact setup and managed host binding? [y/N] ','y']);
 const driver=spawn('/usr/bin/python3',['-c',ptyDriver],{stdio:['pipe','pipe','pipe'],timeout:15000});let stdout='',stderr='';driver.stdout.on('data',c=>stdout+=c);driver.stderr.on('data',c=>stderr+=c);driver.stdin.end(JSON.stringify({argv:[process.execPath,new URL('../src/beta/cli.mjs',import.meta.url).pathname,'--home',paths.home,'setup'],steps}));
 const code=await new Promise(resolve=>driver.once('close',resolve));assert.equal(code,0,stderr);const saved=await readSettings(paths),creds=JSON.parse(await readFile(paths.credentials));assert.deepEqual(saved.providers[1],second);assert.equal(saved.providers[0].model,'explicit-new-model');assert.equal(saved.providers[0].credentialRef,'custom-first-key');assert.equal(creds.entries['custom-first-key'],'dummy-first-after-wave01');assert.equal(creds.entries['custom-second-key'],'dummy-second-retained-wave01');assert.equal(creds.entries.retained,'dummy-unrelated-wave01');assert.deepEqual(saved.execution,old.execution);assert.equal(saved.codexPath,old.codexPath);assert.deepEqual(calls,[]);assert.doesNotMatch(stdout,/dummy-(?:first|second|unrelated)/);assert.equal(JSON.parse(await readFile(host)).mcpServers.unrelated.command,'keep');await noIntent(paths);
});

for(const kind of ['credentials','settings','intent','staged'])test(`final resumed fixture host read fences newer ${kind} and retains recovery state`,async t=>{
 const {paths}=await fixture(t,{native:false}),s=settings({workers:false});s.host.id='codex';s.defaults.review.hostId='codex';await saveJson(paths.config,s);
 let registration=null,resuming=false,reads=0,newer;
 const changedFile=kind==='credentials'?paths.credentials:kind==='settings'?paths.config:kind==='intent'?paths.setupIntent:path.join(paths.configDir,'setup-credentials.json');
 const registrations={get:async()=>{
  if(resuming&&++reads===2){
   newer=kind==='credentials'||kind==='staged'?{schema:1,entries:{retained:'dummy-newer-final-wave01'}}:kind==='settings'?{...s,serviceMaxConcurrentTasks:2}:{...JSON.parse(await readFile(paths.setupIntent)),hadAgent:true};await saveJson(changedFile,newer);
  }return registration;
 },add:async()=>{registration={name:'mosaic-beta',enabled:true,transport:{type:'stdio',command:paths.launcher,args:['mcp']}};},remove:async()=>{registration=null;}};
 await assert.rejects(setupPortable(paths,{settings:s,ask:async p=>/Apply this exact/.test(p)?'y':'n',output:{write(){}},verifyExecution:()=>{},codexRegistrations:registrations,afterStep:step=>{if(step==='complete')throw Error('fixture complete interruption');}}),/fixture complete interruption/);
 const intent=await readFile(paths.setupIntent),staged=await readFile(path.join(paths.configDir,'setup-credentials.json'));resuming=true;
 await assert.rejects(setupPortable(paths,{ask:()=>assert.fail('resume must not ask'),output:{write(){}},verifyExecution:()=>{},codexRegistrations:registrations}),/changed|newer/i);
 assert.deepEqual(JSON.parse(await readFile(changedFile)),newer);if(kind!=='intent')assert.deepEqual(await readFile(paths.setupIntent),intent);if(kind!=='staged')assert.deepEqual(await readFile(path.join(paths.configDir,'setup-credentials.json')),staged);
});

for(const field of ['model','url'])for(const percent of [false,true])test(`advanced retained-key ${percent?'percent-':''}JSON identity in ${field} rejects before preflight and output`,async t=>{
 const {paths,old,host}=await fixture(t),key='review/key',unicode=[...key].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join(''),encoded=percent?encodeURIComponent(JSON.stringify(unicode).slice(1,-1)):JSON.stringify(unicode).slice(1,-1);
 await saveJson(paths.credentials,{schema:1,entries:{'worker-key':key}});const before=await bytes([paths.config,paths.credentials,host]),io=advanced({key:field==='model'?'k':'n',model:field==='model'?encoded:'fixture-model',url:old.providers[0].baseUrl+(field==='url'?'/'+encoded:'')});let preflight=false;
 await assert.rejects(run(paths,io,{verifyExecution:()=>{preflight=true;}}),/Credential values must occur only/);assert.equal(preflight,false);assert.doesNotMatch(io.text(),/Mosaic setup summary|Exact private setup preview|optional model discovery/);assert.ok(!io.text().includes(encoded));assert.deepEqual(await bytes([paths.config,paths.credentials,host]),before);await noIntent(paths);
});

test('explicit new endpoint key retains its profile reference and never overwrites an unrelated derived reference',async t=>{
 const {paths,old}=await fixture(t);old.providers[0].credentialRef='custom-profile-key';await saveJson(paths.config,old);await saveJson(paths.credentials,{schema:1,entries:{'custom-profile-key':'dummy-selected-old-wave01','worker-key':'dummy-unrelated-derived-wave01'}});
 assert.equal(await run(paths,advanced({key:'y',url:'http://127.0.0.1:2/v1'})),true);
 const saved=await readSettings(paths),creds=JSON.parse(await readFile(paths.credentials));assert.equal(saved.providers[0].credentialRef,'custom-profile-key');assert.equal(creds.entries['custom-profile-key'],'dummy-replacement-wave01');assert.equal(creds.entries['worker-key'],'dummy-unrelated-derived-wave01');
});

for(const owner of ['profile','unused'])test(`new advanced profile key cannot overwrite a ${owner} retained reference`,async t=>{
 const {paths,old}=await fixture(t),second={...profile('second',owner==='profile'?'worker-key':'second-key'),displayName:'Second fixture'};old.providers=[second];old.defaults.workerId='second';old.defaults.plannerWorkerId='second';old.capacityGroups=[{id:'second',limit:1}];await saveJson(paths.config,old);
 const retained={'worker-key':'dummy-retained-collision-wave01','worker-key-2':'dummy-unused-suffix-wave01',...(owner==='unused'?{'second-key':'dummy-second-kept-wave01'}:{})};await saveJson(paths.credentials,{schema:1,entries:retained});let current=0;
 const ask=async(prompt,options)=>{
  if(/Choose host/.test(prompt))return '3';if(/Number of already-running/.test(prompt))return '2';if(/Profile \d identifier/.test(prompt))return ++current===1?'worker':'second';if(/Display name/.test(prompt))return current===1?'First fixture':'Second fixture';if(/API base URL/.test(prompt))return current===1?'http://127.0.0.1:2/v1':second.baseUrl;if(/Model ID/.test(prompt))return 'fixture-model';if(/require an API bearer key/.test(prompt))return current===1?'y':'k';if(options?.secret)return 'dummy-new-profile-wave01';if(/Default worker identifier|Planner worker identifier/.test(prompt))return 'second';if(/Service maximum/.test(prompt))return '1';if(/Apply this exact/.test(prompt))return 'y';return 'n';
 };
 assert.equal(await run(paths,{ask,output:{write(){}}}),true);const saved=await readSettings(paths),creds=JSON.parse(await readFile(paths.credentials));for(const [ref,value] of Object.entries(retained))assert.equal(creds.entries[ref],value);assert.equal(saved.providers[1].credentialRef,second.credentialRef);assert.ok(!Object.hasOwn(retained,saved.providers[0].credentialRef));assert.equal(creds.entries[saved.providers[0].credentialRef],'dummy-new-profile-wave01');
});


test('rotating a key still rejects an identity containing its retired value before diagnostics',async t=>{
 const {paths,old,host}=await fixture(t),before=await bytes([paths.config,paths.credentials,host]);
 const io=advanced({key:'y',model:'model-dummy-original-wave01'});
 let preflight=false;
 await assert.rejects(run(paths,io,{verifyExecution:()=>{preflight=true;}}),/Credential values must occur only/);
 assert.equal(preflight,false);assert.doesNotMatch(io.text(),/dummy-original-wave01|Mosaic setup summary|optional model discovery/);
 assert.deepEqual(await bytes([paths.config,paths.credentials,host]),before);await noIntent(paths);
});

for(const withKey of [false,true])test(`saved remote HTTP settings fail before a ${withKey?'credentialed':'keyless'} setup or diagnostic`,async t=>{
 const {paths,old,host}=await fixture(t);
 old.providers[0].baseUrl='http://192.0.2.2:8000/v1';
 if(!withKey)old.providers[0].credentialRef=null;
 await saveJson(paths.config,old);
 const before=await bytes([paths.config,paths.credentials,host]);
 await assert.rejects(readSettings(paths),/HTTPS/);
 await assert.rejects(run(paths,{ask:()=>assert.fail('No interactive setup or diagnostic allowed'),output:{write(){}}}),/HTTPS/);
 let diagnostic='';
 await doctor(paths,{write:value=>{diagnostic+=value;}},{providers:true,gitReady:async()=>null});
 assert.match(diagnostic,/HTTPS.*previous installed version/);
 assert.doesNotMatch(diagnostic,/192\.0\.2\.2|dummy-original-wave01|Provider worker/);
 assert.deepEqual(await bytes([paths.config,paths.credentials,host]),before);await noIntent(paths);
});
