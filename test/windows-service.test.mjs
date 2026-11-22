import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,rm,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {serviceDefinition} from '../src/beta/windows-service.mjs';

test('per-user service definition binds an absolute launcher and working directory',()=>{
  const paths={launcher:'C:\\Users\\A B\\bin\\mosaic.exe',state:'C:\\Users\\A B\\state'};
  assert.deepEqual(JSON.parse(serviceDefinition(paths)),{version:1,launcher:paths.launcher,args:['serve'],state:paths.state});
});
test('native scheduled task can be created, verified, removed and registered again', {skip:process.platform!=='win32'},async t=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'Mosaic service '));t.after(()=>rm(tmp,{recursive:true,force:true}));
  const root=fileURLToPath(new URL('../',import.meta.url));
  const beta=path.join(tmp,'src','beta'),bin=path.join(tmp,'bin');
  await mkdir(beta,{recursive:true});await mkdir(bin);
  for(const name of ['windows-service.mjs','windows-files.mjs','files.mjs'])
    await copyFile(path.join(root,'src','beta',name),path.join(beta,name));
  execFileSync(process.env.ComSpec,['/d','/s','/c','call "%MOSAIC_BUILD_SCRIPT%" "%MOSAIC_TEST_BINARY%"'],{
    cwd:tmp,env:{...process.env,MOSAIC_BUILD_SCRIPT:path.join(root,'distribution','win32-files','build.cmd'),MOSAIC_TEST_BINARY:path.join(bin,'mosaic-files.exe')},windowsVerbatimArguments:true,stdio:'inherit'
  });
  const service=await import(pathToFileURL(path.join(beta,'windows-service.mjs')));
  const files=await import(pathToFileURL(path.join(beta,'files.mjs')));
  const paths=files.locations(tmp,true);await files.privateDirectories(paths);
  t.after(async()=>{if(await service.registration(paths).then(x=>x.registered).catch(()=>false))await service.unregisterWindowsService(paths)});
  assert.equal((await service.registration(paths)).owned,false);
  await service.ensureWindowsService(paths);
  const first=await service.registration(paths);
  assert.equal(first.registered,true);assert.equal(first.owned,true);
  assert.equal(await service.ensureWindowsService(paths),first.xmlHash);
  await service.unregisterWindowsService(paths);
  assert.equal((await service.registration(paths)).registered,false);
  await service.ensureWindowsService(paths);
  assert.equal((await service.registration(paths)).registered,true);
  assert.equal(JSON.parse(await readFile(service.serviceRecord(paths),'utf8')).version,1);
  await service.unregisterWindowsService(paths);
});
