import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cp,link,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

test('Windows maintenance creates its own private lock and rejects a linked SQLite sidecar', {skip:process.platform!=='win32'}, async t=>{
  const source=fileURLToPath(new URL('../',import.meta.url));
  const root=await mkdtemp(path.join(tmpdir(),'Mosaic lock '));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const runtime=path.join(root,'runtime');
  await mkdir(path.join(runtime,'bin'),{recursive:true});
  await cp(path.join(source,'src'),path.join(runtime,'src'),{recursive:true});
  execFileSync(process.env.ComSpec,['/d','/s','/c','call "%MOSAIC_BUILD%" "%MOSAIC_OUTPUT%"'],{
    windowsVerbatimArguments:true,env:{...process.env,MOSAIC_BUILD:path.join(source,'distribution/win32-files/build.cmd'),
      MOSAIC_OUTPUT:path.join(runtime,'bin/mosaic-files.exe')}});
  const {locations,withLock}=await import(pathToFileURL(path.join(runtime,'src/beta/files.mjs')));
  const paths=locations(root,true);
  assert.equal(await withLock(paths,()=>123),123);
  const outside=path.join(root,'preserve.txt');await writeFile(outside,'keep');
  await link(outside,path.join(paths.configDir,'maintenance.sqlite3-journal'));
  await assert.rejects(withLock(paths,()=>assert.fail('lock should be refused')));
  assert.equal(await readFile(outside,'utf8'),'keep');
});
