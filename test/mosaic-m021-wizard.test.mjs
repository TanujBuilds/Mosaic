import test from 'node:test';
import assert from 'node:assert/strict';
import {collectPortableSetup,formatPortableSetupSummary} from '../src/beta/setup-wizard.mjs';
import {configuredPolicies,validateSettingsCredentials} from '../src/beta/settings.mjs';

const fingerprint='a'.repeat(64),runtime={execution:{backend:'darwin-seatbelt',backendRevision:2,runtimeFingerprint:fingerprint},nativeCheckRuntime:{schema:1,artifactManifestPath:'/fixture/runtime/check-artifact/artifact-manifest.json',artifactManifestSha256:fingerprint}};
function simple({host='',location='',url='http://127.0.0.1:11434/v1',model='fixture-model',key=null}={}){
 const prompts=[];let text='';
 return {prompts,output:{write(value){text+=value;}},text:()=>text,ask:async(prompt,options)=>{
  prompts.push({prompt,options});if(/Choose host/.test(prompt))return host;if(/Choose worker setup/.test(prompt))return location;if(/API base URL/.test(prompt))return url;if(/Model ID/.test(prompt))return model;if(/require an API bearer key/.test(prompt))return key===null?'n':'y';if(/Bearer key|OpenRouter API key/.test(prompt))return key;assert.fail('Unexpected simple-path question: '+prompt);
 }};
}
for(const [choice,hostId] of [['','codex'],['2','claude-code'],['3','cursor'],['4','antigravity']]){
 test(`simple ${hostId} worker has neutral defaults and one capacity slot`,async()=>{
  const io=simple({host:choice}),result=await collectPortableSetup(io.ask,io.output,runtime),s=result.settings,p=s.providers[0];
  assert.equal(result.presentation,'simple');assert.equal(result.workerLocation,'local');assert.equal(s.schema,2);assert.equal(s.host.id,hostId);assert.equal(s.codexPath,undefined);assert.equal(s.providers.length,1);
  assert.equal(p.id,'worker-1');assert.equal(p.revision,'r1');assert.equal(p.displayName,'Worker 1');assert.equal(p.transport,'openai-chat');assert.equal(p.baseUrl,'http://127.0.0.1:11434/v1');assert.equal(p.model,'fixture-model');assert.equal(p.maxOutputTokens,12000);assert.equal(p.maxContextTokens,null);assert.equal(p.concurrency,1);assert.equal(p.capacityGroup,'worker-1');assert.equal(p.credentialRef,null);assert.equal(p.streaming,false);assert.deepEqual(p.roles,['worker']);
  assert.deepEqual(p.capabilities,{workerProtocol:'mosaic-structured-v1',transports:['json'],modelDiscovery:'manual',taskKinds:['coding','consult']});assert.equal(s.serviceMaxConcurrentTasks,1);assert.deepEqual(s.capacityGroups,[{id:'worker-1',limit:1}]);assert.deepEqual(s.defaults,{workerId:'worker-1',plannerWorkerId:'worker-1',review:{source:'host',hostId}});assert.deepEqual(s.execution,runtime.execution);assert.deepEqual(s.nativeCheckRuntime,runtime.nativeCheckRuntime);
  const policies=configuredPolicies(s);assert.equal(policies.providerPolicy.defaultWorkerId,'worker-1');assert.equal(policies.providerPolicy.plannerWorkerId,'worker-1');assert.equal(policies.reviewPolicy.source,'host');assert.equal(policies.reviewPolicy.hostId,hostId);assert.equal(policies.reviewPolicy.fallback,'wait');assert.deepEqual(result.entries,{});
  assert.ok(!io.prompts.some(({prompt})=>/identifier|concurrent|capacity|display name|number of/i.test(prompt)));assert.ok(io.prompts.every(({options})=>!options?.secret));
 });
 test(`simple ${hostId} app-only setup keeps host review without worker defaults`,async()=>{
  const io=simple({host:choice,location:'4'}),result=await collectPortableSetup(io.ask,io.output,runtime),s=result.settings;assert.equal(result.workerLocation,'none');assert.equal(result.presentation,'simple');assert.equal(s.host.id,hostId);assert.equal(s.codexPath,undefined);assert.deepEqual(s.providers,[]);assert.deepEqual(s.capacityGroups,[]);assert.deepEqual(s.defaults,{workerId:null,plannerWorkerId:null,review:{source:'host',hostId}});assert.deepEqual(result.entries,{});assert.equal(io.prompts.length,2);assert.equal(configuredPolicies(s).providerPolicy,undefined);assert.equal(configuredPolicies(s).reviewPolicy.hostId,hostId);
  const summary=formatPortableSetupSummary(s,{manualHost:true,workerLocation:'none'});assert.match(summary,/delegation is not ready/);assert.match(summary,/manual registration pending/);assert.match(summary,/cloud service/);assert.ok(!summary.includes('"schema"'));
 });
}
for(const [choice,location,url] of [['1','local','http://localhost:11434/v1'],['2','remote','https://worker.example:8080/v1'],['3','api','https://api.example/v1']])test(`${location} choice preserves manual URL and model without persisting topology`,async()=>{
 const io=simple({location:choice,url,model:'exact-model-2026'}),result=await collectPortableSetup(io.ask,io.output,runtime);assert.equal(result.workerLocation,location);assert.equal(result.settings.providers[0].baseUrl,url);assert.equal(result.settings.providers[0].model,'exact-model-2026');assert.equal(result.settings.providers[0].transport,'openai-chat');assert.equal(result.settings.workerLocation,undefined);assert.equal(result.settings.providers[0].location,undefined);
 assert.match(io.text(),/Approved task context goes to the supplied worker endpoint/);assert.match(io.text(),/Remote and hosted endpoints send it off this Mac/);assert.match(io.text(),/local worker does not make app review local/);assert.match(io.text(),/cloud service/);assert.match(io.text(),/will not contact the endpoint until/);if(location==='remote')assert.match(io.text(),/localhost means the computer running Mosaic/);
 const summary=formatPortableSetupSummary(result.settings,{manualHost:false,workerLocation:location});assert.ok(summary.includes(url));assert.ok(summary.includes('exact-model-2026'));assert.match(summary,/1 service slot/);assert.match(summary,/worker slots 1; capacity group slots 1/);assert.match(summary,/fixture-tested.*actual app connection remains unverified/);assert.match(summary,/does not prove coding quality or app connection/);assert.match(summary,/closed apps wait durably/);assert.ok(!summary.includes('"schema"'));
});
for(const key of [null,'dummy-plaintext-worker-key'])test(`remote HTTP is rejected before ${key?'authenticated':'unauthenticated'} setup can use it`,async()=>{
 const io=simple({location:'1',url:'http://192.0.2.1:8080/v1',key});
 await assert.rejects(collectPortableSetup(io.ask,io.output,runtime),/HTTPS.*encrypted.*loopback/i);
 assert.ok(!io.prompts.some(({prompt})=>/Model ID|bearer key/i.test(prompt)));
});
for(const url of ['http://127.7.1.2:11434/v1','http://[::1]:11434/v1'])test(`manual setup allows loopback HTTP at ${url}`,async()=>{
 const io=simple({location:'2',url});
 const {settings}=await collectPortableSetup(io.ask,io.output,runtime);
 assert.equal(settings.providers[0].baseUrl,url);
 assert.match(formatPortableSetupSummary(settings),/loopback listener on this Mac/);
});
test('setup discloses a remote destination entered under the local worker menu option',async()=>{
 const io=simple({location:'1',url:'https://worker.example/v1'});
 const result=await collectPortableSetup(io.ask,io.output,runtime);
 for(const compact of [false,true]){
  const summary=formatPortableSetupSummary(result.settings,{workerLocation:result.workerLocation,compact});
  assert.match(summary,/https:\/\/worker\.example\/v1/);
  assert.match(summary,/off this Mac|leaves this Mac/);
  assert.doesNotMatch(summary,/location: this Mac/);
 }
});
test('simple bearer key uses hidden ask and private entries only',async()=>{
 const key='dummy-wizard-private-4935',io=simple({location:'3',url:'https://api.example/v1',key}),result=await collectPortableSetup(io.ask,io.output,runtime);assert.deepEqual(result.entries,{'worker-1-key':key});assert.equal(result.settings.providers[0].credentialRef,'worker-1-key');assert.deepEqual(io.prompts.filter(p=>p.options?.secret).map(p=>p.prompt),['Bearer key (hidden): ']);await validateSettingsCredentials(null,result.settings,{schema:1,entries:result.entries});assert.ok(!JSON.stringify(result.settings).includes(key));assert.ok(!io.text().includes(key));assert.ok(!formatPortableSetupSummary(result.settings).includes(key));
});
for(const [choice,name,baseUrl] of [
 ['1','OpenAI Platform','https://api.openai.com/v1'],
 ['2','Kimi Platform','https://api.moonshot.ai/v1'],
 ['3','Z.ai GLM','https://api.z.ai/api/paas/v4'],
 ['4','OpenRouter','https://openrouter.ai/api/v1'],
])test(`hosted ${name} preset uses the documented endpoint, exact model and hidden key`,async()=>{
 const model='account-model-v2',key='dummy-hosted-key-separate';
 const io=simple({location:'3',url:choice,model,key});
 const result=await collectPortableSetup(io.ask,io.output,runtime);
 const [profile]=result.settings.providers;
 assert.equal(profile.baseUrl,baseUrl);
 assert.equal(profile.model,model);
 assert.equal(profile.displayName,name);
 assert.equal(profile.transport,'openai-chat');
 assert.equal(profile.capabilities.modelDiscovery,'manual');
 assert.deepEqual(result.entries,{'worker-1-key':key});
 assert.equal(io.prompts.filter(({options})=>options?.secret).length,1);
 assert.ok(!io.prompts.some(({prompt})=>/require an API bearer key/.test(prompt)));
 assert.match(io.text(),/paste your own.*API base URL/i);
 await validateSettingsCredentials(null,result.settings,{schema:1,entries:result.entries});
 assert.ok(!io.text().includes(key));
 assert.ok(!formatPortableSetupSummary(result.settings).includes(key));
});
test('a mistaken key in a custom endpoint is rejected before model and key questions',async()=>{
 const io=simple({location:'3',url:'sk-or-v1-synthetic-mistaken-key'});
 await assert.rejects(collectPortableSetup(io.ask,io.output,runtime),/API base URL/);
 assert.equal(io.prompts.at(-1).options.masked,true);
 assert.ok(!io.prompts.some(({prompt})=>/Model ID|bearer key/i.test(prompt)));
 assert.ok(!io.text().includes('sk-or-v1-synthetic-mistaken-key'));
});
test('named hosted preset requires an API key at setup',async()=>{
 const io=simple({location:'3',url:'2',key:''});
 await assert.rejects(collectPortableSetup(io.ask,io.output,runtime),/API key cannot be empty/);
});
test('hosted provider menu rejects an invalid provider number',async()=>{
 const io=simple({location:'3',url:'8',key:null});
 await assert.rejects(collectPortableSetup(io.ask,io.output,runtime),/Invalid hosted API provider/);
 assert.ok(!io.prompts.some(({prompt})=>/Model ID/.test(prompt)));
});
for(const [label,options,error] of [
 ['host menu',{host:'0'},/Invalid host choice/],['worker menu',{location:'7'},/Invalid worker setup choice/],
 ['blank URL',{url:''},/API base URL/],['userinfo URL',{url:'https://user:pass@example/v1'},/API base URL/],['query URL',{url:'https://api.example/v1?key=dummy'},/API base URL/],['fragment URL',{url:'https://api.example/v1#dummy'},/API base URL/],['unsupported scheme',{url:'file:///tmp/model'},/API base URL/],['blank model',{model:''},/Invalid API worker profile/],['model whitespace',{model:' model '},/Invalid API worker profile/]
])test(`simple invalid ${label} rejects without printing supplied identity`,async()=>{
 const io=simple(options);await assert.rejects(collectPortableSetup(io.ask,io.output,runtime),error);if(options.url)assert.ok(!io.text().includes(options.url));assert.ok(!io.text().includes('Mosaic setup summary'));
});
test('collection propagates EOF instead of inferring remaining answers',async()=>{
 const io=simple(),original=io.ask;let count=0;io.ask=async(...args)=>{if(++count===3)throw Error('Setup input ended');return original(...args);};await assert.rejects(collectPortableSetup(io.ask,io.output,runtime),/Setup input ended/);assert.equal(io.prompts.length,2);
});
function advanced({protocol='1',existingSettings=null,key=null,firstId='first',firstUrl='http://127.0.0.1:8011/v1',secondUrl='http://127.0.0.1:8011/v1',reviewerUrl='https://review.example/v1',keyChoice,retainedKeys={}}={}){
 const prompts=[];let output='',current='',routes=0;
 const values={first:{id:firstId,name:'First worker',url:firstUrl,model:'worker-a'},second:{id:'second',name:'Second worker',url:secondUrl,model:'worker-b'},reviewer:{id:'review',name:'API reviewer',url:reviewerUrl,model:'review-model'}};
 const ask=async(prompt,options)=>{
  prompts.push({prompt,options});if(/Choose host/.test(prompt))return '2';if(/Choose worker setup/.test(prompt))return '5';if(/Number of/.test(prompt))return '2';if(/Profile 1 identifier/.test(prompt)){current='first';return values[current].id;}if(/Profile 2 identifier/.test(prompt)){current='second';return values[current].id;}if(/Profile reviewer identifier/.test(prompt)){current='reviewer';return values[current].id;}
  if(/Display name/.test(prompt))return values[current].name;if(/API base URL/.test(prompt))return values[current].url;if(/Model ID/.test(prompt))return values[current].model;if(/Reviewer API protocol/.test(prompt))return protocol;if(/require an API bearer key|Choose how to provide the API key/.test(prompt))return current==='first'?(keyChoice??(key!==null?'y':'n')):(retainedKeys[current]===true?'k':retainedKeys[current]||'n');if(/Bearer key/.test(prompt))return key;if(/Default worker identifier/.test(prompt))return 'second';if(/Planner worker identifier/.test(prompt))return '';if(/Add an explicit specialty route/.test(prompt))return ++routes===1?'y':'n';if(/Category/.test(prompt))return 'backend';if(/^Worker identifier/.test(prompt))return firstId;if(/separately configured API reviewer/.test(prompt))return 'y';if(/Service maximum/.test(prompt))return '2';assert.fail('Unexpected advanced question: '+prompt);
 };
 return {ask,prompts,output:{write(value){output+=value;}},text:()=>output,options:{...runtime,existingSettings}};
}
for(const [protocol,transport] of [['1','openai-chat'],['2','openai-responses'],['3','anthropic-messages']])test(`advanced two-worker setup retains routes, shared capacity and ${transport} review`,async()=>{
 const io=advanced({protocol}),result=await collectPortableSetup(io.ask,io.output,io.options),s=result.settings;assert.equal(result.presentation,'advanced');assert.equal(result.workerLocation,null);assert.equal(s.host.id,'claude-code');assert.equal(s.providers.length,3);assert.equal(s.providers[2].transport,transport);assert.equal(s.providers[2].capabilities.workerProtocol,null);assert.deepEqual(s.providers[2].capabilities.taskKinds,[]);assert.equal(s.defaults.workerId,'second');assert.equal(s.defaults.plannerWorkerId,'second');assert.deepEqual(s.defaults.review,{source:'api',reviewer:{id:'review',revision:'r1'}});assert.deepEqual(s.defaults.routing,{version:1,rules:[{id:'rule-1',category:'backend',providerId:'first'}],defaultWorkerId:'second'});assert.equal(s.serviceMaxConcurrentTasks,2);assert.deepEqual(s.providers.map(p=>p.concurrency),[2,2,2]);assert.deepEqual(s.providers.map(p=>p.capacityGroup),['first','first','review']);assert.deepEqual(s.capacityGroups,[{id:'first',limit:2},{id:'review',limit:2}]);const policies=configuredPolicies(s);assert.equal(policies.providerPolicy.defaultWorkerId,'second');assert.equal(policies.reviewPolicy.source,'api');assert.equal(policies.reviewPolicy.reviewer.transport,transport);assert.equal(policies.routingPolicy.rules[0].providerId,'first');const summary=formatPortableSetupSummary(s);assert.match(summary,/separate API API reviewer/);assert.ok(summary.includes(transport));
});
test('existing schema2 uses advanced replacement path and leaves prior configuration intact during collection',async()=>{
 const first=simple({host:'3'}),existing=(await collectPortableSetup(first.ask,first.output,runtime)).settings,before=structuredClone(existing),io=advanced({existingSettings:existing}),result=await collectPortableSetup(io.ask,io.output,io.options);assert.equal(result.presentation,'advanced');assert.ok(!io.prompts.some(({prompt})=>/Choose worker setup/.test(prompt)));assert.match(io.text(),/Cancelling preserves your current workers and review settings/);assert.deepEqual(existing,before);
});
test('advanced default and planner prompts never interpolate a provider identifier equal to its key',async()=>{
 const key='dummy-private-identifier-321',io=advanced({key,firstId:key}),result=await collectPortableSetup(io.ask,io.output,io.options);assert.ok(!io.text().includes(key));assert.ok(io.prompts.every(({prompt})=>!prompt.includes(key)));await assert.rejects(validateSettingsCredentials(null,result.settings,{schema:1,entries:result.entries}),/Credential values must occur only in the private credential store/);
});

test('returning users can select a hosted preset and explicitly keep its saved key',async()=>{
 const initial=advanced({firstUrl:'https://api.moonshot.ai/v1',key:'dummy-initial-kimi-key'});
 const {settings}=await collectPortableSetup(initial.ask,initial.output,initial.options);
 const before=structuredClone(settings);
 const io=advanced({existingSettings:settings,firstUrl:'2',keyChoice:'k'});
 const result=await collectPortableSetup(io.ask,io.output,io.options);
 assert.deepEqual(result.settings.providers[0],before.providers[0]);
 assert.deepEqual(result.settings.providers[1],before.providers[1]);
 assert.deepEqual(settings,before);
 assert.deepEqual(result.entries,{});
 assert.ok(io.prompts.every(({options})=>!options?.secret));
 assert.match(io.text(),/Kimi Platform/);
});
test('returning users cannot keep a saved key after switching to another hosted preset',async()=>{
 const initial=advanced({firstUrl:'https://api.moonshot.ai/v1',key:'dummy-initial-kimi-key'});
 const {settings}=await collectPortableSetup(initial.ask,initial.output,initial.options);
 const io=advanced({existingSettings:settings,firstUrl:'1',key:'dummy-new-openai-key',keyChoice:'k'});
 const result=await collectPortableSetup(io.ask,io.output,io.options);
 assert.equal(result.settings.providers[0].baseUrl,'https://api.openai.com/v1');
 assert.deepEqual(result.entries,{'first-key':'dummy-new-openai-key'});
 assert.equal(io.prompts.filter(({options})=>options?.secret).length,1);
 assert.equal(settings.providers[0].baseUrl,'https://api.moonshot.ai/v1');
});
test('switching a profile to a hosted preset preserves the key shared by another saved profile',async()=>{
 const initial=advanced({key:'dummy-shared-original-key'});
 const {settings}=await collectPortableSetup(initial.ask,initial.output,initial.options);
 settings.providers[1].credentialRef='first-key';
 const io=advanced({existingSettings:settings,firstUrl:'1',key:'dummy-new-hosted-key',retainedKeys:{second:true}});
 const result=await collectPortableSetup(io.ask,io.output,io.options);
 assert.equal(result.settings.providers[0].credentialRef,'first-key-2');
 assert.deepEqual(result.entries,{'first-key-2':'dummy-new-hosted-key'});
 assert.equal(result.settings.providers[1].credentialRef,'first-key');
});

for(const [label,retainedIndex,options,credentialRef] of [
 ['leaves a different canonical endpoint on its existing key',1,{},'first-key-2'],
 ['rotates the shared key for a canonical alias with the same transport',1,{secondUrl:'https://API.OPENAI.COM:443/v1/'},'first-key'],
 ['leaves a different transport at the same URL on its existing key',2,{reviewerUrl:'https://api.openai.com/v1',protocol:'2'},'first-key-2'],
])test(`named preset rotation ${label}`,async()=>{
 const previousUrl='https://api.openai.com/v1';
 const oldKey='dummy-old-openai-platform-key',newKey='dummy-new-openai-platform-key';
 const initial=advanced({...options,firstUrl:previousUrl,key:oldKey});
 const {settings}=await collectPortableSetup(initial.ask,initial.output,initial.options);
 settings.providers[retainedIndex].credentialRef='first-key';

 const io=advanced({...options,existingSettings:settings,firstUrl:'1',key:newKey,keyChoice:'',
  retainedKeys:{[retainedIndex===1?'second':'reviewer']:true}});
 const result=await collectPortableSetup(io.ask,io.output,io.options);
 assert.equal(result.settings.providers[0].baseUrl,previousUrl);
 assert.equal(result.settings.providers[0].credentialRef,credentialRef);
 assert.deepEqual(result.settings.providers[retainedIndex],settings.providers[retainedIndex]);
 assert.deepEqual(result.entries,{[credentialRef]:newKey});

 const mergedEntries={'first-key':oldKey,...result.entries};
 assert.equal(mergedEntries[result.settings.providers[retainedIndex].credentialRef],credentialRef==='first-key'?newKey:oldKey);
});


for(const role of ['worker','reviewer'])test(`expanded setup isolates a rotated ${role} key from a different recipient`,async()=>{
 const oldKey='dummy-shared-old-manual-key',newKey='dummy-rotated-manual-key';
 const secondUrl='https://second-worker.example/v1';
 const initial=advanced({key:oldKey,secondUrl});
 const {settings}=await collectPortableSetup(initial.ask,initial.output,initial.options);
 const [first,second,reviewer]=settings.providers;
 const retained=role==='worker'?second:first;
 const rotated=role==='worker'?first:reviewer;
 rotated.credentialRef=retained.credentialRef='first-key';
 const io=role==='worker'
  ?advanced({existingSettings:settings,firstUrl:'https://different-worker.example/v1',secondUrl,key:newKey,retainedKeys:{second:true}})
  :advanced({existingSettings:settings,secondUrl,key:newKey,keyChoice:'k',retainedKeys:{reviewer:'y'}});
 const result=await collectPortableSetup(io.ask,io.output,io.options);
 const ref=result.settings.providers.find(profile=>profile.id===rotated.id).credentialRef;
 assert.notEqual(ref,retained.credentialRef);
 assert.deepEqual(result.entries,{[ref]:newKey});
 assert.deepEqual(result.settings.providers.find(profile=>profile.id===retained.id),retained);
});
