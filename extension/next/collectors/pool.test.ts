import test from 'node:test';
import assert from 'node:assert/strict';
import { mapConcurrent } from './pool.ts';
test('bounded parallel loading preserves input order despite different completion times', async () => {
  let active=0, peak=0;
  const results=await mapConcurrent([4,3,2,1,0],4,async value=>{
    peak=Math.max(peak,++active);
    await new Promise(resolve=>setTimeout(resolve,value*5)); active--;
    return value;
  });
  assert.equal(peak,4); assert.deepEqual(results,[4,3,2,1,0]);
});
test('cancellation stops pending work and waits for in-flight work to finish',async()=>{
  const controller=new AbortController(); let calls=0,active=0;
  await assert.rejects(mapConcurrent([0,1,2,3,4,5],2,async value=>{
    calls++; active++; await new Promise(resolve=>setTimeout(resolve,5)); active--;
    if(value===0) controller.abort();
    return value;
  },controller.signal),{name:'AbortError'});
  assert.equal(calls,2); assert.equal(active,0);
});
