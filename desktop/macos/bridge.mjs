import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {observerAction} from './board.mjs';

const fields = {
  'observer.board':['source'],'observer.detail':['source','id'],'settings.get':[],'worker.test':[],'host.connect':[],
  'settings.save':['host','provider','model','baseUrl','reviewTarget','reviewerModel','reviewerBaseUrl','revision','key','reviewerKey']
};
export async function dispatch(request,context) {
  if (!request || typeof request!=='object' || Array.isArray(request) || Object.keys(request).some(k=>!['method','payload'].includes(k))) throw Error('Invalid app request.');
  const {method,payload={}}=request;
  if (typeof method!=='string' || !Object.hasOwn(fields,method) || !payload || typeof payload!=='object' || Array.isArray(payload) ||
      Object.keys(payload).some(k=>!fields[method].includes(k))) throw Error('Unsupported app request.');
  if (method.startsWith('observer.')) return observerAction(method,payload,context);
  const {connectionAction}=await import('./connections/index.mjs');
  return connectionAction(method,payload,context);
}
async function main() {
  let request;
  try {
    let size=0; const chunks=[];
    for await (const chunk of process.stdin) {
      size+=chunk.length;
      if (size>65536) throw Error('App request is too large.');
      chunks.push(chunk);
    }
    try { request=JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw Error('Invalid app request.'); }
    const runtimeRoot=fileURLToPath(new URL('../../',import.meta.url));
    const value=await dispatch(request,{home:os.homedir(),runtimeRoot,appPath:path.resolve(runtimeRoot,'../../..')});
    process.stdout.write(JSON.stringify({ok:true,value})+'\n');
  } catch (error) {
    let message=String(error.message||'Request failed.').replace(/[\r\n\u0000-\u001f]/g,' ');
    for (const k of ['key','reviewerKey']) {
      const secret=request?.payload?.[k];
      if (typeof secret==='string' && secret) message=message.replaceAll(secret,'[redacted]');
    }
    process.stdout.write(JSON.stringify({ok:false,error:message.slice(0,400)})+'\n');
  }
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();
