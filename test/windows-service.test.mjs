import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,rm,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {serviceDefinition} from '../src/beta/windows-service.mjs';
import {setTimeout as delay} from 'node:timers/promises';

test('per-user service definition binds an absolute launcher and working directory',()=>{
  const paths={launcher:'C:\\Users\\A B\\bin\\mosaic.exe',state:'C:\\Users\\A B\\state'};
  assert.deepEqual(JSON.parse(serviceDefinition(paths)),{version:1,launcher:paths.launcher,args:['serve'],state:paths.state});
});
test('core registration pins the system PowerShell and literal launcher, isolated from Beta',t=>{
  const previous=process.env.SystemRoot;process.env.SystemRoot='C:\\Windows';
  t.after(()=>{if(previous===undefined)delete process.env.SystemRoot;else process.env.SystemRoot=previous;});
  const configDir="C:\\Users\\O'Brien\\Mosaic Core";
  const paths={core:true,configDir,launcher:path.win32.join(configDir,'mosaic-core.ps1'),state:path.win32.join(configDir,'state')};
  assert.deepEqual(JSON.parse(serviceDefinition(paths)),{
    version:1,kind:'core',launcher:paths.launcher,executable:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    args:['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',paths.launcher,'serve'],state:paths.state
  });
  assert.throws(()=>serviceDefinition({...paths,launcher:"C:\\Users\\O'Brien\\foreign.ps1"}),/core service binding/i);
  assert.throws(()=>serviceDefinition({...paths,state:'C:\\Foreign state'}),/core service binding/i);
});
test('native scheduled task can be created, verified, removed and registered again', {skip:process.platform!=='win32'},async t=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'Mosaic service '));
  const cleanup=[];
  t.after(async()=>{try{for(const remove of cleanup.reverse())await remove();}finally{await rm(tmp,{recursive:true,force:true});}});
  const root=fileURLToPath(new URL('../',import.meta.url));
  const beta=path.join(tmp,'src','beta'),bin=path.join(tmp,'bin');
  await cp(path.join(root,'src'),path.join(tmp,'src'),{recursive:true});
  await mkdir(bin);
  execFileSync(process.env.ComSpec,['/d','/s','/c','call "%MOSAIC_BUILD_SCRIPT%" "%MOSAIC_TEST_BINARY%"'],{
    cwd:tmp,env:{...process.env,MOSAIC_BUILD_SCRIPT:path.join(root,'distribution','win32-files','build.cmd'),MOSAIC_TEST_BINARY:path.join(bin,'mosaic-files.exe')},windowsVerbatimArguments:true,stdio:'inherit'
  });
  const service=await import(pathToFileURL(path.join(beta,'windows-service.mjs')));
  const files=await import(pathToFileURL(path.join(beta,'files.mjs')));
  const windowsFiles=await import(pathToFileURL(path.join(beta,'windows-files.mjs')));
  const paths=files.locations(tmp,true);await files.privateDirectories(paths);
  cleanup.push(()=>service.unregisterWindowsService(paths));
  assert.equal((await service.registration(paths)).owned,false);
  const nonce='b4f5bcc4-b1d6-4d46-b386-38986063d6aa';
  const creating={version:1,phase:'creating',definition:files.hash(serviceDefinition(paths)),nonce};
  await files.saveJson(service.serviceRecord(paths),creating);
  await service.ensureWindowsService(paths);
  // Simulate losing the receipt write after Task Scheduler registered the task.
  await files.saveJson(service.serviceRecord(paths),creating);
  const first=await service.registration(paths);
  assert.equal(first.registered,true);assert.equal(first.owned,true);
  assert.equal(await service.ensureWindowsService(paths),first.xmlHash);
  await service.unregisterWindowsService(paths);
  assert.equal((await service.registration(paths)).registered,false);
  await service.ensureWindowsService(paths);
  assert.equal((await service.registration(paths)).registered,true);
  assert.equal(JSON.parse(await readFile(service.serviceRecord(paths),'utf8')).version,1);
  const configDir=path.join(tmp,"Core O'Brien"),state=path.join(configDir,'state');
  const core={core:true,configDir,state,launcher:path.join(configDir,'mosaic-core.ps1')};
  await windowsFiles.windowsFile('mkdir',state);
  await windowsFiles.windowsWrite(core.launcher,
    'if ($args.Count -ne 1 -or $args[0] -cne "serve") { exit 1 }; '+
    '[IO.File]::WriteAllText((Join-Path ([Environment]::CurrentDirectory) "core-started.txt"), "serve")\n');
  cleanup.push(()=>service.unregisterWindowsService(core));
  const betaRegistration=await service.registration(paths);
  const coreIntent={version:1,phase:'creating',definition:files.hash(serviceDefinition(core)),nonce};
  await files.saveJson(service.serviceRecord(core),coreIntent);
  await service.startWindowsService(core);
  const marker=path.join(state,'core-started.txt');
  let started=false;
  for(let remaining=80;remaining>0&&!started;remaining--){
    started=await readFile(marker,'utf8').then(text=>text==='serve',error=>{if(error.code==='ENOENT')return false;throw error;});
    if(!started)await delay(150);
  }
  assert.ok(started,'Core scheduled task ran the quoted script with its approved working directory and serve argv');
  const coreRegistration=await service.registration(core);
  assert.equal(coreRegistration.registered,true);
  await files.saveJson(service.serviceRecord(core),coreIntent);
  assert.deepEqual(await service.registration(core),coreRegistration);
  await service.unregisterWindowsService(core);
  assert.equal((await service.registration(core)).registered,false);
  assert.deepEqual(await service.registration(paths),betaRegistration);
  await service.unregisterWindowsService(paths);
});
