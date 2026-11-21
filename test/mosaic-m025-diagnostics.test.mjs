import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {LocalProvider} from '../src/harness/provider.mjs';
import {DeepSeekHttpAdapter} from '../src/adapters/deepseek-http.mjs';
import {ProviderRegistry} from '../src/harness/providers/registry.mjs';
import {digest} from '../src/harness/contracts.mjs';
const execute=promisify(execFile);
const secret='dummy-key-"escaped%42';
const completion={model:'fixture-model',choices:[{message:{content:'PRIVATE completion output'},finish_reason:'stop'}]};
const diagnostics=()=>import('../src/beta/provider-diagnostics.mjs');
const json=(res,body,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
function profile(baseUrl,advertised=false){return {schema:1,id:'worker-one',revision:'revision-one',displayName:'Worker',transport:'openai-chat',baseUrl,model:'fixture-model',roles:['worker'],capabilities:{workerProtocol:'mosaic-structured-v1',transports:['json','sse'],modelDiscovery:advertised?'advertised':'manual',taskKinds:['coding','consult']},maxContextTokens:null,maxOutputTokens:12000,concurrency:1,capacityGroup:'capacity-one',credentialRef:'key-one',streaming:false};}
function client(p,options={}){return new LocalProvider({baseUrl:p.baseUrl,model:p.model,openAICompatible:true,apiKey:secret,capabilities:{protocol:p.capabilities.workerProtocol,transports:p.capabilities.transports,modelDiscovery:p.capabilities.modelDiscovery},...options});}
async function fixture(t,handler,{tls}={}){
 const calls=[];
 const receive=async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=chunks.length?JSON.parse(Buffer.concat(chunks)):null;calls.push({method:req.method,url:req.url,body,authenticated:req.headers.authorization==='Bearer '+secret});await handler(req,res,body,calls);};
 const server=tls?https.createServer(tls,receive):http.createServer(receive);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 return {base:`${tls?'https':'http'}://127.0.0.1:${server.address().port}/v1`,calls};
}

for(const code of ['model_not_found','context_length_exceeded'])test(`real HTTP ${code} error exposes only allowlisted metadata and preserves dispatch`,async t=>{
 const f=await fixture(t,(_req,res)=>json(res,{error:{code,message:secret+' PRIVATE body'}},400));
 const p=profile(f.base),c=client(p);
 await assert.rejects(c.complete([]),e=>{assert.equal(e.providerErrorCode,code);assert.equal(e.httpStatus,400);assert.equal(e.requestOutcome,'not_dispatched');assert.doesNotMatch(JSON.stringify(e)+e.message,/PRIVATE|dummy-key/);return true;});
 assert.equal(f.calls.length,1);
});

test('registry preserves allowlisted error category from a real advertised preflight',async t=>{
 const f=await fixture(t,(_req,res)=>json(res,{error:{type:'model_not_found',message:secret}},404));
 const p=profile(f.base,true),registry=ProviderRegistry({profiles:[p],credentialResolver:async()=>secret});
 const c=registry.createClient({version:1,providerId:p.id,revision:p.revision,profileHash:digest(registry.get(p.id,p.revision)),policyHash:'a'.repeat(64)});
 await assert.rejects(c.complete([]),e=>e.providerErrorCode==='model_not_found'&&e.httpStatus===404&&e.requestOutcome==='not_dispatched'&&e.requestOperation==='model_discovery');
 assert.deepEqual(f.calls.map(c=>c.method),['GET']);
});

for(const [name,body] of [['unknown',{error:{code:'secret-category',message:secret}}],['malformed','{'],['oversized',JSON.stringify({error:{code:'model_not_found'},padding:'x'.repeat(4096)})],['free text',{error:{message:'context_length_exceeded'}}]])test(`real HTTP ${name} body falls back to known status without raw fields`,async t=>{
 const f=await fixture(t,(_req,res)=>{res.writeHead(404);res.end(typeof body==='string'?body:JSON.stringify(body));});
 const c=client(profile(f.base));
 await assert.rejects(c.complete([]),e=>{assert.equal(e.providerErrorCode,undefined);assert.equal(e.httpStatus,404);assert.equal(e.requestOutcome,'not_dispatched');assert.doesNotMatch(e.message,/secret-category|dummy-key|context_length/);return true;});
 assert.equal(f.calls.length,1);
});

test('slow error body retains known HTTP status under request cancellation',async t=>{
 const f=await fixture(t,(_req,res)=>{res.writeHead(503);res.flushHeaders();res.write('{"error":');});
 const c=client(profile(f.base)),signal=AbortSignal.timeout(35);
 await assert.rejects(c.complete([],{signal}),e=>{assert.equal(e.httpStatus,503);assert.equal(e.requestOutcome,'unknown');assert.equal(e.providerErrorCode,undefined);return true;});
});

test('metadata discovery stays separate from inference, coding qualification and host evidence',async t=>{
 const d=await diagnostics(),f=await fixture(t,(_req,res)=>json(res,{data:[{id:'fixture-model'},{id:'second'}]}));
 const p=profile(f.base),before=JSON.stringify(p),r=await d.discoverProvider(client(p),p,{secrets:[secret]});
 assert.equal(r.endpoint.state,'responded');assert.equal(r.discovery.state,'listed');assert.equal(r.discovery.selectedModel,'listed');assert.equal(r.discovery.operation,'discovery');assert.equal(r.inference.state,'not_checked');assert.equal(r.codingQualification,'untested');assert.equal(r.hostConnection,'unverified');assert.equal(r.failed,false);assert.equal(JSON.stringify(p),before);
 assert.deepEqual(f.calls.map(c=>c.method),['GET']);assert.equal(f.calls[0].authenticated,true);
 const text=d.formatProviderDiagnostic(r);assert.match(text,/inference.*not checked|inference.*untested/i);assert.doesNotMatch(text,/coding.ready|connected|PRIVATE/);
});

for(const status of [404,405])test(`manual model remains usable after discovery HTTP ${status}`,async t=>{
 const d=await diagnostics(),f=await fixture(t,(req,res)=>req.method==='GET'?json(res,{},status):json(res,completion));
 const p=profile(f.base),c=client(p),listed=await d.discoverProvider(c,p),r=await d.probeProvider(c,p,{previous:listed});
 assert.equal(listed.discovery.state,'unsupported');assert.equal(listed.failed,false);assert.equal(r.discovery.state,'unsupported');assert.equal(r.inference.state,'response_received');assert.equal(r.failed,false);
 assert.deepEqual(f.calls.map(c=>c.method),['GET','POST']);assert.equal(f.calls[1].body.max_tokens,16);assert.equal(f.calls[1].body.stream,false);assert.deepEqual(f.calls[1].body.messages,[{role:'user',content:d.SETUP_PROBE_MESSAGE}]);assert.doesNotMatch(JSON.stringify(r)+d.formatProviderDiagnostic(r),/PRIVATE completion output/);
});

test('independent manual inference performs only POST and never returns response text',async t=>{
 const d=await diagnostics(),f=await fixture(t,(_req,res)=>json(res,completion)),p=profile(f.base),r=await d.probeProvider(client(p,{streaming:true}),p);
 assert.deepEqual(f.calls.map(c=>c.method),['POST']);assert.equal(r.discovery.state,'not_checked');assert.equal(r.inference.state,'response_received');assert.equal(r.codingQualification,'untested');assert.doesNotMatch(JSON.stringify(r)+d.formatProviderDiagnostic(r),/PRIVATE|coding.ready|connected/);
});

test('unlisted manual model keeps listing evidence and still sends selected model',async t=>{
 const d=await diagnostics(),f=await fixture(t,(req,res)=>json(res,req.method==='GET'?{data:[{id:'other-model'}]}:completion));
 const p=profile(f.base),c=client(p),listed=await d.discoverProvider(c,p),r=await d.probeProvider(c,p,{previous:listed});
 assert.equal(listed.discovery.selectedModel,'not_listed');assert.equal(listed.failed,false);assert.equal(r.discovery.selectedModel,'not_listed');assert.equal(r.inference.state,'response_received');assert.equal(f.calls[1].body.model,'fixture-model');assert.equal(p.capabilities.modelDiscovery,'manual');
});

test('advertised inference always gets fresh membership and keeps prior discovery provenance',async t=>{
 const d=await diagnostics();let gets=0;
 const f=await fixture(t,(req,res)=>{if(req.method==='GET'){gets++;json(res,{data:[{id:gets===1?'fixture-model':'other-model'}]});}else json(res,completion);});
 const p=profile(f.base,true),c=client(p),listed=await d.discoverProvider(c,p),r=await d.probeProvider(c,p,{previous:listed});
 assert.equal(r.discovery.state,'listed');assert.equal(r.discovery.selectedModel,'listed');assert.equal(r.discovery.operation,'discovery');assert.equal(r.inference.state,'failed');assert.equal(r.inference.preflight.operation,'inference_preflight');assert.equal(r.inference.preflight.selectedModel,'not_listed');assert.equal(r.inference.requestOutcome,'not_dispatched');assert.equal(r.failed,true);assert.deepEqual(f.calls.map(c=>c.method),['GET','GET']);
});

test('advertised successful preflight plus failed POST retains both observations',async t=>{
 const d=await diagnostics(),f=await fixture(t,(req,res)=>req.method==='GET'?json(res,{data:[{id:'fixture-model'}]}):json(res,{},401));
 const p=profile(f.base,true),r=await d.probeProvider(client(p),p);
 assert.equal(r.discovery.operation,'inference_preflight');assert.equal(r.discovery.selectedModel,'listed');assert.equal(r.inference.preflight.state,'listed');assert.equal(r.inference.category,'authentication');assert.equal(r.endpoint.state,'responded');assert.equal(r.inference.httpStatus,401);assert.equal(r.failed,true);assert.deepEqual(f.calls.map(c=>c.method),['GET','POST']);
});

for(const [status,code,category,words] of [[400,'model_not_found','model_not_found',/provider.reported.*model/i],[400,'context_length_exceeded','context_length_exceeded',/provider.reported.*context/i],[400,undefined,'http',/compatible|request/i],[404,undefined,'http',/base.*path.*model|path.*model/i],[403,undefined,'authentication',/key|access/i],[429,undefined,'rate_limit',/rate|capacity/i],[502,undefined,'server',/server/i]])test(`inference HTTP ${status} ${code??'ambiguous'} has bounded actionable evidence`,async t=>{
 const d=await diagnostics(),f=await fixture(t,(_req,res)=>json(res,{error:{code,message:secret+' PRIVATE'}},status));
 const p=profile(f.base),r=await d.probeProvider(client(p),p),text=d.formatProviderDiagnostic(r);
 assert.equal(r.inference.state,'failed');assert.equal(r.inference.category,category);assert.equal(r.inference.httpStatus,status);assert.equal(r.endpoint.state,'responded');assert.equal(r.failed,true);assert.match(text,words);assert.match(text,/next:/i);assert.match(text,/context capacity.*unverified/i);assert.doesNotMatch(text,/PRIVATE|dummy-key|coding.ready/);assert.equal(f.calls.length,1);
});

for(const [name,body] of [['invalid JSON','{'],['unsupported shape',JSON.stringify({result:secret})]])test(`${name} proves responder but no successful inference`,async t=>{
 const d=await diagnostics(),f=await fixture(t,(_req,res)=>res.end(body)),p=profile(f.base),r=await d.probeProvider(client(p),p);
 assert.equal(r.endpoint.state,'responded');assert.equal(r.inference.state,'failed');assert.equal(r.inference.category,'protocol');assert.equal(r.inference.requestOutcome,'unknown');assert.match(d.formatProviderDiagnostic(r),/compatible|response/i);
});

test('real request deadline covers fresh advertised GET and POST together',async t=>{
 const d=await diagnostics(),f=await fixture(t,(req,res)=>{const timer=setTimeout(()=>json(res,req.method==='GET'?{data:[{id:'fixture-model'}]}:completion),45);res.on('close',()=>clearTimeout(timer));});
 const p=profile(f.base,true),start=Date.now(),r=await d.probeProvider(client(p),p,{deadlineMs:70});
 assert.equal(r.inference.category,'timeout');assert.equal(r.inference.requestOutcome,'unknown');assert.equal(r.inference.preflight.state,'listed');assert.ok(Date.now()-start<1000);assert.deepEqual(f.calls.map(c=>c.method),['GET','POST']);assert.match(d.formatProviderDiagnostic(r),/outcome.*uncertain|uncertain.*outcome/i);
});

test('cancellation stops real request and retains unknown dispatched outcome',async t=>{
 const d=await diagnostics(),controller=new AbortController(),f=await fixture(t,(_req,res)=>{res.writeHead(200);res.flushHeaders();controller.abort();});
 const p=profile(f.base),r=await d.probeProvider(client(p),p,{signal:controller.signal});
 assert.equal(r.inference.category,'cancelled');assert.equal(r.inference.requestOutcome,'unknown');assert.equal(f.calls.length,1);
});

test('refused loopback and deterministic DNS failure are safe address diagnostics with credentials',async t=>{
 const d=await diagnostics(),server=http.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 const p=profile(`http://127.0.0.1:${port}/v1`),r=await d.discoverProvider(client(p),p);
 assert.equal(r.endpoint.state,'transport_failed');assert.equal(r.discovery.category,'address');assert.match(d.formatProviderDiagnostic(r),/address|server|tunnel/i);
 const dns=new LocalProvider({baseUrl:'https://unused.invalid/v1',model:'fixture-model',openAICompatible:true,apiKey:secret,fetchImpl:async()=>{const e=Error(secret);e.code='ENOTFOUND';throw e;}});
 const dnsResult=await d.discoverProvider(dns,p);assert.equal(dnsResult.discovery.category,'address');assert.doesNotMatch(d.formatProviderDiagnostic(dnsResult),/dummy-key/);
});

test('model identities are bounded and reject raw, JSON, percent and unicode-escaped secrets and controls',async t=>{
 const d=await diagnostics(),escaped=[secret,JSON.stringify(secret).slice(1,-1),encodeURIComponent(secret),Array.from(secret,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')];
 const ids=['fixture-model',...escaped,'bad\u001b[31m','x'.repeat(201),...Array.from({length:35},(_,i)=>'safe-'+i)];
 const f=await fixture(t,(_req,res)=>json(res,{data:ids.map(id=>({id}))})),p=profile(f.base),r=await d.discoverProvider(client(p),p,{secrets:[secret]});
 const output=JSON.stringify(r)+d.formatProviderDiagnostic(r,{secrets:[secret]});assert.ok(r.discovery.models.length<=25);assert.ok(r.discovery.models.every(id=>id.length<=200));for(const value of escaped)assert.equal(output.includes(value),false);assert.doesNotMatch(output,/[\u001b\u009b]/);assert.equal(r.discovery.selectedModel,'listed');
});

test('trusted and untrusted owned TLS fixtures preserve certificate verification',async t=>{
 const d=await diagnostics(),root=await mkdtemp(path.join(os.tmpdir(),'mosaic-m025-tls-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const key=path.join(root,'key.pem'),cert=path.join(root,'cert.pem');
 await execute('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1']);
 const f=await fixture(t,(_req,res)=>json(res,{data:[{id:'fixture-model'}]}),{tls:{key:await readFile(key),cert:await readFile(cert)}}),p=profile(f.base);
 const sse=sseProfile(f.base),untrustedStream=await d.probeProvider(client(sse,{streaming:true}),sse);assert.equal(untrustedStream.inference.category,'tls');
 const untrusted=await d.discoverProvider(client(p),p);assert.equal(untrusted.discovery.category,'tls');assert.match(d.formatProviderDiagnostic(untrusted),/certificate|hostname|trust/i);assert.equal(f.calls.length,0);
 const moduleUrl=new URL('../src/beta/provider-diagnostics.mjs',import.meta.url).href,providerUrl=new URL('../src/harness/provider.mjs',import.meta.url).href;
 const script=`import {discoverProvider} from ${JSON.stringify(moduleUrl)};import {LocalProvider} from ${JSON.stringify(providerUrl)};const p=${JSON.stringify(p)};const result=await discoverProvider(new LocalProvider({baseUrl:p.baseUrl,model:p.model,openAICompatible:true}),p);console.log(JSON.stringify(result));`;
 const trusted=await execute(process.execPath,['--input-type=module','-e',script],{env:{...process.env,NODE_EXTRA_CA_CERTS:cert},timeout:5000});
 assert.equal(JSON.parse(trusted.stdout).discovery.state,'listed');assert.equal(f.calls.length,1);
});

test('snapshot guard rejection after membership GET prevents POST and never becomes provider output',async t=>{
 const d=await diagnostics(),f=await fixture(t,(_req,res)=>json(res,{data:[{id:'fixture-model'}]})),p=profile(f.base,true);
 let guards=0;
 await assert.rejects(d.probeProvider(client(p),p,{beforeRequest:async()=>{if(++guards===2)throw Error('snapshot changed');}}),/snapshot changed/);
 assert.deepEqual(f.calls.map(c=>c.method),['GET']);
});

test('empty and reviewer-only diagnostics never request worker endpoints',async t=>{
 const d=await diagnostics(),p={...profile('https://unused.invalid/v1'),roles:['reviewer']};
 const noClient={listModels(){assert.fail('reviewer GET');},complete(){assert.fail('reviewer POST');}};
 assert.equal((await d.discoverProvider(noClient,p)).discovery.state,'not_checked');assert.equal((await d.probeProvider(noClient,p)).inference.state,'not_checked');
});

test('failed optional discovery does not turn successful manual inference into failure',async t=>{
 const d=await diagnostics(),f=await fixture(t,(req,res)=>req.method==='GET'?json(res,{},401):json(res,completion));
 const p=profile(f.base),c=client(p),listed=await d.discoverProvider(c,p),r=await d.probeProvider(c,p,{previous:listed});
 assert.equal(listed.failed,true);assert.equal(r.discovery.state,'failed');assert.equal(r.discovery.httpStatus,401);assert.equal(r.inference.state,'response_received');assert.equal(r.failed,false);
});

test('later transport failure retains prior HTTP responder evidence and operation provenance',async t=>{
 const d=await diagnostics(),f=await fixture(t,(req,res)=>req.method==='GET'?json(res,{data:[{id:'fixture-model'}]}):req.socket.destroy());
 const p=profile(f.base),c=client(p),listed=await d.discoverProvider(c,p),r=await d.probeProvider(c,p,{previous:listed});
 assert.equal(r.endpoint.state,'responded');assert.deepEqual(r.endpoint.observations.map(o=>[o.operation,o.state]),[['discovery','responded'],['inference','transport_failed']]);assert.equal(r.discovery.state,'listed');assert.equal(r.inference.state,'failed');assert.equal(r.inference.requestOutcome,'unknown');
});

test('stalled error-body metadata settles promptly without waiting for the long provider timeout',async t=>{
 const f=await fixture(t,(_req,res)=>{res.writeHead(429);res.flushHeaders();res.write('{');});
 const started=Date.now();await assert.rejects(client(profile(f.base)).complete([]),e=>e.httpStatus===429&&e.requestOutcome==='not_dispatched'&&e.providerErrorCode===undefined);assert.ok(Date.now()-started<1000);
});

test('a later probe cannot reuse an earlier successful advertised preflight',async t=>{
 const d=await diagnostics(),f=await fixture(t,(req,res,_body,calls)=>{if(req.method==='GET')json(res,{data:[{id:calls.length===1?'fixture-model':'other-model'}]});else json(res,completion);});
 const p=profile(f.base,true),c=client(p),first=await d.probeProvider(c,p),r=await d.probeProvider(c,p,{previous:first});
 assert.equal(first.inference.state,'response_received');assert.equal(r.inference.state,'failed');assert.equal(r.inference.preflight.selectedModel,'not_listed');assert.equal(r.inference.operation,'inference_preflight');assert.deepEqual(f.calls.map(c=>c.method),['GET','POST','GET']);
});

test('formatting rejects Unicode terminal formatting and line separators in model identities',async t=>{
 const d=await diagnostics(),f=await fixture(t,(_req,res)=>json(res,{data:[{id:'fixture-model'},{id:'hostile\u202Elabel'},{id:'hostile\u2028line'}]})),p=profile(f.base),r=await d.discoverProvider(client(p),p);
 assert.doesNotMatch(d.formatProviderDiagnostic(r),/[\u202e\u2028]/);assert.deepEqual(r.discovery.models,['fixture-model']);
});

test('unlisted advertised discovery fails with a selected-model next action',async t=>{
 const d=await diagnostics(),f=await fixture(t,(_req,res)=>json(res,{data:[{id:'other-model'}]})),p=profile(f.base,true),r=await d.discoverProvider(client(p),p);
 assert.equal(r.failed,true);assert.equal(r.discovery.category,'model_not_advertised');assert.equal(r.discovery.selectedModel,'not_listed');assert.match(d.formatProviderDiagnostic(r),/next:.*configured model.*server model list/i);assert.deepEqual(f.calls.map(c=>c.method),['GET']);
});

test('normal dispatch cannot yield after the final onModel ownership fence',async t=>{
 const f=await fixture(t,(_req,res)=>json(res,completion)),p=profile(f.base);let paused=false,dispatchedBeforePause;
 const c=client(p,{fetchImpl:async(url,options)=>{dispatchedBeforePause=!paused;return fetch(url,options);}});
 await c.complete([],{onModel:()=>queueMicrotask(()=>{paused=true;})});
 assert.equal(dispatchedBeforePause,true);assert.deepEqual(f.calls.map(c=>c.method),['POST']);
});

for(const cancelled of [false,true])test(`advertised membership ${cancelled?'cancellation':'timeout'} never implies an uncertain dispatched inference`,async t=>{
 const d=await diagnostics(),controller=new AbortController(),f=await fixture(t,(_req,res)=>{res.writeHead(200);res.flushHeaders();if(cancelled)controller.abort();}),p=profile(f.base,true);
 const r=await d.probeProvider(client(p),p,{signal:controller.signal,deadlineMs:35}),text=d.formatProviderDiagnostic(r);
 assert.equal(r.inference.operation,'inference_preflight');assert.equal(r.inference.requestOutcome,'not_dispatched');assert.deepEqual(f.calls.map(c=>c.method),['GET']);assert.doesNotMatch(text,/dispatched inference|outcome.*uncertain|uncertain.*outcome/i);assert.equal(r.endpoint.state,cancelled?'unknown':'responded');
});

for(const outage of ['disconnect','deadline','invalid JSON'])for(const advertised of [false,true])test(`JSON ${advertised?'membership':'inference'} 200 ${outage} keeps responder evidence separate from failure status`,async t=>{
 const d=await diagnostics(),f=await fixture(t,(_req,res)=>{
  res.writeHead(200,{'content-type':'application/json'});res.flushHeaders();
  if(outage==='invalid JSON')return res.end('{');
  res.write('{');if(outage==='disconnect')setTimeout(()=>res.destroy(),5);
 }),p=profile(f.base,advertised),c=client(p,{timeoutMs:100});
 await assert.rejects(c.complete([]),error=>{
  assert.equal(error.httpStatus,undefined);assert.equal(error.observedHttpStatus,200);
  assert.equal(error.requestOperation,advertised?'model_discovery':'inference');
  assert.equal(error.requestOutcome,advertised?'not_dispatched':'unknown');return true;
 });
 const r=await d.probeProvider(c,p,{deadlineMs:100}),observation=advertised?r.inference.preflight:r.inference;
 assert.equal(r.endpoint.state,'responded');assert.equal(r.endpoint.observedHttpStatus,200);
 assert.equal(observation.httpStatus,undefined);assert.equal(observation.observedHttpStatus,200);
 assert.equal(r.inference.category,outage==='invalid JSON'?'protocol':outage==='deadline'?'timeout':'connection');
 assert.equal(r.inference.requestOutcome,advertised?'not_dispatched':'unknown');
 assert.match(d.formatProviderDiagnostic(r),/HTTP 200 response observed/);
 assert.deepEqual(f.calls.map(c=>c.method),advertised?['GET','GET']:['POST','POST']);
});

for(const [status,want] of [[401,'authentication'],[403,'authentication'],[429,'rate_limit'],[503,'server']])test(`HTTP ${status} remains primary when an error body reports model_not_found`,async t=>{
 const d=await diagnostics(),f=await fixture(t,(_req,res)=>json(res,{error:{code:'model_not_found'}},status)),p=profile(f.base),r=await d.probeProvider(client(p),p);
 assert.equal(r.inference.category,want);assert.equal(r.inference.httpStatus,status);assert.equal(r.endpoint.state,'responded');
});

function sseProfile(base){const p=profile(base);return {...p,streaming:true,capabilities:{...p.capabilities,transports:['sse']}};}
function streamOk(res){res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({model:'fixture-model',choices:[{delta:{content:'PRIVATE '+secret},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');}

test('SSE-only configured transport receives the fixed bounded probe without exposing completion',async t=>{
 const d=await diagnostics(),f=await fixture(t,(_req,res)=>streamOk(res)),p=sseProfile(f.base),r=await d.probeProvider(client(p,{streaming:true}),p,{secrets:[secret]});
 assert.equal(r.inference.state,'response_received');assert.equal(r.failed,false);assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.stream,true);assert.equal(f.calls[0].body.max_tokens,16);assert.deepEqual(f.calls[0].body.messages,[{role:'user',content:d.SETUP_PROBE_MESSAGE}]);assert.doesNotMatch(JSON.stringify(r)+d.formatProviderDiagnostic(r),/PRIVATE|dummy-key/);assert.deepEqual(p.capabilities.transports,['sse']);
});

test('SSE-only malformed stream is classified as protocol failure with observed HTTP response',async t=>{
 const d=await diagnostics(),f=await fixture(t,(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: {bad}\n\n');}),p=sseProfile(f.base),r=await d.probeProvider(client(p,{streaming:true}),p);
 assert.equal(r.inference.state,'failed');assert.equal(r.inference.category,'protocol');assert.equal(r.inference.requestOutcome,'unknown');assert.equal(r.endpoint.state,'responded');assert.equal(f.calls.length,1);assert.match(d.formatProviderDiagnostic(r),/compatible API.*transport/i);
});

test('SSE-only real request obeys the same short deadline and unknown dispatched outcome',async t=>{
 const d=await diagnostics(),f=await fixture(t,(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();}),p=sseProfile(f.base),r=await d.probeProvider(client(p,{streaming:true}),p,{deadlineMs:35});
 assert.equal(r.inference.category,'timeout');assert.equal(r.inference.requestOutcome,'unknown');assert.equal(r.endpoint.state,'responded');assert.equal(f.calls.length,1);
});

for(const code of ['model_not_found','context_length_exceeded'])test(`SSE-only HTTP ${code} reports the bounded provider cause without raw body`,async t=>{
 const d=await diagnostics(),f=await fixture(t,(_req,res)=>json(res,{error:{code,message:'PRIVATE '+secret}},400)),p=sseProfile(f.base),r=await d.probeProvider(client(p,{streaming:true}),p,{secrets:[secret]}),text=d.formatProviderDiagnostic(r);
 assert.equal(r.inference.category,code);assert.equal(r.inference.httpStatus,400);assert.equal(r.inference.requestOutcome,'not_dispatched');assert.equal(r.endpoint.state,'responded');assert.equal(r.failed,true);assert.match(text,/provider-reported/i);assert.doesNotMatch(text+JSON.stringify(r),/PRIVATE|dummy-key/);assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.stream,true);
});

for(const [name,body] of [['oversized',JSON.stringify({error:{code:'model_not_found'},padding:'x'.repeat(4096)})],['malformed','{"error":'],['unrecognized',JSON.stringify({error:{code:'not_allowlisted',message:'PRIVATE '+secret}})]])test(`SSE-only HTTP ${name} error body preserves ambiguous status without retry`,async t=>{
 const d=await diagnostics(),f=await fixture(t,(_req,res)=>{res.writeHead(404,{'content-type':'application/json'});res.end(body);}),p=sseProfile(f.base),r=await d.probeProvider(client(p,{streaming:true}),p),text=d.formatProviderDiagnostic(r);
 assert.equal(r.inference.category,'http');assert.equal(r.inference.httpStatus,404);assert.equal(r.inference.requestOutcome,'not_dispatched');assert.equal(r.endpoint.state,'responded');assert.doesNotMatch(text+JSON.stringify(r),/provider-reported|PRIVATE|dummy-key|not_allowlisted/);assert.equal(f.calls.length,1);
});

for(const deadlineMs of [35,10000])test(`SSE-only slow error body keeps known HTTP status within ${deadlineMs===35?'the request deadline':'the metadata budget'}`,async t=>{
 const d=await diagnostics(),f=await fixture(t,(_req,res)=>{res.writeHead(503,{'content-type':'application/json'});res.flushHeaders();res.write('{"error":');}),p=sseProfile(f.base),start=Date.now(),r=await d.probeProvider(client(p,{streaming:true}),p,{deadlineMs}),text=d.formatProviderDiagnostic(r);
 assert.equal(r.inference.category,'server');assert.equal(r.inference.httpStatus,503);assert.equal(r.inference.requestOutcome,'unknown');assert.equal(r.endpoint.state,'responded');assert.equal(f.calls.length,1);assert.ok(Date.now()-start<1000);assert.doesNotMatch(text+JSON.stringify(r),/provider-reported|PRIVATE|dummy-key/);
});

for(const apiKey of [undefined,secret])test(`remote HTTP is refused for a ${apiKey?'credentialed':'keyless'} worker and API reviewer`,async()=>{
 const baseUrl='http://192.0.2.1:8000/v1',p=profile(baseUrl);
 const fetchImpl=()=>assert.fail('Invalid profile must not reach the transport');
 assert.throws(()=>new DeepSeekHttpAdapter({baseUrl,model:p.model,openAICompatible:true,apiKey,fetchImpl}),/HTTPS/);
 assert.throws(()=>ProviderRegistry({profiles:[{...p,credentialRef:apiKey?p.credentialRef:null}],credentialResolver:fetchImpl}),/HTTPS/);
 const {createReviewTransport}=await import('../src/harness/review/transports/factory.mjs');
 const reviewer={...p,roles:['reviewer'],capabilities:{workerProtocol:null,transports:['json'],modelDiscovery:'manual',taskKinds:[]}};
 assert.throws(()=>createReviewTransport({profile:reviewer,apiKey,fetchImpl}),/configuration is invalid/);
});
