import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {antigravity} from '../../src/beta/hosts/antigravity.mjs';
import {cursor} from '../../src/beta/hosts/cursor.mjs';
import {detectCodingApps, windowsHostExecutable} from '../../src/beta/hosts/detection.mjs';

assert.equal(process.platform, 'win32');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const phase = process.argv[2];
assert.ok(['before', 'after'].includes(phase));
const adapter = {cursor, antigravity}[process.env.EDITOR_ID];
assert.ok(adapter);
const user = {home:process.env.USERPROFILE};
const found = await detectCodingApps(user);
assert.equal(found.includes(adapter.id), phase === 'after');
if (phase === 'after') {
  const executable = await windowsHostExecutable(adapter.id, user);
  assert.ok(path.isAbsolute(executable));
  const home = await mkdtemp(path.join(process.env.RUNNER_TEMP, 'editor preview '));
  const options = {paths:{home, configDir:path.join(home, 'Mosaic')}, launcher:path.join(home, 'Mosaic', 'mosaic.exe')};
  const target = adapter.previewRegistration(options).target;
  await mkdir(path.dirname(target), {recursive:true});
  const previous = JSON.stringify({mcpServers:{existing:{command:'unrelated', args:[]}}});
  await writeFile(target, previous, {flag:'wx'});
  const preview = adapter.previewRegistration({...options, existing:await readFile(target, 'utf8')});
  assert.equal(preview.hostId, adapter.id);
  assert.equal(preview.entry.command, options.launcher);
  assert.deepEqual(preview.entry.args, ['mcp']);
  assert.equal(await readFile(target, 'utf8'), previous);
  console.log(executable);
}
