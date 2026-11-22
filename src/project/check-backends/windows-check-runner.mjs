import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { CheckRunner } from '../sandbox.mjs';
import { digest, Pause } from '../contracts.mjs';
import { WINDOWS_BACKEND } from './windows-appcontainer.mjs';

// A disposable, low-integrity file explicitly shared with all restricted
// application packages detects ambient access to unapproved host objects.
export async function windowsExternalCanary(dir) {
  const file = path.join(dir, 'windows-ambient-acl-canary-' + randomUUID());
  await writeFile(file, 'outside-approved-tree', { flag: 'wx' });
  const icacls = path.join(process.env.SystemRoot, 'System32', 'icacls.exe');
  try {
    for (const args of [
      ['/grant', '*S-1-15-2-2:M'],
      ['/setintegritylevel', 'L'],
    ]) {
      execFileSync(icacls, [file, ...args], { windowsHide: true, stdio: 'pipe', timeout: 5000 });
    }
    return file;
  } catch (error) {
    await unlink(file);
    throw error;
  }
}
// Keep the source-pinned Darwin CheckRunner intact. Each Windows execution
// stages a separate immutable copy and records its hash in the owner binding.
export class WindowsCheckRunner extends CheckRunner {
  #verified = false;
  constructor(workspace, options) {
    super(workspace, options);
    if (
      this.backendIdentity.id !== WINDOWS_BACKEND.id ||
      this.backendIdentity.revision !== WINDOWS_BACKEND.revision
    )
      throw new Pause('Expected the approved Windows backend', 'isolation');
    this.probeExecutable = this.backendIdentity.runtime.runtime.executable;
  }
  async stageInputs() {
    const inventory = await this.workspace.inventory();
    return { files: inventory.map((item) => item.path), inventoryHash: digest(inventory) };
  }
  async run(checks, key, signal) {
    if (!this.#verified) await this.verify(signal);
    return super.run(checks, key, signal);
  }
  async verify(signal) {
    this.#verified = false;
    let external;
    const privateFile = path.join(this.workspace.journal.dir, 'windows-private-canary-' + randomUUID());
    await writeFile(privateFile, 'private', { flag: 'wx' });
    const server = createServer((socket) => {
      socket.on('error', () => {});
      socket.end();
    });
    try {
      external = await windowsExternalCanary(this.workspace.journal.dir);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const program = `
        const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process');
        const denied=action=>{try{action();return false;}catch(error){return ['EACCES','EPERM'].includes(error.code);}};
        const result={readDenied:denied(()=>fs.readFileSync(${JSON.stringify(privateFile)})),writeDenied:denied(()=>fs.writeFileSync('unapproved-output','x'))};
        result.externalReadDenied=denied(()=>fs.readFileSync(${JSON.stringify(external)}));
        result.externalWriteDenied=denied(()=>fs.appendFileSync(${JSON.stringify(external)},'x'));
        fs.writeFileSync('.overnight-output/probe','ok');result.outputWorks=fs.readFileSync('.overnight-output/probe','utf8')==='ok';
        const sub=cp.spawnSync(process.execPath,['-e',"process.stdout.write('child-ok')"],{encoding:'utf8'});result.childProcessWorks=sub.status===0 && sub.stdout==='child-ok';
        const socket=net.connect(${server.address().port},'127.0.0.1');
        socket.once('connect',()=>{socket.destroy();console.log(JSON.stringify({...result,networkDenied:false}));});
        socket.once('error',error=>console.log(JSON.stringify({...result,networkDenied:['EPERM','EACCES'].includes(error.code)})));
        socket.setTimeout(2000,()=>{socket.destroy();process.exit(2);});`;
      const outcome = await this.execute([this.probeExecutable, '-e', program], 15000, signal);
      let result;
      try {
        result = JSON.parse(outcome.stdout);
      } catch {}
      if (
        outcome.code !== 0 ||
        outcome.stopped ||
        ![
          'readDenied',
          'writeDenied',
          'outputWorks',
          'networkDenied',
          'childProcessWorks',
          'externalReadDenied',
          'externalWriteDenied',
        ].every((field) => result?.[field] === true)
      )
        throw new Pause(
          'Windows protected check enforcement probe failed: ' +
            (outcome.stderr || outcome.stdout).slice(-1000),
          'isolation',
        );
      this.#verified = true;
      return {
        ...result,
        backend: this.backendIdentity,
        quiescence: outcome.quiescence,
        provenance: outcome.provenance,
      };
    } finally {
      server.close();
      if (external) await unlink(external);
      await unlink(privateFile);
    }
  }
}
