import assert from 'node:assert/strict';
import test from 'node:test';
import { checkedRun, distribution, experimentEnvironment, pairedDifference } from './compare.mjs';

test('pairing distinguishes a known delay from variation common to both sides', () => {
  const baseline = [1, 9, 2, 11, 3, 5];
  assert.deepEqual(pairedDifference(baseline, baseline).ci95Ms, [0, 0]);
  assert.deepEqual(pairedDifference(baseline, baseline.map(x => x + 2)).ci95Ms, [2, 2]);
  assert.deepEqual(pairedDifference(baseline, baseline.map(x => x - .5)).ci95Ms, [-.5, -.5]);
  assert.equal(distribution([2, 1, 4, 3]).median, 2.5);
});

test('a candidate with different output, stderr, or exit status is rejected', async () => {
  const expected = { stdout: 'RESULT 0\n', stderr: '' };
  for (const source of ['console.log("RESULT 1")', 'console.log("RESULT 0"); console.error("bad")', 'console.log("RESULT 0"); process.exit(2)']) {
    await assert.rejects(checkedRun([process.execPath, '-e', source], expected), /verification/);
  }
});

test('timed command receives the explicit allocator setting', async () => {
  await checkedRun([process.execPath, '-e', 'console.log(process.env.MIMALLOC_ALLOW_THP)'],
    { stdout: '0\n', stderr: '' }, { MIMALLOC_ALLOW_THP: '0' });
  const before = process.env.PERRY_GC_STARTUP_TEST;
  try {
    process.env.PERRY_GC_STARTUP_TEST = 'ambient';
    assert.equal(experimentEnvironment().PERRY_GC_STARTUP_TEST, undefined);
  } finally {
    if (before === undefined) delete process.env.PERRY_GC_STARTUP_TEST;
    else process.env.PERRY_GC_STARTUP_TEST = before;
  }
});

test('a hanging candidate fails the check', async () => {
  await assert.rejects(checkedRun([process.execPath, '-e', 'setInterval(() => {}, 1000)'],
    { stdout: '', stderr: '' }, {}, false, 150), /verification/);
});

test('allocator environment isolates uppercase and lowercase operator settings', async () => {
  const keys = ['MIMALLOC_ALLOW_THP', 'mimalloc_allow_thp', 'PERRY_MEMORY_PROFILE'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = 'ambient';
    for (const key of keys) assert.equal(experimentEnvironment()[key], undefined);
    await checkedRun([process.execPath, '-e', 'console.log(process.env.PERRY_MEMORY_PROFILE, process.env.mimalloc_allow_thp, process.env.MIMALLOC_ALLOW_THP)'],
      { stdout: 'small 1 undefined\n', stderr: '' }, { PERRY_MEMORY_PROFILE: 'small', mimalloc_allow_thp: '1' });
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
