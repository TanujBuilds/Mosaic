import {mkdir,readFile,writeFile,readdir,lstat,open,opendir} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isEntry} from './entry.mjs';
import {command,git} from '../project/process.mjs';
import {digest} from './contracts.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const overnightReference=`# Overnight review v2

Use this reference for new independent background coding work. Historical v1 jobs retain [compatibility](compatibility.md), original IDs, hashes, requests, counters and deadlines. Never retry an expired tracker as part of a software repair. Keep the other three modes unchanged. Research remains parked.

## Prepare the ordinary request

Retain explicit mode choice. Clarify the product outcome, dependencies, acceptance and trusted setup only when genuinely missing. DeepSeek owns the routine stage assignments and implementation plan; Codex owns product scope, protected checks and independent review. There is no native implementation, rescue, takeover or invented owner-answer fallback inside this mode.

Disclose proposed defaults before activation: eight hours, at most ten sequential stages, two hours/stage, five attempts, fifty coding requests and two Codex reviews/stage; the planner has a separate three-request ceiling. Narrower owner limits win. A mode choice alone grants no spending. Prepare the exact normalized goal using goal_prepare with overnight_review modeVersion 2. Pin read/write inventory and literal project checks. Explicit overnightPolicy names preflightCheckIds and finalOnlyCheckIds (plus optional launchCheckIds for literal approved final launch checks), plus maxBatches <=20, maxExchanges <=40, maxCorrections <=2, reconnectMs <=1800000. The final stage must run every project check; implementation stages exclude future final-only gates. Every stage supplies role, scoped permissions/check IDs, dependencies and acceptance. V2 stages are created only by the validated planner, never generic task_submit; individual task_rebind cannot change its graph. Use only a supported separately validated graph transition and preserve IDs/spending; if unavailable, stop and report that limitation. Planner validation is atomic, with no children from an invalid graph.

## Exact preflight and independent launch

Before activation call overnight_preflight using the prepared goalId, exact hash and a stable mutation key. Inspect its long operation through operation_get. It runs explicit starter infrastructure checks under the actual workspace.manifest.permissions, base, approved tracked inventory, dependency copy and sandbox. Trusted build checks consume MOSAIC_APPROVED_INPUTS, a staging tree copied only from approved input inventory, rather than copying the repository root indiscriminately. Failure is actionable before DeepSeek spending; inspect declared inputs instead of letting the worker code around an infrastructure denial. Changed source, dependencies, checks, manifest or runtime invalidate the receipt. Goal activation refuses a missing/mismatched/failed receipt. Use goal_activate only within matching owner authorization.

Confirm actual independent start from goal_get/task_get/queue_get: fresh service-owned planning/request reservation or execution checkpoint, original deadline, current phase and saved overnightRun reportPath/markdownPath. A PID, active label, enqueued record or waiter timeout alone proves no execution. If no actual service progress is saved, say start is unverified. The running coordinator owns DeepSeek, protected checks, check-gated Codex CLI review, integration, monitoring and finalization; the chat can close after confirmed start. Keep the Mac powered and model reachable. A bounded macOS idle-sleep assertion is held while authorized execution runs, released on pause/stop/attention/completion. It is not a native always-on Codex chat or periodic Codex inference.

## Observe, questions and completion

Use [operations](operations.md) and discovered actual tools. The CLI wait is observation only; it does not supervise execution. Optional --cursor SEQ continues at a returned cursor. Current authoritative state is inspected first; default current event cursor avoids historical replay. Forty requests and an observation deadline still bound each wait. Timeout/cancellation ends observation only, never the independent job. Do not imply a monitor handoff or loop native model turns over unchanged state.

Use goal_get.overnightRun plus saved report.json/report.md and the existing dashboard/notifications. Questions pause affected work until the real owner answers. Known non-dispatch provider outages may reconnect for at most thirty minutes inside the original deadline; ambiguous inference remains spent and uncertain, with no automatic resend. Local fixed-text alerts cover completion, blocker, uncertainty and questions only; delivery attempts/results are saved; submission success does not prove OS visibility and suppression may be unknown. The report/dashboard is authoritative. No external communications are sent.

V2 apply_changes accumulates bounded atomic batches without finishing or spending an attempt; finish_stage freezes and gates. A failed functional gate starts the next original attempt retaining edits/spending. Precise protocol diagnostics allow at most two correction responses within the attempt; stale hashes require a fresh read. Infrastructure errors stop with evidence. Candidate, review and integration use effective current/accepted-stage gates plus preflight invariants; final runs the full suite. V2 review packets include bounded approved read-only reference contents, actual earlier checkpoint diffs and captured stage/revision/batch provenance. Final review includes current source contents even with an empty final diff and the output of declared launchCheckIds. Completion receipts/alerts are verified after final integration, not demanded circularly by the code reviewer. A coordinator evidence-delivery defect may use task_review_evidence_retry only with exact task/result hashes, unchanged candidate, passing gates, quiescence and remaining original review budget. This performs no product code edits or model/attempt/deadline renewal. Read/apply action receipts are supplied to the coding model so fulfilled actions are not indistinguishable repeated prompts. Only reviewed integrated work unlocks dependents. Integration failures require supported repair, not target edits or resets.

Automatic success requires the validated graph, all stages independently reviewed/integrated and full final suite passing. Morning report gives result, approved launch instructions (or explicitly unavailable), branch/worktree, checks, reviews, usage, original limits and evidence. Failure preserves first blocker after expiry and gives the exact continuation decision. Publication/deployment/outreach/accounts remain separate authority. Do not claim release acceptance from fixture runs or unit tests: the real three-stage independent DeepSeek/Codex review+revision pilot and installed routing/alert/report evidence are still required. A prepared live pilot is not activation authority.
`;
function overnightSkill(file,body){
 if(file==='SKILL.md')return body.replace('| Explicit bounded background review or historical jobs | [Compatibility](references/compatibility.md) |','| Independent background coding (new v2) | [Overnight review](references/overnight.md) |\n| Historical jobs | [Compatibility](references/compatibility.md) |').replace(/After a launch, use one deterministic[\s\S]*?No always-on Codex supervisor is installed\./,'Use bounded deterministic observation through [operations](references/operations.md). Observation timeout ends only observation. Overnight v2 runs independently in the coordinator after verified start; follow its dedicated reference for exact preflight and saved report locations. Main Codex supervises other native workflows only while its chat is active. No always-on native Codex supervisor is installed.');
 if(file==='references/operations.md')return body+'\n## Overnight v2 and observer continuation\n\nFor independent new overnight work read [Overnight review](overnight.md). wait accepts optional --cursor SEQ and returns its continuation cursor. It observes current state first and defaults to the current event cursor supplied by the getter. Timeout ends observation only. The service owns the overnight monitor and saved report; one short wait is not supervision.\n';
 if(file==='references/compatibility.md')return body+'\nNew independent overnight work uses [Overnight review v2](overnight.md), including exact-policy preflight before activation. Retain all historical handling above for v1 and legacy records.\n';
 return body;
}
const SKILLS=['frontier-harness','frontier-collaborate','frontier-deepseek-only','frontier-codex-only'];
const privateEntry=name=>['local-config.json','connection.json','node_modules','runtime','.data','.git','__pycache__'].includes(name)||/\.(?:sqlite(?:-wal|-shm)?|db|pyc)$/.test(name);
const reviewedSkillFile=file=>file==='SKILL.md'||file==='agents/openai.yaml'||file==='scripts/harness.mjs'||/^references\/[\w/-]+\.md$/.test(file)||/^roles\/(?:implementer|explorer|reviewer)\.toml$/.test(file)||/^examples\/(?:local-config|provider-config)\.json$/.test(file);
async function files(root,prefix='',portableSkill=false){const result=[];if((await lstat(path.join(root,prefix))).isSymbolicLink())throw Error('Package source symlinks are unsupported');for(const entry of await readdir(path.join(root,prefix),{withFileTypes:true})){if(portableSkill&&privateEntry(entry.name)&&!(prefix==='examples'&&entry.name==='local-config.json'))continue;const file=path.posix.join(prefix,entry.name);if(entry.isSymbolicLink())throw Error('Package source symlinks are unsupported');if(entry.isDirectory())result.push(...await files(root,file,portableSkill));else if(entry.isFile())result.push(file);else throw Error('Package sources must be regular files');}return result;}
export async function packageHarness({sourceRoot,destination,dependencies=false,offline=false}){
 sourceRoot=path.resolve(sourceRoot);destination=path.resolve(destination);await mkdir(path.dirname(destination),{recursive:true});
 try{await mkdir(destination,{mode:0o700});}catch(error){if(error.code==='EEXIST')throw Error('Package destination already exists; preserve it and select a new version directory');throw error;}
 const inventory=[];
 const copy=async(source,target,transform)=>{if(!(await lstat(source)).isFile())throw Error('Package sources must be regular files');let data=await readFile(source);if(transform)data=Buffer.from(transform(data.toString('utf8')));await mkdir(path.dirname(target),{recursive:true,mode:0o700});await writeFile(target,data,{mode:0o600});inventory.push({path:path.relative(destination,target).split(path.sep).join('/'),sha256:hash(data),bytes:data.length});};
 for(const name of SKILLS){const skill=path.join(sourceRoot,'.agents/skills',name);for(const file of (await files(skill,'',true)).filter(reviewedSkillFile)){
  await copy(path.join(skill,file),path.join(destination,'skills',name,file),name==='frontier-harness'?body=>overnightSkill(file,body):undefined);
  // Retain the old top-level primary skill and launcher without another runtime.
  if(name==='frontier-harness')await copy(path.join(skill,file),path.join(destination,file),body=>{const updated=overnightSkill(file,body);return file==='SKILL.md'?updated.replaceAll('](../frontier-','](skills/frontier-'):updated;});
 }}
 for(const relative of ['references/overnight.md','skills/frontier-harness/references/overnight.md']){const target=path.join(destination,relative),data=Buffer.from(overnightReference);await mkdir(path.dirname(target),{recursive:true,mode:0o700});await writeFile(target,data,{mode:0o600});inventory.push({path:relative,sha256:hash(data),bytes:data.length});}
 for(const file of await files(path.join(sourceRoot,'src')))await copy(path.join(sourceRoot,'src',file),path.join(destination,'runtime/src',file));
 for(const file of ['package.json','package-lock.json'])await copy(path.join(sourceRoot,file),path.join(destination,'runtime',file));
 const research='.agents/skills/deep-research';for(const file of await files(path.join(sourceRoot,research,'scripts')))if(file.endsWith('.py'))await copy(path.join(sourceRoot,research,'scripts',file),path.join(destination,'runtime',research,'scripts',file));
 for(const file of ['requirements.txt','requirements.lock','deploy/deep-research.service.template'])await copy(path.join(sourceRoot,research,file),path.join(destination,'runtime',research,file));
 if(dependencies){const npm=process.platform==='win32'?[process.execPath,path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js')]:['npm'];const result=await command([...npm,'ci','--omit=dev','--ignore-scripts','--bin-links=false','--no-audit','--no-fund',...(offline?['--offline']:[])],{cwd:path.join(destination,'runtime')});if(result.code!==0)throw Error('Pinned runtime dependency installation failed: '+result.stderr.slice(-2000));
  const modules=path.join(destination,'runtime/node_modules');for(const file of await files(modules)){const data=await readFile(path.join(modules,file));inventory.push({path:'runtime/node_modules/'+file.split(path.sep).join('/'),sha256:hash(data),bytes:data.length});}
 }
 const manifest={schema:1,layout:'shared-runtime-v1',skills:SKILLS,sourceCommit:await git(sourceRoot,'rev-parse','HEAD'),sourceDirty:!!await git(sourceRoot,'status','--porcelain'),nodeMajor:24,sdkVersion:'1.32.2',dependenciesInstalled:dependencies,files:inventory.sort((a,b)=>a.path.localeCompare(b.path))};manifest.contentHash=digest(manifest.files);await writeFile(path.join(destination,'package-manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});return manifest;
}
// Finite verifier bounds and measured compatibility headroom are documented in
// docs/PACKAGE_VERIFICATION_LIMITS.md. These are byte/work ceilings, not options.
const verificationLimits={manifest:8*1024**2,dependency:2*1024**2,files:32768,directories:32768,pathBytes:4096,depth:64,fileBytes:2*1024**3,totalBytes:8*1024**3,chunk:65536};
const dependencyPaths=['runtime/package-lock.json','runtime/node_modules/@modelcontextprotocol/sdk/package.json'];
function parseVerificationJson(bytes,label){
 try{return JSON.parse(bytes.toString('utf8'));}catch{throw new SyntaxError('Invalid package '+label+' JSON');}
}
const sameVerificationEntry=(a,b)=>['dev','ino','mode','size','mtimeNs','ctimeNs','nlink'].every(key=>a[key]===b[key]);
async function verificationDirectory(target){
 const info=await lstat(target,{bigint:true});
 if(!info.isDirectory()||info.isSymbolicLink())throw Error('Package parent must be a regular directory, not a symlink');
 return info;
}
async function verificationParents(destination,relative){
 let target=destination;
 for(const part of relative.split('/')){await verificationDirectory(target);target=path.join(target,part);}
 return target;
}
async function readVerificationFile(target,{expected,metadataLimit,label},buffer){
 if(!Number.isInteger(constants.O_NOFOLLOW)||!Number.isInteger(constants.O_NONBLOCK))throw Error('Package verification requires no-follow and nonblocking file opens');
 const handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=await handle.stat({bigint:true});
  if(!before.isFile())throw Error('Package entries must be regular files, not symlinks or special files');
  if(expected?.mode!==undefined&&(before.mode&0o7777n)!==BigInt(Number.parseInt(expected.mode.slice(3),8)))throw Error('Package executable mode mismatch: '+label);
  if(metadataLimit!==undefined&&before.size>BigInt(metadataLimit))throw Error('Package metadata byte limit exceeded: '+label);
  if(expected&&before.size!==BigInt(expected.bytes))throw Error('Package file checksum mismatch (length): '+label);
  const limit=expected?expected.bytes:metadataLimit,parts=metadataLimit===undefined?null:[],checksum=createHash('sha256');
  let count=0;
  // The extra byte detects growth/overrun without consuming an unbounded tail.
  while(true){
   const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,limit-count+1),count);
   if(!bytesRead)break;
   count+=bytesRead;
   if(count>limit)throw Error('Package file byte limit exceeded: '+label);
   const chunk=buffer.subarray(0,bytesRead);checksum.update(chunk);if(parts)parts.push(Buffer.from(chunk));
  }
  const after=await handle.stat({bigint:true}),current=await lstat(target,{bigint:true});
  if(!sameVerificationEntry(before,after)||!sameVerificationEntry(after,current))throw Error('Package entry changed during verification: '+label);
  if(BigInt(count)!==before.size||expected&&checksum.digest('hex')!==expected.sha256)throw Error('Package file checksum mismatch: '+label);
  return parts?Buffer.concat(parts,count):null;
 }finally{await handle.close();}
}
export async function verifyPackage(destination){
 destination=path.resolve(destination);
 const rootInfo=await verificationDirectory(destination),buffer=Buffer.alloc(verificationLimits.chunk);
 const manifest=parseVerificationJson(await readVerificationFile(path.join(destination,'package-manifest.json'),{metadataLimit:verificationLimits.manifest,label:'package manifest'},buffer),'manifest');
 if(!manifest||manifest.schema!==1||!Array.isArray(manifest.files)||!manifest.files.length||typeof manifest.dependenciesInstalled!=='boolean')throw Error('Invalid package manifest');
 if(manifest.files.length>verificationLimits.files)throw Error('Package inventory entry limit exceeded');
 const seen=new Set(),directories=new Set(['']);let total=0;
 // Validate all metadata/work bounds before touching listed payload paths or
 // canonicalizing the untrusted inventory for the existing digest contract.
 for(const file of manifest.files){
  if(!file||typeof file.path!=='string'||path.isAbsolute(file.path)||file.path.includes('\\')||file.path.includes('\0')||file.path.split('/').some(p=>p==='..'||p==='.'||!p)||!Number.isSafeInteger(file.bytes)||file.bytes<0||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('Invalid package path or file metadata');
  if(file.mode!==undefined&&!['100644','100755','100600'].includes(file.mode))throw Error('Invalid package file mode');
  if(Buffer.byteLength(file.path,'utf8')>verificationLimits.pathBytes||file.path.split('/').length>verificationLimits.depth)throw Error('Package path limit exceeded');
  total+=file.bytes;
  if(file.bytes>verificationLimits.fileBytes||total>verificationLimits.totalBytes)throw Error('Package payload byte limit exceeded');
  if(manifest.dependenciesInstalled&&dependencyPaths.includes(file.path)&&file.bytes>verificationLimits.dependency)throw Error('Package metadata byte limit exceeded: '+file.path);
  if(seen.has(file.path))throw Error('Duplicate package path');seen.add(file.path);
  let parent=path.posix.dirname(file.path);
  while(parent!=='.'&&!directories.has(parent)){
   directories.add(parent);if(directories.size-1>verificationLimits.directories)throw Error('Package directory limit exceeded');parent=path.posix.dirname(parent);
  }
 }
 if(manifest.contentHash!==digest(manifest.files))throw Error('Package manifest checksum mismatch');
 const dependencyMetadata=new Map();
 for(const file of manifest.files){
  const target=await verificationParents(destination,file.path),metadataLimit=manifest.dependenciesInstalled&&dependencyPaths.includes(file.path)?verificationLimits.dependency:undefined;
  const bytes=await readVerificationFile(target,{expected:file,metadataLimit,label:file.path},buffer);
  if(metadataLimit!==undefined)dependencyMetadata.set(file.path,bytes);
 }
 // One bounded iterator is open at a time. Every accepted directory/file must
 // come from the manifest; at most one unexpected entry is needed to reject.
 const pending=[''];let inspected=0;
 while(pending.length){
  const prefix=pending.pop(),target=prefix?await verificationParents(destination,prefix):destination;
  const before=await verificationDirectory(target),directory=await opendir(target,{bufferSize:1});
  try{
   let entry;
   while((entry=await directory.read())!==null){
    if(++inspected>seen.size+directories.size)throw Error('Package directory entry limit exceeded');
    const relative=prefix?prefix+'/'+entry.name:entry.name;
    if(entry.isSymbolicLink())throw Error('Unexpected package symlink: '+relative);
    if(entry.isDirectory()){
     if(!directories.has(relative))throw Error('Unlisted package directory: '+relative);pending.push(relative);
    }else if(!entry.isFile()||relative!=='package-manifest.json'&&!seen.has(relative))throw Error('Unlisted or nonregular package entry: '+relative);
   }
  }finally{await directory.close();}
  if(!sameVerificationEntry(before,await verificationDirectory(target)))throw Error('Package directory changed during verification');
 }
 if(!sameVerificationEntry(rootInfo,await verificationDirectory(destination)))throw Error('Package root changed during verification');
 if(manifest.dependenciesInstalled){
  if(dependencyPaths.some(file=>!dependencyMetadata.has(file))){const error=Error('ENOENT: Missing inventoried runtime dependency metadata');error.code='ENOENT';throw error;}
  const [lock,sdk]=dependencyPaths.map(file=>parseVerificationJson(dependencyMetadata.get(file),'dependency metadata '+file));
  if(sdk.version!==lock.packages['node_modules/@modelcontextprotocol/sdk'].version)throw Error('Pinned runtime dependency mismatch');
 }
 return true;
}
export function renderLaunchAgent({node,entry,root,config,port=4332,logs}){
 for(const value of [node,entry,root,config,logs])if(!path.isAbsolute(value))throw Error('Deployment paths must be absolute');if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid service port');
 const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;'),argv=[node,entry,'serve','--root',root,'--config',config,'--port',String(port)];
 return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.frontier.harness</string><key>ProgramArguments</key><array>${argv.map(x=>'<string>'+escape(x)+'</string>').join('')}</array><key>WorkingDirectory</key><string>${escape(root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>30</integer><key>StandardOutPath</key><string>${escape(path.join(logs,'coordinator.log'))}</string><key>StandardErrorPath</key><string>${escape(path.join(logs,'coordinator-error.log'))}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape(path.dirname(node)+':/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')}</string></dict></dict></plist>\n`;
}
async function main(){const args=process.argv.slice(2),options={};while(args.length){const flag=args.shift();if(['--dependencies','--offline'].includes(flag))options[flag.slice(2)]=true;else if(['--source-root','--destination'].includes(flag)&&args.length)options[flag==='--source-root'?'sourceRoot':'destination']=args.shift();else throw Error('Use --source-root REPO --destination NEW_DIRECTORY [--dependencies] [--offline]');}if(!options.sourceRoot||!options.destination)throw Error('Source and destination required');const manifest=await packageHarness(options);console.log(JSON.stringify({destination:options.destination,contentHash:manifest.contentHash,files:manifest.files.length,dependenciesInstalled:manifest.dependenciesInstalled}));}
if(isEntry(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
