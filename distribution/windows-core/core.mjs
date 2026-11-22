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
  const paths = coreLocations(process.env.LOCALAPPDATA);
  for (const directory of [paths.root, paths.state]) {
    await windowsFile('mkdir',directory);
    await windowsFile('private-directory',directory);
  }
  if (args.length===1 && args[0]==='connect') {
    const {installCoreSkills}=await import('./skills.mjs');
    const skills=await installCoreSkills({home:os.homedir(),version,read:file=>windowsFile('read',file,{max:1024*1024})});
    const server={command:path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),
      args:['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(paths.root,'mosaic-core.ps1'),'mcp']};
    process.stdout.write('Installed core skills in '+path.dirname(skills[0])+'.\nIn your app, inspect the existing frontier-harness MCP server. If the name is free, add this stdio configuration and invoke registry_list.\n'+JSON.stringify({mcpServers:{'frontier-harness':server}},null,2)+'\n');
    return;
  }
  const {main,serve} = await load('src/harness/cli.mjs');
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
  if (!args.length || args.includes('--help')) return main(['--help']);
  return main([...args,'--root',paths.state]);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  main(process.argv.slice(2)).catch(error => {console.error(error.message);process.exitCode=1;});
}
