import {execFile} from 'node:child_process';
import {constants} from 'node:fs';
import {access,stat} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {fileBytes,shellQuote} from '../../../src/beta/files.mjs';
import {getHost} from '../../../src/beta/hosts/index.mjs';

const exec = promisify(execFile);
const name = 'mosaic-beta';
const cliName = host => host === 'codex' ? 'codex' : 'claude';
const previewFor = (paths,host) => getHost(host).previewRegistration({paths,launcher:paths.launcher});

export function registration(paths,host) {
  const {command,argv,entry} = previewFor(paths,host);
  return command ? [command,...argv].map(shellQuote).join(' ') : JSON.stringify({mcpServers:{[name]:entry}},null,2);
}

async function executable(file) {
  try { await access(file,constants.X_OK); return (await stat(file)).isFile(); }
  catch { return false; }
}

async function findCLI(home,host) {
  const command=cliName(host);
  const bins=[path.join(home,'.local','bin'),'/opt/homebrew/bin','/usr/local/bin',
    ...(process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute)];
  const files=[...new Set(bins)].map(bin=>path.join(bin,command));
  if (host==='codex') {
    for (const dir of [path.join(home,'Applications'),'/Applications'])
      for (const binary of ['ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex','Codex.app/Contents/Resources/codex'])
        files.push(path.join(dir,binary));
  }
  for (const file of files) if (await executable(file)) return file;
  return null;
}

function matches(entry,paths) {
  return entry && (entry.type ?? 'stdio')==='stdio' && entry.command===paths.launcher &&
    Array.isArray(entry.args) && entry.args.length===1 && entry.args[0]==='mcp' && !entry.cwd &&
    !entry.env_vars?.length && Object.keys(entry.env??{}).length===0;
}

async function currentRegistration(cli,options,paths,host) {
  if (host==='claude-code') {
    // Claude Code owns this file. Read its user-scope entry only; let the CLI perform edits.
    const data=await fileBytes(path.join(paths.home,'.claude.json'),{max:16*1024*1024});
    if (!data) return 'missing';
    const config=JSON.parse(data);
    if (!config || Array.isArray(config) || typeof config!=='object' ||
        (config.mcpServers !== undefined && (!config.mcpServers || Array.isArray(config.mcpServers) || typeof config.mcpServers!=='object'))) throw Error();
    if (!Object.hasOwn(config.mcpServers ?? {},name)) return 'missing';
    return matches(config.mcpServers[name],paths) ? 'matched' : 'other';
  }
  let stdout;
  try { ({stdout}=await exec(cli,['mcp','get',name,'--json'],options)); }
  catch (error) {
    if (error.code===1 && /^Error: No MCP server named 'mosaic-beta' found\.$/m.test(error.stderr ?? '')) return 'missing';
    throw Error();
  }
  const entry=JSON.parse(stdout);
  return entry.name===name && entry.enabled===true && matches(entry.transport,paths) ? 'matched' : 'other';
}

export async function connectHost(paths,host) {
  const title=getHost(host).displayName;
  const {command,argv}=previewFor(paths,host);
  if(!command)return {ok:false,message:'Use the displayed MCP entry in '+title+' or run mosaic connect for instructions.'};
  const success=() => ({ok:true,message:'Registered in '+title+'. Open a new host session and call registry_list to confirm the connection.'});
  const cli=await findCLI(paths.home,host);
  if (!cli) return {ok:false,message:title+' CLI was not found. Copy the registration command and run it where you use '+title+'.'};
  if (!await executable(paths.launcher)) return {ok:false,message:'The shared Mosaic launcher is unavailable. Restore the terminal installation before registering this host.'};
  const options={cwd:paths.home,timeout:12000,maxBuffer:512*1024,env:{
    HOME:paths.home,CODEX_HOME:paths.codexHome,LANG:'C',
    PATH:[path.dirname(cli),path.dirname(process.execPath),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin'].join(':'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1'
  }};
  try {
    const existing=await currentRegistration(cli,options,paths,host);
    if (existing==='matched') return success();
    if (existing!=='missing') return {ok:false,message:title+' already has a different or disabled mosaic-beta entry. Review that entry in your coding host before registering Mosaic.'};
    await exec(cli,argv,options);
    if (await currentRegistration(cli,options,paths,host)==='matched') return success();
  } catch { /* The host may print private configuration. Never forward CLI output to the desktop. */ }
  return {ok:false,message:'Could not confirm registration in '+title+'. Check its MCP settings or use the copyable command.'};
}
