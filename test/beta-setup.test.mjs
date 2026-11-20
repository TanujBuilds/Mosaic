import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {locations,privateDirectories,saveJson} from '../src/beta/files.mjs';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Goals} from '../src/harness/goals.mjs';
import {detectCodingApps} from '../src/beta/hosts/detection.mjs';
import {readHostConnection,recordHostConnection} from '../src/beta/hosts/connection-evidence.mjs';

const cli=fileURLToPath(new URL('../src/beta/cli.mjs',import.meta.url));
const setupModule=new URL('../src/beta/setup.mjs',import.meta.url).href;
const codexOnly='1\ny\n';
const workerSetup='2\nProbe Worker\nhttps://fixture.invalid/v1\nn\nc\nn\nfixture-model\nn\ny\n';
const run=(paths,args=['setup'],input=codexOnly)=>spawnSync(process.execPath,[cli,'--home',paths.home,...args],{input,encoding:'utf8',timeout:10000});
const bytes=async file=>JSON.parse(await readFile(file,'utf8'));

async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'Mosaic beta setup '));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const paths=locations(path.join(root,'fixture'),true);
 await privateDirectories(paths);
 const sentinel=path.join(root,'outside-fixture-mcp');
 const codex=path.join(paths.home,'.local','bin','codex');
 await mkdir(path.dirname(codex),{recursive:true});
 await writeFile(paths.launcher,'#!/bin/sh\nexit 0\n',{mode:0o755});
 await writeFile(codex,`#!/bin/sh
case "$*" in
 "login status") exit 0 ;;
 "mcp list --json") if [ -e "${sentinel}" ]; then cat "${sentinel}"; else echo '[]'; fi ;;
 "mcp add mosaic-beta -- "*)
  shift 4
  printf '[{"name":"mosaic-beta","enabled":true,"transport":{"type":"stdio","command":"%s","args":["mcp"]}}]\\n' "$1" > "${sentinel}" ;;
 "mcp remove mosaic-beta") unlink "${sentinel}" ;;
 *) exit 2 ;;
esac
`,{mode:0o755});
 return {paths,codex,sentinel,root};
}

test('isolated setup and uninstall keep registrations under the fixture home',async t=>{
 const {paths,sentinel}=await fixture(t);
 const setup=run(paths);
 assert.equal(setup.status,0,setup.stderr);
 await assert.rejects(readFile(sentinel),{code:'ENOENT'});
 assert.match(setup.stdout,/Isolated MCP/);
 assert.equal(run(paths,['uninstall'],'').status,0);
 await assert.rejects(readFile(sentinel),{code:'ENOENT'});
});

test('after uninstall retained settings route bare mosaic back into setup',async t=>{
 const {paths}=await fixture(t);
 assert.equal(run(paths).status,0);
 const outage=run(paths,[],'');
 assert.match(outage.stdout,/Disconnected/);
 assert.doesNotMatch(outage.stdout,/Mosaic Beta setup/);
 assert.equal(run(paths,['uninstall'],'').status,0);
 assert.ok(await bytes(paths.config));
 const bare=run(paths,[],'1\nn\n');
 assert.match(bare.stdout,/Mosaic Beta setup/);
 assert.doesNotMatch(bare.stdout,/Terminal observer/);
});

test('still-applicable worker draft revisions block maintenance until the stopped goal is finalized',async t=>{
 const {paths}=await fixture(t);
 const initial=run(paths,['setup'],workerSetup);
 assert.equal(initial.status,0,initial.stderr);
 const before=await bytes(paths.config);
 const c=new Coordinator({root:paths.state,beta:true,selectedHost:'codex',workerProfile:before.worker.profile});
 let goal,revision;
 const manifest={submissionId:'revision-probe',objective:'Original goal',acceptance:['Scope check']};
 try{
  goal=c.prepareGoal(manifest,'prepare');
  c.activateGoal({goalId:goal.id,hash:goal.hash},'activate');
  c.control({goalId:goal.id,action:'stop'},'stop');
  revision=new Goals(c).prepareRevision({goalId:goal.id,expectedHash:goal.hash,manifest:{...manifest,objective:'Updated goal'}},'revision');
 }finally{c.close();}
 const rejected=run(paths);
 assert.notEqual(rejected.status,0);
 assert.match(rejected.stderr,/prepared.*revision.*finalize/i);
 assert.deepEqual(await bytes(paths.config),before);
 const retired=new Coordinator({root:paths.state,beta:true,selectedHost:'codex',workerProfile:before.worker.profile});
 try{
  const goals=new Goals(retired);
  assert.equal(goals.finalize({goalId:goal.id,partial:true,summary:'Retire stopped goal and its draft'},'finalize').status,'partial');
  assert.throws(()=>goals.activateRevision({revisionId:revision.id,hash:revision.hash},'activate-retired'),/terminal/i);
 }finally{retired.close();}
 const changed=run(paths);
 assert.equal(changed.status,0,changed.stderr);
 assert.equal((await bytes(paths.config)).worker,null);
});

test('setup resumes an approved interrupted update using its private durable intent', {skip:process.platform!=='darwin'},async t=>{
 const {paths}=await fixture(t);
 assert.equal(run(paths).status,0);
 const chflags=flag=>spawnSync('/usr/bin/chflags',[flag,paths.ownership],{encoding:'utf8'});
 assert.equal(chflags('uchg').status,0);
 try{
  const interrupted=run(paths,['setup'],workerSetup);
  assert.notEqual(interrupted.status,0);
 }finally{assert.equal(chflags('nouchg').status,0);}
 const resume=run(paths,['setup'],'');
 assert.equal(resume.status,0,resume.stderr);
 assert.match(resume.stdout,/Resumed interrupted setup/);
 assert.equal((await bytes(paths.config)).worker.profile.model,'fixture-model');
});

test('setup recovers a committed MCP write after its process dies',async t=>{
 const {paths}=await fixture(t);
 const childCode=`
 import {setup} from ${JSON.stringify(setupModule)};
 import {saveJson} from ${JSON.stringify(new URL('../src/beta/files.mjs',import.meta.url).href)};
 const paths=${JSON.stringify({...paths,isolatedMcp:path.join(paths.configDir,'isolated-mcp.json')})};
 const registrations={get:async()=>null,add:async()=>{
  await saveJson(paths.isolatedMcp,{name:'mosaic-beta',enabled:true,transport:{type:'stdio',command:paths.launcher,args:['mcp']}});
  process.kill(process.pid,'SIGKILL');
 }};
 await setup(paths,{registrations});
 `;
 const killed=spawnSync(process.execPath,['--input-type=module','-e',childCode],{input:codexOnly,encoding:'utf8',timeout:10000});
 assert.equal(killed.signal,'SIGKILL');
 const resume=run(paths,['setup'],'');
 assert.equal(resume.status,0,resume.stderr);
 assert.match(resume.stdout,/Resumed interrupted setup/);
 assert.ok(await bytes(paths.config));
});

test('a PTY paste of the key choice and credential never echoes the credential', {skip:process.platform!=='darwin'},async t=>{
 const {paths}=await fixture(t);
 const fake='FIXTURE-PASTED-CREDENTIAL-h4pz';
 const driver=`
import errno, os, pty, select, signal, sys, time
node, cli, fixture, key = sys.argv[1:]
steps = [(b'Choose [1]: ', b'2\\r'), (b'Display name: ', b'Fixture\\r'), (b'include /v1 if required): ', b'https://fixture.invalid/v1\\r'),
         (b'Use a bearer key?', ('y\\r'+key+'\\r').encode()), (b'Responses [C]', b'c\\r'), (b'Request model IDs', b'n\\r'),
         (b'Model ID: ', b'fixture-model\\r'), (b'Send one connection-test prompt', b'n\\r'),
         (b'Apply these beta settings', b'y\\r')]
pid, fd = pty.fork()
if pid == 0: os.execv(node, [node, cli, '--home', fixture, 'setup'])
output = b''
deadline = time.monotonic() + 4
while time.monotonic() < deadline:
    if select.select([fd], [], [], .1)[0]:
        try:
            output += os.read(fd, 4096)
        except OSError as error:
            if error.errno != errno.EIO: raise
        if steps and steps[0][0] in output:
            os.write(fd, steps.pop(0)[1])
    child, status = os.waitpid(pid, os.WNOHANG)
    if child:
        sys.stdout.buffer.write(output)
        sys.exit(os.waitstatus_to_exitcode(status) if not steps else 7)
os.kill(pid, signal.SIGKILL)
os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
sys.exit(8)
`;
 const result=spawnSync('python3',['-c',driver,process.execPath,cli,paths.home,fake],{encoding:'utf8',timeout:8000});
 assert.equal(result.status,0,result.stdout.replaceAll(fake,'[fixture credential]'));
 assert.equal(result.stdout.includes(fake),false,'the typed fixture key is absent from the PTY transcript');
 assert.equal((await bytes(paths.config)).worker.apiKey,fake);
});

test('isolated setup refuses to follow a fixture Codex directory symlink',async t=>{
 const {paths,root}=await fixture(t);
 const outside=path.join(root,'outside-codex');
 await mkdir(outside);
 await symlink(outside,path.join(paths.home,'.codex'));
 const refused=run(paths);
 assert.notEqual(refused.status,0);
 assert.match(refused.stderr,/unsafe directory in isolated fixture/i);
 await assert.rejects(readFile(path.join(outside,'skills','mosaic-beta','SKILL.md')),{code:'ENOENT'});
});

test('a superseded revision permits exact setup but a stopped approval blocks worker removal until finalized',async t=>{
 const {paths}=await fixture(t);
 const initial=run(paths,['setup'],workerSetup);
 assert.equal(initial.status,0,initial.stderr);
 const before=await bytes(paths.config);
 const c=new Coordinator({root:paths.state,beta:true,selectedHost:'codex',workerProfile:before.worker.profile}),goals=new Goals(c);
 const manifest={submissionId:'revision-probe',objective:'Original goal',acceptance:['Scope check']};
 let goal;
 try{
  goal=c.prepareGoal(manifest,'prepare');
  c.activateGoal({goalId:goal.id,hash:goal.hash},'activate');
  c.control({goalId:goal.id,action:'stop'},'stop');
  const draft=(key,objective)=>goals.prepareRevision({goalId:goal.id,expectedHash:goal.hash,manifest:{...manifest,objective}},key);
  const stale=draft('old','Older revision'),superseding=draft('new','Approved revision');
  goals.activateRevision({revisionId:superseding.id,hash:superseding.hash},'approve-new');
  assert.throws(()=>goals.activateRevision({revisionId:stale.id,hash:stale.hash},'activate-old'),/stale/i);
 }finally{c.close();}
 const reapplied=run(paths,['setup'],workerSetup);
 assert.equal(reapplied.status,0,reapplied.stderr);
 assert.deepEqual(await bytes(paths.config),before);
 const rejected=run(paths);
 assert.notEqual(rejected.status,0);
 assert.match(rejected.stderr,/stopped approval.*resume.*finalize/i);
 assert.deepEqual(await bytes(paths.config),before);
 const retiring=new Coordinator({root:paths.state,beta:true,selectedHost:'codex',workerProfile:before.worker.profile});
 try{assert.equal(new Goals(retiring).finalize({goalId:goal.id,partial:true,summary:'Retire stopped approval before removing its worker'},'finalize-before-worker-removal').status,'partial');}
 finally{retiring.close();}
 const changed=run(paths);
 assert.equal(changed.status,0,changed.stderr);
 assert.equal((await bytes(paths.config)).worker,null);
});

function terminalSetup(steps,{width=72,terminal='xterm-256color',plain=false}={}){
 const driver=fileURLToPath(new URL('./fixtures/mosaic-m021-terminal/drive.py',import.meta.url));
 const subject=fileURLToPath(new URL('./fixtures/mosaic-m021-terminal/setup.mjs',import.meta.url));
 const child=spawnSync('python3',[driver,process.execPath,subject,String(width),terminal,plain?'yes':'no',JSON.stringify(steps)],
  {encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
 assert.equal(child.status,0,child.stderr||String(child.error));
 const result=JSON.parse(child.stdout.split('MOSAIC_SETUP_RESULT ')[1].trim());
 assert.equal(result.raw,false);
 return {transcript:child.stdout,result};
}

test('host detection finds known executables and app bundles without running them',async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'Mosaic detected hosts '));
 t.after(()=>rm(home,{recursive:true,force:true}));
 const paths=locations(home,true),bin=path.join(home,'.local','bin');
 assert.deepEqual(await detectCodingApps(paths),[]);
 await mkdir(bin,{recursive:true});
 await writeFile(path.join(bin,'codex'),'#!/bin/sh\nexit 9\n',{mode:0o755});
 await writeFile(path.join(bin,'agy'),'#!/bin/sh\nexit 9\n',{mode:0o755});
 await writeFile(path.join(bin,'claude'),'not executable',{mode:0o644});
 const contents=path.join(home,'Applications','Cursor.app','Contents');
 await mkdir(contents,{recursive:true});
 await writeFile(path.join(contents,'Info.plist'),'fixture bundle');
 assert.deepEqual(await detectCodingApps(paths),['codex','cursor','antigravity']);
});

test('registry call evidence belongs to the saved settings and is invalidated by a host change',async t=>{
 const {paths}=await fixture(t);
 const initial=run(paths);
 assert.equal(initial.status,0,initial.stderr);
 const settings=await bytes(paths.config);
 assert.equal(await readHostConnection(paths),null);
 await recordHostConnection(paths,settings);
 const receipt=await readHostConnection(paths);
 assert.equal(receipt.kind,'registry_call');
 assert.equal(receipt.hostId,'codex');
 assert.ok(Number.isSafeInteger(receipt.at));
 await saveJson(paths.config,{...settings,host:{id:'cursor',options:{}}});
 await recordHostConnection(paths,settings);
 assert.equal(await readHostConnection(paths),null);
});

test('portable setup uses the blue tiled welcome and arrow keys to go back, select a host and save', {skip:process.platform!=='darwin'},()=>{
 const {transcript,result}=terminalSetup([
  ['Pick your coding app','\x1b[B\x1b[B\r'],
  ['Choose a worker','\x1b'],
  ['Pick your coding app','\x1b[A\r'],
  ['Choose a worker','\r'],
  ['Show technical settings details?','\r'],
  ['Save this setup?','\x1b'],
  ['Choose a worker','\r'],
  ['Show technical settings details?','\r'],
  ['Save this setup?','\x1b[A\r']
 ]);
 assert.match(transcript,/\x1b\[34m■/u);
 assert.match(transcript,/Welcome to Mosaic/);
 assert.doesNotMatch(transcript,/\x1b\[(?:[4-5][0-9]|10[0-7])m/u);
 assert.match(transcript,/actual host registration is unverified/i);
 assert.equal(result.saved,true);
 assert.equal(result.host,'claude-code');
});

for(const exit of ['q','\x03'])test(`narrow setup shows the compact mark and cancels safely with ${exit==='q'?'q':'Ctrl+C'}`,{skip:process.platform!=='darwin'},()=>{
 const {transcript,result}=terminalSetup([['Pick your coding app',exit]],{width:38});
 assert.match(transcript,/\x1b\[34m■ {3}■\r?\n■■ ■■\r?\n■ ■ ■/u);
 assert.equal(result.host,undefined);
 assert.equal(result.credentialsWritten,false);
 assert.match(result.error??transcript,/Setup (?:interrupted|exited|cancelled)/i);
});

test('an open setup menu redraws at the new width without a navigation key', {skip:process.platform!=='darwin'},()=>{
 const {result}=terminalSetup([
  ['q / Ctrl+C exit',76],
  ['Up/Down move | Enter confirm | q / Ctrl+C exit',38],
  ['q / Ctrl+C exit','q']
 ],{width:38});
 assert.equal(result.host,undefined);
 assert.equal(result.credentialsWritten,false);
});

for(const policy of [{plain:true},{terminal:'dumb'}])test(`plain portable setup accepts numbered answers for ${policy.plain?'NO_COLOR':'TERM=dumb'}`,{skip:process.platform!=='darwin'},()=>{
 const {transcript,result}=terminalSetup([
  ['Choose host [1]: ','3\r'],
  ['Choose worker setup [1]: ','4\r'],
  ['Show technical settings details? [y/N] ','n\r'],
  ['Run optional model discovery check? [y/N] ','n\r'],
  ['Run optional inference connectivity test with that fixed setup-only message? [y/N] ','n\r'],
  ['Apply this exact setup and managed host binding? [y/N] ','y\r']
 ],policy);
 assert.doesNotMatch(transcript,/\x1b\[34m|■/u);
 assert.equal(result.host,'cursor');
 assert.equal(result.saved,true);
});

test('pasted bearer key stays hidden after navigating with arrow keys', {skip:process.platform!=='darwin'},()=>{
 const key='mosaic-fixture-secret-should-stay-hidden';
 const {transcript,result}=terminalSetup([
  ['Pick your coding app','\r'],
  ['Choose a worker','\x1b[B\r'],
  ['API base URL: ','http://127.0.0.1:1/v1\r'],
  ['Model ID: ','demo-model\r'],
  ['Does this endpoint require an API bearer key? [y/N] ','y\r'+key+'\r'],
  ['Show technical settings details?','\r'],
  ['Check the worker model list?','\r'],
  ['Test the worker connection?','\r'],
  ['Save this setup?','q']
 ]);
 assert.match(transcript,/Bearer key \(hidden\)/);
 assert.ok(!transcript.includes(key));
 assert.equal(result.host,undefined);
 assert.equal(result.credentialsWritten,false);
});
