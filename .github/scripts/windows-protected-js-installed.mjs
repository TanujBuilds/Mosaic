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
import {DatabaseSync} from 'node:sqlite';
import {startInvoiceWorker} from './windows-worker-loopback.mjs';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const directory = process.argv[2];
const candidate = JSON.parse(await readFile(path.join(directory,'candidate.json'),'utf8'));
assert.equal(candidate.sourceCommit, process.env.GITHUB_SHA);
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
  await verifyGitConsent(installed);
  await reviewInvoice({runtime,node,artifact});
  await reviewInvoice({runtime,node,artifact,collaborative:true});
  console.log(JSON.stringify({source:candidate.sourceCommit, fingerprint:verified.fingerprint, verified:verified.files.length,
    tamperedBootstrapRejected:true, guidedSetupConfigured:true}));
} finally {
  await rm(installRoot,{recursive:true,force:true,maxRetries:8,retryDelay:200});
  await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:200});
}

async function verifyGitConsent(installed) {
  const guide = path.join(installed,'distribution','windows','guide.ps1');
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    $tokens = $errors = $null
    $program = [Management.Automation.Language.Parser]::ParseFile($env:MOSAIC_TEST_GUIDE,[ref]$tokens,[ref]$errors)
    if ($errors.Count) { throw 'Bundled guide does not parse in Windows PowerShell 5.1' }
    $function = $program.Find({param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Require-Git'
    }, $false)
    . ([ScriptBlock]::Create($function.Extent.Text))
    function Get-Git { if ($script:ready) { return 'C:\Program Files\Git\cmd\git.exe' } }
    function Install-GitForWindows {
        $script:installCalls++
        $script:ready = $script:installSucceeds
        return $script:ready
    }
    function Read-Host([string]$prompt) {
        $script:prompts.Add($prompt)
        if ($script:answers.Count -eq 0) { throw "Unexpected prompt: $prompt" }
        $reply = $script:answers.Dequeue()
        if ($reply -eq 'recheck') { $script:ready = $true }
        return $reply
    }
    function Assert-Case($name, $initiallyReady, $installSucceeds, [string[]]$answers, $expectedCalls, $expectFound) {
        $script:ready = $initiallyReady
        $script:installSucceeds = $installSucceeds
        $script:installCalls = 0
        $script:prompts = [Collections.Generic.List[string]]::new()
        $script:answers = [Collections.Generic.Queue[string]]::new()
        foreach ($answer in $answers) { $script:answers.Enqueue($answer) }
        $result = Require-Git
        if ($script:answers.Count -or $script:installCalls -ne $expectedCalls -or [bool]$result -ne $expectFound) {
            throw "Unexpected Git consent result: $name"
        }
        if (-not $initiallyReady -and $script:prompts[0] -notmatch '\[y/N\]$') { throw 'Consent must default to No' }
        Write-Output "PASS Git prerequisite $name"
    }
    Assert-Case 'existing' $true $false @() 0 $true
    Assert-Case 'auto install and rediscover' $false $true @('y') 1 $true
    Assert-Case 'default no and manual recheck' $false $false @('', 'recheck') 0 $true
    Assert-Case 'no and defer' $false $false @('n','later') 0 $false
    Assert-Case 'failed auto and manual recheck' $false $false @('y','recheck') 1 $true
  `;
  const result = await exec(ps,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],
    {env:{...env,MOSAIC_TEST_GUIDE:guide}, windowsHide:true, timeout:30000});
  assert.match(result.stdout,/PASS Git prerequisite failed auto and manual recheck/);
  console.log(result.stdout);
}

async function reviewInvoice({runtime,node,artifact,collaborative=false}) {
  const caseRoot = path.join(root,collaborative?'Collaborative':'App-only');
  const repo = path.join(caseRoot,'Invoice project');
  await mkdir(path.join(repo,'src'),{recursive:true});
  await mkdir(path.join(repo,'checks'));
  const source = 'src/total.mjs', script = 'checks/verify.mjs';
  const check = `import {invoiceTotal} from '../src/total.mjs';
if (invoiceTotal(1250, 250) !== 1500) throw 'Include shipping';
if (invoiceTotal(1250, 0) !== 1250) throw 'Preserve zero shipping';
`;
  const baseSource = 'export function invoiceTotal(subtotal, shipping) { return subtotal; }\n';
  const fixedSource = 'export function invoiceTotal(subtotal, shipping) { return subtotal + shipping; }\n';
  await using worker = collaborative ? await startInvoiceWorker({source,baseSource,fixedSource,script,check}) : null;
  await Promise.all([writeFile(path.join(repo,source),baseSource),writeFile(path.join(repo,script),check),
    writeFile(path.join(repo,'.gitattributes'),'* text eol=lf\n')]);
  const git = async (...args) => (await exec('git.exe',['-C',repo,...args],{windowsHide:true})).stdout;
  await git('init','--quiet','--template=','--initial-branch=main');
  await git('config','user.name','Mosaic Windows Fixture');
  await git('config','user.email','fixture@example.invalid');
  await git('add','--','.');
  await git('commit','--quiet','-m','Baseline invoice fixture');
  const base = (await git('rev-parse','HEAD')).trim();
  const rejectionRepo = worker ? path.join(caseRoot,'Invoice scope rejection project') : null;
  if (rejectionRepo) {
    // The scope-denied candidate remains retained. Its write scope must not
    // overlap the independent passing fixture's repository.
    await exec('git.exe',['clone','--quiet','--no-hardlinks','--',repo,rejectionRepo],{windowsHide:true});
    const rejectionBase = (await exec('git.exe',['-C',rejectionRepo,'rev-parse','HEAD'],{windowsHide:true})).stdout.trim();
    assert.equal(rejectionBase,base);
  }
  const executionPolicy = {version:1,backend:'windows-isolated-js',backendRevision:1,runtimeFingerprint:candidate.javascriptFingerprint};
  const module = relative => import(pathToFileURL(path.join(runtime,relative)));
  const {readBundledJavaScriptCheckRuntime} = await module('src/beta/package-contract.mjs');
  const manifest = JSON.parse(await readFile(path.join(runtime,'..','package-manifest.json'),'utf8'));
  const nativeCheckRuntime = await readBundledJavaScriptCheckRuntime(runtime,manifest.javascriptCheckArtifact);
  assert.equal(nativeCheckRuntime.artifactManifestSha256,candidate.javascriptFingerprint);
  const {version,...execution} = executionPolicy;
  const {configuredPolicies,readCredentials,readSettings} = await module('src/beta/settings.mjs');
  const {locations,privateDirectories,saveJson} = await module('src/beta/files.mjs');
  const home = collaborative ? path.join(caseRoot,'Disposable home') : env.USERPROFILE;
  if (collaborative) await mkdir(home);
  const paths = locations(home,collaborative);
  await privateDirectories(paths);
  if (worker) {
    const {setupPortable,portableSetupComplete} = await module('src/beta/portable-setup.mjs');
    const {HOST_IDS} = await module('src/beta/hosts/index.mjs');
    const prompts = [
      [/Choose host/u,String(HOST_IDS.indexOf('claude-code')+1)],
      [/Choose worker setup/u,'3'],
      [/API base URL/u,worker.url],
      [/Model ID/u,worker.model],
      [/require an API bearer key/u,'y'],
      [/Bearer key \(hidden\)/u,worker.key,{secret:true}],
      [/Show technical settings details/u,'n'],
      [/Run optional model discovery/u,'n'],
      [/Run optional inference connectivity test/u,'n'],
      [/Apply this exact setup and managed host binding/u,'y'],
    ];
    let setupOutput = '';
    assert.equal(await setupPortable(paths,{execution,nativeCheckRuntime,
      ask:async (prompt,options) => {
        const item = prompts.shift();
        assert.ok(item,'Unexpected setup question: '+prompt);
        assert.match(prompt,item[0]);
        if (item[2]) assert.deepEqual(options,item[2]);
        return item[1];
      },
      output:{write:value => { setupOutput += value; }},
    }),true);
    assert.deepEqual(prompts,[]);
    assert.equal(await portableSetupComplete(paths),true);
    assert.equal((await readCredentials(paths)).entries['worker-1-key'],worker.key);
    assert.ok(!setupOutput.includes(worker.key),'Secret appeared in setup output');
    assert.ok(!(await readFile(paths.config,'utf8')).includes(worker.key),'Secret appeared in settings');
    assert.deepEqual(worker.requests,[],'Saving setup should not contact the configured worker');
  } else {
    const lifecycle = path.join(path.dirname(runtime),'distribution','windows','lifecycle.mjs');
    const status = () => exec(node,[lifecycle,'coding-status'],{env,windowsHide:true,timeout:30000});
    await assert.rejects(status(), error => error.code===3 && /Protected coding is in development/.test(error.stdout));
    await saveJson(paths.config,{schema:2,host:{id:'claude-code',options:{}},providers:[],capacityGroups:[],serviceMaxConcurrentTasks:1,
      defaults:{workerId:null,plannerWorkerId:null,review:{source:'host',hostId:'claude-code'}},execution,nativeCheckRuntime});
    assert.equal((await status()).stdout,'');
    console.log('The installed guide passes the saved, verified JavaScript policy and holds unconfigured coding.');
  }
  const settings = await readSettings(paths);
  const state = collaborative ? paths.state : path.join(caseRoot,'Installed service state');
  const service = worker ? String.raw`
    import {serveBeta} from ${JSON.stringify(pathToFileURL(path.join(runtime,'src','beta','service.mjs')).href)};
    import {locations} from ${JSON.stringify(pathToFileURL(path.join(runtime,'src','beta','files.mjs')).href)};
    import {readSettings} from ${JSON.stringify(pathToFileURL(path.join(runtime,'src','beta','settings.mjs')).href)};
    const paths = locations(process.argv[1], true);
    await serveBeta(paths,await readSettings(paths));
  ` : String.raw`
    import {serve} from ${JSON.stringify(pathToFileURL(path.join(runtime,'src','harness','cli.mjs')).href)};
    await serve({root:process.argv[1], port:0, runtimeConfig:JSON.parse(process.argv[2]),headless:true});
  `;
  const appConfig = {beta:true,hostId:'claude-code',executionPolicy,nativeCheckRuntime,configuredPolicies:configuredPolicies(settings)};
  const serviceArgs = worker ? [home] : [state,JSON.stringify(appConfig)];
  const child = spawn(node,['--input-type=module','-e',service,...serviceArgs], {
    env,windowsHide:true,stdio:['ignore','pipe','pipe'],
  });
  let errors = '';
  child.stderr.on('data', bytes => { errors += bytes; });
  const closed = once(child,'close');
  const lines = createInterface({input:child.stdout});

  let invoke;
  try {
    const [line] = await Promise.race([once(lines,'line'),closed.then(() => {throw Error(errors);}),
      delay(20000,[] ,{ref:false})]);
    assert.ok(line,'Installed coordinator did not start');
    const endpoint = JSON.parse(await readFile(path.join(state,'connection.json'),'utf8'));
    assert.equal(new URL(endpoint.url).hostname,'127.0.0.1');
    invoke = async (name,input={}) => {
      const result = await fetch(new URL('/api/invoke',endpoint.url),{method:'POST',
        headers:{'content-type':'application/json',authorization:'Bearer '+endpoint.token},
        body:JSON.stringify({name,input}),signal:AbortSignal.timeout(90000)});
      const body = await result.json();
      if (!result.ok) throw Error(name + ' failed: ' + body.error);
      return body;
    };
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
    const prepare = async (mode,project=repo) => {
      let transcript = '', prepared;
      const replies = [mode,'Include shipping in the invoice total','Preserve zero shipping','src/, checks/',source,'node checks/verify.mjs'];
      const wizardStatus = await runFirstTask(firstTaskPaths,['--repo',project],{
        ask:async prompt => {
          assert.ok(replies.length,'Unexpected guided prompt: '+prompt);
          return replies.shift();
        },
        output:{write:text => { transcript += text; }},
        invoke:async (name,input) => {
          const reply = name==='assignment_prepare' && !worker
            ? await invoke(name,{...input,manifest:{...input.manifest,environment:'fixture'}})
            : await invoke(name,input);
          if (name==='assignment_prepare') prepared=reply;
          return reply;
        },
      });
      assert.equal(wizardStatus,0,transcript);
      assert.deepEqual(replies,[]);
      assert.match(transcript,/Windows checks support dependency-free JavaScript modules/);
      assert.match(transcript,/Claude Code only/);
      if (mode === 'collaborative') assert.match(transcript,/Collaborative/);
      assert.doesNotMatch(transcript,/^\s*\d+\. (?:API-worker-only|Overnight review)/mu);
      assert.equal(prepared.status,'prepared');
      const draft = await invoke('goal_get',{goalId:prepared.goalId});
      assert.equal(draft.manifest.mode.id,mode);
      return draft;
    };
    const draft = await prepare(collaborative?'collaborative':'codex_only',rejectionRepo??repo);
    assert.deepEqual(draft.manifest.project.checks[0].argv,[path.join(artifact,'node.exe'),script]);
    const taskSpec = (actor,submissionId) => ({actor,submissionId,kind:'coding',
      objective:'Include shipping',acceptance:['Both invoice totals are correct'],
      limits:{attempts:1,modelCalls:1,reviews:1,questions:0}});
    const activate = (draft,id) => key('goal_activate',{goalId:draft.id,hash:draft.hash},id);
    const abandon = async (goal,id) => {
      await key('work_control',{goalId:goal.id,action:'stop'},'stop-'+id);
      await key('goal_finalize',{goalId:goal.id,summary:'Completed the negative control',partial:true},'finalize-'+id);
    };
    const submit = (goal,actor,id) => key('task_submit',{
      goalId:goal.id,expectedGoalHash:goal.hash,expectedGoalVersion:goal.version,task:taskSpec(actor,id),
    },id);
    const waitTask = async (taskId,status) => {
      const deadline = Date.now()+90000;
      while (Date.now()<deadline) {
        const task = await invoke('task_get',{taskId});
        if (task.status===status) return task;
        if (['blocked','failed','uncertain','stopped','awaiting_review','ready_to_integrate'].includes(task.status))
          throw Error(`Task reached ${task.status} while waiting for ${status}: ${task.reason??''}`);
        await delay(100);
      }
      throw Error('Worker task did not reach '+status);
    };
    const requests = () => {
      const db = new DatabaseSync(path.join(state,'harness.sqlite3'),{readOnly:true});
      try { return db.prepare('SELECT kind,status FROM requests ORDER BY rowid').all().map(row => [row.kind,row.status]); }
      finally { db.close(); }
    };
    if (worker) {
      assert.deepEqual(draft.manifest.providerPolicy,configuredPolicies(settings).providerPolicy);
      assert.deepEqual(draft.manifest.reviewPolicy,{version:1,source:'host',hostId:'claude-code',fallback:'wait'});
      assert.ok(!JSON.stringify(draft).includes(worker.key),'Credential leaked into approval');
      const {assertExecutionAvailable} = await module('src/harness/execution.mjs');
      const deny = /requires host review and either coding-app-only or Collaborative/u;
      for (const change of [
        {mode:{id:'deepseek_only',version:1}},
        {mode:{id:'overnight_review',version:1}},
        {reviewPolicy:{source:'api'}},
        {providerPolicy:undefined},
        {workerProfile:{legacy:true}},
      ]) {
        assert.throws(() => assertExecutionAvailable({...draft.manifest,...change},{nativeCheckRuntime}),deny);
      }
      const app = await activate(await prepare('codex_only'),'configured-app-only');
      assert.equal(app.manifest.providerPolicy,undefined);
      await assert.rejects(submit(app,'deepseek','app-only-worker-denied'),/Mode prohibits actor/u);
      assert.deepEqual(requests(),[]);
      assert.deepEqual(worker.requests,[]);
      await abandon(app,'configured-app-only');
      const denied = await activate(draft,'scope-denial');
      assert.deepEqual(worker.requests,[],'Activation alone must not dispatch a coding worker');
      const negative = await submit(denied,'deepseek','reject-invoice-edit');
      const blocked = await waitTask(negative.id,'blocked');
      assert.match(blocked.reason,/Write outside approved scope: checks\/verify\.mjs/u);
      assert.equal(blocked.spent.model,1);
      assert.deepEqual((await invoke('review_inbox',{goalId:denied.id})).items,[]);
      const worktree = path.join(state,'coding','artifacts',negative.id,'worktree');
      assert.equal(await readFile(path.join(worktree,source),'utf8'),baseSource);
      assert.equal(await readFile(path.join(worktree,script),'utf8'),check);
      await abandon(denied,'scope-denial');
    }
    const goal = await activate(worker?await prepare('collaborative'):draft,'approve-invoice');
    const task = await submit(goal,worker?'deepseek':'codex','repair-invoice');
    if (worker) {
      const checked = await waitTask(task.id,'awaiting_review');
      assert.equal(checked.spent.model,1);
      assert.equal(checked.providerBinding.providerId,'worker-1');
      assert.equal(checked.providerBinding.policyHash,goal.manifest.providerPolicyHash);
      assert.equal(await readFile(path.join(checked.result.worktree,source),'utf8'),fixedSource);
      assert.equal(await readFile(path.join(checked.result.worktree,script),'utf8'),check);
      assert.ok(checked.result.checks[0].passed);
      assert.equal(checked.result.checks[0].backend.id,'windows-isolated-js');
      assert.equal(checked.result.checks[0].quiescence.activeProcesses,0);
    } else {
      const started = await operation('native_start',{taskId:task.id,layout:'candidate_v1'});
      assert.equal(await readFile(path.join(started.native.worktree,source),'utf8'),baseSource);
      await writeFile(path.join(started.native.worktree,source),fixedSource);
      await operation('native_finish',{taskId:task.id,summary:'Included shipping'});
    }
    const item = (await invoke('review_inbox',{goalId:goal.id})).items.find(value=>value.taskId===task.id);
    assert.ok(item?.waitingForHost,'Checked candidate did not reach host review');
    const ticket = await key('review_reserve',item.binding);
    assert.equal(ticket.reviewer.source,'host');
    assert.equal(ticket.reviewer.hostId,'claude-code');
    assert.deepEqual(ticket.binding,item.binding);
    assert.equal(ticket.evidence.baseCommit,base);
    assert.equal(ticket.evidence.files.find(file => file.path===source)?.content,fixedSource);
    assert.equal(ticket.evidence.files.find(file => file.path===script)?.content,check);
    assert.deepEqual(ticket.evidence.checks.map(({passed,code}) => [passed,code]),[[true,0]]);
    await key('review_submit',{ticketId:ticket.ticketId,...item.binding,
      verdict:{decision:'accept',feedback:'Scripted host reviewed the exact invoice diff and protected evidence.',findings:[]}});
    const context = await invoke('owner_action_context',{goalId:goal.id,taskId:task.id});
    const integrate = {taskId:task.id,expectedIntegrationBinding:context.candidate.binding,feedback:'Integrate the approved invoice change'};
    const accepted = await operation('task_integrate',integrate);
    const repeated = await operation('task_integrate',integrate);
    assert.equal(accepted.integration.commit,repeated.integration.commit);
    assert.equal((await git('rev-list','--parents','-1',accepted.integration.commit)).trim(),accepted.integration.commit+' '+base);
    assert.equal((await git('rev-list','--count',base+'..'+accepted.integration.commit)).trim(),'1');
    assert.equal((await git('diff','--name-only',base,accepted.integration.commit)).trim(),source);
    assert.equal(await git('show',accepted.integration.commit+':'+script),check);
    assert.equal(await git('show',accepted.integration.commit+':'+source),fixedSource);
    assert.equal(accepted.integration.checks[0].backend.id,'windows-isolated-js');
    assert.equal(accepted.integration.checks[0].quiescence.activeProcesses,0);
    assert.equal((await git('rev-parse','HEAD')).trim(),base);
    assert.equal(await git('status','--porcelain'),'');
    assert.equal((await key('goal_finalize',{goalId:goal.id,summary:'Integrated the approved invoice repair'})).status,'completed');
    if (worker) {
      assert.deepEqual(worker.failures,[]);
      assert.deepEqual(worker.requests,[
        {method:'POST',path:'/v1/chat/completions',task:'reject-invoice-edit'},
        {method:'POST',path:'/v1/chat/completions',task:'repair-invoice'},
      ]);
      assert.deepEqual(requests(),[['model','completed'],['model','completed']]);
    } else assert.deepEqual(requests(),[]);
    console.log(JSON.stringify({integration:accepted.integration.commit,baseline:base,approvedCheckSha256:digest(check),
      scriptedReview:true,replayReturnedSameCommit:true,configuredWorkers:worker?1:0,
      ...(worker?{appOnlyWorkerDenied:true,outOfScopeBatchDenied:true,workerRequests:2}:{})}));
  } finally {
    if (invoke) await invoke('service_stop',{idempotencyKey:'windows-js-close'}).catch(()=>{});
    if (child.exitCode === null) {
      const result = await Promise.race([closed,delay(2500, null,{ref:false})]);
      if (!result && child.exitCode === null) child.kill();
    }
    await closed;
    lines.close();
  }
}
