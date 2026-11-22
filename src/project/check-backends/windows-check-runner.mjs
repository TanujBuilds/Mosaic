import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { CheckRunner } from '../sandbox.mjs';
import { digest, Pause } from '../contracts.mjs';
import { WINDOWS_BACKEND } from './windows-appcontainer.mjs';

// Keep the source-pinned Darwin CheckRunner intact. Each Windows execution
// stages a separate immutable copy and records its hash in the owner binding.
export class WindowsCheckRunner extends CheckRunner {
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
  async verify(signal) {
    const privateFile = path.join(this.workspace.journal.dir, 'windows-private-canary-' + randomUUID());
    await writeFile(privateFile, 'private', { flag: 'wx' });
    const server = createServer((socket) => {
      socket.on('error', () => {});
      socket.end();
    });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const program = `
        const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process');
        const denied=action=>{try{action();return false;}catch(error){return ['EACCES','EPERM'].includes(error.code);}};
        const result={readDenied:denied(()=>fs.readFileSync(${JSON.stringify(privateFile)})),writeDenied:denied(()=>fs.writeFileSync('unapproved-output','x'))};
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
        !['readDenied', 'writeDenied', 'outputWorks', 'networkDenied', 'childProcessWorks'].every(
          (field) => result?.[field] === true,
        )
      )
        throw new Pause(
          'Windows protected check enforcement probe failed: ' +
            (outcome.stderr || outcome.stdout).slice(-1000),
          'isolation',
        );
      return {
        ...result,
        backend: this.backendIdentity,
        quiescence: outcome.quiescence,
        provenance: outcome.provenance,
      };
    } finally {
      server.close();
      await unlink(privateFile);
    }
  }
}
