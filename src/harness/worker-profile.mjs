import {normalizeProviderCapabilities} from './provider-capabilities.mjs';

function field(value, limit) {
 return typeof value==='string'&&value.length<=limit&&value.trim()===value&&value.length>0&&!/[\x00-\x1f\x7f-\x9f]/u.test(value);
}

export function isLoopbackProvider(url) {
 const {hostname}=new URL(url);
 return hostname==='localhost'||hostname==='localhost.'||hostname==='[::1]'||/^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(hostname);
}

export class RemoteProviderTransportError extends Error {
 constructor(){
  super('HTTPS is required for remote API base URLs. Use an HTTPS endpoint or an encrypted forward with a loopback URL.');
 }
}

export function workerEndpoint(value) {
 let url;
 try{if(field(value,2048))url=new URL(value);}catch{}
 if(!url||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.href.includes('?')||url.href.includes('#'))
  throw Error('Use an HTTP or HTTPS API base URL without credentials, query parameters or fragment');
 if(url.protocol==='http:'&&!isLoopbackProvider(url))throw new RemoteProviderTransportError();
 return url.href.replace(/\/+$/,'');
}

export function workerProfile(raw) {
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||
    Object.keys(raw).some(key=>!['baseUrl','model','displayName','revision','streaming','capabilities'].includes(key))||
    !field(raw.model,200)||!field(raw.displayName,80)||!field(raw.revision,80)||typeof raw.streaming!=='boolean')
  throw Error('Invalid API worker profile');
 const capabilities=normalizeProviderCapabilities(raw.capabilities,raw.streaming);
 return {baseUrl:workerEndpoint(raw.baseUrl),model:raw.model,displayName:raw.displayName,revision:raw.revision,streaming:raw.streaming,
  ...(capabilities?{capabilities}:{})};
}
