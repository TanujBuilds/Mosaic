import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {lstat, realpath} from 'node:fs/promises';

// Rank known transient checkout locations below user projects. Keep the path local.
export function isHistoryCheckout(repo) {
  const dir = path.normalize(repo);
  const tmp = path.resolve(tmpdir());
  return [tmp, '/private'+tmp, '/private/tmp', '/tmp'].some(root=>dir.startsWith(root+'/')) ||
    /(?:^|\/)(?:\.data|\.sites-checkout|\.codex\/worktrees)(?:\/|$)/.test(dir) ||
    /\/Mosaic(?: Preview| Beta)?\/state\/(?:native-candidates|integration)\/artifacts\//.test(dir);
}

// Older coordinators omit repository identity and last goal activity from
// their viewer snapshots. Project only these fields for goals already visible.
export async function readProjectIndex(state, ids, tasks = []) {
  const metadata = new Map();
  if (!ids.length) return metadata;
  const file = path.join(state, 'harness.sqlite3');
  let db;
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.uid !== process.getuid() || await realpath(file) !== file) return metadata;
    const {DatabaseSync} = await import('node:sqlite');
    db = new DatabaseSync(file, {readOnly:true, timeout:120});
    db.exec('PRAGMA query_only=ON');
    const lookup = db.prepare(`SELECT json_extract(data,'$.manifest.project.repo') AS repo,
      json_extract(data,'$.createdAt') AS createdAt,
      (SELECT at FROM events WHERE goal_id=records.id ORDER BY seq DESC LIMIT 1) AS at
      FROM records WHERE kind='goal' AND id=?`);
    for (const id of ids.slice(0,100)) {
      const row = lookup.get(id);
      if (!row) continue;
      const repo = typeof row.repo === 'string' && path.isAbsolute(row.repo) ? path.normalize(row.repo) : null;
      metadata.set(id, {
        project:repo ? {id:createHash('sha256').update(repo).digest('hex').slice(0,24),name:path.basename(repo) || repo,parent:path.basename(path.dirname(repo)),history:isHistoryCheckout(repo)} : null,
        updatedAt:row.at ?? row.createdAt
      });
    }
    const taskReason=db.prepare("SELECT substr(json_extract(data,'$.reason'),1,500) AS reason FROM records WHERE kind='task' AND id=? AND json_extract(data,'$.goalId')=?");
    for (const task of tasks.slice(0,500)) {
      if (!metadata.has(task.goalId) || !['blocked','failed','uncertain'].includes(task.status)) continue;
      const reason=taskReason.get(task.id,task.goalId)?.reason;
      if (typeof reason==='string' && /(?:\b(?:401|403)\b|credential|api key|unauthori[sz]ed|authentication)/i.test(reason))
        metadata.get(task.goalId).connectionIssue=true;
    }
  } catch {
    // A stopped, moved, older, or busy database must not hide viewer data.
  } finally { db?.close(); }
  return metadata;
}
