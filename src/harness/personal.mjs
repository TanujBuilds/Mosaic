import {lstat,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {windowsSystemTool} from './windows-desktop.mjs';

const begin='<!-- BEGIN FRONTIER-HARNESS ONBOARDING v1 -->';
const end='<!-- END FRONTIER-HARNESS ONBOARDING v1 -->';
export function mergeOnboarding(existing,template){
 const positions=text=>({starts:[...text.matchAll(/<!-- BEGIN FRONTIER-HARNESS ONBOARDING v1 -->/g)].map(x=>x.index),ends:[...text.matchAll(/<!-- END FRONTIER-HARNESS ONBOARDING v1 -->/g)].map(x=>x.index)});
 const fresh=template.trim(),p=positions(fresh),old=positions(existing);
 const markers=(existing.match(/<!--\s*(?:BEGIN|END)\s+FRONTIER-HARNESS ONBOARDING/g)??[]).length;
 if(markers!==old.starts.length+old.ends.length)throw Error('Unknown or incomplete managed onboarding block');
 if(p.starts.length!==1||p.ends.length!==1||p.starts[0]!==0||p.ends[0]+end.length!==fresh.length)throw Error('Invalid managed onboarding template');
 if(!old.starts.length&&!old.ends.length)return existing+(existing.endsWith('\n\n')?'':existing.endsWith('\n')?'\n':existing?'\n\n':'')+fresh+'\n';
 if(old.starts.length!==1||old.ends.length!==1||old.starts[0]>=old.ends[0])throw Error('Conflicting managed onboarding block; preserve personal instructions');
 return existing.slice(0,old.starts[0])+fresh+existing.slice(old.ends[0]+end.length);
}
async function runLocal(command,args,input){
 await new Promise((resolve,reject)=>{
  const child=spawn(command,args,{stdio:['pipe','ignore','ignore'],shell:false});
  child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Local helper failed')));
  child.stdin.on('error',reject);child.stdin.end(input);
 });
}
export async function openObserver({root,run=runLocal}){
 const file=path.join(root,'viewer-connection.json');let connection;
 try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>8192)throw Error();connection=JSON.parse(await readFile(file,'utf8'));}catch{throw Error('Mosaic viewer connection unavailable; inspect the local coordinator');}
 let origin;
 try{const u=new URL(connection.url);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.pathname!=='/'||u.search||u.hash||connection.role!=='viewer'||typeof connection.token!=='string'||connection.token.length<32)throw Error();origin=u.origin;}catch{throw Error('A viewer connection to the local loopback coordinator is required');}
 try{
  if(process.platform==='win32'){
   await run(windowsSystemTool('clip.exe'),[],connection.token);
   await run(windowsSystemTool('rundll32.exe'),['url.dll,FileProtocolHandler',origin+'/']);
  }else{await run('/usr/bin/pbcopy',[],connection.token);await run('/usr/bin/open',[origin+'/']);}
 }catch{throw Error('Could not open Mosaic locally; no connection key was displayed');}
 return {status:'opened',url:origin+'/',message:'Viewer key copied locally. Paste it into Connection key if login is requested.'};
}
