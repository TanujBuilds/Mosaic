import {DatabaseSync} from 'node:sqlite';
import {assertWindowsDatabaseFiles,prepareWindowsDatabase} from '../harness/windows-database.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {lstat,mkdir,open,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {constants as bufferConstants} from 'node:buffer';
import os from 'node:os';
import {windowsFile,windowsWrite} from './windows-files.mjs';
import path from 'node:path';

export const label='com.mosaic.beta';
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const shellQuote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
export const currentHome=()=>os.homedir();

export function locations(home,isolated=false){
 if(!path.isAbsolute(home)||/[\x00-\x1f]/u.test(home))throw Error('Home must be an absolute local directory');
 const windows=process.platform==='win32';
 const localAppData=isolated?path.join(home,'AppData','Local'):(process.env.LOCALAPPDATA||path.join(home,'AppData','Local'));
 if(windows&&!path.isAbsolute(localAppData))throw Error('LOCALAPPDATA must be an absolute directory');
 const root=windows?path.join(localAppData,'Mosaic Beta'):path.join(home,'Library','Application Support','Mosaic Beta');
 const configDir=path.join(root,'config');
 const codexHome=!isolated&&process.env.CODEX_HOME?path.resolve(process.env.CODEX_HOME):path.join(home,'.codex');
 return {home,root,isolated,codexHome,configDir,versions:path.join(root,'versions'),state:path.join(root,'state'),
  launcher:windows?path.join(root,'bin','mosaic.exe'):path.join(home,'.local','bin','mosaic'),config:path.join(configDir,'settings.json'),
  ownership:path.join(configDir,'bindings.json'),installation:path.join(configDir,'installation.json'),
  setupIntent:path.join(configDir,'setup-intent.json'),credentials:path.join(configDir,'credentials.json'),disabled:path.join(configDir,'disabled.json'),isolatedMcp:path.join(configDir,'isolated-mcp.json'),
  plist:path.join(home,'Library','LaunchAgents',label+'.plist'),
  skill:path.join(codexHome,'skills','mosaic-beta','SKILL.md'),zshrc:path.join(home,'.zshrc')};
}

export async function entry(file){
 try{return await lstat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
}

export async function fileBytes(file,{max=1024*1024,privateFile=false}={}){
 if(!Number.isSafeInteger(max)||max<0||max>=bufferConstants.MAX_LENGTH)throw RangeError('File byte limit must be a supported nonnegative finite integer');
 if(process.platform==='win32')return windowsFile(privateFile?'read-private':'read',file,{max,optional:true});
 const unsafe=()=>Error('Unsafe file permissions or type at '+file);
 if(!Number.isInteger(constants.O_NOFOLLOW)||!constants.O_NOFOLLOW||!Number.isInteger(constants.O_NONBLOCK)||!constants.O_NONBLOCK)
  throw Error('Safe file reads are unavailable on this platform');
 let handle;
 try{handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
 catch(error){if(error.code==='ENOENT')return null;if(error.code==='ELOOP')throw unsafe();throw error;}
 try{
  const info=await handle.stat({bigint:true});
  if(!info.isFile()||info.size>BigInt(max)||privateFile&&(info.mode&0o077n))throw unsafe();
  // One sentinel byte detects growth without allocating or reading past max+1.
  const bytes=Buffer.alloc(Number(info.size)+1);let length=0;
  while(length<bytes.length){
   const {bytesRead}=await handle.read(bytes,length,bytes.length-length,length);
   if(!bytesRead)break;
   length+=bytesRead;
  }
  if(length>max)throw unsafe();
  const after=await handle.stat({bigint:true});
  // This detects observed changes, not every hostile concurrent same-UID write.
  if(BigInt(length)!==info.size||['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'].some(key=>info[key]!==after[key]))
   throw Error('File changed while reading at '+file);
  return bytes.subarray(0,length);
 }finally{await handle.close();}
}

export async function jsonFile(file,options){
 const data=await fileBytes(file,options);
 if(!data)return null;
 try{return JSON.parse(data);}catch{throw Error('Invalid JSON file at '+file);}
}

export async function atomic(file,bytes,{mode=0o600}={}){
 if(process.platform==='win32')return windowsWrite(file,bytes);
 const tmp=path.join(path.dirname(file),'.mosaic-beta-'+randomUUID());
 try{
  await writeFile(tmp,bytes,{flag:'wx',mode,flush:true});
  await rename(tmp,file);
 }finally{await rm(tmp,{force:true});}
}

export const saveJson=(file,value)=>atomic(file,JSON.stringify(value,null,2)+'\n');

export async function localDirectory(paths,directory,{create=true}={}){
 if(process.platform==='win32'){
  const relative=path.relative(paths.home,directory);
  if(paths.isolated&&(path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep)))throw Error('Fixture paths must stay within the isolated home');
  await windowsFile(create?'mkdir':'directory',directory,{optional:!create});return;
 }
 if(!paths.isolated){
  if(create)await mkdir(directory,{recursive:true,mode:0o700});
  return;
 }
 const parts=path.relative(paths.home,directory).split(path.sep);
 if(parts[0]==='..'||path.isAbsolute(parts.join(path.sep)))throw Error('Fixture paths must stay within the isolated home');
 if(create)await mkdir(paths.home,{recursive:true,mode:0o700});
 let current=paths.home;
 for(const part of ['',...parts.filter(Boolean)]){
  current=path.join(current,part);
  if(part&&create)await mkdir(current,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  const info=await entry(current);
  if(!info&&!create)return;
  if(!info?.isDirectory())throw Error('Unsafe directory in isolated fixture at '+current);
 }
}

export async function privateDirectories(paths){
 for(const directory of [paths.root,paths.configDir,paths.state,paths.versions]){
  await localDirectory(paths,directory);
  if(process.platform==='win32'){await windowsFile('private-directory',directory);continue;}
  const info=await lstat(directory);
  if(!info.isDirectory()||info.mode&0o077||info.uid!==process.getuid()||await realpath(directory)!==path.join(await realpath(paths.home),path.relative(paths.home,directory)))
   throw Error('Use an owned private directory (0700) at '+directory);
 }
}

export function readMaintenanceDatabase(file,read){
 let db;
 try{
  if(process.platform==='win32'&&!assertWindowsDatabaseFiles(file))throw Error('Missing Windows maintenance database');
  db=new DatabaseSync(file,{readOnly:true,timeout:1000});
  return read(db);
 }catch(error){
  // SQLite keeps the primary result code in the low byte of extended codes.
  if(error?.code==='ERR_SQLITE_ERROR'&&[5,6].includes(error.errcode&0xff)){
   throw Error('The Mosaic Beta state database is locked. Wait for the database to become available, then retry. If an installation is pending, run mosaic recover.',{cause:error});
  }
  throw error;
 }finally{db?.close();}
}

export async function withLock(paths,work){
 await privateDirectories(paths);
 const file=path.join(paths.configDir,'maintenance.sqlite3');
 if(process.platform==='win32')prepareWindowsDatabase(file);
 else{
  try{const handle=await open(file,'wx',0o600);await handle.close();}
  catch(error){if(error.code!=='EEXIST')throw error;}
  const info=await lstat(file);
  if(!info.isFile()||info.mode&0o077||info.uid!==process.getuid())throw Error('Unsafe Mosaic Beta maintenance lock');
 }
 const lock=new DatabaseSync(file);
 try{
  // SQLite releases the operating-system lock when a process exits, including SIGKILL.
  try{lock.exec('BEGIN IMMEDIATE');}
  catch(error){if(error.errcode!==5)throw error;throw Error('Another Mosaic Beta maintenance command is running. Retry when it finishes.');}
  return await work();
 }finally{lock.close();}
}
