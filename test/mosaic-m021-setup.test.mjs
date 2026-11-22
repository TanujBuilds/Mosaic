import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable,Writable} from 'node:stream';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {locations,privateDirectories,saveJson} from '../src/beta/files.mjs';
import {doctor,setup,readSettings,setupComplete} from '../src/beta/setup.mjs';
import {setupPortable} from '../src/beta/portable-setup.mjs';
import {configuredPolicies} from '../src/beta/settings.mjs';

const fingerprint='a'.repeat(64);
const runtime={execution:{backend:'darwin-seatbelt',backendRevision:2,runtimeFingerprint:fingerprint},nativeCheckRuntime:{schema:1,artifactManifestPath:'/fixture/runtime/check-artifact/artifact-manifest.json',artifactManifestSha256:fingerprint}};
const hosts=['codex','claude-code','cursor','antigravity'];
async function fixture(t){const home=await mkdtemp(path.join(os.tmpdir(),'Mosaic setup01 integration '));t.after(()=>rm(home,{recursive:true,force:true}));const paths=locations(home,true);await privateDirectories(paths);await mkdir(path.dirname(paths.launcher),{recursive:true});await writeFile(paths.launcher,'#!/bin/sh\nexit 0\n',{mode:0o755});return paths;}
function streams(answers){let text='';return {input:Readable.from([Array.isArray(answers)?answers.join('\n')+'\n':answers]),output:new Writable({write(c,e,cb){text+=c;cb();}}),text:()=>text};}
async function noSetupWrites(paths){for(const file of [paths.config,paths.credentials,paths.setupIntent,path.join(paths.configDir,'setup-credentials.json'),path.join(paths.configDir,'portable-binding.json')])await assert.rejects(readFile(file),{code:'ENOENT'});}
async function loopback(t){const requests=[];const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push({method:req.method,url:req.url,body,authorization:req.headers.authorization});res.setHeader('content-type','application/json');res.end(JSON.stringify({model:'fixture-model',choices:[{message:{content:'setup ok'},finish_reason:'stop'}]}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));return {url:`http://127.0.0.1:${server.address().port}/v1`,requests};}
function simpleAnswers({host='cursor',location='1',url='http://127.0.0.1:1/v1',model='fixture-model',details='n',discovery='n',probe='n',apply='y'}={}){return [String(hosts.indexOf(host)+1),location,...(location==='4'?[]:[url,model,'n']),details,discovery,probe,apply];}
function assertDataBoundary(text){assert.match(text,/approved task context/i);assert.match(text,/endpoint/i);assert.match(text,/cloud/i);assert.match(text,/review/i);assert.doesNotMatch(text,/all (?:processing|data|work) (?:stays|remains) (?:on|in) (?:this|your) Mac/i);}

// These tests catch a default flow that still requires internal profile/capacity values,
// persists a topology choice, silently probes, or assigns review to the wrong host.
for(const host of hosts)for(const location of ['1','4'])test(`simple setup saves ${host} ${location==='4'?'without worker':'with one worker'} and truthful host status`,async t=>{
 const paths=await fixture(t),{url,requests}=await loopback(t),io=streams(simpleAnswers({host,location,url}));
 assert.equal(await setup(paths,{...io,portable:true,...runtime,verifyExecution:()=>{}}),true);
 const settings=await readSettings(paths);assert.equal(settings.schema,2);assert.equal(settings.host.id,host);assert.deepEqual(settings.defaults.review,{source:'host',hostId:host});assert.equal(settings.codexPath,undefined);assert.deepEqual(settings.execution,runtime.execution);assert.deepEqual(settings.nativeCheckRuntime,runtime.nativeCheckRuntime);assert.equal(settings.providers.length,location==='4'?0:1);assert.equal(settings.defaults.workerId,location==='4'?null:'worker-1');assert.equal(settings.defaults.plannerWorkerId,location==='4'?null:'worker-1');assert.equal(settings.serviceMaxConcurrentTasks,1);
 if(location!=='4'){const p=settings.providers[0];assert.equal(p.id,'worker-1');assert.equal(p.revision,'r1');assert.equal(p.displayName,'Worker 1');assert.equal(p.transport,'openai-chat');assert.equal(p.baseUrl,url);assert.equal(p.model,'fixture-model');assert.equal(p.maxOutputTokens,12000);assert.equal(p.concurrency,1);assert.deepEqual(settings.capacityGroups,[{id:'worker-1',limit:1}]);assert.equal(configuredPolicies(settings).providerPolicy.defaultWorkerId,'worker-1');}
 else assert.deepEqual(settings.capacityGroups,[]);
 assert.equal(requests.length,0);assert.equal(await setupComplete(paths),true);assertDataBoundary(io.text());assert.match(io.text(),/fixture-tested/);assert.doesNotMatch(io.text(),/"providers"\s*:/);assert.doesNotMatch(io.text(),/Profile \d identifier:|Default worker identifier|Service maximum concurrent tasks/);assert.match(io.text(),/pull|closed hosts/i);
});

for(const location of ['2','3'])test(`simple location ${location} keeps canonical supplied endpoint with zero discovery or inference`,async t=>{
 const paths=await fixture(t),{url,requests}=await loopback(t),io=streams(simpleAnswers({location,url}));assert.equal(await setup(paths,{...io,portable:true,...runtime,verifyExecution:()=>{}}),true);const saved=await readSettings(paths);assert.equal(saved.providers[0].baseUrl,url);assert.equal(saved.providers[0].transport,'openai-chat');assert.equal(saved.workerLocation,undefined);assert.equal(saved.providers[0].workerLocation,undefined);assertDataBoundary(io.text());assert.equal(requests.length,0);if(location==='2')assert.match(io.text(),/localhost.*Mosaic|Mosaic.*localhost/i);
});

test('simple user may inspect normalized technical details before the separate probe and apply decisions',async t=>{
 const paths=await fixture(t),io=streams(simpleAnswers({location:'4',details:'y'}));assert.equal(await setup(paths,{...io,portable:true,...runtime,verifyExecution:()=>{}}),true);assert.match(io.text(),/"providers"\s*:\s*\[\]/);assert.match(io.text(),/"source"\s*:\s*"host"/);assert.match(io.text(),/Connectivity\/inference: untested/);
});

test('simple opted-in loopback probe sends only the fixed message and does not claim coding or host qualification',async t=>{
 const paths=await fixture(t),{url,requests}=await loopback(t),io=streams(simpleAnswers({url,probe:'y'}));assert.equal(await setup(paths,{...io,portable:true,...runtime,verifyExecution:()=>{}}),true);assert.equal(requests.length,1);assert.equal(requests[0].method,'POST');const body=JSON.parse(requests[0].body);assert.deepEqual(body.messages,[{role:'user',content:'Mosaic setup connectivity probe. Reply with setup ok.'}]);assert.equal(body.max_tokens,16);assert.equal(requests[0].authorization,undefined);assert.ok(!requests[0].body.includes(paths.home));assert.match(io.text(),/fixed setup message/i);assert.match(io.text(),/unprobed|unverified|not.*(?:quality|connected)/i);
});

test('simple final cancellation and EOF leave settings, credentials and registration absent',async t=>{
 for(const answers of [simpleAnswers({apply:'n'}),['3','4']]){const paths=await fixture(t),io=streams(answers);if(answers.length===2)await assert.rejects(setup(paths,{...io,portable:true,...runtime,verifyExecution:()=>{}}),/interrupt/i);else assert.equal(await setup(paths,{...io,portable:true,...runtime,verifyExecution:()=>{}}),false);await noSetupWrites(paths);await assert.rejects(readFile(path.join(paths.home,'.cursor','mcp.json')),{code:'ENOENT'});}
});

for(const [field,value] of [['host','9'],['location','9'],['endpoint','http://user:pass@127.0.0.1/v1'],['endpoint','http://127.0.0.1/v1?key=value'],['endpoint','http://127.0.0.1/v1#fragment'],['endpoint',''],['model','']])test(`simple setup rejects invalid ${field} without any private writes`,async t=>{
 const paths=await fixture(t);let answers=field==='host'?[value]:field==='location'?['3',value]:['3','1',field==='endpoint'?value:'http://127.0.0.1:1/v1',field==='model'?value:'fixture-model','n','n','n','y'];const io=streams(answers);await assert.rejects(setup(paths,{...io,portable:true,...runtime,verifyExecution:()=>{}}),/invalid|required|interrupt|empty|endpoint|URL|model/i);await noSetupWrites(paths);
});

test('actual non-TTY simple bearer entry rejects before reading or echoing pasted key and writes nothing',async t=>{
 const paths=await fixture(t),key='dummy-non-tty-setup01-7392',io=streams(['3','1','http://127.0.0.1:1/v1','fixture-model','y',key,'n','n','y']);await assert.rejects(setup(paths,{...io,portable:true,...runtime,verifyExecution:()=>{}}),/interactive terminal/i);assert.ok(!io.text().includes(key));await noSetupWrites(paths);
});

test('TTY input with redirected output rejects hidden bearer entry before consuming a key',async t=>{
 const paths=await fixture(t),key='dummy-redirected-setup01-key',io=streams(['3','1','http://127.0.0.1:1/v1','fixture-model','y',key,'n','n','y']);io.input.isTTY=true;
 await assert.rejects(setup(paths,{...io,portable:true,...runtime,verifyExecution:()=>{}}),/interactive terminal/i);assert.ok(!io.text().includes(key));await noSetupWrites(paths);
});

for(const boundary of ['details','probe','preflight'])test(`setup rejects credential rotation at ${boundary} before stale publication or inference`,async t=>{
 const paths=await fixture(t),{url,requests}=await loopback(t),model='dummy-rotated-private-model';let text='',rotated=false,publishedBeforeRotation='';
 const rotate=async()=>{publishedBeforeRotation=text;rotated=true;await saveJson(paths.credentials,{schema:1,entries:{'rotated-key':model}});};
 const answers=['3','1',url,model,'n','y','n','y','y'];
 const ask=async prompt=>{text+=prompt;if(boundary==='details'&&/technical settings details/.test(prompt)||boundary==='probe'&&/optional inference/.test(prompt))await rotate();return answers.shift();};
 await assert.rejects(setupPortable(paths,{ask,output:{write:x=>{text+=x;}},...runtime,verifyExecution:async()=>{if(boundary==='preflight')await rotate();}}),/Settings or credentials changed while preview was open/);
 assert.equal(rotated,true);assert.equal(requests.length,0);assert.ok(!text.slice(publishedBeforeRotation.length).includes(model));assert.ok(!text.includes('Exact private setup preview')||boundary==='probe');assert.equal(JSON.parse(await readFile(paths.credentials)).entries['rotated-key'],model);await assert.rejects(readFile(paths.config),{code:'ENOENT'});await assert.rejects(readFile(paths.setupIntent),{code:'ENOENT'});
});

test('settings replaced while the details question is open are preserved without probing the stale endpoint',async t=>{
 const paths=await fixture(t),{url,requests}=await loopback(t),replacement=complexSettings(),answers=['3','1',url,'fixture-model','n','y','y','y'];let text='';
 const ask=async prompt=>{if(/technical settings details/.test(prompt))await saveJson(paths.config,replacement);return answers.shift();};
 await assert.rejects(setupPortable(paths,{ask,output:{write:x=>{text+=x;}},...runtime,verifyExecution:()=>{}}),/Settings or credentials changed while preview was open/);assert.equal(requests.length,0);assert.deepEqual(JSON.parse(await readFile(paths.config)),replacement);assert.ok(!text.includes('Exact private setup preview'));await assert.rejects(readFile(paths.setupIntent),{code:'ENOENT'});
});

function profile(id,roles=['worker']){return {schema:1,id,revision:'r1',displayName:id,transport:'openai-chat',baseUrl:'http://127.0.0.1:1/v1',model:'fixture-model',roles,capabilities:{workerProtocol:roles.includes('worker')?'mosaic-structured-v1':null,transports:['json'],modelDiscovery:'manual',taskKinds:roles.includes('worker')?['coding','consult']:[]},maxContextTokens:null,maxOutputTokens:4096,concurrency:1,capacityGroup:'shared',credentialRef:null,streaming:false};}
function complexSettings(){return {schema:2,host:{id:'cursor',options:{}},providers:[profile('first'),profile('second'),profile('reviewer',['reviewer'])],defaults:{workerId:'second',plannerWorkerId:'first',review:{source:'api',reviewer:{id:'reviewer',revision:'r1'}},routing:{version:1,rules:[{id:'docs',category:'docs',providerId:'first'}],defaultWorkerId:'second'}},...runtime,serviceMaxConcurrentTasks:1,capacityGroups:[{id:'shared',limit:1}]};}

test('existing multiple-worker API settings enter advanced collection and cancellation preserves exact bytes',async t=>{
 const paths=await fixture(t),original=complexSettings();await saveJson(paths.config,original);await saveJson(paths.credentials,{schema:1,entries:{'retained-key':'dummy-retained-setup01-key'}});const target=path.join(paths.home,'.cursor','mcp.json');await mkdir(path.dirname(target),{recursive:true});await saveJson(target,{mcpServers:{unrelated:{command:'preserve'}}});const before=await Promise.all([paths.config,paths.credentials,target].map(f=>readFile(f))),io=streams(['3','0','1','n','n','n']);assert.equal(await setup(paths,{...io,portable:true,...runtime,verifyExecution:()=>{}}),false);assert.match(io.text(),/Number of already-running API worker profiles/);assert.doesNotMatch(io.text(),/Choose worker location|Where is.*worker/i);assert.deepEqual(await Promise.all([paths.config,paths.credentials,target].map(f=>readFile(f))),before);await assert.rejects(readFile(paths.setupIntent),{code:'ENOENT'});
});

test('provided settings expose independent discovery, inference and apply choices',async t=>{
 const paths=await fixture(t),raw=complexSettings(),io=streams(['n','n','y']);assert.equal(await setup(paths,{...io,portable:true,settings:raw,verifyExecution:()=>{}}),true);const saved=await readSettings(paths);assert.equal(saved.providers.length,3);assert.equal(saved.defaults.workerId,'second');assert.equal(saved.defaults.plannerWorkerId,'first');assert.equal(saved.defaults.review.source,'api');assert.deepEqual(saved.defaults.routing.rules,[{id:'docs',category:'docs',providerId:'first'}]);assert.doesNotMatch(io.text(),/technical details.*\?/i);
});

// A question-aware fake writes prompts just like askSession, but permits a dummy
// secret entry so validation and prompt safety can be exercised independently of TTY.
test('advanced two-worker private identifier is rejected without echo before preview probe or writes',async t=>{
 const paths=await fixture(t),{url,requests}=await loopback(t),key='dummy-private-profile-setup01';let output='',profileIndex=0;const seen=[],out={write:text=>{output+=text;}};
 const ask=async(prompt,options={})=>{seen.push({prompt,secret:options.secret===true});out.write(prompt);if(/Choose host/.test(prompt))return '3';if(/advanced setup/i.test(prompt))return '5';if(/Number of already-running/.test(prompt))return '2';if(/Profile .* identifier/.test(prompt)){profileIndex++;return profileIndex===1?key:'second';}if(/Display name/.test(prompt))return 'Worker';if(/API base URL/.test(prompt))return url;if(/Model ID/.test(prompt))return 'fixture-model';if(/require.*key/.test(prompt))return profileIndex===1?'y':'n';if(options.secret)return key;if(/Default worker identifier/.test(prompt)||/Planner worker identifier/.test(prompt))return '';if(/specialty route|separately configured API reviewer/i.test(prompt))return 'n';if(/Service maximum/.test(prompt))return '1';throw Error('Unexpected setup question');};
 await assert.rejects(setupPortable(paths,{ask,output:out,...runtime,verifyExecution:()=>{throw Error('private identity must fail first');}}),/credential.*private|private.*credential/i);assert.equal(seen.filter(x=>x.secret).length,1);assert.ok(!output.includes(key));assert.ok(!output.includes('Exact private setup preview'));assert.equal(requests.length,0);await noSetupWrites(paths);
});

test('simple dummy bearer is stored privately and absent from public preview and fixed probe body',async t=>{
 const paths=await fixture(t),{url,requests}=await loopback(t),key='dummy-hidden-setup01-8537';let output='';const prompts=[];const answers=['3','1',url,'fixture-model','y',key,'n','n','y','y'];const ask=async(prompt,options={})=>{prompts.push({prompt,secret:options.secret===true});output+=prompt;assert.ok(answers.length,'unexpected extra setup question');return answers.shift();};assert.equal(await setupPortable(paths,{ask,output:{write:text=>{output+=text;}},...runtime,verifyExecution:()=>{}}),true);const saved=await readSettings(paths);assert.equal(saved.providers[0].credentialRef,'worker-1-key');assert.equal(prompts.filter(p=>p.secret).length,1);assert.deepEqual(JSON.parse(await readFile(paths.credentials)),{schema:1,entries:{'worker-1-key':key}});assert.equal((await stat(paths.credentials)).mode&0o777,0o600);assert.ok(!JSON.stringify(saved).includes(key));assert.ok(!output.includes(key));assert.equal(requests.length,1);assert.equal(requests[0].authorization,'Bearer '+key);assert.ok(!requests[0].body.includes(key));assert.equal(answers.length,0);
});

test('missing Apple Git tools appear before host selection and allow setup to finish',async t=>{
 const paths=await fixture(t),io=streams(simpleAnswers()),gitReady=async()=>false;
 assert.equal(await setup(paths,{...io,portable:true,...runtime,verifyExecution:()=>{},gitReady}),true);
 const warning=io.text().indexOf('xcode-select --install');
 assert.ok(warning>=0 && warning<io.text().indexOf('Choose host'));
 assert.match(io.text(),/mosaic doctor/);
 assert.equal((await readSettings(paths)).defaults.workerId,'worker-1');
 const report=streams([]);
 await doctor(paths,report.output,{gitReady});
 assert.match(report.text(),/CHECK  Git for coding tasks.*xcode-select --install/);
});

test('doctor shows the saved dispatch switch without changing a healthy result',async t=>{
 const paths=await fixture(t),{url,requests}=await loopback(t),io=streams(['n','n','y']);
 const settings={schema:2,host:{id:'cursor',options:{}},providers:[],
  defaults:{workerId:null,plannerWorkerId:null,review:{source:'host',hostId:'cursor'}},
  execution:{backend:'codex-sandbox',backendRevision:1},codexPath:process.execPath,
  serviceMaxConcurrentTasks:1,capacityGroups:[]};
 assert.equal(await setup(paths,{...io,portable:true,settings,verifyExecution:()=>{}}),true);
 await saveJson(path.join(paths.state,'viewer-connection.json'),{
  url:new URL(url).origin,role:'viewer',token:'a'.repeat(64),
 });
 async function report(){
  const out=streams([]);
  assert.equal(await doctor(paths,out.output,{gitReady:async()=>true}),true);
  assert.match(out.text(),/^OK  Coordinator · Authenticated viewer connection ready\.$/m);
  return out.text();
 }
 assert.match(await report(),/^INFO  Dispatch · Mosaic is on\./m);
 await saveJson(paths.disabled,{schema:1,disabled:true});
 const saved=await readFile(paths.disabled);
 assert.match(await report(),/^INFO  Dispatch · Mosaic is off\. New dispatch is blocked.*mosaic on/m);
 assert.deepEqual(await readFile(paths.disabled),saved);
 await rm(paths.disabled);
 assert.match(await report(),/^INFO  Dispatch · Mosaic is on\./m);
 assert.deepEqual(requests.map(request=>JSON.parse(request.body)),Array(3).fill({name:'tools_list',input:{}}));
});

test('Apple Git readiness inspects executable tools without running the Git shim',async t=>{
 const {macGitReady}=await import('../src/beta/git-readiness.mjs');
 const paths=await fixture(t),bin=path.join(paths.home,'usr/bin');
 const run=async(command,args)=>{
  assert.equal(command,'/usr/bin/xcode-select');
  assert.deepEqual(args,['--print-path']);
  return {stdout:paths.home+'\n'};
 };
 assert.equal(await macGitReady({platform:'darwin',run}),false);
 await mkdir(bin,{recursive:true});
 await writeFile(path.join(bin,'git'),'#!/bin/sh\nexit 19\n',{mode:0o755});
 assert.equal(await macGitReady({platform:'darwin',run}),true);
 assert.equal(await macGitReady({platform:'linux',run:assert.fail}),null);
});

test('a demo with missing Git prints recovery before it creates sample files',async t=>{
 const {runFirstTask}=await import('../src/beta/first-task.mjs');
 const paths=await fixture(t),demoParent=path.join(paths.home,'samples');
 await mkdir(demoParent);
 await assert.rejects(runFirstTask(paths,['--demo'],{demoParent,gitReady:async()=>false}),/xcode-select --install.*mosaic doctor/);
 assert.deepEqual(await readdir(demoParent),[]);
});
