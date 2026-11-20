import path from 'node:path';
import {lstat, realpath, rm} from 'node:fs/promises';
import {client} from './client.mjs';
import {jsonFile, saveJson, withLock} from './files.mjs';
import {configuredPolicies, readSettings} from './settings.mjs';
import {digest, identifier, keys} from '../harness/contracts.mjs';
import {repositoryCommonDirectory} from '../harness/assignment-intake.mjs';
import {chooseGoal, confirmTerminal, terminalText as clean} from './owner-terminal.mjs';

const modes = new Set(['collaborative', 'deepseek_only', 'codex_only', 'overnight_review']);
const presetPath = (paths, key) => path.join(paths.configDir, 'project-preset-' + key + '.json');
const repoKey = async repo => digest(await repositoryCommonDirectory(path.resolve(repo)));
const checkPattern = /^[a-z0-9-]{1,120}$/u;
const sha = /^[a-f0-9]{64}$/u;

function validatePreset(value) {
 keys(value, ['schema', 'mode', 'worker', 'checks'], 'project preset');
 if (value.schema !== 1 || !modes.has(value.mode) || !Array.isArray(value.checks) || value.checks.length > 50) {
  throw Error('Invalid project preset.');
 }
 if (value.worker !== null) {
  keys(value.worker, ['id', 'revision', 'profileHash'], 'preset worker');
  identifier(value.worker.id, 'worker ID');
  if (typeof value.worker.revision !== 'string' || !value.worker.revision || value.worker.revision.length > 80
   || !sha.test(value.worker.profileHash ?? '')) throw Error('Invalid preset worker identity.');
 }
 const ids = new Set();
 for (const check of value.checks) {
  keys(check, ['id', 'definitionHash'], 'preset check');
  if (!checkPattern.test(check.id ?? '') || !sha.test(check.definitionHash ?? '') || ids.has(check.id)) throw Error('Invalid preset check.');
  ids.add(check.id);
 }
 return value;
}

async function readSaved(paths, file) {
 const expectedHome = await realpath(paths.home);
 for (const dir of [paths.root, paths.configDir]) {
  const stat = await lstat(dir).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return null;
  if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077
   || await realpath(dir) !== path.join(expectedHome, path.relative(paths.home, dir))) throw Error('Project presets require a private Mosaic settings directory.');
 }
 const value = await jsonFile(file, {privateFile: true, max: 16 * 1024});
 return value === null ? null : validatePreset(value);
}

function currentWorkers(settings) {
 return settings ? configuredPolicies(settings).providerPolicy?.workers ?? [] : [];
}

export async function readProjectPreset(paths, repo) {
 const value = await readSaved(paths, presetPath(paths, await repoKey(repo)));
 if (!value) return null;
 const available = value.worker && currentWorkers(await readSettings(paths))
  .some(worker => worker.id === value.worker.id && worker.revision === value.worker.revision && digest(worker) === value.worker.profileHash);
 return {mode: value.mode, workerId: available ? value.worker.id : null,
  ...(value.worker && !available ? {savedWorkerUnavailable: true} : {}), checks: value.checks};
}

export async function runProjectPreset(paths, args = [], options = {}) {
 const [action, flag, value, ...extra] = args;
 const output = options.output ?? process.stdout;
 if (extra.length || !value || !(action === 'save' && flag === '--goal'
  || ['show', 'clear'].includes(action) && flag === '--repo')) {
  throw Error('Use mosaic preset save --goal GOAL_ID or mosaic preset show|clear --repo PATH.');
 }
 if (action === 'show') {
  const preset = await readProjectPreset(paths, value);
  if (!preset) output.write('No saved preferences for this project.\n');
  else {
   output.write(`Suggested mode ${preset.mode}\nWorker ${preset.workerId ?? (preset.savedWorkerUnavailable ? 'saved profile is unavailable or changed' : 'no preference')}\n`);
   output.write(`Suggested check IDs ${preset.checks.map(check => check.id).join(', ') || 'none'}\n`);
  }
  return 0;
 }
 if (action === 'clear') {
  const file = presetPath(paths, await repoKey(value));
  const existing = await readSaved(paths, file);
  if (!existing) {
   output.write('No saved preferences for this project.\n');
   return 0;
  }
  if (!await confirmTerminal('Remove these project suggestions', {...options, output})) return 0;
  await withLock(paths, async () => {
   if (digest(await readSaved(paths, file)) !== digest(existing)) throw Error('Project suggestions changed. Review them again.');
   await rm(file);
  });
  output.write('Removed saved project suggestions.\n');
  return 0;
 }
 const goal = await chooseGoal(options.invoke ?? client(paths), value);
 const {project, mode, workerDefault} = goal.manifest;
 if (!project || goal.manifest.environment !== 'live') throw Error('Select a real project goal to save its suggestions.');
 const workers = currentWorkers(await readSettings(paths));
 const defaultWorker = workerDefault;
 const selected = defaultWorker && workers.find(worker => worker.id === defaultWorker.id && worker.revision === defaultWorker.revision && digest(worker) === defaultWorker.profileHash);
 const preset = validatePreset({schema: 1, mode: mode.id,
  worker: selected ? {id: selected.id, revision: selected.revision, profileHash: digest(selected)} : null,
  checks: project.checkSuggestions,
 });
 const file = presetPath(paths, await repoKey(project.repo));
 const existing = await readSaved(paths, file);
 output.write(`Project ${clean(project.repo)}\nMode ${preset.mode} · worker ${preset.worker?.id ?? 'no preference'}\nCheck IDs ${preset.checks.map(check => check.id).join(', ') || 'none'}\n`);
 if (!await confirmTerminal('Save these suggestions for future drafts in this project', {...options, output})) return 0;
 await withLock(paths, async () => {
  if (digest(await readSaved(paths, file)) !== digest(existing)) throw Error('Project suggestions changed. Review them again.');
  await saveJson(file, preset);
 });
 output.write('Saved project suggestions. Future drafts still require approval.\n');
 return 0;
}
