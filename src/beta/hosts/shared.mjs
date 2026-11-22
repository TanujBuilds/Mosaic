import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonical} from '../../harness/contracts.mjs';
import {shellQuote} from '../files.mjs';
const name='mosaic-beta';
const fingerprint=value=>createHash('sha256').update(canonical(value)).digest('hex');
const copy=value=>structuredClone(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
export function formatHostCommand(command, argv, platform = process.platform) {
 const words = [command, ...argv];
 return platform === 'win32'
  ? '& ' + words.map(word => "'" + word.replaceAll("'", "''") + "'").join(' ')
  : words.map(shellQuote).join(' ');
}
function absolute(value,label){if(typeof value!=='string'||!path.isAbsolute(value)||value.length>4096||/[\x00-\x1f\x7f]/u.test(value))throw Error(`Invalid ${label}`);return value;}
function config(value,cli){
 if(value===undefined||value===null)return cli?{registration:null}:{};
 if(typeof value==='string'){try{value=JSON.parse(value);}catch{throw Error('Malformed host JSON configuration');}}
 if(!object(value)||Buffer.byteLength(canonical(value))>1024*1024)throw Error('Invalid or oversized host configuration');
 if(cli){if(value.registration!==null&&value.registration!==undefined&&!object(value.registration))throw Error('Invalid CLI registration snapshot');}
 else if(value.mcpServers!==undefined&&!object(value.mcpServers))throw Error('Invalid mcpServers configuration map');
 return copy(value);
}
function select(value,cli){return cli?value.registration??null:value.mcpServers?.[name]??null;}
function set(value,entry,cli,hadMap){
 const next=copy(value);
 if(cli)next.registration=entry;
 else if(entry!==null){next.mcpServers??={};Object.defineProperty(next.mcpServers,name,{value:copy(entry),enumerable:true,writable:true,configurable:true});}
 else {delete next.mcpServers?.[name];if(!hadMap&&next.mcpServers&&Object.keys(next.mcpServers).length===0)delete next.mcpServers;}
 return next;
}
function ioContract(io){
 if(!io||['read','compareAndSwap','readReceipt','writeReceipt','removeReceipt'].some(k=>typeof io[k]!=='function'))throw Error('Manual registration requires an explicitly injected atomic compareAndSwap configuration/receipt adapter');
 return io;
}
export function createHostAdapter({id,displayName,relativeConfig,cliCommand,cliArgs,entryType=false,documentation,connectionHelp}){
 const cli=id==='codex';
 const descriptor={schema:1,id,displayName,transport:'stdio',reviewDelivery:'pull',capabilities:Object.freeze({tools:true,evidenceLevel:'fixture-tested',automaticWakeup:false,nativeModelVerification:false}),documentation};
 const adapter={...descriptor,connectionHelp:Object.freeze(connectionHelp),
  previewRegistration({paths,launcher,existing}={}){
   if(!object(paths))throw Error('Host paths are required');
   const home=absolute(paths.home,'host home'),configDir=absolute(paths.configDir,'receipt directory');
   absolute(launcher,'Mosaic launcher');
   const target=cli&&paths.codexHome!==undefined
    ?path.join(absolute(paths.codexHome,'Codex profile'),'config.toml')
    :path.join(home,...relativeConfig);
   const before=config(existing,cli);
   const entry={...(entryType?{type:'stdio'}:{}),command:launcher,args:['mcp']};
   const ownedEntry=cli?{name,enabled:true,transport:{type:'stdio',...entry}}:entry;
   if(select(before,cli)!==null)throw Error('Existing mosaic-beta entry is foreign; use its original ownership receipt to remove or preserve it');
   const after=set(before,ownedEntry,cli,!!before.mcpServers);
   const command=cliCommand??null,argv=cliArgs?cliArgs(launcher):null;
   const instructions=`Manual configuration for ${displayName}: review this ${name} entry and preserve other settings. ${connectionHelp.locate} If the name already exists, keep an exact match and preserve a differing entry. ${command?`If the name is available, run the reviewed argv as ${formatHostCommand(command, argv)}. `:`Add only the new entry inside mcpServers. `}${connectionHelp.refresh} Pull review_inbox from the main conversation, inspect bounded evidence, then use review_reserve and review_submit with exact binding hashes. An inactive or closed host is not guaranteed to wake; disconnected review remains durably waiting. API review is separately authenticated and explicitly selected. Protected checks require an explicitly configured available backend; native revision2 uses the separately fingerprinted bundled check artifact. This registration preview alone does not prove host sign-in, model identity or sandbox enforcement.`;
   const value={schema:1,hostId:id,transport:'stdio',reviewDelivery:'pull',evidenceLevel:'fixture-tested',target,receiptFile:path.join(configDir,`host-${id}-binding.json`),launcher,entry,ownedEntry,command,argv,
    expectedConfigHash:fingerprint(before),appliedConfigHash:fingerprint(after),hadMcpServers:!!before.mcpServers,instructions};
   return {...value,previewHash:fingerprint(value)};
  },
  async applyRegistration(preview,{io}={}){
   validatePreview(preview);ioContract(io);
   const current=config(await io.read(preview.target),cli),receipt=await io.readReceipt(preview.receiptFile),entry=select(current,cli),entryHash=fingerprint(preview.ownedEntry);
   if(receipt){
    if(receipt.schema!==1||receipt.hostId!==id||receipt.previewHash!==preview.previewHash||receipt.target!==preview.target||receipt.entryHash!==entryHash||!['pending','complete'].includes(receipt.state))throw Error('Host registration receipt conflicts with exact preview identity');
    if(receipt.state==='complete'){
     if(fingerprint(entry)!==entryHash)throw Error('Owned host registration changed');
     return copy(receipt);
    }
    if(fingerprint(current)!==preview.expectedConfigHash&&fingerprint(current)!==preview.appliedConfigHash)throw Error('Host configuration changed during interrupted apply');
   }else {
    if(fingerprint(current)!==preview.expectedConfigHash||entry!==null)throw Error('Host configuration changed since preview');
   }
   const pending={schema:1,hostId:id,target:preview.target,previewHash:preview.previewHash,entryHash,hadMcpServers:preview.hadMcpServers,state:'pending'};
   if(!receipt)await io.writeReceipt(pending,preview.receiptFile);
   if(fingerprint(current)!==preview.appliedConfigHash){
    // The adapter must compare the current canonical config hash and replace it
    // as one atomic operation. A reread or atomic rename alone is insufficient.
    const applied=await io.compareAndSwap(set(current,preview.ownedEntry,cli,preview.hadMcpServers),preview.target,{expectedHash:fingerprint(current),command:preview.command,argv:preview.argv});
    if(applied!==true)throw Error('Host configuration changed during conditional apply; pending ownership retained');
   }
   const actual=config(await io.read(preview.target),cli);
   if(fingerprint(select(actual,cli))!==entryHash)throw Error('Host registration adapter did not save the exact preview entry');
   const complete={...pending,state:'complete'};await io.writeReceipt(complete,preview.receiptFile);return copy(complete);
  },
  async removeRegistration({io,receiptFile}={}){
   ioContract(io);const receipt=await io.readReceipt(receiptFile);
   if(!receipt)return {removed:false,reason:'no-ownership-receipt'};
   if(receipt.schema!==1||receipt.hostId!==id||!['pending','complete'].includes(receipt.state)||!/^[a-f0-9]{64}$/.test(receipt.entryHash)||typeof receipt.hadMcpServers!=='boolean')throw Error('Invalid host ownership receipt');
   absolute(receipt.target,'host configuration target');
   const current=config(await io.read(receipt.target),cli);
   if(receipt.state==='pending'&&select(current,cli)===null){await io.removeReceipt(receiptFile);return {removed:true};}
   if(fingerprint(select(current,cli))!==receipt.entryHash)return {removed:false,reason:'modified-owned-entry'};
   const removed=await io.compareAndSwap(set(current,null,cli,receipt.hadMcpServers),receipt.target,{expectedHash:fingerprint(current),remove:true});
   if(removed!==true)throw Error('Host configuration changed during conditional removal; ownership retained');
   await io.removeReceipt(receiptFile);return {removed:true};
  }
 };
 function validatePreview(preview){
  if(!object(preview)||preview.hostId!==id||preview.schema!==1)throw Error('Invalid host preview identity');
  const {previewHash,...value}=preview;if(fingerprint(value)!==previewHash)throw Error('Host preview identity changed');
  absolute(preview.launcher,'Mosaic launcher');absolute(preview.target,'host configuration');absolute(preview.receiptFile,'ownership receipt');
  const entry={...(entryType?{type:'stdio'}:{}),command:preview.launcher,args:['mcp']};
  const owned=cli?{name,enabled:true,transport:{type:'stdio',...entry}}:entry;
  if(fingerprint(entry)!==fingerprint(preview.entry)||fingerprint(owned)!==fingerprint(preview.ownedEntry)||preview.command!==(cliCommand??null)||fingerprint(preview.argv)!==fingerprint(cliArgs?cliArgs(preview.launcher):null))throw Error('Host preview owned entry or argv changed');
 }
 return Object.freeze(adapter);
}
