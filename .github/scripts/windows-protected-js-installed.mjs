import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const directory = process.argv[2];
const candidate = JSON.parse(await readFile(path.join(directory,'candidate.json'),'utf8'));
const archived = process.env.GITHUB_REF === 'refs/heads/codex/windows-private-restart';
if (archived) {
  assert.equal(candidate.sourceCommit,'7cf176d1cdb3260182f5e1c1e7ac3a673c93af7b');
  assert.equal(candidate.sourceTree,'17586a60fa4f26b5d7ed23d6314952071eb7be4b');
  assert.equal(candidate.archiveSha256,'78f5ef24be34a7cfefd4cc4f0e07e5bda7181b71c5286c20c7606f42886fd311');
  assert.equal(candidate.javascriptFingerprint,'dcc13cfd0085e091f3ae444615c0e14eaee4d7368fdf8f6243b1ebab8337b84c');
} else assert.equal(candidate.sourceCommit, process.env.GITHUB_SHA);
assert.match(candidate.javascriptFingerprint, /^[a-f0-9]{64}$/);
const bootstrap = path.join(directory,'install.ps1'), archive = path.join(directory,candidate.archiveName);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(digest(await readFile(bootstrap)), candidate.bootstrapSha256);
assert.equal(digest(await readFile(archive)), candidate.archiveSha256);
const root = await mkdtemp(path.join(process.env.RUNNER_TEMP,'Mosaic isolated JS install '));
const env = {...process.env};
const installRoot = path.join(env.LOCALAPPDATA,'Mosaic Beta');
await assert.rejects(lstat(installRoot),{code:'ENOENT'});
const exec = promisify(execFile);
const ps = path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
try {
  await exec(ps,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',bootstrap,
    '-Archive',archive,'-ArchiveSha256',candidate.archiveSha256,'-Version',candidate.version,'-NoGuide'],
  {env, windowsHide:true, timeout:150000});
  const installed = path.join(installRoot,'versions',candidate.version);
  const runtime = path.join(installed,'runtime'), artifact = path.join(runtime,'javascript-check-artifact');
  const metadata = await readFile(path.join(installed,'package-manifest.json'));
  assert.equal(digest(metadata), candidate.packageManifestSha256);
  assert.equal(JSON.parse(metadata).javascriptCheckArtifact.fingerprint, candidate.javascriptFingerprint);
  const node = path.join(runtime,'bin','node.exe');
  const verify = String.raw`
    import {validateWindowsJavaScriptArtifact} from ${JSON.stringify(pathToFileURL(path.join(runtime,'src','project','check-backends','windows-js-artifact.mjs')).href)};
    import {readBundledNativeCheckRuntime} from ${JSON.stringify(pathToFileURL(path.join(runtime,'src','beta','package-contract.mjs')).href)};
    const old = await readBundledNativeCheckRuntime();
    if (old.artifactManifestSha256 !== ${JSON.stringify(candidate.nativeFingerprint)}) throw Error('Legacy runtime changed identity');
    const result = validateWindowsJavaScriptArtifact(JSON.parse(process.argv[1]));
    process.stdout.write(JSON.stringify(result));
  `;
  const check = dir => exec(node,['--input-type=module','-e',verify,JSON.stringify({schema:1,
    artifactManifestPath:path.join(dir,'javascript-artifact.json'), artifactManifestSha256:candidate.javascriptFingerprint})],
  {env, windowsHide:true, timeout:30000});
  const verified = JSON.parse((await check(artifact)).stdout);
  assert.equal(verified.files.length,12);
  assert.equal(verified.backend.id,'windows-isolated-js');
  const tampered = path.join(root,'tampered runtime');
  await cp(artifact,tampered,{recursive:true});
  await writeFile(path.join(tampered,'isolated-js-program.mjs'),'throw Error("Must never run");\n');
  await assert.rejects(check(tampered), error => error.stderr.includes('Isolated JavaScript artifact file changed'));
  const help = await exec(path.join(installRoot,'bin','mosaic.exe'),['--help'],{env,windowsHide:true,timeout:30000});
  assert.match(help.stdout,/Mosaic/);
  await reviewInvoice({runtime,node,artifact});
  console.log(JSON.stringify({source:candidate.sourceCommit, fingerprint:verified.fingerprint, verified:verified.files.length,
    tamperedBootstrapRejected:true, guidedSetupConfigured:true}));
} finally {
  await rm(installRoot,{recursive:true,force:true,maxRetries:8,retryDelay:200});
  await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:200});
}

async function reviewInvoice({runtime,node,artifact}) {
  const repo = path.join(root,'Invoice project'), state = path.join(root,'Installed service state');
  await mkdir(path.join(repo,'src'),{recursive:true});
  await mkdir(path.join(repo,'checks'));
  const source = 'src/total.mjs', script = 'checks/verify.mjs';
  const check = `import {invoiceTotal} from '../src/total.mjs';
if (invoiceTotal(1250, 250) !== 1500) throw 'Include shipping';
if (invoiceTotal(1250, 0) !== 1250) throw 'Preserve zero shipping';
`;
  const baseSource = 'export function invoiceTotal(subtotal, shipping) { return subtotal; }\n';
  const fixedSource = 'export function invoiceTotal(subtotal, shipping) { return subtotal + shipping; }\n';
  await Promise.all([writeFile(path.join(repo,source),baseSource),writeFile(path.join(repo,script),check),
    writeFile(path.join(repo,'.gitattributes'),'* text eol=lf\n')]);
  const git = async (...args) => (await exec('git.exe',['-C',repo,...args],{windowsHide:true})).stdout;
  await git('init','--quiet','--template=','--initial-branch=main');
  await git('config','user.name','Mosaic Windows Fixture');
  await git('config','user.email','fixture@example.invalid');
  await git('add','--','.');
  await git('commit','--quiet','-m','Baseline invoice fixture');
  const base = (await git('rev-parse','HEAD')).trim();
  const executionPolicy = {version:1,backend:'windows-isolated-js',backendRevision:1,runtimeFingerprint:candidate.javascriptFingerprint};
  const module = relative => import(pathToFileURL(path.join(runtime,relative)));
  const {readBundledJavaScriptCheckRuntime} = await module('src/beta/package-contract.mjs');
  const manifest = JSON.parse(await readFile(path.join(runtime,'..','package-manifest.json'),'utf8'));
  const nativeCheckRuntime = await readBundledJavaScriptCheckRuntime(runtime,manifest.javascriptCheckArtifact);
  assert.equal(nativeCheckRuntime.artifactManifestSha256,candidate.javascriptFingerprint);
  const settings = {schema:2,host:{id:'claude-code',options:{}},providers:[],capacityGroups:[],serviceMaxConcurrentTasks:1,
    defaults:{workerId:null,plannerWorkerId:null,review:{source:'host',hostId:'claude-code'}},
    execution:{backend:executionPolicy.backend,backendRevision:executionPolicy.backendRevision,
      runtimeFingerprint:executionPolicy.runtimeFingerprint},nativeCheckRuntime};
  const {configuredPolicies} = await module('src/beta/settings.mjs');
  const {locations,privateDirectories,saveJson} = await module('src/beta/files.mjs');
  const paths = locations(env.USERPROFILE);
  await privateDirectories(paths);
  const installedVersion = path.dirname(runtime);
  const lifecycle = path.join(installedVersion,'distribution','windows','lifecycle.mjs');
  const status = () => exec(node,[lifecycle,'coding-status'],{env,windowsHide:true,timeout:30000});
  await assert.rejects(status(), error => error.code===3 && /Protected coding is in development/.test(error.stdout));
  await saveJson(paths.config,settings);
  assert.equal((await status()).stdout,'');
  console.log('The installed guide passes the saved, verified JavaScript policy and holds unconfigured coding.');
  const config = {beta:true,hostId:'claude-code',executionPolicy,nativeCheckRuntime,configuredPolicies:configuredPolicies(settings)};
  const service = String.raw`
    import {serve} from ${JSON.stringify(pathToFileURL(path.join(runtime,'src','harness','cli.mjs')).href)};
    await serve({root:process.argv[1], port:0, runtimeConfig:JSON.parse(process.argv[2]),headless:true});
  `;
  let active, endpoint;
  async function startService() {
    const child = spawn(node,['--input-type=module','-e',service,state,JSON.stringify(config)], {
      env,windowsHide:true,stdio:['ignore','pipe','pipe'],
    });
    const closed = once(child,'close');
    const lines = createInterface({input:child.stdout});
    active = {child,closed,lines};
    let errors = '';
    child.stderr.on('data', bytes => { if (errors.length < 8192) errors += bytes; });
    const [line] = await Promise.race([once(lines,'line'),closed.then(() => {throw Error(errors);}),
      delay(25000,[],{ref:false})]);
    assert.ok(line,'Installed coordinator did not start');
    endpoint = JSON.parse(await readFile(path.join(state,'connection.json'),'utf8'));
    assert.equal(new URL(endpoint.url).hostname,'127.0.0.1');
  }
  const invoke = async (name,input={}) => {
    const result = await fetch(new URL('/api/invoke',endpoint.url),{method:'POST',
      headers:{'content-type':'application/json',authorization:'Bearer '+endpoint.token},
      body:JSON.stringify({name,input}),signal:AbortSignal.timeout(90000)});
    const body = await result.json();
    if (!result.ok) throw Error(name + ' failed: ' + body.error);
    return body;
  };
  async function stopService(crash = false) {
    if (!active) return;
    const {child,closed,lines} = active;
    if (child.exitCode === null && child.signalCode === null) {
      if (crash) assert.ok(child.kill());
      else await invoke('service_stop',{idempotencyKey:'windows-js-close-'+child.pid}).catch(()=>{});
      const result = await Promise.race([closed,delay(2500,null,{ref:false})]);
      if (!result && child.exitCode === null && child.signalCode === null) child.kill();
    }
    await closed;
    lines.close();
    active = undefined;
  }
  try {
    await startService();
    const key = (name,input,id=name) => invoke(name,{...input,idempotencyKey:'windows-js-'+id});
    const operation = async (name,input,id=name) => {
      const {id:operationId} = await key(name,input,id);
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        const saved = await invoke('operation_get',{operationId});
        if (saved.status === 'completed') return saved.result;
        if (!['running','pending','capacity_wait'].includes(saved.status))
          throw Error(name + ' ' + saved.status + ' ' + saved.error);
        await delay(100);
      }
      throw Error(name+' exceeded fixture deadline');
    };
    const {runFirstTask} = await module('src/beta/first-task.mjs');
    const firstTaskPaths = {...paths,state};
    let transcript = '', prepared;
    const replies = ['1','Include shipping in the invoice total','Preserve zero shipping','src/, checks/',source,'node checks/verify.mjs'];
    const wizardStatus = await runFirstTask(firstTaskPaths,['--repo',repo],{
      ask:async prompt => {
        assert.ok(replies.length,'Unexpected guided prompt: '+prompt);
        return replies.shift();
      },
      output:{write:text=> { transcript += text; }},
      invoke:async (name,input)=>{
        const reply = name==='assignment_prepare'
          ? await invoke(name,{...input,manifest:{...input.manifest,environment:'fixture'}})
          : await invoke(name,input);
        if(name==='assignment_prepare')prepared=reply;
        return reply;
      },
    });
    assert.equal(wizardStatus,0,transcript);
    assert.deepEqual(replies,[]);
    assert.match(transcript,/Windows checks support dependency-free JavaScript modules/);
    assert.match(transcript,/Claude Code only/);
    assert.equal(prepared.status,'prepared');
    const draft = await invoke('goal_get',{goalId:prepared.goalId});
    assert.deepEqual(draft.manifest.project.checks[0].argv,[path.join(artifact,'node.exe'),script]);
    const goal = await key('goal_activate',{goalId:draft.id,hash:draft.hash});
    const task = await key('task_submit',{goalId:goal.id,task:{submissionId:'invoice',actor:'codex',kind:'coding',
      objective:'Include shipping',acceptance:['Both invoice totals are correct']}});
    const started = await operation('native_start',{taskId:task.id,layout:'candidate_v1'});
    assert.equal(await readFile(path.join(started.native.worktree,source),'utf8'),baseSource);
    await writeFile(path.join(started.native.worktree,source),fixedSource);
    await operation('native_finish',{taskId:task.id,summary:'Included shipping'});
    const item = (await invoke('review_inbox',{goalId:goal.id})).items.find(value=>value.taskId===task.id);
    assert.ok(item,'Checked candidate did not reach review');
    const ticket = await key('review_reserve',item.binding);
    await key('review_submit',{ticketId:ticket.ticketId,...item.binding,
      verdict:{decision:'accept',feedback:'Scripted host reviewed the exact invoice diff and protected evidence.',findings:[]}});
    let context = await invoke('owner_action_context',{goalId:goal.id,taskId:task.id});
    const originalBinding = context.candidate.binding;
    if (archived) {
      await stopService(true);
      await startService();
      context = await invoke('owner_action_context',{goalId:goal.id,taskId:task.id});
      assert.equal(context.candidate.binding,originalBinding);
    }
    const integrate = {taskId:task.id,expectedIntegrationBinding:context.candidate.binding,feedback:'Integrate the approved invoice change'};
    const accepted = await operation('task_integrate',integrate);
    if (archived) {
      await stopService();
      await startService();
    }
    const repeated = await operation('task_integrate',integrate);
    assert.equal(accepted.integration.commit,repeated.integration.commit);
    assert.equal((await git('rev-list','--parents','-1',accepted.integration.commit)).trim(),accepted.integration.commit+' '+base);
    assert.equal((await git('diff','--name-only',base,accepted.integration.commit)).trim(),source);
    assert.equal(await git('show',accepted.integration.commit+':'+script),check);
    assert.equal(await git('show',accepted.integration.commit+':'+source),fixedSource);
    assert.equal(accepted.integration.checks[0].backend.id,'windows-isolated-js');
    assert.equal(accepted.integration.checks[0].quiescence.activeProcesses,0);
    assert.equal((await git('rev-parse','HEAD')).trim(),base);
    console.log(JSON.stringify({integration:accepted.integration.commit,baseline:base,approvedCheckSha256:digest(check),
      scriptedReview:true,replayReturnedSameCommit:true,coordinatorReplacedBeforeAndAfterIntegration:archived,configuredWorkers:0}));
  } finally {
    await stopService();
  }
}
