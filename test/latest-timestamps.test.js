import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlMetricsStore } from '../src/durable/SqlMetricsStore.js';
import { makeSqlStorage } from './helpers/sql-storage.js';

test('heartbeats use receipt time independently of sample time and display cache TTL', async () => {
  const store = new SqlMetricsStore(makeSqlStorage());
  const now = Date.now();
  await store.ingest([{ serverId: 'a', samples: [{ ts: now - 3600000, data: { cpu: 1 } }] }], { now });
  assert.deepEqual(await store.timestamps(['a', 'missing']), { a: now });
});

test('heartbeat lookups cover multiple SQL binding chunks', async () => {
  const store = new SqlMetricsStore(makeSqlStorage());
  const now = Date.now();
  const updates = Array.from({ length: 150 }, (_, i) => ({ serverId: `s${i}`, samples: [{ ts: now, data: { cpu: i } }] }));
  await store.ingest(updates, { now });
  const timestamps = await store.timestamps(updates.map(update => update.serverId));
  assert.equal(Object.keys(timestamps).length, 150);
  assert.ok(Object.values(timestamps).every(timestamp => timestamp === now));
});

test('a duplicate report after restart does not advance its original heartbeat', async () => {
  const storage = makeSqlStorage();
  const now = Date.now();
  const updates = [{ serverId: 'a', samples: [{ ts: now, data: { cpu: 10 } }] }];
  const identity = { now, reportKey: 'a:r1', fingerprint: 'same' };
  await new SqlMetricsStore(storage).ingest(updates, identity);
  const restarted = new SqlMetricsStore(storage);
  await restarted.ingest(updates, { ...identity, now: now + 60000 });
  assert.equal((await restarted.timestamps(['a'])).a, now);
});
