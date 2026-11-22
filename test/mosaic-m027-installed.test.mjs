import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,realpath,rm,stat,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const required=process.env.MOSAIC_REQUIRE_INSTALLED==='1',archive=process.env.MOSAIC_INSTALLED_ARCHIVE;
const sha=value=>createHash('sha256').update(value).digest('hex');
const probeMessage='Mosaic setup connectivity probe. Reply with setup ok.';
const responseMarker='PRIVATE_M027_FIXTURE_RESPONSE';
const keys=['M027-private-key/one-Q31','M027-private-"key-two-K52','M027-private-key\\three-S73'];
const privateForms=keys.flatMap(key=>[key,JSON.stringify(key).slice(1,-1),encodeURIComponent(key),encodeURIComponent(encodeURIComponent(key))]);
const privateTextAbsent=value=>privateForms.every(key=>!value.includes(key));
const redact=value=>privateForms.reduce((text,key)=>text.replaceAll(key,'[fixture credential]'),value);

async function command(argv,{env,cwd,input='',timeout=120000}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(argv[0],argv.slice(1),{env,cwd,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',timedOut=false;
  child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
  child.stdin.on('error',error=>{if(error.code!=='EPIPE')reject(error);});child.stdin.end(input);
  let escalation;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');escalation=setTimeout(()=>child.kill('SIGKILL'),5000);escalation.unref();},timeout);timer.unref();
  child.once('error',error=>{clearTimeout(timer);clearTimeout(escalation);reject(error);});
  child.once('close',(code,signal)=>{clearTimeout(timer);clearTimeout(escalation);resolve({argv,code,signal,timedOut,stdout,stderr});});
 });
}

// Answers, including dummy keys, arrive on stdin rather than command arguments,
// environment variables or a persisted driver-input file. Each match advances a
// cursor so repeated prompt text cannot satisfy a later question accidentally.
const ptyDriver=String.raw`
import errno, json, os, pty, select, signal, sys, time
config = json.load(sys.stdin)
steps = config['steps']
pid, fd = pty.fork()
if pid == 0:
    os.chdir(config['cwd'])
    os.execve(config['argv'][0], config['argv'], dict(os.environ))
output = bytearray()
matched = []
cursor = 0
status = None
timed_out = False
deadline = time.monotonic() + 90
def read_available(wait):
    if select.select([fd], [], [], wait)[0]:
        try:
            chunk = os.read(fd, 65536)
            output.extend(chunk)
            return bool(chunk)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
    return False
try:
    while time.monotonic() < deadline:
        read_available(.05)
        while steps:
            needle = steps[0]['prompt'].encode()
            found = output.find(needle, cursor)
            if found < 0:
                break
            step = steps.pop(0)
            cursor = found + len(needle)
            matched.append({'label': step['label'], 'promptEndOffset': cursor})
            answer = step['answer'].encode()
            while answer:
                answer = answer[os.write(fd, answer):]
        child, child_status = os.waitpid(pid, os.WNOHANG)
        if child:
            status = child_status
            for unused in range(20):
                if not read_available(.01):
                    break
            break
    if status is None:
        timed_out = True
        os.killpg(pid, signal.SIGTERM)
        for unused in range(40):
            child, child_status = os.waitpid(pid, os.WNOHANG)
            if child:
                status = child_status
                break
            time.sleep(.05)
        if status is None:
            os.killpg(pid, signal.SIGKILL)
            unused, status = os.waitpid(pid, 0)
finally:
    if status is None:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        unused, status = os.waitpid(pid, 0)
    os.close(fd)
code = os.waitstatus_to_exitcode(status)
sys.stdout.buffer.write(output)
sys.stdout.buffer.flush()
sys.stderr.write('M027_PTY ' + json.dumps({'childCode': code, 'timedOut': timed_out, 'matched': matched, 'remaining': [step['label'] for step in steps]}) + '\n')
sys.exit(124 if timed_out else code if code else 125 if steps else 0)
`;

function guidedSteps(urls){
 const steps=[],add=(label,prompt,answer)=>steps.push({label,prompt,answer:answer+'\r'});
 add('coding app','Pick your coding app','3');
 add('guided choice','Choose a worker','6');
 add('worker count','How many workers? 2 or 3 [3]: ','3');
 for(let i=1;i<=3;i++){
  add('worker '+i+' location',`Choose for worker ${i} [1]: `,String(i));
  add('worker '+i+' URL',`Worker ${i} API base URL: `,urls[i-1]);
  add('worker '+i+' model',`Worker ${i} Model ID: `,'fixture-model');
  // Paste the affirmative answer and key together, before the hidden-key
  // question resumes, to exercise readline's queued-paste echo protection.
  add('worker '+i+' hidden key',`Worker ${i} does this endpoint require an API bearer key? [y/N] `,'y\r'+keys[i-1]);
  add('worker '+i+' specialty',`Worker ${i} specialties: 1. General  2. Backend  3. Frontend  4. Tests  5. Docs  6. Design (comma-separated numbers; Enter for none): `,String(i+1));
 }
 add('default worker','Default worker number (1-3) [1]: ','3');
 add('planner worker','Planner worker number (1-3) [1]: ','2');
 add('shared workers 1 and 2','Worker 2 shares physical capacity with: 0. Separate service; 1. Worker 1 [0]: ','1');
 add('separate worker 3','Worker 3 shares physical capacity with: 0. Separate service; 1. Worker 1; 2. Worker 2 [0]: ','0');
 add('total slots','Total concurrent tasks (1-4) [1]: ','2');
 for(let i=1;i<=3;i++)add('worker '+i+' slots',`Worker ${i} maximum concurrent tasks (1-4) [1]: `,'1');
 add('shared service 1 slots','Shared service 1 maximum concurrent tasks for workers 1, 2 (1-4) [1]: ','1');
 add('shared service 2 slots','Shared service 2 maximum concurrent tasks for workers 3 (1-4) [1]: ','1');
 add('declined technical details','Show technical settings details? [y/N] ','n');
 for(let i=1;i<=3;i++)add('worker '+i+' discovery',`Worker ${i}: run optional model discovery check? [y/N] `,i===2?'n':'y');
 for(let i=1;i<=3;i++)add('worker '+i+' inference',`Worker ${i}: run optional inference connectivity test with that fixed setup-only message? [y/N] `,i===1?'n':'y');
 add('apply setup','Apply this exact setup and managed host binding? [y/N] ','y');
 return steps;
}

test('new extracted CLI saves a guided three-worker pool through real hidden-key PTY entry and native validation',{
 skip:!archive&&!required,timeout:360000
},async t=>{
 assert.ok(archive,'MOSAIC_INSTALLED_ARCHIVE must name the new candidate archive');
 assert.equal(process.platform,'darwin');assert.equal(process.arch,'arm64');
 const parent=process.env.MOSAIC_INSTALLED_ROOT_PARENT;
 if(required)assert.ok(parent&&path.isAbsolute(parent),'Use a task-owned durable installed parent');
 await mkdir(parent??os.tmpdir(),{recursive:true,mode:0o700});
 const root=await realpath(await mkdtemp(path.join(parent??os.tmpdir(),'Mosaic M027 installed proof ')));
 const source=await realpath(fileURLToPath(new URL('../',import.meta.url)));
 assert.ok(root!==source&&!root.startsWith(source+path.sep),'Extract and run outside the development checkout');
 const archiveSha256=sha(await readFile(archive)),runs=[],calls=[],servers=[],runtimeModules=[],privateFiles=[];
 let completed=false,installationVersion=null,nativeIdentity=null,ptyObservation=null;
 const extractionHome=path.join(root,'Extraction home');await mkdir(extractionHome,{mode:0o700});
 const env={PATH:'/usr/bin:/bin',HOME:extractionHome,TMPDIR:os.tmpdir(),LANG:'en_US.UTF-8',TERM:'xterm-256color',CI:'1'};
 t.after(async()=>{
  for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  const evidence={schemaVersion:1,task:'m027',root,retainedRoot:!completed,completed,fixtureOnly:true,liveModelCalls:false,sourceImports:false,preflightBypassed:false,archive,archiveSha256,installationVersion,environment:env,ptyDriverSha256:sha(ptyDriver),ptyObservation,runtimeModules,nativeIdentity,privateFiles,calls,runs};
  const encoded=JSON.stringify(evidence,null,2)+'\n';
  assert.ok(privateTextAbsent(encoded),'Installed evidence must never contain dummy credential bytes');
  const evidenceDir=process.env.MOSAIC_INSTALLED_EVIDENCE_DIR;
  if(evidenceDir){await mkdir(evidenceDir,{recursive:true,mode:0o700});await writeFile(path.join(evidenceDir,'m027-installed.json'),encoded,{mode:0o600});}
  if(completed)await rm(root,{recursive:true,force:true});
 });
 const run=async(argv,options={})=>{
  const result=await command(argv,{env,cwd:root,...options});
  runs.push({...result,stdout:redact(result.stdout),stderr:redact(result.stderr),stdoutSha256:sha(result.stdout),stderrSha256:sha(result.stderr),privateOutputAbsent:privateTextAbsent(result.stdout+result.stderr)});
  assert.equal(result.timedOut,false,'Owned installed command exceeded its deadline; retain the proof root');
  assert.ok(privateTextAbsent(result.stdout+result.stderr),'Raw installed terminal/error output exposed a dummy credential');
  assert.ok(!(result.stdout+result.stderr).includes(responseMarker),'Provider response bodies must remain private');
  return result;
 };
 const success=result=>assert.equal(result.code,0,redact(result.stderr+'\n'+result.stdout));
 success(await run(['/usr/bin/tar','-xzf',archive,'-C',root]));
 const listing=await run(['/usr/bin/tar','-tzf',archive]);success(listing);
 const stem=listing.stdout.split('\n').find(Boolean).split('/')[0],bundle=path.join(root,stem);
 const modules=['src/beta/multi-worker-setup.mjs','src/beta/setup-wizard.mjs','src/beta/portable-setup.mjs','src/beta/provider-diagnostics.mjs','src/beta/settings.mjs','src/beta/cli.mjs','bin/node'];
 for(const file of modules)assert.ok(listing.stdout.split('\n').includes(stem+'/payload/runtime/'+file),'New candidate archive must contain '+file);
 for(let index=0;index<3;index++){
  const server=http.createServer(async(req,res)=>{
   let body='';for await(const chunk of req)body+=chunk;
   const authorization=req.headers.authorization??'',record={worker:index+1,method:req.method,url:req.url,authorizationMatchesOwnKey:authorization==='Bearer '+keys[index],authorizationSha256:sha(authorization),bodyContainsCredential:!privateTextAbsent(body),...(body?{body:JSON.parse(redact(body)),bodySha256:sha(body)}:{})};
   // Never retain the header bytes. The boolean plus digest prove selection of
   // this worker's distinct private credential without putting it in evidence.
   calls.push(record);res.setHeader('content-type','application/json');
   if(!record.authorizationMatchesOwnKey){res.writeHead(401);res.end(JSON.stringify({error:{message:responseMarker}}));return;}
   if(req.method==='GET'&&req.url==='/v1/models')res.end(JSON.stringify({data:[{id:'fixture-model'},...keys.map(id=>({id}))]}));
   else if(req.method==='POST'&&req.url==='/v1/chat/completions')res.end(JSON.stringify({model:'fixture-model',choices:[{message:{content:responseMarker+' '+keys[index]},finish_reason:'stop'}]}));
   else {res.writeHead(404);res.end(JSON.stringify({error:{message:responseMarker}}));}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});servers.push(server);
 }
 const urls=servers.map(server=>`http://127.0.0.1:${server.address().port}/v1`);
 const home=path.join(root,'Three worker home');await mkdir(home,{mode:0o700});const caseEnv={...env,HOME:home};
 success(await run([path.join(bundle,'install'),'--home',home,'--no-path'],{env:caseEnv}));
 const product=path.join(home,'Library/Application Support/Mosaic Beta'),configDir=path.join(product,'config');
 const installation=JSON.parse(await readFile(path.join(configDir,'installation.json'),'utf8'));installationVersion=installation.version;
 const runtime=path.join(product,'versions',installation.version,'runtime'),cli=path.join(runtime,'src/beta/cli.mjs'),node=path.join(runtime,'bin/node');
 for(const file of modules){
  const installed=path.join(runtime,file),bytes=await readFile(installed),info=await stat(installed),packaged=await readFile(path.join(bundle,'payload/runtime',file));
  assert.equal(sha(bytes),sha(packaged),'Installed runtime must match the newly extracted payload: '+file);
  runtimeModules.push({path:file,sha256:sha(bytes),bytes:info.size,mode:info.mode&0o777});
 }
 const driver=path.join(root,'m027-pty-driver.py');await writeFile(driver,ptyDriver,{mode:0o600});
 const steps=guidedSteps(urls),expectedLabels=steps.map(step=>step.label);
 const pty=await run(['/usr/bin/python3',driver],{env:caseEnv,input:JSON.stringify({argv:[node,cli,'--home',home,'setup'],cwd:root,steps}),timeout:120000});
 const marker=pty.stderr.split('\n').find(line=>line.startsWith('M027_PTY '));
 assert.ok(marker,'The real PTY driver must report its terminal lifecycle');ptyObservation=JSON.parse(marker.slice('M027_PTY '.length));
 success(pty);assert.equal(ptyObservation.childCode,0);assert.equal(ptyObservation.timedOut,false);assert.deepEqual(ptyObservation.remaining,[]);assert.deepEqual(ptyObservation.matched.map(item=>item.label),expectedLabels);
 const terminal=pty.stdout.replaceAll('\r','');
 for(let i=1;i<=3;i++)assert.ok(terminal.includes(`Worker ${i} Bearer key (hidden): `),'Each worker key uses the hidden terminal collector');
 assert.doesNotMatch(terminal,/Exact private setup preview/,'Guided summary keeps technical details optional');
 assert.match(terminal,/chosen routes/i);assert.match(terminal,/not proof of model quality|not proof a model is best/i);assert.match(terminal,/2 service slots/);assert.match(terminal,/worker slots 1, 1, 1/);assert.match(terminal,/capacity group slots 1, 1/);
 assert.match(terminal,/Reviewer: Cursor/);assert.match(terminal,/cloud/);assert.match(terminal,/actual app connection remains unverified|actual host compatibility unprobed/);assert.match(terminal,/closed hosts wait durably/);
 const settingsFile=path.join(configDir,'settings.json'),settingsBytes=await readFile(settingsFile),settings=JSON.parse(settingsBytes);
 assert.ok(privateTextAbsent(settingsBytes.toString()),'Saved public settings must exclude credential bytes');
 assert.equal(settings.schema,2);assert.deepEqual(settings.host,{id:'cursor',options:{}});assert.equal(settings.providers.length,3);assert.equal(settings.serviceMaxConcurrentTasks,2);
 assert.equal(settings.defaults.workerId,'worker-3');assert.equal(settings.defaults.plannerWorkerId,'worker-2');assert.deepEqual(settings.defaults.review,{source:'host',hostId:'cursor'});
 assert.deepEqual(settings.defaults.routing,{version:1,rules:[{id:'rule-1',category:'backend',providerId:'worker-1'},{id:'rule-2',category:'frontend',providerId:'worker-2'},{id:'rule-3',category:'tests',providerId:'worker-3'}],defaultWorkerId:'worker-3'});
 assert.deepEqual(settings.capacityGroups,[{id:'worker-1',limit:1},{id:'worker-3',limit:1}]);assert.equal(settings.workerLocation,undefined);
 for(const [index,profile] of settings.providers.entries()){
  const id='worker-'+(index+1);
  assert.deepEqual(profile,{schema:1,id,revision:'r1',displayName:'Worker '+(index+1),transport:'openai-chat',baseUrl:urls[index],model:'fixture-model',roles:['worker'],capabilities:{workerProtocol:'mosaic-structured-v1',transports:['json'],modelDiscovery:'manual',taskKinds:['coding','consult']},maxContextTokens:null,maxOutputTokens:12000,concurrency:1,capacityGroup:index===1?'worker-1':id,streaming:false,credentialRef:id+'-key'});
 }
 const credentialFile=path.join(configDir,'credentials.json'),credentialBytes=await readFile(credentialFile),credentials=JSON.parse(credentialBytes);
 assert.equal(credentials.schema,1);assert.deepEqual(Object.keys(credentials.entries).sort(),['worker-1-key','worker-2-key','worker-3-key']);
 for(let i=0;i<3;i++)assert.ok(credentials.entries['worker-'+(i+1)+'-key']===keys[i],'Private credential store retains Worker '+(i+1)+' entered key');
 for(const file of ['settings.json','credentials.json','portable-binding.json','host-cursor-binding.json']){
  const target=path.join(configDir,file),bytes=await readFile(target),info=await stat(target);
  assert.equal(info.mode&0o777,0o600,'Setup file must remain private: '+file);assert.equal(info.uid,process.getuid());
  if(file!=='credentials.json')assert.ok(privateTextAbsent(bytes.toString()),'Public setup/host receipt excludes keys: '+file);
  privateFiles.push({path:file,sha256:sha(bytes),bytes:info.size,mode:info.mode&0o777,uid:info.uid,credentialValuesExcluded:file!=='credentials.json'});
 }
 const receipt=JSON.parse(await readFile(path.join(configDir,'portable-binding.json'),'utf8'));assert.equal(receipt.complete,true);assert.equal(receipt.hostId,'cursor');
 for(const file of ['setup-intent.json','setup-credentials.json'])await assert.rejects(readFile(path.join(configDir,file)),{code:'ENOENT'});
 const nativeManifest=path.join(runtime,'check-artifact/artifact-manifest.json'),nativeBytes=await readFile(nativeManifest),nativeFingerprint=sha(nativeBytes);
 assert.deepEqual(settings.execution,{backend:'darwin-seatbelt',backendRevision:2,runtimeFingerprint:nativeFingerprint});
 assert.deepEqual(settings.nativeCheckRuntime,{schema:1,artifactManifestPath:nativeManifest,artifactManifestSha256:nativeFingerprint});
 nativeIdentity={artifactManifestPath:nativeManifest,artifactManifestSha256:nativeFingerprint,artifactManifestBytes:nativeBytes.length,nodeSha256:runtimeModules.find(module=>module.path==='bin/node').sha256,setupNativeValidationPassed:true,preflightBypassed:false};
 assert.deepEqual(calls.map(call=>[call.worker,call.method,call.url]),[[1,'GET','/v1/models'],[3,'GET','/v1/models'],[2,'POST','/v1/chat/completions'],[3,'POST','/v1/chat/completions']]);
 assert.ok(calls.every(call=>call.authorizationMatchesOwnKey&&!call.bodyContainsCredential),'Every selected request uses only its own private bearer header');
 assert.equal(new Set(calls.map(call=>call.authorizationSha256)).size,3,'Three workers retain distinct request credentials');
 for(const call of calls.filter(call=>call.method==='POST')){assert.equal(call.body.model,'fixture-model');assert.deepEqual(call.body.messages,[{role:'user',content:probeMessage}]);assert.equal(call.body.max_tokens,16);assert.ok(!JSON.stringify(call.body).includes(home));}
 for(let i=1;i<=3;i++){
  const discoveryConsent=terminal.indexOf(`Worker ${i}: run optional model discovery check?`),inferenceConsent=terminal.indexOf(`Worker ${i}: run optional inference connectivity test`);
  const getDisclosure=terminal.indexOf('GET '+urls[i-1]+'/models'),postDisclosure=terminal.indexOf('POST '+urls[i-1]+'/chat/completions');
  assert.ok(getDisclosure>=0&&getDisclosure<discoveryConsent,'Exact GET disclosure precedes Worker '+i+' consent');
  assert.ok(postDisclosure>=0&&postDisclosure<inferenceConsent,'Exact POST disclosure precedes Worker '+i+' consent');
 }
 const inferenceDisclosure=terminal.slice(0,terminal.indexOf('Worker 1: run optional inference connectivity test'));
 for(const text of [probeMessage,'16 tokens','10-second','authentication','cost','No project files','No retries or fallback'])assert.ok(inferenceDisclosure.includes(text),'Bounded inference disclosure includes '+text);
 for(const module of runtimeModules){const bytes=await readFile(path.join(runtime,module.path)),info=await stat(path.join(runtime,module.path));assert.equal(sha(bytes),module.sha256,'Setup preserves installed runtime bytes');assert.equal(info.mode&0o777,module.mode,'Setup preserves installed runtime modes');}
 // The extracted command must also preserve the actual terminal-only safeguard;
 // a piped key is not a substitute for the successful PTY path above.
 const refusedHome=path.join(root,'Non terminal refusal home');await mkdir(refusedHome,{mode:0o700});const refusedEnv={...env,HOME:refusedHome};
 success(await run([path.join(bundle,'install'),'--home',refusedHome,'--no-path'],{env:refusedEnv}));
 const beforeCalls=calls.length,refused=await run([path.join(refusedHome,'.local/bin/mosaic'),'setup'],{env:refusedEnv,input:['3','6','2','1',urls[0],'fixture-model','y',keys[0]].join('\n')+'\n'});
 assert.notEqual(refused.code,0);assert.match(refused.stderr,/interactive terminal.*terminal output/);assert.equal(calls.length,beforeCalls,'Refused private entry cannot contact a provider');
 const refusedConfig=path.join(refusedHome,'Library/Application Support/Mosaic Beta/config');
 for(const file of ['settings.json','credentials.json','setup-intent.json','setup-credentials.json','portable-binding.json','host-cursor-binding.json'])await assert.rejects(readFile(path.join(refusedConfig,file)),{code:'ENOENT'});
 completed=true;
});
