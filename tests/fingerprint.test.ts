import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { createFingerprintReader } from '../packages/db/src/fingerprint.js';

test('concurrent device reads share pending work without blocking or retaining hardware results', async () => {
  let captures = 0;
  let release!: (value: Record<string, string>) => void;
  const read = createFingerprintReader(() => {
    captures++;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const pending = Array.from({ length: 30 }, () => read('installation'));
  // The event loop must progress while the hardware reader is pending.
  await setImmediate();
  assert.equal(captures, 1);
  release({ uuid: '  uuid-1234 ', board: 'board-1234', guid: 'guid-1234' });
  const results = await Promise.all(pending);
  const expected = createHash('sha256')
    .update(JSON.stringify([1, 'installation', 'smbios', ['UUID-1234', 'BOARD-1234']]))
    .digest('hex');
  for (const result of results) assert.deepEqual(result, { mode: 'smbios', hash: expected });
  const next = read('installation');
  const otherInstance = read('another-installation');
  await setImmediate();
  assert.equal(captures, 2);
  release({ uuid: 'uuid-5678', board: 'board-5678' });
  assert.notEqual((await next).hash, expected);
  assert.notEqual((await otherInstance).hash, (await next).hash);
});

test('failed hardware probes are retried and fallback remains bound to MachineGuid', async () => {
  let captures = 0;
  const read = createFingerprintReader(async () => {
    if (++captures === 1) throw new Error('probe failed');
    return { uuid: 'UNKNOWN', board: '00000000', guid: ' guid-1234 ' };
  });
  const results = await Promise.allSettled([read('a'), read('a')]);
  assert.ok(results.every((r) => r.status === 'rejected'));
  const fallback = await read('a');
  assert.equal(captures, 2);
  assert.deepEqual(fallback, {
    mode: 'machine-guid',
    hash: createHash('sha256')
      .update(JSON.stringify([1, 'a', 'machine-guid', ['GUID-1234']]))
      .digest('hex'),
  });
  await assert.rejects(createFingerprintReader(async () => ({}))('a'), /NO_STABLE_DEVICE_ID/);
});
