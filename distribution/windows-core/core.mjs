import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export function coreLocations(localAppData) {
  if (!localAppData || !path.win32.isAbsolute(localAppData) || !/^[A-Za-z]:[\\/]/.test(localAppData)) {
    throw Error('Mosaic core needs a local Windows user profile');
  }
  const root = path.win32.join(localAppData, 'Mosaic');
  return {root, state:path.win32.join(root,'state'), config:path.win32.join(root,'core-config.json')};
}

export async function main(args) {
  if (process.platform !== 'win32') throw Error('This launcher requires Windows');
  const version = fileURLToPath(new URL('../../',import.meta.url));
  const runtime = path.join(version,'runtime');
  const load = file => import(pathToFileURL(path.join(runtime,file)).href);
  const {windowsFile} = await load('src/beta/windows-files.mjs');
  const versions=path.dirname(path.resolve(version));
  const installedRoot=path.dirname(versions);
  if(path.basename(versions)!=='versions'||path.basename(installedRoot)!=='Mosaic')throw Error('Start Mosaic core from its installed version directory');
  const paths = coreLocations(path.dirname(installedRoot));
  for (const directory of [paths.root, paths.state]) {
    await windowsFile('mkdir',directory);
    await windowsFile('private-directory',directory);
  }
  const servicePaths={...paths,configDir:paths.root,launcher:path.join(paths.root,'mosaic-core.ps1'),core:true};
  if(args.length===1 && ['start','remove-startup'].includes(args[0])){
    const {startWindowsService,unregisterWindowsService}=await load('src/beta/windows-service.mjs');
    if(args[0]==='remove-startup') return unregisterWindowsService(servicePaths);
    await startWindowsService(servicePaths);
    const {readConnectionRecord}=await load('src/harness/wait-client.mjs');
    const deadline=Date.now()+20000;
    while(Date.now()<deadline){
      try{
        const viewer=await readConnectionRecord(path.join(paths.state,'viewer-connection.json'));
        const url=new URL(viewer.url);
        if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||viewer.role!=='viewer')throw Error('Invalid core viewer connection');
        const response=await fetch(new URL('/api/invoke',url),{method:'POST',headers:{authorization:'Bearer '+viewer.token,'content-type':'application/json'},
          body:JSON.stringify({name:'tools_list',input:{}}),signal:AbortSignal.timeout(1000)});
        if(response.ok && (await response.json()).some(tool=>tool.name==='observer_snapshot')) {
          process.stdout.write('Mosaic core is ready.\n');return;
        }
      }catch{}
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    throw Error('Core was registered, but its authenticated observer did not become ready. Use core serve for foreground troubleshooting.');
  }
  if (args.length===1 && args[0]==='prepare-update') {
    for(const suffix of ['','-wal','-shm','-journal']) {
      await windowsFile('private-file',path.join(paths.state,'harness.sqlite3'+suffix),{optional:true});
    }
    const {assertMaintenanceIdle}=await load('src/beta/service.mjs');
    await assertMaintenanceIdle(paths,{offline:true,settingsChange:true});
    return;
  }
  if (args.length===1 && args[0]==='connect') {
    const {installCoreSkills}=await import('./skills.mjs');
    const skills=await installCoreSkills({home:os.homedir(),version,read:file=>windowsFile('read',file,{max:1024*1024})});
    await main(['start']);
    const server={command:path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),
      args:['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(paths.root,'mosaic-core.ps1'),'mcp']};
    process.stdout.write('Installed core skills in '+path.dirname(skills[0])+'.\nIn your app, inspect the existing frontier-harness MCP server. If the name is free, add this stdio configuration and invoke registry_list.\n'+JSON.stringify({mcpServers:{'frontier-harness':server}},null,2)+'\n');
    return;
  }
  const {main:harnessMain,serve} = await load('src/harness/cli.mjs');
  if (args[0] === 'serve') {
    if (args.length !== 1) throw Error('Use core serve');
    const bytes = await windowsFile('read-private',paths.config,{optional:true});
    const config = bytes ? JSON.parse(bytes) : {};
    const {readBundledNativeCheckRuntime} = await load('src/beta/package-contract.mjs');
    const nativeCheckRuntime = await readBundledNativeCheckRuntime(runtime);
    return serve({root:paths.state,port:0,runtimeConfig:{...config,nativeCheckRuntime,
      executionPolicy:{version:1,backend:'windows-appcontainer',backendRevision:1,runtimeFingerprint:nativeCheckRuntime.artifactManifestSha256}}});
  }
  if (args.includes('--root')) throw Error('Installed Mosaic core has its own per-user state directory');
  if (!args.length || args.includes('--help')) return harnessMain(['--help']);
  return harnessMain([...args,'--root',paths.state]);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  main(process.argv.slice(2)).catch(error => {console.error(error.message);process.exitCode=1;});
}
