import test from 'node:test';
import assert from 'node:assert/strict';
import {collectPortableSetup,formatPortableSetupSummary} from '../src/beta/setup-wizard.mjs';
import {configuredPolicies,validateSettingsCredentials} from '../src/beta/settings.mjs';

const fingerprint='a'.repeat(64),runtime={execution:{backend:'darwin-seatbelt',backendRevision:2,runtimeFingerprint:fingerprint},nativeCheckRuntime:{schema:1,artifactManifestPath:'/fixture/runtime/check-artifact/artifact-manifest.json',artifactManifestSha256:fingerprint}};
function guide({count=3,locations=[1,2,3],urls=['http://localhost:8011/v1','https://remote.example/v1','https://api.example/v1'],models=['local-model','remote-model','api-model'],keys=[null,null,null],routes=['2','3','4,5'],shared={},slots='',workerSlots={},groupSlots={},defaultWorker='',planner='',resolve=''}={}){
 let text='',worker=0;const prompts=[];
 const ask=async(prompt,options)=>{prompts.push({prompt,options});text+=prompt;
  if(/Choose host/.test(prompt))return '3';if(/Choose worker setup/.test(prompt))return '6';if(/How many workers/.test(prompt))return String(count);
  const numbered=prompt.match(/^Worker (\d+) /);if(numbered)worker=Number(numbered[1])-1;
  if(/location/.test(prompt))return String(locations[worker]);if(/API base URL/.test(prompt))return urls[worker];if(/Model ID/.test(prompt))return models[worker];if(/require an API bearer key/.test(prompt))return keys[worker]===null?'n':'y';if(/Bearer key/.test(prompt)){assert.equal(options?.secret,true);return keys[worker];}
  if(/specialties/.test(prompt))return routes[worker]??'';if(/Resolve/.test(prompt))return resolve;if(/Default worker number/.test(prompt))return defaultWorker;if(/Planner worker number/.test(prompt))return planner;
  if(/shares physical capacity/.test(prompt))return shared[worker+1]??'';if(/Total concurrent/.test(prompt))return slots;if(/Worker \d+ maximum/.test(prompt))return workerSlots[worker+1]??'';
  const group=prompt.match(/^Shared service (\d+) maximum/);if(group)return groupSlots[group[1]]??'';
  assert.fail('Unexpected question: '+prompt);
 };return {ask,output:{write:v=>{text+=v;}},text:()=>text,prompts};
}
for(const count of [2,3])test(`guided ${count} workers produce normalized neutral pool, routes and safe defaults`,async()=>{
 const io=guide({count}),r=await collectPortableSetup(io.ask,io.output,runtime),s=r.settings,ids=count===2?['worker-1','worker-2']:['worker-1','worker-2','worker-3'];
 assert.equal(r.presentation,'guided');assert.deepEqual(s.providers.map(p=>p.id),ids);assert.deepEqual(s.providers.map(p=>p.model),count===2?['local-model','remote-model']:['local-model','remote-model','api-model']);assert.equal(s.serviceMaxConcurrentTasks,1);assert.ok(s.providers.every(p=>p.concurrency===1));assert.ok(s.capacityGroups.every(g=>g.limit===1));assert.equal(s.defaults.workerId,'worker-1');assert.equal(s.defaults.plannerWorkerId,'worker-1');assert.deepEqual(s.defaults.review,{source:'host',hostId:'cursor'});
 const policy=configuredPolicies(s);assert.equal(policy.routingPolicy.defaultWorkerId,'worker-1');assert.deepEqual(policy.routingPolicy.rules.map(r=>[r.category,r.providerId]),count===2?[['backend','worker-1'],['frontend','worker-2']]:[['backend','worker-1'],['frontend','worker-2'],['tests','worker-3'],['docs','worker-3']]);
 assert.match(io.text(),/chosen routes|chosen specialties/i);assert.match(io.text(),/not.*(?:best|quality)|does not.*(?:best|quality)/i);assert.ok(!io.prompts.some(p=>/identifier|Display name/.test(p.prompt)));
 const summary=formatPortableSetupSummary(s);for(const [i,p] of s.providers.entries()){assert.ok(summary.includes(`Worker ${i+1}`));assert.ok(summary.includes(p.model));assert.ok(summary.includes(p.baseUrl));}assert.match(summary,/default.*planner|planner.*default/i);assert.match(summary,/backend/);assert.match(summary,/frontend/);assert.match(summary,/shared service|capacity group/i);
});
test('guided explicit defaults and allowed overlap retain independent worker and shared service limits',async()=>{
 const io=guide({defaultWorker:'3',planner:'2',slots:'4',workerSlots:{1:'2',2:'1',3:'3'},groupSlots:{1:'2',2:'1',3:'3'}}),s=(await collectPortableSetup(io.ask,io.output,runtime)).settings;
 assert.equal(s.defaults.workerId,'worker-3');assert.equal(s.defaults.plannerWorkerId,'worker-2');assert.equal(s.serviceMaxConcurrentTasks,4);assert.deepEqual(s.providers.map(p=>p.concurrency),[2,1,3]);assert.deepEqual(s.capacityGroups.map(g=>g.limit),[2,1,3]);assert.match(formatPortableSetupSummary(s),/4 service slots/);
});
test('canonical endpoint aliases always share physical capacity and a single default slot',async()=>{
 const io=guide({urls:['https://EXAMPLE.test:443/v1/','https://example.test/v1','https://other.test/v1']}),s=(await collectPortableSetup(io.ask,io.output,runtime)).settings;
 assert.deepEqual(s.providers.map(p=>p.capacityGroup),['worker-1','worker-1','worker-3']);assert.deepEqual(s.capacityGroups,[{id:'worker-1',limit:1},{id:'worker-3',limit:1}]);assert.equal(s.providers[0].baseUrl,s.providers[1].baseUrl);
 assert.ok(!io.prompts.some(p=>/^Worker 2 shares/.test(p.prompt)),'An alias cannot be declared independent');
});
test('different URLs can explicitly share a known physical server with transitive alias membership',async()=>{
 const io=guide({urls:['https://first.test/v1','https://second.test/v1','https://SECOND.test:443/v1/'],shared:{2:'1'}}),s=(await collectPortableSetup(io.ask,io.output,runtime)).settings;
 assert.deepEqual(s.providers.map(p=>p.capacityGroup),['worker-1','worker-1','worker-1']);assert.deepEqual(s.capacityGroups,[{id:'worker-1',limit:1}]);assert.equal(configuredPolicies(s).providerPolicy.capacityGroups.length,1);
});
for(const [resolve,want] of [['1','worker-1'],['2','worker-2']])test(`duplicate specialty requires explicit resolution (${resolve})`,async()=>{
 const io=guide({count:2,routes:['2','2'],resolve}),s=(await collectPortableSetup(io.ask,io.output,runtime)).settings;
 assert.equal(io.prompts.filter(p=>/Resolve/.test(p.prompt)).length,1);assert.deepEqual(s.defaults.routing.rules.map(r=>[r.category,r.providerId]),[['backend',want]]);
});
for(const kind of ['literal','percent','json'])test(`all worker credentials validate before an earlier ${kind} identity can be published`,async()=>{
 const key=kind==='json'?'dummy-private-"\\-later':'dummy-private-later';const encoded=kind==='percent'?[...key].map(c=>'%'+c.charCodeAt(0).toString(16)).join(''):kind==='json'?JSON.stringify(key).slice(1,-1):key;
 const io=guide({models:[encoded,'safe-second','safe-third'],keys:[null,null,key]});
 await assert.rejects(collectPortableSetup(io.ask,io.output,runtime),/Credential values must occur only/);assert.ok(io.prompts.every(p=>!p.prompt.includes(key)&&!p.prompt.includes(encoded)));assert.ok(!io.text().includes(key));assert.ok(!io.text().includes(encoded));
});
test('each worker retains its own hidden key without exposing any entered identity in subsequent questions',async()=>{
 const keys=['dummy-private-one','dummy-private-two','dummy-private-three'],io=guide({keys}),r=await collectPortableSetup(io.ask,io.output,runtime);
 assert.deepEqual(r.entries,{'worker-1-key':keys[0],'worker-2-key':keys[1],'worker-3-key':keys[2]});assert.deepEqual(r.settings.providers.map(p=>p.credentialRef),['worker-1-key','worker-2-key','worker-3-key']);await validateSettingsCredentials(null,r.settings,{schema:1,entries:r.entries});assert.equal(io.prompts.filter(p=>p.options?.secret).length,3);
 for(const key of keys)assert.ok(!io.text().includes(key));
});
for(const options of [{slots:'5'},{defaultWorker:'4'},{planner:'0'},{routes:['7']},{count:1},{count:4},{keys:['',null,null]},{count:2,routes:['2','2'],resolve:'3'}])test(`invalid guided choice rejects without preview (${JSON.stringify(options)})`,async()=>{const io=guide(options);await assert.rejects(collectPortableSetup(io.ask,io.output,runtime));assert.doesNotMatch(io.text(),/Mosaic setup summary/);});
for(const encode of [value=>value,value=>[...value].map(c=>'%'+c.charCodeAt(0).toString(16)).join(''),value=>[...value].map(c=>'%25'+c.charCodeAt(0).toString(16)).join('')])test('an earlier endpoint containing a later private key is rejected before any identity publication',async()=>{
 const key='dummy-url-later-private',url='https://first.test/v1/'+encode(key),io=guide({urls:[url,'https://second.test/v1','https://third.test/v1'],keys:[null,null,key]});
 await assert.rejects(collectPortableSetup(io.ask,io.output,runtime),/Credential values must occur only/);assert.ok(!io.text().includes(url));assert.ok(io.prompts.every(p=>!p.prompt.includes(url)));
});
const unicodeIdentity=value=>[...value].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('');
for(const [form,encode] of [['slash',value=>value.replaceAll('/','\\/')],['unicode',unicodeIdentity],['percent-json',value=>encodeURIComponent(unicodeIdentity(value))],['nested-json',value=>unicodeIdentity(value).replaceAll('\\','\\u005c')]])for(const field of ['model','url'])test(`reversible ${form} ${field} identity rejects before any candidate or summary can escape`,async()=>{
 const key='later/key',encoded=encode(key),io=guide({count:2,keys:[null,key],routes:['',''],...(field==='model'?{models:[encoded,'safe-model']}:{urls:['https://first.test/v1/'+encoded,'https://second.test/v1']})});
 await assert.rejects(collectPortableSetup(io.ask,io.output,runtime),/Credential values must occur only/);assert.ok(!io.text().includes(encoded));
});
const jsonIdentity=value=>JSON.stringify(value).slice(1,-1);
for(const [form,encode] of [['json-unicode',value=>jsonIdentity(unicodeIdentity(value))],['percent-json-unicode',value=>encodeURIComponent(jsonIdentity(unicodeIdentity(value)))],['double-json-unicode',value=>jsonIdentity(jsonIdentity(unicodeIdentity(value)))]])for(const field of ['model','url'])test(`composed ${form} ${field} identity rejects a later key before returning settings`,async()=>{
 const key='review/key',encoded=encode(key),io=guide({count:2,keys:[null,key],routes:['',''],...(field==='model'?{models:[encoded,'safe-model']}:{urls:['https://first.test/v1/'+encoded,'https://second.test/v1']})});
 await assert.rejects(collectPortableSetup(io.ask,io.output,runtime),/Credential values must occur only/);assert.ok(!io.text().includes(encoded));assert.ok(io.prompts.every(({prompt})=>!prompt.includes(encoded)));
});
test('unrelated escaped identities remain unchanged in the guided settings and summary',async()=>{
 const model='safe\\\\u006dodel\\/variant%2fraw',url='https://first.test/v1/safe%5Cu006dodel%2fvariant',io=guide({count:2,models:[model,'safe-model'],urls:[url,'https://second.test/v1'],keys:[null,'review/key'],routes:['','']}),result=await collectPortableSetup(io.ask,io.output,runtime);
 assert.equal(result.settings.providers[0].model,model);assert.equal(result.settings.providers[0].baseUrl,url);assert.equal(result.entries['worker-2-key'],'review/key');const summary=formatPortableSetupSummary(result.settings);assert.ok(summary.includes(model));assert.ok(summary.includes(url));
});

test('guided hosted presets keep an exact model and a separate private key per worker',async()=>{
 const keys=['dummy-openai-guided-key','dummy-kimi-guided-key','dummy-glm-guided-key'];
 const io=guide({locations:[4,5,6],models:['openai-model','kimi-model','glm-model'],keys});
 const result=await collectPortableSetup(io.ask,io.output,runtime);
 assert.deepEqual(result.settings.providers.map(({baseUrl,model,credentialRef})=>[baseUrl,model,credentialRef]),[
  ['https://api.openai.com/v1','openai-model','worker-1-key'],
  ['https://api.moonshot.ai/v1','kimi-model','worker-2-key'],
  ['https://api.z.ai/api/paas/v4','glm-model','worker-3-key'],
 ]);
 assert.deepEqual(Object.values(result.entries),keys);
 assert.ok(!io.prompts.some(({prompt})=>/API base URL|require an API bearer key/.test(prompt)));
 assert.equal(io.prompts.filter(({options})=>options?.secret).length,3);
 const summary=formatPortableSetupSummary(result.settings);
 for(const name of ['OpenAI Platform','Kimi Platform','Z.ai GLM'])assert.ok(summary.includes(name));
 for(const key of keys)assert.ok(!summary.includes(key));
});
