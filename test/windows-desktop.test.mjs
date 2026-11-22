import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {IdleSleepAssertion} from '../src/harness/overnight-lifecycle.mjs';
test('Windows overnight sleep assertion releases at stop and retains the approved deadline',()=>{
  const calls=[];let killed=0;
  const power=new IdleSleepAssertion({platform:'win32',spawnProcess:(...args)=>{
    calls.push(args);const child=new EventEmitter();child.kill=()=>{killed++;};return child;
  }});
  const deadline=Date.now()+120000;
  power.sync(true,deadline);power.sync(true,deadline);
  assert.equal(calls.length,1);
  assert.equal(calls[0][2].env.MOSAIC_POWER_DEADLINE,String(deadline));
  assert.equal(calls[0][2].stdio[0],'pipe');
  power.sync(false,deadline);
  assert.equal(killed,1);
  power.sync(true,Date.now()-1);
  assert.equal(calls.length,1);
});
