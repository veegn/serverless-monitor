import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlMetricsStore } from '../src/durable/SqlMetricsStore.js';
import { makeSqlStorage } from './helpers/sql-storage.js';

test('latest metrics preserve typed reports across SQL binding chunks and restarts', async () => {
  const storage = makeSqlStorage();
  const store = new SqlMetricsStore(storage);
  const now = Date.now();
  const reports = Array.from({ length: 121 }, (_, i) => ({ serverId: `s${i}`, samples: [{ ts: now, data: { cpu: i, os: 'Linux', ip_v4: '192.0.2.1' } }] }));
  await store.ingest(reports, { now });
  const rows = await new SqlMetricsStore(storage).latest(reports.map(report => report.serverId));
  assert.equal(rows.length, 121);
  for (const report of rows) {
    assert.equal(report.samples[0].data.cpu, Number(report.serverId.slice(1)));
    assert.equal(report.samples[0].data.ip_v4, '192.0.2.1');
  }
});

test('a delayed backfill cannot replace a newer current sample', async () => {
  const store = new SqlMetricsStore(makeSqlStorage());
  const now = Date.now();
  await store.ingest([{ serverId: 'a', samples: [{ ts: now, data: { cpu: 90 } }] }], { now });
  await store.ingest([{ serverId: 'a', samples: [{ ts: now - 120000, data: { cpu: 10 } }] }], { now: now + 1000 });
  const [report] = await store.latest(['a']);
  assert.equal(report.samples[0].data.cpu, 90);
  assert.equal(report.reportTs, now + 1000);
});

test('missing nodes and empty latest lookups return an empty result', async () => {
  const store = new SqlMetricsStore(makeSqlStorage());
  assert.deepEqual(await store.latest(['missing']), []);
  assert.deepEqual(await store.latest([]), []);
});

test('latest display data can expire without deleting a node heartbeat', async () => {
  const storage = makeSqlStorage();
  const now = Date.now();
  await new SqlMetricsStore(storage).ingest([{ serverId: 'a', samples: [{ ts: now - 600000, data: { cpu: 10 } }] }], { now: now - 600000 });
  const restarted = new SqlMetricsStore(storage);
  assert.equal((await restarted.latest(['a'])).length, 1);
  assert.equal((await restarted.latest(['a'], now - 300000)).length, 0);
  assert.equal((await restarted.timestamps(['a'])).a, now - 600000);
});

test('failed latest storage reads reject instead of reporting all nodes offline', async () => {
  const storage = makeSqlStorage();
  const store = new SqlMetricsStore(storage);
  await store.latest([]);
  storage.db.close();
  await assert.rejects(store.latest(['a']));
});
