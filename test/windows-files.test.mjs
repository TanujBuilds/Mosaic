import assert from 'node:assert/strict';
import {test} from 'node:test';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,symlink,writeFile,link} from 'node:fs/promises';
import {locations} from '../src/beta/files.mjs';

test('isolated beta location uses the platform installation root', () => {
  const paths = locations(os.homedir(), true);
  const expected = process.platform === 'win32'
    ? ['AppData','Local','Mosaic Beta','bin','mosaic.exe'] : ['.local','bin','mosaic'];
  assert.equal(paths.launcher,path.join(os.homedir(),...expected));
});
test('Windows file helper enforces private ACLs, bounded reads and safe replacement', {skip:process.platform!=='win32'},async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'Mosaic file QA '));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const build=fileURLToPath(new URL('../distribution/win32-files/build.cmd',import.meta.url));
  const exe=path.join(root,'mosaic-files.exe');
  execFileSync(process.env.ComSpec,['/d','/s','/c','call "%MOSAIC_BUILD_SCRIPT%" "%MOSAIC_TEST_BINARY%"'],{
    cwd:root,env:{...process.env,MOSAIC_BUILD_SCRIPT:build,MOSAIC_TEST_BINARY:exe},windowsVerbatimArguments:true,stdio:'inherit'
  });
  const run=(args,input)=>execFileSync(exe,args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe']});
  const dir=path.join(root,'private');
  run(['mkdir',dir]);run(['private-directory',dir]);
  const file=path.join(dir,'credentials.json');
  run(['write',file],'initial');run(['write',file],'replacement');
  assert.equal(run(['read-private',file,'11']),'replacement');
  assert.throws(()=>run(['read',file,'10']));
  const alias=path.join(root,'alias');
  await symlink(dir,alias,'junction');
  assert.throws(()=>run(['read',path.join(alias,'credentials.json'),'11']));
  assert.throws(()=>run(['write',path.join(alias,'credentials.json')],'changed'));
  assert.equal(await readFile(file,'utf8'),'replacement');
  const second=path.join(dir,'also.json');await link(file,second);
  assert.throws(()=>run(['read-private',file,'11']));
  assert.throws(()=>run(['read',file+':stream','11']));
  const publicDir=path.join(root,'broad-acl');await mkdir(publicDir);
  const publicFile=path.join(publicDir,'data');await writeFile(publicFile,'ordinary');
  execFileSync('icacls.exe',[publicFile,'/grant','*S-1-1-0:R']);
  assert.throws(()=>run(['read-private',publicFile,'8']));
});
