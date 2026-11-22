import {integrationBinding} from './owner-inbox.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {access,readFile} from 'node:fs/promises';
import {canonicalRepository,capacitySnapshot,writeScopeWait,inertUnstartedGoal,repositoryLockId,sharedBaseJournalId} from './scheduling/capacity.mjs';
import {effectiveIntegrationChecks,isOvernightV2} from './overnight.mjs';
import { repairIntegration,assertPendingRepair } from './integration-repair.mjs';
import { NativeCandidates } from './native-candidates.mjs';
import { Journal } from '../project/journal.mjs';
import { Workspace,inspectRepository } from '../project/workspace.mjs';
import {approvedChecks,executionFields} from './execution.mjs';
import { matches,protectedPath,relativePath,secretPath,digest as fileDigest,Pause } from '../project/contracts.mjs';
import { git,gitBytes } from '../project/process.mjs';
import { windowsIndexModes } from '../project/git.mjs';
import { windowsGitFileMode } from '../project/windows-git.mjs';
import { CodingAdapter } from './coding.mjs';
import { digest,identifier,text } from './contracts.mjs';
import { assertBehavioralChecks,behavioralModeHash,deriveBehavioralEvidence,readBehavioralFileModes } from './behavioral-validation.mjs';

const isWindows=process.platform==='win32';
const windowsFiles=isWindows?await import('../beta/windows-files.mjs'):null;
const changedFileLimit=128*1024;

function behavioralEvidenceFor(project, checkSpecs, checks, snapshot, modes){
 const executableModesHash=modes?behavioralModeHash(modes):undefined;
 return deriveBehavioralEvidence(project,{checks,checkIds:checkSpecs.map(check=>check.id),snapshot,executableModesHash});
}

function assertCheckpointSnapshot(checkpoint,snapshot){
 if(digest(checkpoint.snapshot)!==digest(snapshot))throw Error('Checkpoint snapshot differs from the protected check run');
}

function checkedPath(workspace,file,{includeWrites=true}={}){
 if(secretPath(file)||file.startsWith('dist/')||file.startsWith('.overnight-output/'))return false;
 const {readPaths,writePaths}=workspace.manifest.permissions;
 return matches(file,readPaths)||includeWrites&&!protectedPath(file)&&matches(file,writePaths);
}

function checkedFileModes(workspace,snapshot){
 return readBehavioralFileModes(workspace,Object.keys(snapshot).filter(file=>checkedPath(workspace,file)));
}

async function assertCheckedModes(workspace,snapshot,modes){
 const current=await checkedFileModes(workspace,snapshot);
 if(current.size!==modes.size||[...modes].some(([file,mode])=>current.get(file)!==mode))throw Error('Executable bit changed after the protected check snapshot');
}

async function assertCheckoutConfig(workspace,beforeCommit){
 const root=workspace.root;
 const autocrlf=await git(root,'config','--type=bool-or-str','--default','false','--get','core.autocrlf');
 const eol=(await git(root,'config','--default','native','--get','core.eol')).toLowerCase();
 if(autocrlf==='true')throw Error('Git checkout core.autocrlf selects CRLF; cannot bind the checked bytes to a commit');
 if(autocrlf.toLowerCase()!=='input'&&(eol==='crlf'||eol==='native'&&process.platform==='win32'))throw Error('Git checkout core.eol selects CRLF; cannot bind the checked bytes to a commit');
 if(!isWindows&&beforeCommit&&await git(root,'config','--type=bool','--default','true','--get','core.filemode')==='false')throw Error('Git core.filemode=false prevents binding the checked executable bit to a commit');
}

function gitBlobId(bytes){
 return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

async function checkedBlobIds(workspace,snapshot,modes,{beforeCommit=false}={}){
 await assertCheckoutConfig(workspace,beforeCommit);
 const files=[...modes.keys()],ids=new Map();
 for(let start=0;start<files.length;start+=32){
  const batch=files.slice(start,start+32);
  // --all reports even a driver literally named "unset" or "unspecified".
  // Inspect attributes without executing a clean or checkout conversion.
  const attributes=(await git(workspace.root,'check-attr','--all','-z','--',...batch)).split('\0');
  for(let i=1;i<attributes.length;i+=3){
   const name=attributes[i],value=attributes[i+1];
   if(name==='filter')throw Error('Git filter attribute prevents binding checked bytes to a commit');
   if(name==='ident'||name==='working-tree-encoding'||name==='eol'&&value.toLowerCase()==='crlf')throw Error('Git checkout attribute '+name+'='+value+' prevents binding checked bytes to a commit');
  }
  const raw=[];
  for(const file of batch){
   const filename=await workspace.file(file);
   const bytes=isWindows?await windowsFiles.windowsFile('read',filename,{max:changedFileLimit}):await readFile(filename);
   if(fileDigest(bytes)!==snapshot[file])throw Error('Workspace bytes changed after the protected check snapshot');
   raw.push(gitBlobId(bytes));
  }
  if(beforeCommit){
   const clean=(await git(workspace.root,'hash-object','--',...batch)).split('\n');
   if(clean.length!==raw.length||raw.some((id,index)=>id!==clean[index]))throw Error('Git normalization would commit bytes different from the checked snapshot');
  }
  batch.forEach((file,index)=>ids.set(file,raw[index]));
 }
 await workspace.assertSnapshot(snapshot);
 await assertCheckedModes(workspace,snapshot,modes);
 return ids;
}

async function commitBlob(workspace,blob){
 const bytes=await gitBytes(workspace.root,'cat-file','blob',blob);
 if(gitBlobId(bytes)!==blob)throw Error('Git blob bytes differ from the checkpoint tree');
 return bytes;
}

async function committedChanges(workspace,base,commit,writePaths){
 const diff=await gitBytes(workspace.root,'diff-tree','-r','--no-commit-id','--raw','--no-abbrev','--no-renames','--no-ext-diff','--no-textconv','--ignore-submodules=none','-z',base,commit,'--');
 const records=diff.toString('utf8').split('\0');
 if(!diff.equals(Buffer.from(records.join('\0')))||records.length%2!==1||records.at(-1)!=='')throw Error('Cannot read exact checkpoint change paths');
 const edits=[];
 for(let i=0;i<records.length-1;i+=2){
  const file=relativePath(records[i+1]);
  if(protectedPath(file)||!matches(file,writePaths))throw Error('Candidate change outside approved scope');
  const [beforeMode,afterMode,beforeBlob,afterBlob]=records[i].slice(1).split(' ');
  if([beforeMode,afterMode].some(mode=>!['000000','100644','100755'].includes(mode)))throw Error('Candidate checkpoint contains an unsupported file type');
  const before=beforeMode==='000000'?null:await commitBlob(workspace,beforeBlob);
  const after=afterMode==='000000'?null:await commitBlob(workspace,afterBlob);
  const content=after?.toString('utf8')??null;
  if(after&&(after.length>changedFileLimit||after.includes(0)||!after.equals(Buffer.from(content))))throw Error('Candidate checkpoint file must be valid UTF-8 text up to 128 KiB: '+file);
  edits.push({path:file,action:after===null?'delete':'write',content,beforeHash:before===null?null:fileDigest(before),afterHash:after===null?null:fileDigest(after),beforeMode:before===null?null:beforeMode,afterMode:after===null?null:afterMode});
 }
 return edits;
}

async function assertImportedPaths(workspace,changes,errorForPath){
 for(const change of changes){
  const {hash}=await workspace.content(change.path);
  if(hash!==change.afterHash||await workspace.fileMode(change.path)!==change.afterMode)throw errorForPath(change.path);
 }
}

function pendingImportMismatch(file){
 return Error('Saved pending integration differs from the verified checkpoint'+(file?' for '+file:'')+'. Inspect the pending import journal before retrying.');
}

async function assertPendingImport({journal,workspace},pending,task,checkpoint,changes){
 const appliedKeys=new Set(journal.events.filter(event=>event.type==='edits.applied').map(event=>event.data.key));
 const unfinished=journal.events.filter(event=>event.type==='edits.intent'&&!appliedKeys.has(event.data.key));
 if(unfinished.some(event=>event.data.key!==pending?.importKey))throw Error('Another pending edit transaction owns the integration journal. Inspect its recovery evidence before retrying.');
 if(!pending)return;
 const {importKey}=pending;
 if(pending.taskId!==task.id||pending.candidateCommit!==checkpoint.commit||typeof importKey!=='string'||!importKey)throw pendingImportMismatch();
 const plans=journal.events.filter(event=>event.type==='integration.import.intent'&&event.data.key===importKey);
 const edits=journal.events.filter(event=>event.type==='edits.intent'&&event.data.key===importKey);
 if(plans.length>1||edits.length>1||!plans.length&&(edits.length||appliedKeys.has(importKey))||!edits.length&&appliedKeys.has(importKey))throw pendingImportMismatch();
 if(!plans.length)return; // The coordinator may have stopped immediately after reserving the target.
 const [plan]=plans,[editIntent]=edits;
 const prior=journal.events.filter(event=>event.sequence<plan.sequence);
 const priorCommit=prior.findLast(event=>event.type==='stage.accepted')?.data.commit??workspace.manifest.baseCommit;
 const priorSnapshot=prior.findLast(event=>event.data.snapshot)?.data.snapshot;
 const {data:saved}=plan;
 if(saved.taskId!==task.id||saved.candidateCommit!==checkpoint.commit||saved.baseCommit!==priorCommit||
    !priorSnapshot||digest(saved.snapshotBefore??null)!==digest(priorSnapshot)||!Array.isArray(saved.changes))throw pendingImportMismatch();
 const expected=new Map(changes.map(change=>[change.path,change]));
 const priorHash=file=>Object.hasOwn(priorSnapshot,file)?priorSnapshot[file]:null;
 // Historical mode-less rows can only resume regular non-executable files and deletions.
 const modesMatch=(row,change)=>['beforeMode','afterMode'].every(field=>Object.hasOwn(row,field)?row[field]===change[field]:change[field]!=='100755');
 const recorded=new Set();
 for(const row of saved.changes){
  const change=expected.get(row?.path),before=row?.before;
  if(!change||recorded.has(row.path)||row.afterHash!==change.afterHash||!modesMatch(row,change)||
     priorHash(row.path)!==change.beforeHash||before?.path!==row.path||before.hash!==change.beforeHash||
     (change.beforeHash===null?before.content!==null:typeof before.content!=='string'||fileDigest(before.content)!==change.beforeHash))throw pendingImportMismatch(row?.path);
  recorded.add(row.path);
 }
 if(editIntent){
  if(editIntent.sequence<=plan.sequence||digest(editIntent.data.snapshotBefore??null)!==digest(priorSnapshot)||!Array.isArray(editIntent.data.changes))throw pendingImportMismatch();
  const recordedEdits=new Set();
  for(const row of editIntent.data.changes){
   const change=expected.get(row?.path);
   if(!change||!recorded.has(row.path)||recordedEdits.has(row.path)||
      row.before!==change.beforeHash||row.after!==change.afterHash||row.content!==change.content||!modesMatch(row,change))throw pendingImportMismatch(row?.path);
   recordedEdits.add(row.path);
  }
  for(const file of recorded)if(!recordedEdits.has(file))throw pendingImportMismatch(file);
 }
 const unchanged=changes.filter(change=>!recorded.has(change.path));
 for(const change of unchanged)if(priorHash(change.path)!==change.afterHash)throw pendingImportMismatch(change.path);
 await assertImportedPaths(workspace,unchanged,pendingImportMismatch);
}

async function assertCheckedCommit(workspace,checkpoint,snapshot,modes){
 assertCheckpointSnapshot(checkpoint,snapshot);
 // CheckRunner reads working bytes, whereas Git can commit transformed bytes.
 const checked=await checkedBlobIds(workspace,snapshot,modes);
 const tree=new Map();
 for(const entry of (await git(workspace.root,'ls-tree','-r','-z',checkpoint.commit)).split('\0').filter(Boolean)){
  const tab=entry.indexOf('\t'),file=entry.slice(tab+1);
  if(checkedPath(workspace,file)){
   const [mode,,blob]=entry.slice(0,tab).split(' ');
   tree.set(file,{mode,blob});
  }
 }
 if(tree.size!==checked.size||[...checked].some(([file,blob])=>tree.get(file)?.blob!==blob))throw Error('Commit bytes differ from the checked snapshot; inspect Git filters and line endings');
 if([...modes].some(([file,mode])=>tree.get(file).mode!==mode))throw Error('Commit executable bit differs from the protected check snapshot');
 if(await git(workspace.root,'rev-parse','HEAD')!==checkpoint.commit)throw Error('Commit changed after checking the snapshot');
}

export class Integration {
 constructor({c,checksFactory,config={},signal}){this.signal=signal;this.c=c;this.checksFactory=checksFactory;this.config=config;this.inflight=new Map();this.repositoryTurns=new Map();this.executionContext=new AsyncLocalStorage();this.nativeCandidates=new NativeCandidates(this);}
 async effect(key,input,action){
  identifier(key,'idempotencyKey');const hash=digest(input),old=this.c.store.maybe('effect',key);
  if(old&&old.hash!==hash)throw Error('Idempotency key conflict');if(old?.status==='completed')return old.result;
  if(this.inflight.has(key))return this.inflight.get(key);
  if(!old)this.c.store.tx(()=>this.c.store.put('effect',{id:key,hash,status:'pending',input,at:this.c.now()}));
  const run=(async()=>{const operation=this.c.store.all('operation').find(row=>row.key===key||'effect-'+row.key===key);const result=await this.executionContext.run({operationKey:key,...(operation?{operationId:operation.id}:{})},action);this.c.store.tx(()=>this.c.store.put('effect',{id:key,hash,status:'completed',result,at:this.c.now()}));return result;})();
  this.inflight.set(key,run);try{return await run;}catch(error){if(error.code==='locked')error.retryable=true;throw error;}finally{this.inflight.delete(key);}
 }
 repositoryId(g){return repositoryLockId(g);}
 baseJournalId(g,generation){return sharedBaseJournalId(g,generation);}
 async integrationJournal(g){
  let id=g.integration?.journalId;
  if(!id){
   // Existing goal journals retain their path and semantics. New portable goals
   // share one checked target; historical no-policy work remains private.
   let historical=false;try{await access(path.join(this.c.store.root,'integration','jobs',g.id+'.jsonl'));historical=true;}catch(error){if(error.code!=='ENOENT')throw error;}
   const legacyNative=!g.manifest.reviewPolicy&&g.manifest.mode.actors.includes('codex');
   if(historical||!g.manifest.providerPolicy||legacyNative)id=g.id;
   else {
    const repository=canonicalRepository(g.manifest.project.repo),cohort=this.c.store.all('goal').filter(other=>other.manifest.project&&canonicalRepository(other.manifest.project.repo)===repository&&other.manifest.project.baseCommit===g.manifest.project.baseCommit),retired=new Set(cohort.filter(other=>other.integrationSealed&&other.integration?.journalId).map(other=>other.integration.journalId)),known=[...new Set(cohort.filter(other=>other.integration?.journalId&&!retired.has(other.integration.journalId)).map(other=>other.integration.journalId))];
    if(known.length>1)throw Error('Incompatible shared journals for approved base; preserve prior generations');
    id=known[0];
    // Retain an early shared journal even if initialization crashed just before
    // its goal reference was saved. New bases get a distinct durable generation.
    if(!id){const legacyId=this.repositoryId(g),file=path.join(this.c.store.root,'integration','jobs',legacyId+'.jsonl');let exists=true;try{await access(file);}catch(error){if(error.code!=='ENOENT')throw error;exists=false;}if(exists&&!retired.has(legacyId)){const old=await new Journal(path.join(this.c.store.root,'integration'),legacyId).load();if(old.last('integration.repository')?.baseCommit===g.manifest.project.baseCommit)id=legacyId;}}
    id??=this.baseJournalId(g);if(retired.has(id))id=this.baseJournalId(g,g.id);
   }
  }
  return new Journal(path.join(this.c.store.root,'integration'),id).load();
 }
 assertPreparationGoal(expected,{live=true}={}){
  const current=this.c.store.get('goal',expected.id);if(live)this.c.liveGoal(current);
  if(current.hash!==expected.hash||current.version!==expected.version||digest(current.manifest.project)!==digest(expected.manifest.project))throw Error('Goal approval or project version changed during integration preparation');
  return current;
 }
 async goalWorkspace(goalId,{native=false,journal:lockedJournal,validatePrior,repairPin,beforeRecovery}={}){
  const g=this.c.store.get('goal',goalId);if(g.integrationSealed)throw Error('Preserved partial integration workspace is retired; use a separately approved goal');if(!g.manifest.project)throw Error('Goal has no coding project');
  if(repairPin)assertPendingRepair(this,repairPin);
  const journal=lockedJournal??await this.integrationJournal(g),p=g.manifest.project;
  const shared=journal.id!==g.id,origin=journal.last('integration.repository');
  if(shared&&origin&&(origin.baseCommit!==p.baseCommit||origin.repository!==canonicalRepository(p.repo)))throw Error('Incompatible approved repository base; preserve candidate for a separately approved integration');
  const manifest={...executionFields(g.manifest),repo:p.repo,baseCommit:p.baseCommit,permissions:p,...(isOvernightV2(g.manifest)?{overnightV2:true}:{})};
  if(!repairPin&&!journal.last('workspace.created')){const inspected=await inspectRepository(p.repo,p);if(inspected.baseCommit!==p.baseCommit)throw Error('Approved source revision changed');}
  const workspace=new Workspace(manifest,journal);
  if(repairPin){
   // Inverse import can only open its already initialized, pinned target.
   if(!journal.last('workspace.created')||workspace.root!==g.integration.worktree||workspace.branch!==g.integration.branch||p.baseCommit!==g.integration.baseCommit||shared&&!origin)throw Error('Pending repair requires the original initialized integration workspace');
   await access(journal.file);await access(path.join(workspace.root,'.git'));
   if(await git(workspace.root,'branch','--show-current')!==workspace.branch)throw Error('Pending repair integration branch changed');
   assertPendingRepair(this,repairPin,journal);
  }else await workspace.initialize();
  if(shared&&!origin)await journal.append('integration.repository',{repository:canonicalRepository(p.repo),baseCommit:p.baseCommit});
  if(!native){await beforeRecovery?.({journal,workspace},g);await workspace.recover();}
  this.c.store.tx(()=>{const current=repairPin?assertPendingRepair(this,repairPin).goal:this.assertPreparationGoal(g,{live:!native||!g.integration});validatePrior?.();if(!current.integration){current.integration={worktree:workspace.root,branch:workspace.branch,baseCommit:p.baseCommit,...(shared?{journalId:journal.id}: {})};this.c.store.put('goal',current);}});
  return {journal,workspace,g:this.c.store.get('goal',goalId),shared};
 }
 checks(workspace,context={}){this.c.verifyCurrentWorker?.();return approvedChecks(workspace,{checksFactory:this.checksFactory,config:this.config,context:{...context,...this.executionContext.getStore(),c:this.c}});}
 async lockedGoal(goalId,{native=false,refuseLegacy=false,integrationTaskId=null,repairPin,beforeRecovery,wait=false}={}){
  if(repairPin){if(repairPin.goal.id!==goalId||repairPin.task.id!==integrationTaskId)throw Error('Pending repair target mismatch');assertPendingRepair(this,repairPin);}
  const g=this.c.store.get('goal',goalId),repository=canonicalRepository(g.manifest.project.repo);
  // Coding lanes share this short preparation turn, then use separate candidate
  // journals. Wait only for an in-process owner whose release we can observe;
  // durable/external locks and their conservative recovery remain authoritative.
  while(this.repositoryTurns.has(repository)){
   if(!wait)throw new Pause('A runner already owns this job','locked');
   await this.repositoryTurns.get(repository);this.signal?.throwIfAborted();
  }
  const turn=Promise.withResolvers();this.repositoryTurns.set(repository,turn.promise);
  const endTurn=()=>{if(this.repositoryTurns.get(repository)===turn.promise)this.repositoryTurns.delete(repository);turn.resolve();};
  // Lock order is canonical repository then integration journal. Journal's
  // random token is the lock generation; only verified ESRCH permits recovery.
  let releaseRepository,releaseJournal;
  try{
   const repositoryJournal=await new Journal(path.join(this.c.store.root,'integration-repository-locks'),this.repositoryId(g)).load();releaseRepository=await repositoryJournal.lock();
   for(const other of this.c.store.all('goal')){
    if(!other.manifest.project||canonicalRepository(other.manifest.project.repo)!==repository)continue;
    if(other.integrationPending&&other.integrationPending.taskId!==integrationTaskId)throw Error('Another pending integration must be recovered first');
    if(other.integrationOwner&&(other.id!==goalId||refuseLegacy))throw Error('Native legacy owner holds integration workspace');
   }
   const journal=await this.integrationJournal(g),verifiedJournals=new Set(),verifiedHeads=new Set(),inertProofs=new Set(),snapshot=capacitySnapshot(this.c);
   // Reversing an existing pinned import does not admit a new lineage.
   for(const other of repairPin?[]:snapshot.goals){
    if(other.id===g.id||!other.manifest.project||canonicalRepository(other.manifest.project.repo)!==repository)continue;
    // Historical private targets never join a shared lineage. Universal locks,
    // pending imports, native owners and write-scope fences still apply.
    if(journal.id===g.id&&!other.integration?.journalId)continue;
    const differentBase=other.manifest.project.baseCommit!==g.manifest.project.baseCommit;
    if(differentBase||other.integrationSealed||other.status==='partial'&&(other.integration?.journalId??other.id)!==journal.id){await this.assertClosedPredecessor(other,g,{snapshot,verifiedJournals,verifiedHeads,inertProofs});continue;}
    if(!other.integration)continue;
    const otherJournal=other.integration.journalId??other.id;
    if(otherJournal===journal.id||journal.id===g.id&&!other.integration.journalId)continue;
    if(snapshot.tasks.some(t=>t.goalId===other.id&&t.status==='accepted'&&t.integration))throw Error('Incompatible independent integration state; source must incorporate finalized accepted heads before a newly approved successor base');
   }
   const validatePrior=()=>{for(const id of inertProofs)if(!inertUnstartedGoal(this.c,this.c.store.get('goal',id),{allowDraft:true}))throw Error('Prior inert authority changed during integration preparation');};
   this.c.store.tx(()=>{if(repairPin)assertPendingRepair(this,repairPin);else this.assertPreparationGoal(g,{live:!native||!g.integration});validatePrior();});
   releaseJournal=await journal.lock();
   const target=await this.goalWorkspace(goalId,{native,journal,validatePrior,repairPin,beforeRecovery});
   const release=async()=>{try{try{await releaseJournal();}finally{await releaseRepository();}}finally{endTurn();}};
   return {...target,release};
  }catch(error){try{try{await releaseJournal?.();}finally{await releaseRepository?.();}}finally{endTurn();}throw error;}
 }
 async assertClosedPredecessor(prior,current,{snapshot,verifiedJournals,verifiedHeads,inertProofs}){
  if(inertUnstartedGoal(this.c,prior,{allowDraft:true})){inertProofs?.add(prior.id);return;}
  const tasks=snapshot.tasks.filter(t=>t.goalId===prior.id),receipt=prior.receipt;
  const held=snapshot.requests.some(r=>r.task_id===prior.id||tasks.some(t=>t.id===r.task_id)||!snapshot.goals.some(g=>g.id===r.task_id)&&!snapshot.tasks.some(t=>t.id===r.task_id));
  if(!['completed','partial'].includes(prior.status)&&prior.activatedAt!=null&&!prior.integration&&!held&&!snapshot.planning.some(p=>p.goalId===prior.id)&&tasks.every(t=>t.startedAt==null&&!t.owner&&!t.native))throw Error('Unstarted prior goal requires exact prepareRevision/activateRevision for its source base; original deadline and limits remain unchanged');
  if(!['completed','partial'].includes(prior.status)||!receipt||prior.receiptHash!==digest(receipt)||receipt.goalId!==prior.id||receipt.approvalHash!==prior.hash||receipt.goalVersion!==prior.version||digest(prior.manifest)!==prior.hash||
     prior.integrationPending||prior.integrationOwner||tasks.some(t=>!['accepted','partial','failed','cancelled','stopped','blocked'].includes(t.status)||t.owner||t.native?.writerActive)||snapshot.planning.some(p=>p.goalId===prior.id)||
     this.c.store.all('reviewer').some(r=>r.goalId===prior.id&&r.status==='reserved'))throw Error('Incompatible prior work must be finalized and quiescent before a newly approved successor base');
  // Draft revisions of a completed goal have no executable authority and are
  // preserved. Only still-owned inference (including unattributed corruption)
  // prevents retirement; a clock or completed goal label cannot free it.
  if(held)throw Error('Prior or unattributed inference remains uncertain; preserve original spending and ownership');
  if(!Array.isArray(receipt.tasks)||receipt.tasks.length!==tasks.length||tasks.some(t=>!receipt.tasks.some(saved=>saved.id===t.id&&saved.status===t.status&&saved.hash===t.hash&&saved.resultHash===digest(t.result)&&digest(saved.integration??null)===digest(t.integration??null))))throw Error('Prior finalized task receipt changed; preserve old work');
  for(const task of tasks)if(task.native?.layout==='candidate_v1'&&task.result?.savedNative)await this.assertPreservedPartial(task);
  const heads=[prior.manifest.project.baseCommit,...tasks.flatMap(t=>t.status==='accepted'&&t.integration?.commit?[t.integration.commit]:[])];
  if(prior.integration){
   const id=prior.integration.journalId??prior.id,verificationKey=id+':'+digest(prior.manifest.project);
   if(!verifiedJournals.has(verificationKey)){
    const journal=new Journal(path.join(this.c.store.root,'integration'),id);await access(journal.file);await access(path.join(journal.dir,'worktree','.git'));await journal.load();
    if(journal.tail||journal.events.some(e=>e.type==='edits.intent'&&!journal.events.some(done=>done.type==='edits.applied'&&done.data.key===e.data.key)))throw Error('Prior integration journal remains uncertain; preserve pending recovery');
    try{const lock=JSON.parse(await readFile(path.join(journal.dir,'lock.json'),'utf8'));if(!Number.isInteger(lock.pid)||lock.pid<=0||typeof lock.token!=='string'||!lock.token)throw Error('Prior integration lock is uncertain');try{process.kill(lock.pid,0);throw Error('Prior integration writer still owns its journal');}catch(error){if(error.code!=='ESRCH')throw error;}}
    catch(error){if(error.code!=='ENOENT')throw error;}
    const workspace=new Workspace({...executionFields(prior.manifest),repo:prior.manifest.project.repo,baseCommit:prior.manifest.project.baseCommit,permissions:prior.manifest.project},journal),checkpoint=journal.last('stage.accepted')??{commit:prior.manifest.project.baseCommit,snapshot:journal.last('workspace.created')?.snapshot};
    if(workspace.root!==prior.integration.worktree||!checkpoint.snapshot||await git(workspace.root,'rev-parse','HEAD')!==checkpoint.commit)throw Error('Prior accepted integration head changed; preserve prior journal');
    const sealed=prior.integrationSealed;
    if(sealed){
     const released=journal.last('native.released');
     if(prior.status!=='partial'||sealed.worktree!==workspace.root||sealed.head!==checkpoint.commit||sealed.snapshotHash!==digest(sealed.snapshot)||released?.snapshotHash!==sealed.snapshotHash||released.head!==sealed.head||digest(released.snapshot)!==digest(sealed.snapshot))throw Error('Prior sealed partial lacks an exact recorded snapshot');
     await workspace.assertSnapshot(sealed.snapshot);
     // Historical seals recorded bytes but not new executable modes. Preserve
     // dirty files only when their modes still match the committed preimage.
     for(const [file,mode] of await checkedFileModes(workspace,sealed.snapshot)){const entry=await git(workspace.root,'ls-tree','HEAD','--',file),expected=entry?entry.split(' ')[0]:'100644';if(mode!==expected)throw Error('Prior sealed partial executable mode is uncertain');}
    }else{await workspace.assertSnapshot(checkpoint.snapshot);const modes=await checkedFileModes(workspace,checkpoint.snapshot);await assertCheckedCommit(workspace,checkpoint,checkpoint.snapshot,modes);}
    heads.push(checkpoint.commit);verifiedJournals.add(verificationKey);
   }
  }
  for(const head of heads){if(verifiedHeads.has(head))continue;if(await git(current.manifest.project.repo,'merge-base',head,current.manifest.project.baseCommit)!==head)throw Error('New approved base omits prior accepted integration head; preserve both histories');verifiedHeads.add(head);}
 }
 async assertPreservedPartial(task){
  const saved=task.result.savedNative,target=await this.nativeCandidates.open(task),{workspace,journal}=target;
  if(journal.tail)throw Error('Prior partial journal is incomplete; preserve recovery');
  const released=journal.last('native.released');
  if(saved.initialized===false){let exists=true;try{await access(path.join(workspace.root,'.git'));}catch(error){if(error.code!=='ENOENT')throw error;exists=false;}if(exists)throw Error('Prior partial appeared after its uninitialized seal');return;}
  if(saved.worktree!==workspace.root||saved.snapshotHash!==digest(saved.snapshot)||released?.snapshotHash!==saved.snapshotHash||released.head!==saved.head||digest(released.snapshot)!==digest(saved.snapshot)||await git(workspace.root,'rev-parse','HEAD')!==saved.head)throw Error('Prior partial candidate differs from its exact release seal');
  await workspace.assertSnapshot(saved.snapshot);
  for(const [file,mode] of await checkedFileModes(workspace,saved.snapshot)){const entry=await git(workspace.root,'ls-tree','HEAD','--',file),expected=entry?entry.split(' ')[0]:'100644';if(mode!==expected)throw Error('Prior partial executable mode is uncertain');}
 }
 integrationChecks(workspace,task,operationKey){
  const context={goalId:task.goalId,taskId:task.id,operationKey};
  if(task.native?.layout==='candidate_v1')context.integrationCandidate=task;
  return this.checks(workspace,context);
 }
 async combinedChecks(target,task,goal,checkSpecs){
  const current={goalId:goal.id,goalHash:goal.hash,project:goal.manifest.project,checkSpecs,overnightV2:isOvernightV2(goal.manifest)},contracts=new Map();
  // Contracts are saved by checked commits, independent of mutable goal records.
  // Each old check runs under its own original permissions rather than a union.
  for(const event of target.journal.events){const contract=event.type==='stage.accepted'&&event.data.integrationContract;if(contract)contracts.set(digest({project:contract.project,checkSpecs:contract.checkSpecs}),contract);}
  contracts.set(digest({project:current.project,checkSpecs:current.checkSpecs}),current);
  const evidence=[];let results;
  for(const contract of contracts.values()){
   this.currentCandidate(task);
   const {overnightV2:ignored,...manifest}=target.workspace.manifest,workspace=new Workspace({...manifest,permissions:contract.project,...(contract.overnightV2?{overnightV2:true}:{})},target.journal);
   const snapshot=await workspace.snapshot(),modes=await readBehavioralFileModes(workspace,Object.keys(snapshot));
   const runner=this.integrationChecks(workspace,task,'integration-proof:'+task.id);await runner.verify(this.signal);this.currentCandidate(task);const checks=await runner.run(contract.checkSpecs,`integrate-${task.id}-${contract.goalId}`,this.signal);
   await workspace.assertSnapshot(snapshot);const afterModes=await readBehavioralFileModes(workspace,Object.keys(snapshot));if(behavioralModeHash(modes)!==behavioralModeHash(afterModes))throw Error('Combined executable bit changed during protected checks');
   const behavioralEvidence=behavioralEvidenceFor(contract.project,contract.checkSpecs,checks,snapshot,modes);
   evidence.push({...contract,checks,...(behavioralEvidence?{behavioralEvidence}:{})});
   if(contract===current)results=checks;
  }
  return {results,evidence,contract:current};
 }
 async executionBase(goalId){
  const target=await this.lockedGoal(goalId,{refuseLegacy:true,wait:true});
  try{await target.workspace.recover();if(await git(target.workspace.root,'diff','HEAD','--name-only'))throw Error('Integration has uncommitted imported edits; recover integration first');return await git(target.workspace.root,'rev-parse','HEAD');}finally{await target.release();}
 }
 async candidate(task,{original=false}={}){return !original&&task.native?.layout==='candidate_v1'?this.nativeCandidates.open(task):new CodingAdapter({c:this.c,config:this.config}).open(task);}
 async changes(workspace,base,writePaths){
  const files=new Set((await git(workspace.root,'diff','--no-renames','--name-only','-z',base,'--')).split('\0').filter(Boolean));
  for(const f of (await git(workspace.root,'ls-files','--others','--exclude-standard','-z')).split('\0').filter(Boolean))if(!f.startsWith('dist/')&&!f.startsWith('.overnight-output/'))files.add(f);
  const index=isWindows?await windowsIndexModes(workspace.root,files):null;
  const edits=[];
  for(const file of files){
   if(protectedPath(file)||!matches(file,writePaths))throw Error('Candidate change outside approved scope');
   const entry=await git(workspace.root,'ls-tree',base,'--',file),listed=Boolean(entry),beforeMode=entry?entry.split(' ')[0]:null;
   if(isWindows&&listed)windowsGitFileMode(beforeMode);
   let beforeExact=null;
   if(listed){
    // Retrieve the committed bytes without line-ending or whitespace trimming.
    const objectName=`${base}:${file}`;
    beforeExact=isWindows?await gitBytes(workspace.root,'cat-file','blob',objectName):
     await git(workspace.root,'show',objectName,'--format=','-z');
   }
   let current,afterMode;
   if(isWindows){
    const bytes=await windowsFiles.windowsFile('read',await workspace.file(file),{max:changedFileLimit,optional:true});
    const content=bytes?.toString('utf8')??null;
    if(bytes&&(bytes.includes(0)||!bytes.equals(Buffer.from(content))))throw Error('Candidate file must be valid UTF-8 text: '+file);
    current={content,hash:bytes?fileDigest(bytes):null};
    const indexedMode=windowsGitFileMode(index.get(file));
    afterMode=bytes?indexedMode:null;
   }else{
    current=await workspace.content(file);
    afterMode=await workspace.fileMode(file);
   }
   edits.push({path:file,action:current.content===null?'delete':'write',content:current.content,beforeHash:listed?fileDigest(beforeExact):null,afterHash:current.hash,beforeMode,afterMode});
  }
  return edits;
 }
 async prepareChanges(workspace,changes){
  const edits=[];
  for(const change of changes){
   const current=await workspace.content(change.path),mode=await workspace.fileMode(change.path),hasMode=Object.hasOwn(change,'afterMode');
   if(current.hash===change.afterHash&&(!hasMode||mode===change.afterMode))continue;
   if(current.hash!==change.beforeHash||hasMode&&mode!==change.beforeMode){
    throw Error(`Integration conflict for ${change.path}; preserve candidate for repair and review`);
   }
   edits.push({path:change.path,action:change.action,content:change.content,baseHash:current.hash,...(hasMode?{mode:change.afterMode}: {})});
  }
  return edits;
 }
 async applyChanges(workspace,changes,key,writePaths){await workspace.apply(key,{writePaths},await this.prepareChanges(workspace,changes));}
 currentCandidate(t){
  const current=this.c.liveTask(t),identity=x=>({goalVersion:x.goalVersion,hash:x.hash,result:x.result,native:x.native?{generationId:x.native.generationId??x.id,round:x.native.round,commit:x.native.commit??null,baseCommit:x.native.baseCommit??null}:null,legacyBehavioralReview:x.legacyBehavioralReview??null});
  if(!['awaiting_review','ready_to_integrate'].includes(current.status)||current.owner||current.native?.writerActive||digest(identity(current))!==digest(identity(t)))throw Error('Candidate state or approved generation changed before integration');
  return current;
 }
 async checkedCandidateSnapshot(candidate,task,goal,snapshot,modes){
  if(task.native?.layout==='candidate_v1'){
   const checkpoint=candidate.journal.last('stage.accepted');
   if(!checkpoint||checkpoint.commit!==task.native.commit||await git(candidate.workspace.root,'rev-parse','HEAD')!==task.native.commit)throw Error('Native candidate commit changed after checks');
   assertCheckpointSnapshot(checkpoint,snapshot);
   return snapshot;
  }
  // Worker results expose only the approved readable portion of the snapshot.
  const scoped=Object.fromEntries(Object.entries(snapshot).filter(([file])=>checkedPath(candidate.workspace,file,{includeWrites:false})));
  if(!task.result?.snapshot||task.result.baseCommit!==candidate.manifest.baseCommit||digest(scoped)!==digest(task.result.snapshot))throw Error('Candidate snapshot changed after its saved checks');
  if(goal.manifest.mode.review==='legacy'&&!goal.manifest.reviewPolicy){
   const binding=task.legacyBehavioralReview;
   if(binding?.approvalHash!==goal.hash||binding.taskHash!==task.hash||binding.baseCommit!==candidate.manifest.baseCommit||binding.snapshotHash!==digest(scoped))throw Error('Legacy review does not match the approved candidate snapshot');
   const scopedModes=new Map([...modes].filter(([file])=>Object.hasOwn(scoped,file)));
   if(binding.executableModesHash!==behavioralModeHash(scopedModes))throw Error('Legacy review does not match the candidate executable bits');
  }
  return scoped;
 }
 async accept(input,key){return this.effect(key,{op:'integration.accept',...input},async()=>{
  let t=this.c.getTask(input.taskId),g=this.c.store.get('goal',t.goalId);
  const verifyBinding=current=>{
   const binding=current.status==='accepted'?current.integration?.ownerActionBinding:integrationBinding(this.c.store.get('goal',current.goalId),current);
   if(input.expectedIntegrationBinding!==undefined&&input.expectedIntegrationBinding!==binding)
    throw Error('Reviewed candidate or goal changed. Refresh the inbox.');
  };
  verifyBinding(t);
  if(t.status==='accepted'&&t.integration)return t;
  this.c.liveGoal(g);
  this.c.liveTask(t);
  if(!['awaiting_review','ready_to_integrate'].includes(t.status))throw Error('Candidate is not ready for integration');
  if(!g.manifest.reviewPolicy&&g.manifest.mode.review==='legacy'&&t.legacyDecision?.decision!=='accept')throw Error('Passing legacy review required');
  if(g.manifest.reviewPolicy)await this.c.reviewService.assertCandidate(t);
  if(g.integrationOwner&&g.integrationOwner!==t.id)throw Error('Native Codex task owns integration workspace');
  const candidate=await this.candidate(t),releaseCandidate=await candidate.journal.lock();
  try{
   t=this.currentCandidate(t);verifyBinding(t);await candidate.workspace.recover();if(g.manifest.reviewPolicy)await this.c.reviewService.assertCandidate(t,{lock:false});
   const project=g.manifest.project,candidateSnapshot=project.behavioralChecks||g.manifest.reviewPolicy?await candidate.workspace.snapshot():null;
   const candidateModes=candidateSnapshot?await checkedFileModes(candidate.workspace,candidateSnapshot):null;
   const checkedSnapshot=candidateSnapshot?await this.checkedCandidateSnapshot(candidate,t,g,candidateSnapshot,candidateModes):null;
   const checks=this.integrationChecks(candidate.workspace,t,'candidate-accept:'+t.id),candidateCheckSpecs=candidate.manifest.permissions.checks;
   await checks.verify(this.signal);const candidateChecks=await checks.run(candidateCheckSpecs,`accept-${t.id}`,this.signal);
   if(candidateSnapshot){
    await candidate.workspace.assertSnapshot(candidateSnapshot);
    await assertCheckedModes(candidate.workspace,candidateSnapshot,candidateModes);
   }
   if(!candidateChecks.every(x=>x.passed))throw Error('Candidate checks no longer pass');
   if(g.manifest.reviewPolicy)await this.c.reviewService.assertCandidate(t,{lock:false});
   const candidateBehavioralEvidence=behavioralEvidenceFor(project,candidateCheckSpecs,candidateChecks,checkedSnapshot,candidateModes);
   assertBehavioralChecks(candidateBehavioralEvidence);
   t=this.currentCandidate(t);verifyBinding(t);const candidateStage=t.integrationFailures?.length?`candidate-repair-${t.integrationFailures.length}`:'candidate';
   if(candidateSnapshot&&t.native?.layout!=='candidate_v1')await checkedBlobIds(candidate.workspace,candidateSnapshot,candidateModes,{beforeCommit:true});
   const checkpoint=t.native?.layout==='candidate_v1'?{commit:t.native.commit,snapshot:await candidate.workspace.snapshot()}:await candidate.journal.memo(`${candidateStage}/checkpoint`,()=>candidate.workspace.checkpoint({id:candidateStage,writePaths:t.spec.permissions.writePaths}));
   if(candidateSnapshot)await assertCheckedCommit(candidate.workspace,checkpoint,candidateSnapshot,candidateModes);
   if(!candidate.journal.events.some(e=>e.type==='stage.accepted'&&e.data.commit===checkpoint.commit))await candidate.journal.append('stage.accepted',{stageId:candidateStage,...checkpoint});
   const changes=await committedChanges(candidate.workspace,candidate.manifest.baseCommit,checkpoint.commit,t.spec.permissions.writePaths);
   const target=await this.lockedGoal(g.id,{refuseLegacy:true,integrationTaskId:t.id,beforeRecovery:async(target,currentGoal)=>{
    t=this.currentCandidate(t);verifyBinding(t);
    await assertPendingImport(target,currentGoal.integrationPending,t,checkpoint,changes);
   }}),release=target.release;
   try{
    t=this.currentCandidate(t);verifyBinding(t);
    if(candidateSnapshot){
     await candidate.workspace.assertSnapshot(candidateSnapshot);
     await assertCheckedModes(candidate.workspace,candidateSnapshot,candidateModes);
     if(await git(candidate.workspace.root,'rev-parse','HEAD')!==checkpoint.commit)throw Error('Candidate commit changed before import');
    }
    await this.prepareChanges(target.workspace,changes);
    // Fence the async preparation against approval/rebind before reserving the
    // target. The persisted reservation then prevents either change during import.
    const importKey=this.c.store.tx(()=>{
     t=this.currentCandidate(t);verifyBinding(t);
     if(g.manifest.reviewPolicy)this.c.reviewService.assertAccepted(t);
     if(t.status==='awaiting_review'){this.c.review({taskId:t.id,decision:'accept',feedback:text(input.feedback,'review feedback')},`review-${key}`);t=this.c.getTask(t.id);}
     const goal=this.c.store.get('goal',g.id),importKey=goal.integrationPending?.importKey??`import-${t.id}-${checkpoint.commit}`;
     if(goal.integrationPending&&goal.integrationPending.taskId!==t.id)throw Error('Another pending integration owns target');
     goal.integrationPending??={taskId:t.id,candidateCommit:checkpoint.commit,importKey,at:this.c.now()};
     if(goal.integrationPending.candidateCommit!==checkpoint.commit)throw Error('Pending integration candidate changed');
     this.c.store.put('goal',goal);return importKey;
    });
    if(!target.journal.events.some(e=>e.type==='integration.import.intent'&&e.data.key===importKey)){
     const edits=await this.prepareChanges(target.workspace,changes),captured=[];for(const edit of edits)captured.push({path:edit.path,before:await target.workspace.content(edit.path),afterHash:edit.action==='delete'?null:fileDigest(edit.content),beforeMode:await target.workspace.fileMode(edit.path),afterMode:edit.action==='delete'?null:edit.mode??await target.workspace.fileMode(edit.path)??'100644'});
     await target.journal.append('integration.import.intent',{key:importKey,taskId:t.id,candidateCommit:checkpoint.commit,baseCommit:await git(target.workspace.root,'rev-parse','HEAD'),snapshotBefore:await target.workspace.snapshot(),changes:captured});
    }
    await this.applyChanges(target.workspace,changes,importKey,t.spec.permissions.writePaths);
    await assertImportedPaths(target.workspace,changes,file=>Error('Imported file differs from the verified checkpoint for '+file+'. Inspect the pending import before retrying.'));
    const checkSpecs=effectiveIntegrationChecks(this.c,t,g.manifest),bindTargetSnapshot=project.behavioralChecks||target.shared||g.manifest.reviewPolicy;
    const snapshotBeforeChecks=bindTargetSnapshot?await target.workspace.snapshot():null;
    const combinedModes=snapshotBeforeChecks?await checkedFileModes(target.workspace,snapshotBeforeChecks):null;
    let results,combinedEvidence,integrationContract;
    if(target.shared){const combined=await this.combinedChecks(target,t,g,checkSpecs);results=combined.results;combinedEvidence=combined.evidence;integrationContract=combined.contract;}
    else {const runner=this.integrationChecks(target.workspace,t,'integration:'+t.id);await runner.verify(this.signal);results=await runner.run(checkSpecs,`integrate-${t.id}`,this.signal);}
    const snapshot=await target.workspace.snapshot();
    if(snapshotBeforeChecks){
     if(digest(snapshot)!==digest(snapshotBeforeChecks))throw Error('Combined snapshot changed during protected checks');
     await assertCheckedModes(target.workspace,snapshot,combinedModes);
    }
    const behavioralEvidence=behavioralEvidenceFor(project,checkSpecs,results,snapshot,combinedModes);
    await target.journal.append('integration.checks',{key:importKey,checks:combinedEvidence?combinedEvidence.flatMap(e=>e.checks):results,snapshot,...(combinedEvidence?{combinedEvidence}:{}),...(behavioralEvidence?{behavioralEvidence}:{})});
    if(!(combinedEvidence?combinedEvidence.flatMap(e=>e.checks):results).every(x=>x.passed))throw Error('Integrated checks failed');
    for(const evidence of combinedEvidence??[])assertBehavioralChecks(evidence.behavioralEvidence);
    assertBehavioralChecks(behavioralEvidence);
    t=this.currentCandidate(t);
    if(bindTargetSnapshot)await checkedBlobIds(target.workspace,snapshot,combinedModes,{beforeCommit:true});
    const stage=`task-${t.id}-${checkpoint.commit}`,imported=await target.journal.memo(`${stage}/checkpoint`,()=>target.workspace.checkpoint({id:stage,writePaths:t.spec.permissions.writePaths}));
    if(bindTargetSnapshot)await assertCheckedCommit(target.workspace,imported,snapshot,combinedModes);
    if(!target.journal.events.some(e=>e.type==='stage.accepted'&&e.data.stageId===stage))await target.journal.append('stage.accepted',{stageId:stage,...imported,...(integrationContract?{integrationContract}: {})});
    this.c.store.tx(()=>{const current=this.currentCandidate(t);verifyBinding(current);current.status='accepted';if(current.native?.layout==='candidate_v1')current.native.status='integrated';current.integration={commit:imported.commit,candidateCommit:checkpoint.commit,worktree:target.workspace.root,checks:results,...(input.expectedIntegrationBinding!==undefined?{ownerActionBinding:input.expectedIntegrationBinding}:{}),...(combinedEvidence?{combinedEvidence}:{}),review:g.manifest.reviewPolicy?(g.manifest.reviewPolicy.source==='host'?'host_review':'api_review'):g.manifest.mode.review==='checks'?'none':g.manifest.mode.review==='legacy'?'codex_legacy':'codex_operator',...(g.manifest.reviewPolicy?{reviewAcceptance:current.reviewAcceptance}:{}),...(behavioralEvidence?{candidateBehavioralEvidence,behavioralEvidence}:{})};this.c.store.put('task',current);const goal=this.c.store.get('goal',g.id);goal.integrationPending=null;this.c.store.put('goal',goal);this.c.emit('task.integrated',g.id,t.id,current.integration);});
    return this.c.getTask(t.id);
   }finally{await release();}
  }finally{await releaseCandidate();}
 });}
 async repair(input,key){return this.effect(key,{op:'integration.repair',...input},()=>repairIntegration(this,input,key));}
 async startNative(input,key){return this.effect(key,{op:'native.start',...input},()=>input.layout==='candidate_v1'?this.nativeCandidates.start(input.taskId,{},input.registration):this.beginNative(input.taskId));}
 async beginNative(taskId,extra={}){
  const t=this.c.getTask(taskId),g=this.c.store.get('goal',t.goalId);this.c.liveGoal(g);this.c.verifyCurrentWorker?.();
  this.c.liveTask(t,{allowStopped:!!extra.takeoverReason});
  if(!g.manifest.mode.actors.includes('codex')||t.spec.kind!=='coding')throw Error('Mode prohibits native Codex execution');
  if(g.manifest.reviewPolicy)throw Error('Versioned review requires an isolated candidate_v1 native layout');
  if(t.native?.layout==='candidate_v1')throw Error('Existing native candidate requires explicit candidate_v1 layout');
  if(t.status==='codex_active')return t;
  if(!['codex_ready','blocked','stopped','awaiting_review','ready_to_integrate'].includes(t.status)||t.owner)throw Error('Worker must be quiescent before native execution');
  if(!t.spec.dependsOn.every(id=>this.c.getTask(id).status==='accepted'))throw Error('Dependencies are incomplete');
  if(g.integrationOwner&&g.integrationOwner!==t.id)throw Error('Another native task owns integration workspace');
  const target=await this.lockedGoal(g.id),unlock=target.release;try{
   if(target.shared)throw Error('Historical native layout requires private integration; preserve shared target for separately approved integration');
   const snapshot=await target.workspace.snapshot();
   this.c.store.tx(()=>{this.c.verifyCurrentWorker?.();const current=this.c.liveTask(t,{allowStopped:!!extra.takeoverReason});const scopeWait=writeScopeWait({task:current,goal:g,snapshot:capacitySnapshot(this.c)});if(scopeWait)throw Error(scopeWait.explanation);current.status='codex_active';current.executionActor='codex';current.stopRequested=false;current.startedAt??=this.c.now();current.deadline??=Math.min(g.deadline,current.startedAt+t.spec.limits.seconds*1000);current.native={worktree:target.workspace.root,startSnapshot:snapshot,...extra};const goal=this.c.store.get('goal',g.id);if(goal.integrationOwner&&goal.integrationOwner!==t.id)throw Error('Another native task owns integration workspace');goal.integrationOwner=t.id;this.c.store.put('goal',goal);this.c.store.put('task',current);this.c.learning.pin(t.id);this.c.emit('task.native_started',g.id,t.id,{worktree:target.workspace.root});});
  }finally{await unlock();}return this.c.getTask(t.id);
 }
 async takeover(input,key){return this.effect(key,{op:'native.takeover',...input},async()=>{
  const t=this.c.getTask(input.taskId);text(input.reason,'takeover reason');
  if(t.owner||['running','uncertain'].includes(t.status))throw Error('Stop and verify worker quiescence before takeover');
  const g=this.c.store.get('goal',t.goalId);if(!g.manifest.mode.actors.includes('codex'))throw Error('Mode prohibits takeover');
  const source=await this.candidate(t,{original:true}),release=await source.journal.lock();try{
   await source.workspace.recover();const frozen=await source.workspace.snapshot(),changes=await this.changes(source.workspace,source.manifest.baseCommit,t.spec.permissions.writePaths);
   const extra={workerWorktree:source.workspace.root,workerSnapshot:frozen,workerManifest:source.manifest,workerJournalRoot:source.journal.root,takeoverReason:input.reason};
   const native=input.layout==='candidate_v1'?await this.nativeCandidates.start(t.id,extra,input.registration):await this.beginNative(t.id,extra);
   const target=input.layout==='candidate_v1'?await this.candidate(native):await this.lockedGoal(g.id,{native:true}),unlock=target.release??await target.journal.lock();try{await this.applyChanges(target.workspace,changes,`takeover-${t.id}`,t.spec.permissions.writePaths);}finally{await unlock();}
   this.c.emit('task.taken_over',g.id,t.id,{reason:input.reason,workerSnapshot:frozen});return this.c.getTask(native.id);
  }finally{await release();}
 });}
 async finishNative(input,key){return this.effect(key,{op:'native.finish',...input},async()=>{
  const t=this.c.getTask(input.taskId),g=this.c.store.get('goal',t.goalId);text(input.summary,'summary');
  if(t.native?.layout==='candidate_v1')return this.nativeCandidates.finish(input);
  if(g.manifest.reviewPolicy)throw Error('Versioned review requires candidate_v1 finish and separate bound review');
  if(t.status==='accepted'&&t.integration?.review==='codex_native')return t;
  this.c.liveGoal(g);if(t.status!=='codex_active'||g.integrationOwner!==t.id)throw Error('Native task ownership mismatch');
  this.c.liveTask(t);
  const target=await this.lockedGoal(g.id,{native:true}),release=target.release;try{
   if(target.shared)throw Error('Historical native layout cannot accept a shared integration target; preserve candidate for separately approved integration');
   if(t.native.workerSnapshot){const source=await this.candidate(t),unlock=await source.journal.lock();try{if(digest(await source.workspace.snapshot())!==digest(t.native.workerSnapshot))throw Error('Frozen worker checkout changed after takeover');}finally{await unlock();}}
   const snapshot=await target.workspace.snapshot(),before=t.native.startSnapshot;
   for(const f of new Set([...Object.keys(snapshot),...Object.keys(before)]))if(snapshot[f]!==before[f]&&(protectedPath(f)||!matches(f,t.spec.permissions.writePaths)))throw Error('Native change outside approved scope or protected checks');
   await target.journal.append('native.adopted',{taskId:t.id,snapshot});
   const project=g.manifest.project,modes=project.behavioralChecks?await checkedFileModes(target.workspace,snapshot):null;
   const runner=this.checks(target.workspace,{goalId:g.id,taskId:t.id,operationKey:'integration:'+t.id});await runner.verify(this.signal);const results=await runner.run(project.checks,`native-${t.id}`,this.signal);
   if(!results.every(x=>x.passed))throw Error('Native checks failed');
   const behavioralEvidence=behavioralEvidenceFor(project,project.checks,results,snapshot,modes);
   if(behavioralEvidence){
    await target.workspace.assertSnapshot(snapshot);
    await assertCheckedModes(target.workspace,snapshot,modes);
   }
   assertBehavioralChecks(behavioralEvidence);
   this.c.liveTask(t);
   if(behavioralEvidence)await checkedBlobIds(target.workspace,snapshot,modes,{beforeCommit:true});
   const stage=`native-${t.id}`,checkpoint=await target.journal.memo(`${stage}/checkpoint`,()=>target.workspace.checkpoint({id:stage,writePaths:t.spec.permissions.writePaths}));
   if(behavioralEvidence)await assertCheckedCommit(target.workspace,checkpoint,snapshot,modes);
   if(!target.journal.events.some(e=>e.type==='stage.accepted'&&e.data.stageId===stage))await target.journal.append('stage.accepted',{stageId:stage,...checkpoint});
   this.c.store.tx(()=>{const current=this.c.liveTask(t);const goal=this.c.store.get('goal',g.id);if(current.status!=='codex_active'||goal.integrationOwner!==t.id)throw Error('Native task ownership changed');current.status='accepted';current.result={summary:input.summary,checks:results};current.integration={commit:checkpoint.commit,worktree:target.workspace.root,checks:results,review:'codex_native',...(behavioralEvidence?{behavioralEvidence}:{})};this.c.store.put('task',current);goal.integrationOwner=null;this.c.store.put('goal',goal);this.c.emit('task.native_finished',g.id,t.id,current.integration);});return this.c.getTask(t.id);
  }finally{await release();}
 });}
 async releaseNative(input,key){return this.effect(key,{op:'native.release',...input},async()=>{
  const t=this.c.getTask(input.taskId);text(input.reason,'release reason');
  if(t.native?.layout==='candidate_v1')return this.nativeCandidates.release(input);
  if(t.status==='partial'&&t.result?.savedNative)return t;
  const g=this.c.store.get('goal',t.goalId);
  if(t.spec.kind!=='coding'||t.executionActor!=='codex'||t.status!=='stopped'||t.owner||g.integrationOwner!==t.id)throw Error('Stop native editing and retain its ownership before explicit release');
  const target=await this.lockedGoal(g.id,{native:true}),unlock=target.release;
  try{
   const snapshot=await target.workspace.snapshot(),head=await git(target.workspace.root,'rev-parse','HEAD');
   const savedNative={worktree:target.workspace.root,head,snapshot,snapshotHash:digest(snapshot),reason:input.reason};
   await target.journal.append('native.released',{taskId:t.id,...savedNative});
   return this.c.store.tx(()=>{
    const current=this.c.store.get('task',t.id),goal=this.c.store.get('goal',g.id);
    if(current.status!=='stopped'||goal.integrationOwner!==t.id)throw Error('Native ownership changed before release');
    current.status='partial';current.result={summary:input.reason,savedNative};current.reason='Native partial preserved; integration workspace retired';goal.integrationOwner=null;goal.integrationSealed=savedNative;
    this.c.store.put('task',current);this.c.store.put('goal',goal);this.c.emit('task.native_released',g.id,t.id,{snapshotHash:savedNative.snapshotHash,reason:input.reason});return this.c.getTask(t.id);
   });
  }finally{await unlock();}
 });}
}
