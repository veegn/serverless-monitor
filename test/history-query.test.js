import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlMetricsStore } from '../src/durable/SqlMetricsStore.js';
import { DEFAULT_LONG_HISTORY_POINTS, normalizeLongHistoryPoints } from '../src/utils/settings.js';
import { makeSqlStorage } from './helpers/sql-storage.js';

test('long-history point settings only accept supported values', () => {
  assert.equal(normalizeLongHistoryPoints(30), String(DEFAULT_LONG_HISTORY_POINTS));
  assert.equal(normalizeLongHistoryPoints('120'), '120');
  assert.equal(normalizeLongHistoryPoints(240), '240');
});

test('history spans days and week boundaries using one indexed store', async () => {
  const store = new SqlMetricsStore(makeSqlStorage());
  const now = Date.now();
  await store.ingest([{ serverId: 'a', samples: [0, 1, 3, 6].map(days => ({ ts: now - days * 86400000, data: { cpu: days + 1 } })) }], { now });
  const rows = await store.history('a', { hours: 168, points: 120, now });
  assert.deepEqual(rows.map(row => row.cpu), [7, 4, 2, 1]);
  assert.equal((await store.history('a', { hours: 1, now })).length, 1);
});

test('history excludes expired and future samples and caps query output', async () => {
  const store = new SqlMetricsStore(makeSqlStorage());
  const now = Date.now();
  const samples = [{ ts: now - 8 * 86400000, data: { cpu: 99 } }, { ts: now + 120000, data: { cpu: 99 } },
    ...Array.from({ length: 180 }, (_, i) => ({ ts: now - i * 60000, data: { cpu: i } }))];
  await store.ingest([{ serverId: 'a', samples }], { now });
  const history = await store.history('a', { hours: 168, points: 60, now });
  assert.ok(history.length <= 60);
  assert.ok(history.every(point => point.timestamp <= now && point.timestamp >= now - 7 * 86400000));
});

test('retention cleanup is bounded and resumes after a long idle period', async () => {
  const store = new SqlMetricsStore(makeSqlStorage());
  const now = Date.now();
  const reports = Array.from({ length: 11 }, (_, node) => ({ serverId: `s${node}`,
    samples: Array.from({ length: 101 }, (_, i) => ({ ts: now - i * 3600000, data: { cpu: i } })) }));
  await store.ingest(reports, { now });
  assert.equal(store.cleanup(now + 8 * 86400000), true);
  assert.equal(store.rows('SELECT COUNT(*) AS count FROM metric_blocks')[0].count, 111);
  assert.equal(store.cleanup(now + 8 * 86400000), false);
  assert.equal(store.rows('SELECT COUNT(*) AS count FROM metric_blocks')[0].count, 11, 'latest heartbeats survive history expiry');
  assert.equal((await store.history('s0', { hours: 168, now: now + 8 * 86400000 })).length, 0);
});
