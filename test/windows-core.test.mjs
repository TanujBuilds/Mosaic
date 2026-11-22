import test from 'node:test';
import assert from 'node:assert/strict';
import {coreLocations} from '../distribution/windows-core/core.mjs';

test('Windows core chooses separate per-user state for Beta read-only attachment', () => {
  const local = 'C:\\Users\\QA User\\AppData\\Local';
  const paths = coreLocations(local);
  assert.equal(paths.state,local+'\\Mosaic\\state');
  assert.equal(paths.config,local+'\\Mosaic\\core-config.json');
  for (const value of ['',undefined,'relative','\\\\server\\share']) assert.throws(()=>coreLocations(value));
});

test('core skill discovery preserves a foreign skill and can resume after an identical install',async t=>{
  const fs=await import('node:fs/promises');
  const path=await import('node:path');
  const os=await import('node:os');
  const {installCoreSkills}=await import('../distribution/windows-core/skills.mjs');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'core skills '));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const version=path.join(dir,'version'),home=path.join(dir,'home');
  await fs.mkdir(home);
  for(const name of ['frontier-harness','frontier-collaborate','frontier-deepseek-only','frontier-codex-only']){
    const source=path.join(version,'skills',name);
    await fs.mkdir(source,{recursive:true});await fs.writeFile(path.join(source,'SKILL.md'),name);
  }
  const script=path.join(version,'skills/frontier-harness/scripts');
  await fs.mkdir(script);await fs.writeFile(path.join(script,'harness.mjs'),'original');
  await fs.mkdir(path.join(version,'distribution/windows-core'),{recursive:true});
  await fs.writeFile(path.join(version,'distribution/windows-core/skill-entry.mjs'),'stable');
  const options={home,version,read:file=>fs.readFile(file)};
  const skills=await installCoreSkills(options);
  assert.equal(skills.length,4);assert.deepEqual(await installCoreSkills(options),skills);
  const foreign=path.join(skills[0],'SKILL.md');await fs.writeFile(foreign,'personal');
  await assert.rejects(installCoreSkills(options),/differs/);assert.equal(await fs.readFile(foreign,'utf8'),'personal');
});
