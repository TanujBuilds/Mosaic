import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFile } from 'node:fs/promises';
import { isEntry } from './entry.mjs';
import { Registry } from './contracts.mjs';

export const registryTool={name:'registry_list',description:'List the registered versioned modes, capabilities and workflows. Does not dispatch work.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}};
export async function startMcp({invoke,tools=[registryTool],name='frontier-harness',instructions}={}){
 const server=new Server({name,version:'0.1.0'},{capabilities:{tools:{}},instructions});
 server.setRequestHandler(ListToolsRequestSchema,async()=>({tools}));
 server.setRequestHandler(CallToolRequestSchema,async (request,extra)=>{
  try{
   if(!tools.some(t=>t.name===request.params.name))throw Error('Unknown harness tool');
   const value=invoke?await invoke(request.params.name,request.params.arguments??{},
    {capabilities:server.getClientCapabilities(),sendRequest:extra.sendRequest,signal:extra.signal}):new Registry().snapshot();
   return {content:[{type:'text',text:JSON.stringify(value)}]};
  }catch(error){return {isError:true,content:[{type:'text',text:JSON.stringify({error:error.message})}]};}
 });
 await server.connect(new StdioServerTransport());return server;
}
async function main(){
 const args=process.argv.slice(2);
 if(args.length===1&&args[0]==='--registry-only'){await startMcp();return;}
 const at=args.indexOf('--connection'),connectionFile=at>=0?args[at+1]:process.env.FRONTIER_HARNESS_CONNECTION;
 if(!connectionFile)throw Error('Provide --connection PRIVATE_CONNECTION_JSON');
 const connection=JSON.parse(await readFile(connectionFile,'utf8'));
 const u=new URL(connection.url);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password)throw Error('Coordinator must use authenticated loopback');
 const invoke=async(name,input)=>{
  const response=await fetch(new URL('/api/invoke',u),{method:'POST',headers:{authorization:`Bearer ${connection.token}`,'content-type':'application/json'},body:JSON.stringify({name,input}),signal:AbortSignal.timeout(35000)});
  const body=await response.json();if(!response.ok)throw Error(body.error??`Coordinator HTTP ${response.status}`);return body;
 };
 const tools=await invoke('tools_list',{});await startMcp({invoke,tools});
}
if(isEntry(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
