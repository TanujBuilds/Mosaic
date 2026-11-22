import {codex} from './codex.mjs';
import {claudeCode} from './claude-code.mjs';
import {cursor} from './cursor.mjs';
import {antigravity} from './antigravity.mjs';
import {formatHostCommand} from './shared.mjs';
const adapters=new Map([codex,claudeCode,cursor,antigravity].map(adapter=>[adapter.id,adapter]));
export const HOST_IDS=Object.freeze([...adapters.keys()]);
export function getHost(id){const adapter=adapters.get(id);if(!adapter)throw Error('Unsupported Mosaic host');return adapter;}
export function normalizeHostSettings(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!['id','options'].includes(key)))throw Error('Invalid host settings');
 getHost(raw.id);const options=raw.options??{};
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).length)throw Error('Unsupported host registration option');
 return {id:raw.id,options:{}};
}
export const hostRegistry=Object.freeze({get(id){const {schema,id:hostId,displayName,transport,reviewDelivery,capabilities,documentation}=getHost(id);return structuredClone({schema,id:hostId,displayName,transport,reviewDelivery,capabilities,documentation});},list(){return HOST_IDS.map(id=>this.get(id));}});

export function formatHostRegistrationGuide(preview,{platform=process.platform}={}){
 const {displayName,connectionHelp}=getHost(preview.hostId);
 const entry=preview.command
  ?'If the name is available, run this command in your terminal:\n'+formatHostCommand(preview.command,preview.argv,platform)
  :'If the file is empty or missing, use the JSON below. In an existing file, add only the mosaic-beta member inside mcpServers. If that object is missing, add it while keeping the other settings.\n'+JSON.stringify({mcpServers:{'mosaic-beta':preview.entry}},null,2);
 return [
  `Connect ${displayName} · user MCP configuration`,
  `Host target: ${preview.target}`,
  connectionHelp.locate,
  `If mosaic-beta already exists, compare it with the command ${JSON.stringify(preview.launcher)} and the single argument "mcp". Keep an exact match. If it differs, preserve the existing entry and resolve the conflict in the app before continuing.`,
  entry,
  connectionHelp.refresh,
  'After the app lists the Mosaic tools, ask it to call mosaic-beta registry_list with {} in the same session. The tool dispatches no Mosaic work. If you use an app conversation to request the call, that conversation may use the app’s model.',
  ''
 ].join('\n');
}

// A bridge call is historical evidence, and does not identify the app or its current health.
export function formatHostReadiness(hostId,{configuration='selected',instructions='not recorded for this configuration',registration='unverified',connection=null,nextAction}={}){
 const host=getHost(hostId),fixture=registration==='fixture',saved=registration==='saved';
 const registrationDetail=fixture?'saved in a disposable fixture; actual host registration is unverified.':saved?'saved registration verified; actual tool discovery and calls remain unverified.':'unverified; saving local settings or instructions does not register the coding app.';
 const next=nextAction??(fixture||saved?`In an actual ${host.displayName} profile, discover the mosaic-beta tools, then call registry_list with {} to check the connection without dispatching Mosaic work.`:`Run mosaic connect for ${host.displayName} or use mosaic host-preview --host ${hostId} for the JSON preview.`);
 const observed=connection?.hostId===hostId&&connection?.kind==='registry_call';
 const toolCall=observed?`INFO  Last bridge registry call · ${new Date(connection.at).toISOString()}. Check the selected app for its current connection.`:'UNVERIFIED  Host tool call · no successful call observed from the selected coding app.';
 return `INFO  Coding app · ${host.displayName} ${configuration}; selection does not prove a connection.\nINFO  Host registration instructions · ${instructions}.\n${fixture||saved?'INFO':'UNVERIFIED'}  Host registration · ${registrationDetail}\nUNVERIFIED  Host tools discovered · no discovery observed from the selected coding app.\n${toolCall}\nINFO  Host evidence · fixture adapters, provider checks and coordinator viewer tools_list do not prove coding-app discovery or a successful call; these stages make no sign-in, host-version, coding-quality or live-provider qualification claim.\nNext action: ${next}\n`;
}
