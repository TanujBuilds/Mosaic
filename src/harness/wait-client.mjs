import {open} from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {windowsFile} from '../beta/windows-files.mjs';
const fault=waitReason=>Object.assign(Error('Wait observation unavailable'),{waitReason});
async function readBounded(file,max){const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{if(!(await handle.stat()).isFile())throw fault('invalid_connection');const bytes=Buffer.alloc(max+1),{bytesRead}=await handle.read(bytes,0,max+1,0);if(bytesRead>max)throw fault('invalid_connection');return bytes.subarray(0,bytesRead).toString('utf8');}finally{await handle.close();}}
export async function readConnectionRecord(file){
 let text;
 if(process.platform==='win32'){
  const directory=await windowsFile('private-directory',path.dirname(file),{optional:true});
  const bytes=directory===null?null:await windowsFile('read-private',file,{max:65536,optional:true});
  if(bytes===null)throw Object.assign(Error('Coordinator connection unavailable'),{code:'ENOENT'});
  text=bytes.toString('utf8');
 }else text=await readBounded(file,65536);
 try{return JSON.parse(text);}catch{throw Error('Invalid coordinator connection record');}
}
/** Private connection bytes never leave this client. No coordinator construction or fallback. */
export function waitClient(root){return async(name,input,{signal,timeoutMs}={})=>{
 if(!['task_get','operation_get','events_wait'].includes(name))throw fault('request_failed');
 let cfg,url;try{cfg=await readConnectionRecord(path.join(root,'connection.json'));url=new URL(cfg.url);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||!url.port||![url.origin,url.origin+'/'].includes(cfg.url)||typeof cfg.token!=='string'||cfg.token.length<32||cfg.token.length>4096||/[\x00-\x20\x7f]/.test(cfg.token))throw fault('invalid_connection');
 }catch(error){if(error.waitReason)throw error;if(error.code==='ENOENT')throw fault('request_failed');throw fault('invalid_connection');}
 const requestSignal=signal??AbortSignal.timeout(Math.min(timeoutMs??30000,300000));
 const response=await fetch(new URL('/api/invoke',url),{method:'POST',redirect:'error',headers:{authorization:'Bearer '+cfg.token,'content-type':'application/json'},body:JSON.stringify({name,input}),signal:requestSignal});
 if(!response.ok){await response.body?.cancel();throw fault([401,403].includes(response.status)?'access_denied':'request_failed');}
 const reader=response.body.getReader(),parts=[];let bytes=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>2097152){await reader.cancel();throw fault('response_limit');}parts.push(value);}}finally{reader.releaseLock();}
 try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw fault('invalid_response');}
};}
