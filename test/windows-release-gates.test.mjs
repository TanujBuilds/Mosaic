import assert from 'node:assert/strict';
import test from 'node:test';
import {nativeBackendFactory} from '../src/project/check-backends/platform-native-runtime.mjs';

test('production rejects Windows revision 1 before a protected process can start', () => {
  assert.throws(() => nativeBackendFactory({id:'windows-appcontainer',revision:1}), {
    code:'isolation',message:/qualified Windows filesystem boundary/,
  });
});
