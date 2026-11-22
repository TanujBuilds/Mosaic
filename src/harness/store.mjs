import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, digest, identifier } from './contracts.mjs';

export const taskEventLookupId='+task_id';
export const taskGoalId="CASE WHEN json_valid(data) THEN json_extract(data,'$.goalId') END";
export const terminalTaskStatuses=Object.freeze(['accepted','failed','partial','cancelled']);
// The partial index keeps historical task payloads off the scheduling path.
// Include malformed or missing status data so the scheduler still sees it.
const unfinishedTask="kind='task' AND CASE WHEN json_valid(data) THEN COALESCE(json_extract(data,'$.status') NOT IN ("+
 terminalTaskStatuses.map(status=>"'"+status+"'").join(',')+"),1) ELSE 1 END";

export class Store {
 constructor(root){
  this.root=path.resolve(root);mkdirSync(this.root,{recursive:true,mode:0o700});
  this.db=new DatabaseSync(path.join(this.root,'harness.sqlite3'));
  const version=this.db.prepare('PRAGMA user_version').get().user_version;if(![0,1].includes(version)){this.db.close();this.db=null;throw Error(`Unsupported harness database schema version ${version}`);}
  chmodSync(path.join(this.root,'harness.sqlite3'),0o600);this.depth=0;this.commitListeners=new Set();
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
   -- The kind-only index also orders matching rows by rowid. The primary
   -- key orders by id and requires a temporary sort of full record payloads.
   CREATE INDEX IF NOT EXISTS records_kind ON records(kind);
   CREATE INDEX IF NOT EXISTS records_unfinished_tasks ON records(kind) WHERE ${unfinishedTask};
   CREATE INDEX IF NOT EXISTS records_task_goal ON records(${taskGoalId}) WHERE kind='task';
   CREATE TABLE IF NOT EXISTS submissions(kind TEXT NOT NULL,scope TEXT NOT NULL,key TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(kind,scope,key));
   CREATE TABLE IF NOT EXISTS commands(key TEXT PRIMARY KEY,hash TEXT NOT NULL,result TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,goal_id TEXT,task_id TEXT,type TEXT NOT NULL,data TEXT NOT NULL);
   -- The rowid suffix is the event sequence. Index an identity expression
   -- so existing task_id queries keep their separate non-output index.
   CREATE INDEX IF NOT EXISTS events_task_last ON events(${taskEventLookupId}) WHERE task_id IS NOT NULL;
   CREATE INDEX IF NOT EXISTS events_task_activity ON events(task_id) WHERE type!='model.output';
   CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,key TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(task_id,key));
   CREATE INDEX IF NOT EXISTS requests_task ON requests(task_id,kind);
   PRAGMA user_version=1;`);
  this.readChanges=this.db.prepare('SELECT total_changes() AS n');
  this.readDataVersion=this.db.prepare('PRAGMA data_version');
  this.readHasTasksForGoal=this.db.prepare(`SELECT 1 FROM records WHERE kind='task' AND (${taskGoalId})=? LIMIT 1`);
  this.readUnfinishedTasks=this.db.prepare(`SELECT data FROM records INDEXED BY records_unfinished_tasks WHERE ${unfinishedTask} ORDER BY rowid`);
 }
 close(){if(this.db){this.db.close();this.db=null;}}
 tx(fn){
  if(this.depth)return fn();
  this.db.exec('BEGIN IMMEDIATE');
  this.depth++;
  let value;
  try{
   value=fn();
   if(value?.then)throw Error('Async work cannot run inside state transaction');
   this.db.exec('COMMIT');
  }catch(error){
   try{this.db.exec('ROLLBACK');}catch(rollbackError){
    // SQLite may already have rolled back. Keep cleanup diagnostics secondary,
    // including when the original thrown value is frozen or is not an object.
    try{this.lastRollbackError=rollbackError;}catch{}
    try{Object.defineProperty(error,'rollbackError',{value:rollbackError,configurable:true});}catch{}
   }
   throw error;
  }finally{this.depth--;}
  for(const wake of this.commitListeners)wake();
  return value;
 }
 revision(){
  return this.readChanges.get().n+':'+this.readDataVersion.get().data_version;
 }
 waitForChange(revision,timeout,signal){
  if(signal.aborted||this.revision()!==revision)return Promise.resolve();
  return new Promise(resolve=>{
   const wake=()=>{
    clearTimeout(timer);
    this.commitListeners.delete(wake);
    signal.removeEventListener('abort',wake);
    resolve();
   };
   const timer=setTimeout(wake,timeout);
   this.commitListeners.add(wake);
   signal.addEventListener('abort',wake,{once:true});
  });
 }
 get(kind,id){const row=this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,id);if(!row)throw Error(`Unknown ${kind}: ${id}`);return JSON.parse(row.data);}
 maybe(kind,id){try{return this.get(kind,id);}catch(e){if(e.message.startsWith('Unknown '))return null;throw e;}}
 all(kind){return this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind).map(r=>JSON.parse(r.data));}
 hasTasksForGoal(goalId){return Boolean(this.readHasTasksForGoal.get(goalId));}
 unfinishedTasks(){return this.readUnfinishedTasks.all().map(row=>JSON.parse(row.data));}
 put(kind,value){this.db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind,value.id,canonical(value));return value;}
 event(type,{goalId=null,taskId=null,data={},at=Date.now()}={}){return Number(this.db.prepare('INSERT INTO events(at,goal_id,task_id,type,data) VALUES(?,?,?,?,?)').run(at,goalId,taskId,type,canonical(data)).lastInsertRowid);}
 events(after=0,limit=100){return this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(after,Math.min(1000,limit)).map(r=>({...r,data:JSON.parse(r.data)}));}
 command(key,input,fn){identifier(key,'idempotencyKey');const hash=digest(input);return this.tx(()=>{const old=this.db.prepare('SELECT * FROM commands WHERE key=?').get(key);if(old){if(old.hash!==hash)throw Error('Idempotency key conflict');return JSON.parse(old.result);}const result=fn();this.db.prepare('INSERT INTO commands(key,hash,result) VALUES(?,?,?)').run(key,hash,canonical(result));return result;});}
 submission(kind,scope,key,hash,create){const old=this.db.prepare('SELECT * FROM submissions WHERE kind=? AND scope=? AND key=?').get(kind,scope,key);if(old){if(old.hash!==hash)throw Error('Submission conflict');return this.get(kind,old.id);}const result=create(randomUUID());this.put(kind,result);this.db.prepare('INSERT INTO submissions VALUES(?,?,?,?,?)').run(kind,scope,key,result.id,hash);return result;}
 request(taskId,key){const row=this.db.prepare('SELECT * FROM requests WHERE task_id=? AND key=?').get(taskId,key);return row?{...row,...JSON.parse(row.data)}:null;}
 requestOutcomes(taskId){return this.db.prepare("SELECT key,kind,status,json_extract(data,'$.requestOutcome') AS outcome FROM requests WHERE task_id=?").all(taskId);}
 spent(taskId){return Object.fromEntries(this.db.prepare('SELECT kind,COUNT(*) AS n FROM requests WHERE task_id=? GROUP BY kind').all(taskId).map(r=>[r.kind,Number(r.n)]));}
}
