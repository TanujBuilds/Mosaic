import test from 'node:test';
import assert from 'node:assert/strict';
import {coreLocations} from '../distribution/windows-core/core.mjs';

test('Windows core chooses separate per-user state for Beta read-only attachment', () => {
  const local = 'C:\\Users\\QA User\\AppData\\Local';
  const paths = coreLocations(local);
  assert.equal(paths.state,local+'\\Mosaic\\state');
  assert.equal(paths.config,local+'\\Mosaic\\core-config.json');
  for (const value of ['',undefined,'relative','\\\\server\\share']) assert.throws(()=>coreLocations(value));
});
