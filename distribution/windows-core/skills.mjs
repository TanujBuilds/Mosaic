import {randomUUID,createHash} from 'node:crypto';
import {lstat,mkdir,readdir,rename,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';

const names=['frontier-harness','frontier-collaborate','frontier-deepseek-only','frontier-codex-only'];
const digest = data => createHash('sha256').update(data).digest('hex');
async function regularDirectory(directory) {
  const info=await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Skill destination is redirected');
}
async function inventory(directory,prefix='') {
  const result=[];
  for (const entry of await readdir(path.join(directory,prefix),{withFileTypes:true})) {
    const relative=path.posix.join(prefix,entry.name);
    if(entry.isDirectory()) result.push(...await inventory(directory,relative));
    else if(entry.isFile()) result.push(relative);
    else throw Error('Unexpected link or special entry in skill directory');
  }
  return result.sort();
}

export async function installCoreSkills({home,version,read}) {
  const root=path.join(home,'.agents','skills');
  await regularDirectory(home);
  for(const directory of [path.dirname(root),root]) {
    try { await mkdir(directory); } catch(error) { if(error.code!=='EEXIST') throw error; }
    await regularDirectory(directory);
  }
  const pending=[];
  try {
    for(const name of names) {
      const source=path.join(version,'skills',name),target=path.join(root,name);
      const files=await inventory(source);
      const expected=new Map();
      for(const file of files) expected.set(file,await read(path.join(source,file)));
      if(name==='frontier-harness') expected.set('scripts/harness.mjs',await read(path.join(version,'distribution/windows-core/skill-entry.mjs')));
      const exists=await lstat(target).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if(exists) {
        await regularDirectory(target);
        if(JSON.stringify(await inventory(target))!==JSON.stringify(files)) throw Error('Existing '+name+' has different files');
        for(const [file,data] of expected) if(digest(await read(path.join(target,file)))!==digest(data)) throw Error('Existing '+name+' differs. Its files have been preserved.');
        continue;
      }
      const stage=path.join(root,'.mosaic-'+randomUUID());
      await mkdir(stage);
      pending.push({stage,target});
      for(const [file,data] of expected) {
        await mkdir(path.dirname(path.join(stage,file)),{recursive:true});
        await writeFile(path.join(stage,file),data,{flag:'wx'});
      }
    }
    for(const {stage,target} of pending) await rename(stage,target);
  } finally {
    for(const {stage} of pending) await rm(stage,{force:true,recursive:true});
  }
  return names.map(name=>path.join(root,name));
}
