import {mkdir, rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {windowsFile, windowsWrite} from '../../beta/windows-files.mjs';
import {digest, matches, Pause} from '../contracts.mjs';
import {gitBytes} from '../git.mjs';
import {superviseWindowsCheck, windowsDependencyInventory, windowsRelativePath} from './windows-appcontainer.mjs';
import {validateWindowsJavaScriptArtifact, windowsJavaScriptBackend} from './windows-js-artifact.mjs';

const probe = `
for (const name of ['process','require','fetch','WebSocket','std','os']) {
  if (globalThis[name] !== undefined) throw 'Unexpected capability';
}
let denied = false;
try { await import('node:fs'); } catch { denied = true; }
if(!denied) throw 'Unexpected built-in';
const approvedModule = './approved.mjs';
if ((await import(approvedModule)).fixture !== 42) throw 'Input mismatch';
`;
const supported = /\.(?:js|mjs)$/u;
const isolation = message => new Pause(message, 'isolation');
const timeoutLimit = 60_000;

export function assertWindowsJavaScriptChecks(project, node) {
  if (!project?.checks?.length) throw isolation('An approved JavaScript check is required');
  for (const check of project.checks) {
    const entry = check.argv[1];
    if (check.argv.length !== 2 || check.argv[0] !== node || !supported.test(entry) ||
        !matches(entry,project.readPaths) || matches(entry,project.writePaths) ||
        check.env && Object.keys(check.env).length || check.screenshots?.length)
      throw isolation('Windows isolated checks require the bundled Node selector and one read-only JavaScript module without arguments, environment or screenshots');
    windowsRelativePath(entry);
  }
}

export function isolatedJavaScriptRuntime(config, expected) {
  if (expected !== undefined && config?.artifactManifestSha256 !== expected)
    throw isolation('Windows isolated JavaScript fingerprint differs from the approved policy');
  const artifact = validateWindowsJavaScriptArtifact(config);
  const [node, supervisor] = artifact.files;
  return {...artifact, runtime:{executable:path.join(artifact.root,node.path),sha256:node.sha256},
    supervisor:{executable:path.join(artifact.root,supervisor.path),sha256:supervisor.sha256,protocol:1}};
}

export class WindowsIsolatedJavaScriptCheckRunner {
  constructor(workspace, options) {
    this.workspace = workspace;
    this.options = options;
    const runtime = isolatedJavaScriptRuntime(options.nativeCheckRuntime, options.expectedRuntimeFingerprint);
    this.backendIdentity = {...windowsJavaScriptBackend, executable:runtime.supervisor.executable, runtime};
  }

  async verify(signal) {
    this.verifyDependencies();
    const entry = 'probe.mjs';
    const modules = [[entry,probe],['approved.mjs','export const fixture = 42;']];
    const argv = [this.backendIdentity.runtime.runtime.executable,'-e',probe];
    const result = await this.execute({entry,modules,argv,signal,timeoutMs:10000, revalidate:async () => modules});
    if (!result.passed) throw isolation('Windows isolated JavaScript enforcement probe failed');
    return {readDenied:true,writeDenied:true,networkDenied:true,childProcessWorks:false,
      backend:this.backendIdentity,quiescence:result.quiescence,provenance:result.provenance};
  }

  verifyDependencies() {
    const deps = windowsDependencyInventory(path.join(this.workspace.root,'node_modules'));
    if (deps.present || deps.hash !== this.options.expectedDependencyHash)
      throw isolation('Isolated JavaScript currently requires a dependency-free checkout');
  }

  async run(checks, _key, signal) {
    const {workspace,options} = this;
    const node = this.backendIdentity.runtime.runtime.executable;
    assertWindowsJavaScriptChecks({...workspace.manifest.permissions,checks},node);
    const results = [];
    for (const check of checks) {
      const entry = check.argv[1];
      const baseline = await gitBytes(options.repo,'show',options.baseCommit + ':' + entry);
      const revalidate = async () => {
        const inventory = (await workspace.inventory()).filter(file => supported.test(file.path));
        if (inventory.length > 128) throw isolation('Too many approved JavaScript modules');
        const modules = [];
        let total = 0;
        for (const {path:file,hash} of inventory) {
          const source = await workspace.content(file);
          if (source.hash !== hash || source.content === null) throw isolation('Approved JavaScript source changed');
          total += Buffer.byteLength(source.content) + Buffer.byteLength(file);
          if (total > 2 * 1024 * 1024) throw isolation('Approved JavaScript inputs exceed their byte limit');
          modules.push([file,source.content]);
        }
        const checkSource = modules.find(([file]) => file === entry)?.[1];
        if (checkSource === undefined || !Buffer.from(checkSource).equals(baseline))
          throw isolation('Approved JavaScript check bytes differ from the committed baseline');
        return modules;
      };
      const modules = await revalidate();
      const finished = await this.execute({entry,modules,argv:check.argv,signal,
        timeoutMs:Math.min(check.timeoutMs ?? timeoutLimit,timeoutLimit),revalidate});
      if (signal?.aborted) throw new Pause('Check interrupted; it will rerun on resume','stopped');
      await workspace.assertSnapshot();
      results.push({id:check.id,argv:check.argv,...finished,screenshots:[],backend:this.backendIdentity});
    }
    return results;
  }

  async execute({entry,modules,argv,signal,timeoutMs,revalidate}) {
    const {workspace, options} = this;
    const {runtime} = this.backendIdentity;
    this.verifyDependencies();
    const stageRoot = path.join(options.stateRoot,'js-stage');
    await windowsFile('mkdir',stageRoot);
    await windowsFile('private-directory',stageRoot);
    const stage = path.join(stageRoot,randomUUID());
    await windowsFile('mkdir',stage);
    await windowsFile('private-directory',stage);
    let disposable = true;
    try {
      const stagedRuntime = path.join(stage,'runtime');
      const stagedInput = path.join(stage,'inputs','check.json');
      await Promise.all([mkdir(path.join(stage,'work','.overnight-output','tmp'),{recursive:true}),
        mkdir(path.dirname(stagedInput)),mkdir(stagedRuntime)]);
      const written = [];
      for (const file of runtime.files) {
        const bytes = await windowsFile('read',path.join(runtime.root,file.path),{max:file.bytes});
        if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw isolation('Pinned Windows runtime changed');
        const destination = path.join(stagedRuntime,file.path);
        await mkdir(path.dirname(destination),{recursive:true});
        try { await windowsWrite(destination,bytes); }
        catch (error) { throw isolation('Cannot stage pinned component '+file.path+': '+error.message); }
        written.push({path:destination, hash:file.sha256, max:file.bytes});
      }
      const payload = Buffer.from(JSON.stringify({entry, modules, timeoutMs}));
      await windowsWrite(stagedInput,payload);
      written.push({path:stagedInput,hash:digest(payload),max:payload.length});
      const fields = {schema:1,backend:windowsJavaScriptBackend,argv,cwd:workspace.root,
        profileHash:digest({entry, timeoutMs, capabilities:'module-bytes-only'}),
        inputInventoryHash:digest(modules.map(([name,bytes])=>[name,digest(bytes)])),
        dependencyInventoryHash:options.expectedDependencyHash,runtimeFingerprint:runtime.fingerprint,
        runtimeHash:runtime.runtime.sha256,supervisorHash:runtime.supervisor.sha256};
      const binding = {...fields,bindingHash:digest(fields)};
      const exact = async () => {
        this.verifyDependencies();
        if (digest(await revalidate()) !== digest(modules)) throw isolation('Windows check input inventory changed');
        for (const file of written) {
          if (digest(await windowsFile('read',file.path,{max:file.max})) !== file.hash)
            throw isolation('Staged Windows JavaScript artifact changed');
        }
      };
      await exact();
      const owner = await options.ownership.begin(binding);
      disposable = false;
      let result;
      try {
        result = await superviseWindowsCheck({
          runtime:{...runtime, root:stagedRuntime,
            supervisor:{...runtime.supervisor,executable:path.join(stagedRuntime,'mosaic-windows-supervisor.exe')}},
          stage,owner,binding,timeoutMs:timeoutMs+2000,signal,revalidate:exact,isolatedJavaScript:true,
        });
      } catch (error) {
        await owner.uncertain(error);
        const unclear = isolation('Windows JavaScript supervisor did not prove exit');
        unclear.executionOutcome = 'unknown';
        throw unclear;
      }
      disposable = true;
      await exact();
      const passed = result.code === 0 && !result.stopped && result.stdout === 'ready\npassed\n' && result.stderr === '';
      return {...result,passed,provenance:{...binding,requestId:owner.requestId,resolvedExecutable:runtime.runtime.executable}};
    } finally {
      if (disposable) await rm(stage,{recursive:true,force:true,maxRetries:5});
    }
  }
}
