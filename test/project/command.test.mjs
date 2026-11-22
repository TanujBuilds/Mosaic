import test from 'node:test';
import assert from 'node:assert/strict';
import {command} from '../../src/project/process.mjs';

test('stopped command retains only the configured output bytes', async () => {
 const result = await command([process.execPath, '-e', 'process.stdout.write("x".repeat(4096))'], {maxBuffer:1024});
 assert.equal(result.stopped, true);
 assert.equal(result.stdout, 'x'.repeat(1024));
 assert.equal(result.stderr, '');
});
