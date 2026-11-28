import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ElicitRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {locations, privateDirectories, saveJson} from '../src/beta/files.mjs';
import {repositoryCommonDirectory} from '../src/harness/assignment-intake.mjs';
import {digest} from '../src/harness/contracts.mjs';

async function bridge(t, {elicitation, answer, worker = false} = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mosaic-project-chat-'));
  const paths = locations(home, true);
  await privateDirectories(paths);
  const host = 'claude-code';
  const provider = {schema:1,id:'local',revision:'r1',displayName:'Local',transport:'openai-chat',
    baseUrl:'http://127.0.0.1:1/v1',model:'test',roles:['worker'],capabilities:{workerProtocol:'mosaic-structured-v1',
      transports:['json'],modelDiscovery:'manual',taskKinds:['coding']},maxContextTokens:null,maxOutputTokens:4096,
    concurrency:1,capacityGroup:'local',credentialRef:null,streaming:false};
  await saveJson(paths.config, {schema:2,host:{id:host,options:{}},providers:worker ? [provider] : [],
    defaults:{workerId:worker ? 'local' : null,plannerWorkerId:worker ? 'local' : null,review:{source:'host',hostId:host}},
    execution:{backend:'codex-sandbox',backendRevision:1},codexPath:process.execPath,serviceMaxConcurrentTasks:1,
    capacityGroups:worker ? [{id:'local',limit:1}] : []});
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const {name} = JSON.parse(body);
    calls.push(name);
    res.writeHead(name === 'tools_list' ? 200 : 400, {'content-type':'application/json'});
    res.end(JSON.stringify(name === 'tools_list' ? [] : {error:'Unexpected coordinator call'}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(home, {recursive:true, force:true});
  });
  await saveJson(path.join(paths.state, 'connection.json'), {
    url:'http://127.0.0.1:' + server.address().port, token:randomBytes(32).toString('hex'),
  });
  const client = new Client({name:'project-chat-test', version:'1'}, {capabilities:elicitation ? {elicitation} : {}});
  if (answer) client.setRequestHandler(ElicitRequestSchema, ({params}) => answer(params));
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({command:process.execPath,
    args:[fileURLToPath(new URL('../src/beta/cli.mjs', import.meta.url)), '--home', home, 'mcp'],stderr:'pipe'}));
  async function choose(args = {}) {
    const result = await client.callTool({name:'choose_workflow',arguments:args});
    const value = JSON.parse(result.content[0].text);
    if (result.isError) throw Error(value.error);
    return value;
  }
  return {client, choose, calls, paths};
}

test('a connected project chat discovers the entry point and gets one text choice when forms are unavailable', async t => {
  const {client, choose, calls} = await bridge(t);
  assert.equal((await client.listTools()).tools[0].name, 'choose_workflow');
  assert.match(client.getInstructions(), /use Mosaic.*choose_workflow/s);
  assert.match(client.getInstructions(), /active goal’s pinned mode/);
  assert.match(client.getInstructions(), /approval/);
  const result = await choose();
  assert.equal(result.status, 'choice_required');
  assert.equal(result.choices.length, 4);
  assert.equal(result.recommendedMode, 'codex_only');
  assert.equal(result.choices.find(item => item.mode === 'codex_only').label, 'Claude Code only');
  assert.equal(result.choices.filter(item => item.requiresSetup).length, 3);
  const chosen = await choose({mode:'codex_only'});
  assert.equal(chosen.mode, 'codex_only');
  assert.equal(chosen.status, 'selected');
  assert.equal((await choose({mode:'collaborative'})).status, 'setup_required');
  await assert.rejects(choose({mode:'auto'}), /workflow/);
  await assert.rejects(choose({approve:true}), /unknown field/);
  await assert.rejects(choose({repo:'relative'}), /absolute/);
  assert.deepEqual(calls, ['tools_list']);
});

for (const [scenario, elicitation] of [['modern', {form:{}}], ['legacy', {}]]) {
  test(scenario + ' native form selects exactly the workflow the user accepts', async t => {
    let count = 0;
    const {choose, calls} = await bridge(t, {elicitation, worker:true, answer:params => {
      count++;
      const field = params.requestedSchema.properties.workflow;
      assert.equal(field.enum.length, 4);
      assert.equal(field.default, undefined);
      assert.deepEqual(params.requestedSchema.required, ['workflow']);
      assert.deepEqual(Object.keys(params.requestedSchema.properties), ['workflow']);
      assert.match(params.message, /Which workflow/);
      return {action:'accept',content:{workflow:field.enum.find(label => label.startsWith('API worker only'))}};
    }});
    const result = await choose();
    assert.equal(result.mode, 'deepseek_only');
    assert.equal(result.source, 'picker');
    assert.equal(result.status, 'selected');
    assert.equal((await choose({mode:'overnight_review'})).mode, 'overnight_review');
    assert.equal(count, 1);
    assert.deepEqual(calls, ['tools_list']);
  });
}

test('cancel, decline, invalid and missing form answers all leave the task unstarted', async t => {
  const answers = [{action:'cancel'}, {action:'decline'}, {action:'accept',content:{workflow:'imaginary'}}, {action:'accept'}];
  const {choose, calls} = await bridge(t, {elicitation:{form:{}}, answer:() => answers.shift()});
  assert.equal((await choose()).status, 'cancelled');
  assert.equal((await choose()).status, 'cancelled');
  await assert.rejects(choose(), /valid workflow choice/);
  await assert.rejects(choose(), /valid workflow choice/);
  assert.deepEqual(calls, ['tools_list']);
});

test('a host advertising only URL requests gets the chat question', async t => {
  const {choose} = await bridge(t, {elicitation:{url:{}}});
  assert.equal((await choose()).status, 'choice_required');
});

test('a host missing its advertised form handler gets the chat question', async t => {
  const {choose} = await bridge(t, {elicitation:{form:{}}});
  assert.equal((await choose()).status, 'choice_required');
});

test('an owner-saved project workflow is reused, and an explicit choice wins', async t => {
  const {choose, paths, calls} = await bridge(t, {elicitation:{form:{}}, worker:true,
    answer:() => { throw Error('Unexpected picker'); }});
  const repo = path.join(paths.home, 'project');
  execFileSync('git', ['init', '--quiet', repo]);
  const key = digest(await repositoryCommonDirectory(repo));
  await saveJson(path.join(paths.configDir,'project-preset-' + key + '.json'), {
    schema:1, mode:'overnight_review', worker:null, checks:[],
  });
  const saved = await choose({repo});
  assert.equal(saved.source, 'project_preset');
  assert.equal(saved.mode, 'overnight_review');
  assert.equal((await choose({repo, mode:'codex_only'})).mode, 'codex_only');
  assert.deepEqual(calls, ['tools_list']);
});
