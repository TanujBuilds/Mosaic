import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {appendFile, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {windowsFile, windowsWrite} from '../../src/beta/windows-files.mjs';
import {startApi} from '../../src/harness/api.mjs';
import {Coordinator} from '../../src/harness/coordinator.mjs';
import {Dispatcher} from '../../src/harness/tools.mjs';

const windows = process.platform === 'win32';
if (process.env.GITHUB_ACTIONS === 'true') {
  assert.equal(process.platform, 'win32');
  assert.equal(process.arch, 'x64');
  assert.equal(process.versions.node, '24.22.3');
}
const exec = promisify(execFile);
const researchCli = fileURLToPath(new URL('../../scripts/mosaic-research-mission.mjs', import.meta.url));
const pythonDriver = fileURLToPath(new URL('../../src/harness/research-missions/fixture-driver.py', import.meta.url));
const recipeCli = fileURLToPath(new URL('../../scripts/mosaic-workflow-recipes.mjs', import.meta.url));
const decode = async file => JSON.parse(await readFile(file, 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const scratch = windows ? path.join(os.tmpdir(), 'mosaic-research-' + randomUUID()) :
  await mkdtemp(path.join(os.tmpdir(), 'mosaic-research-'));
if (windows) {
  await windowsFile('mkdir', scratch);
  await windowsFile('private-directory', scratch);
}

async function cli(script, ...args) {
  try {
    return JSON.parse((await exec(process.execPath, [script, ...args], {
      cwd: scratch, timeout: 90_000, maxBuffer: 1024 * 1024, windowsHide: true,
    })).stdout);
  } catch (error) {
    throw Error(path.basename(script) + ': ' + (error.stderr?.trim() || error.message));
  }
}

async function research() {
  const target = path.join(scratch, "worker's mission");
  const demo = output => cli(researchCli, 'demo', '--output', output);
  if (windows) {
    await assert.rejects(demo(target), /Windows protected coding is in development/);
    await assert.rejects(demo(target), /must be a fresh directory/);
    const link = path.join(scratch, 'alias');
    await symlink(target, link, 'junction');
    await assert.rejects(demo(path.join(link, 'another')), /Unsafe output parent or symlink/);
    const c = new Coordinator({root:path.join(target, 'coordinator')});
    try {
      assert.deepEqual(c.store.all('goal').map(goal => goal.status), ['draft']);
      assert.equal(c.store.all('task').length, 0);
    } finally { c.close(); }
    return {status:'held_at_goal_activation', tasks:0, freshOutputGuard:true, reparsePointGuard:true};
  }
  const result = await demo(target);
  assert.equal(result.fixture, true);
  assert.deepEqual(result.statuses, ['awaiting_review', 'revision_needed', 'awaiting_review', 'accepted', 'partial']);
  const file = path.join(target, 'transcript.json');
  const transcript = await decode(file);
  const [original, negative, fresh, final, partial] = transcript.stages;
  assert.equal(original.candidateHash, negative.candidateHash);
  assert.notEqual(fresh.candidateHash, original.candidateHash);
  assert.equal(final.candidateHash, fresh.candidateHash);
  assert.notEqual(partial.taskId, final.taskId);
  for (const stage of [negative, fresh, final]) {
    for (const field of ['remoteJobId', 'taskId', 'goalId', 'goalDeadline', 'deadline']) {
      assert.equal(stage[field], original[field], field);
    }
  }
  for (const name of ['reservationReplay', 'staleCandidateRejected', 'incompleteCoverageRejected',
    'fullReviewReplay', 'changedReplayRejected']) assert.equal(transcript.checks[name], true, name);
  assert.deepEqual(transcript.fixture, {sourceBasis:'invented_local_sources',
    reviewer:'simulated_independent_reviewer', liveValidation:'not_run'});
  const [rejected, accepted, incomplete] = await Promise.all(['revision-needed', 'accepted', 'partial']
    .map(name => decode(path.join(target, name + '.json'))));
  assert.equal(rejected.sourcesHash, accepted.sourcesHash);
  assert.notEqual(rejected.reportHash, accepted.reportHash);
  assert.equal(accepted.claims.find(claim => claim.id === 'C1').support, 'reviewed_supported');
  assert.match(incomplete.collectionReason, /cannot repair/i);
  await assert.rejects(demo(target), /must be a fresh directory/);
  const link = path.join(scratch, 'alias');
  await symlink(target, link, 'dir');
  await assert.rejects(demo(path.join(link, 'another')), /Unsafe output parent or symlink/);
  return {statuses:result.statuses, checks:transcript.checks, sourceBasis:transcript.fixture.sourceBasis,
    reviewer:transcript.fixture.reviewer, liveValidation:transcript.fixture.liveValidation,
    transcriptSha256:sha256(await readFile(file)), sourceSha256:accepted.sourcesHash, reportSha256:accepted.reportHash};
}

async function pythonArtifacts() {
  const root = path.join(scratch, 'Python artifact fixture');
  const python = process.env.FRONTIER_TEST_PYTHON ?? (windows ? 'python.exe' : 'python3');
  async function drive(args, packet) {
    const child = exec(python, ['-ISB', '-X', 'utf8', pythonDriver, root, ...args], {
      cwd:scratch, timeout:15000, maxBuffer:1024 * 1024, windowsHide:true,
    });
    child.child.stdin.on('error', () => {});
    child.child.stdin.end(packet === undefined ? undefined : JSON.stringify(packet));
    return JSON.parse((await child).stdout);
  }
  const rpc = packet => drive(['rpc'], packet);
  const manifest = {mode:'fixture', schema:2, submission_id:'windows-offline-python',
    question:'How do the invented queues recover after process restart?',
    not_after:Math.floor(Date.now() / 1000) + 120, collaboration:{supervisor:'codex', max_questions:0},
    scope:{include_domains:['fixture.invalid']},
    limits:{seconds:120, model_calls:4, searches:1, downloads:1},
    research_policy:{version:3, finish:'selectors_only', discovery:'search_required',
      repairContextVersion:1, correctionStrategy:'targeted_v1',
      review:{version:1, role:'independent_operator', maxRounds:2, maxRevisions:1,
        maxCorrectionModelCalls:2, rubricSha256:'b'.repeat(64)}}};
  const prepared = await rpc({command:'prepare_manifest', manifest});
  const job = await rpc({command:'submit', manifest:prepared.manifest, approved_hash:prepared.hash});
  const request = (command, input) => rpc({command, job:job.id, ...input});
  const initial = await drive(['initial', job.id]);
  assert.equal(initial.status, 'awaiting_semantic_review');
  const first = (await request('proposal_export')).descriptor;
  const decide = async (candidate, label, decision, findings) => {
    const binding = {candidateHash:candidate.candidateHash, rubricHash:candidate.rubricSha256};
    const key = {...binding, idempotency_key:'reserve-' + label};
    const ticket = await request('review_reserve', key);
    assert.deepEqual(await request('review_reserve', key), {...ticket, dispatchRequired:false});
    const verdict = {...binding, decision, findings, ticketId:ticket.id, coverage:candidate.units,
      idempotency_key:'submit-' + label};
    const accepted = await request('review_submit', verdict);
    assert.deepEqual(await request('review_submit', verdict), accepted);
  };
  await decide(first, 'initial', 'revise', [{unit:'claims:C1', code:'lost_condition',
    message:'Recovery requires a valid lease.', evidence:[]}]);
  assert.equal((await drive(['correct', job.id])).status, 'awaiting_semantic_review');
  const revised = (await request('proposal_export')).descriptor;
  assert.equal(revised.assembly.baseCandidateHash, first.candidateHash);
  assert.equal(revised.sourcesSha256, first.sourcesSha256);
  assert.notEqual(revised.reportSha256, first.reportSha256);
  await decide(revised, 'corrected', 'accept', []);
  assert.equal((await drive(['finalize', job.id])).status, 'completed');
  const packet = await request('export');
  const collected = await drive(['collect'], packet);
  assert.equal(collected.checksums_verified, true);
  const hashes = {};
  for (const [name, bytes] of Object.entries(packet.files)) {
    const content = await readFile(path.join(collected.directory, name));
    assert.deepEqual(content, Buffer.from(bytes, 'base64'));
    hashes[name] = sha256(content);
  }
  const receipt = await decode(path.join(collected.directory, 'receipt.json'));
  assert.equal(receipt.mode, 'fixture');
  assert.equal(receipt.quality.accepted_candidate_hash, revised.candidateHash);
  for (const [name, hash] of Object.entries(receipt.artifacts)) assert.equal(hashes[name], hash);
  return {status:collected.status, modelSource:'scripted_fixture', reviewer:'simulated_independent_reviewer',
    candidateSha256:revised.candidateHash, hashes};
}

async function preview() {
  const root = path.join(scratch, 'preview-state');
  const coordinator = new Coordinator({root});
  const config = {environment:'fixture'};
  const dispatcher = new Dispatcher({c:coordinator, config});
  let api;
  try {
    const goal = coordinator.prepareLegacyGoal({submissionId:'windows-offline-preview', environment:'fixture',
      mode:'collaborative', objective:'Preview invented fixture comparison',
      acceptance:['Keep research parked']}, 'fixture-prepare');
    if (windows) assert.throws(() => coordinator.activateGoal({goalId:goal.id, hash:goal.hash}, 'fixture-activate'),
      /Windows protected coding is in development/);
    const token = randomBytes(32).toString('hex');
    api = await startApi({dispatcher, token, headless:true});
    const connection = path.join(root, 'connection.json');
    const record = JSON.stringify({url:api.url, token});
    if (windows) await windowsWrite(connection, record);
    else await writeFile(connection, record, {mode:0o600});
    const input = {goalId:goal.id, recipeId:'research-comparison', version:1,
      parameters:{question:'Which example is easier to check?', alternatives:'Example A and Example B',
        constraints:'Use invented local source material.', asOf:'2026-11-10'}};
    const inputFile = path.join(scratch, 'preview.json');
    await writeFile(inputFile, JSON.stringify(input), {mode:0o600});
    const revision = coordinator.store.revision();
    const result = await cli(recipeCli, 'preview', '--root', root, '--input', inputFile);
    assert.deepEqual(result, await cli(recipeCli, 'preview', '--root', root, '--input', inputFile));
    assert.equal(result.validTemplate, true);
    assert.equal(result.launchable, false);
    assert.equal(result.goalHash, goal.hash);
    assert.deepEqual(result.resolvedDefinition.tasks.map(task => task.kind), ['research']);
    assert.ok(result.diagnostics.some(row => row.code === 'research_parked'));
    assert.ok(result.diagnostics.some(row => row.code === 'goal_inactive'));
    assert.equal(coordinator.getGoal(goal.id).status, 'draft');
    assert.equal(coordinator.store.revision(), revision);
    assert.equal(coordinator.store.all('task').length, 0);
    const requests = coordinator.store.db.prepare('SELECT COUNT(*) AS count FROM requests').get().count;
    assert.equal(requests, 0);
    return {definitionDigest:result.definitionDigest, previewDigest:result.previewDigest,
      diagnostics:result.diagnostics.map(row => row.code), tasks:0, requests};
  } finally {
    await api?.close();
    coordinator.close();
  }
}

try {
  const checks = {research, preview, pythonArtifacts};
  const results = await Promise.allSettled(Object.values(checks).map(check => check()));
  const report = Object.fromEntries(Object.keys(checks).map((name, index) => {
    const result = results[index];
    return [name, result.status === 'fulfilled' ? result.value : {error:result.reason.message}];
  }));
  const receipt = JSON.stringify({platform:process.platform, arch:process.arch, node:process.versions.node,
    revision:process.env.GITHUB_SHA ?? null, ...report}, null, 2);
  console.log(receipt);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    '### Offline research and recipe preview\n\n```json\n' + receipt + '\n```\n');
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, 'Offline research or recipe preview failed');
} finally {
  await rm(scratch, {recursive:true, force:true, maxRetries:4});
}
