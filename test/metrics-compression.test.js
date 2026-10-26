import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlMetricsStore } from '../src/durable/SqlMetricsStore.js';
import { historySampling, HISTORY_RANGES } from '../src/utils/historyPolicy.js';
import { emptyBlock, emptyAggregate, addValues } from '../src/durable/metricAggregates.js';
import { encodeMetricParts, decodeMetricPart, METRIC_PART_MAX_BYTES } from '../src/durable/metricCodec.js';
import { makeSqlStorage } from './helpers/sql-storage.js';
import { historySeries } from '../src/frontend/utils/historyCharts.js';

const HOUR = 3600_000;
const MINUTE = 60_000;
const origin = Math.floor(Date.now() / HOUR) * HOUR;
const report = (samples, serverId = 'a') => [{ serverId, samples: samples.map(([ts, data]) => ({ ts, data })) }];

test('chart series keeps report-level observations sparse and timeout gaps explicit', () => {
  const data = [
    { timestamp: 10, gpu: 20, peaks: { gpu: 90 } },
    { timestamp: 20, cpu: 50 },
    { timestamp: 30, gpu: null },
    { timestamp: 40, gpu: 30 }
  ];
  assert.deepEqual(historySeries(data, row => row.gpu), [
    { x: 10, y: 20, peak: 90 }, { x: 30, y: null }, { x: 40, y: 30 }
  ]);
});

test('all nine ranges have explicit resolutions and bounded point counts', () => {
  const counts = [60, 90, 120, 120, 144, 144, 144, 192, 168];
  for (const [index, range] of HISTORY_RANGES.entries()) {
    assert.equal(historySampling(range.hours).intervalMs, range.interval);
    assert.equal(historySampling(range.hours).points, counts[index]);
    assert.equal(historySampling(range.hours).durationMs, range.seconds * 1000);
  }
  assert.equal(historySampling(0.167).durationMs, 600_000, 'legacy 0.167 alias means exactly ten minutes');
  assert.equal(historySampling(168, 60).points, 60);
  assert.equal(historySampling(168, 1000).intervalMs % MINUTE, 0);
});

test('a complete week satisfies every range without exceeding its point budget or dropping spikes', async () => {
  const store = new SqlMetricsStore(makeSqlStorage());
  const now = origin + 50 * MINUTE;
  const minuteSamples = Array.from({ length: 10080 }, (_, index) => [now - index * MINUTE, {
    cpu: index === 3 * 24 * 60 + 11 ? 99 : 1, net_in_speed: index === 3 * 24 * 60 + 11 ? 10000 : 10
  }]);
  await store.ingest(report(minuteSamples), { now });
  await store.ingest(report(Array.from({ length: 360 }, (_, index) => [now - index * 10_000 - 1000, { cpu: 1, net_in_speed: 10 }])) , { now });
  for (const range of HISTORY_RANGES) {
    const data = await store.history('a', { hours: range.hours, now });
    assert.equal(data.length, historySampling(range.hours).points, range.label);
    assert.ok(data.every(point => point.timestamp >= now - range.seconds * 1000 && point.timestamp <= now));
  }
  const week = await store.history('a', { hours: 168, now });
  assert.equal(Math.max(...week.map(point => point.peaks.cpu)), 99);
  assert.equal(Math.max(...week.map(point => point.net_in_speed)), 10000);
});

test('weighted aggregation preserves peaks, fractional loss, zeros and exact latest counters', async () => {
  const store = new SqlMetricsStore(makeSqlStorage());
  const now = origin + 50 * MINUTE;
  const a = { cpu: 10, ram_used: 50, ram_total: 100, net_in_speed: 100, loss_ct: 0, ping_ct: 10, net_rx: 1_000_000_000_001 };
  const b = { cpu: 30, ram_used: 50, ram_total: 100, net_in_speed: 100, loss_ct: 0, ping_ct: 30, net_rx: 1_000_000_000_002 };
  const c = { cpu: 90, ram_used: 100, ram_total: 200, net_in_speed: 1000, loss_ct: 1, ping_ct: 50, net_rx: 1_000_000_000_003 };
  const ts = now - 3 * MINUTE + 1000;
  await store.ingest(report([[ts, a], [ts + 1000, b]]), { now });
  await store.ingest(report([[ts + 1000, b], [ts + MINUTE, c]]), { now });
  const [row] = await store.history('a', { hours: 1, points: 1, now });
  assert.equal(row.cpu, 43.3, 'sum/count weights a two-sample minute twice as much');
  assert.equal(row.peaks.cpu, 90);
  assert.equal(row.net_in_speed, 1000);
  assert.equal(row.averages.net_in_speed, 400);
  assert.equal(row.loss_ct, 0.3);
  assert.equal(row.peaks.loss_ct, 1);
  assert.equal(row.ping_ct, 30);
  assert.equal(row.ram_percent, 50, 'capacity changes must not bias utilization');
  assert.equal(row.net_rx, c.net_rx);
});

test('short history uses ten-second buckets while old or sparse data keeps its real resolution', async () => {
  const storage = makeSqlStorage();
  const store = new SqlMetricsStore(storage);
  const now = origin + 50 * MINUTE;
  const start = now - 10 * MINUTE;
  await store.ingest(report(Array.from({ length: 600 }, (_, index) => [start + index * 1000 + 500, { cpu: index % 100 }])) , { now });
  const short = await store.history('a', { hours: 0.167, now });
  assert.equal(short.length, 60);
  assert.equal(short[0].cpu, 4.5);
  assert.equal(short[0].peaks.cpu, 9);
  assert.equal((await store.history('a', { hours: 0.5, now })).length, 30);
  assert.equal((await store.history('a', { hours: 1, now })).length, 20);
  const restarted = new SqlMetricsStore(storage);
  assert.deepEqual(await restarted.history('a', { hours: 0.167, now }), short);
  const later = now + 3 * HOUR;
  store.cleanup(later);
  assert.equal(Object.keys(store.readBlock('a', origin).block.f).length, 0);
  assert.equal((await store.history('a', { hours: 6, now: later })).length, 4);
  await store.ingest(report([[now - 2 * MINUTE, { cpu: 8 }]], 'sparse'), { now });
  assert.equal((await store.history('sparse', { hours: 0.167, now })).length, 1, 'no fabricated points between reports');
});

test('missing intervals and explicit disabled or timeout probe markers survive compression', async () => {
  const store = new SqlMetricsStore(makeSqlStorage());
  const now = origin + 50 * MINUTE;
  await store.ingest(report([
    [now - 9 * MINUTE, { cpu: 0, ping_ct: 10, loss_ct: 0 }],
    [now - MINUTE, { cpu: 0, ping_ct: false, loss_ct: false, ping_cu: null, loss_cu: null }]
  ]), { now });
  const data = await store.history('a', { hours: 0.167, now });
  assert.equal(data.length, 2);
  assert.equal(data[0].cpu, 0);
  assert.equal(data[1].ping_ct, false);
  assert.equal(data[1].loss_ct, false);
  assert.equal(data[1].ping_cu, null);
  assert.equal(data[1].loss_cu, null);
  assert.equal(data[1].ping_cm, undefined);
});

test('GPU dimensions, nested disk IO, loads and numeric precision have separate aggregation rules', async () => {
  const store = new SqlMetricsStore(makeSqlStorage());
  const now = origin + 50 * MINUTE;
  const ts = now - MINUTE;
  await store.ingest(report([
    [ts, { cpu: 1.23456, load_avg: '1.01 2.02 3.03', disk: { read_bps: 10.4, await_ms: 1.24 },
      gpu_info: [{ id: '__proto__', name: 'A GPU', info: 10, mem_used: 50, mem_total: 100, power: 25.12 }] }],
    [ts + 1000, { cpu: 9.87654, load_avg: '3.03 4.04 5.05', disk: { read_bps: 90.4, await_ms: 9.86 },
      gpu_info: JSON.stringify([{ id: '__proto__', name: 'A GPU', info: 90, mem_used: 70, mem_total: 100, power: 75.34 }]) }]
  ]), { now });
  const [row] = await store.history('a', { hours: 1, points: 1, now });
  assert.equal(row.cpu, 5.6);
  assert.equal(row.disk.read_bps, 90);
  assert.equal(row.disk.await_ms, 9.9);
  assert.equal(row.load_avg, '2.02 3.03 4.04');
  assert.equal(row.gpu_info[0].name, 'A GPU');
  assert.equal(row.gpu_info[0].info, 50);
  assert.equal(row.gpu_info[0].mem_used, 60);
  assert.equal(row.gpu_info[0].mem_total, 100);
  assert.equal(row.gpu_info[0].power, 50.2);
  assert.equal(row.peaks.gpu_info[0].info, 90);
});

test('retry journal crosses hour boundaries and does not advance a duplicate heartbeat', async () => {
  const storage = makeSqlStorage();
  const before = origin + HOUR - 1000;
  const updates = report([[before, { cpu: 10 }]]);
  const identity = { now: before, reportKey: 'a:hour-boundary', fingerprint: 'same' };
  await new SqlMetricsStore(storage).ingest(updates, identity);
  let store = new SqlMetricsStore(storage);
  assert.equal((await store.ingest(updates, { ...identity, now: before + 5000 })).duplicate, true);
  assert.equal((await store.timestamps(['a'])).a, before);
  await store.ingest(report([[before + 6000, { cpu: 20 }]]), { now: before + 6000, reportKey: 'a:next', fingerprint: 'next' });
  store = new SqlMetricsStore(storage);
  await assert.rejects(store.ingest(updates, { ...identity, now: before + 7000, fingerprint: 'different' }), error => error.code === 409);
  assert.equal((await store.ingest(updates, { ...identity, now: before + 8000 })).duplicate, true);
});

test('failure in the second hour rolls back the first hour and retry journal as one transaction', async () => {
  const storage = makeSqlStorage();
  const store = new SqlMetricsStore(storage);
  const before = origin + HOUR - 1000;
  await store.ingest(report([[before, { cpu: 10 }]]), { now: before });
  storage.db.exec(`CREATE TRIGGER fail_second_hour BEFORE INSERT ON metric_blocks
    WHEN NEW.bucket = ${origin + HOUR} BEGIN SELECT RAISE(ABORT, 'second hour failure'); END;`);
  const samples = report([[before + 500, { cpu: 90 }], [before + 2000, { cpu: 70 }]]);
  const options = { now: before + 3000, reportKey: 'atomic', fingerprint: 'same' };
  await assert.rejects(store.ingest(samples, options), /second hour failure/);
  assert.equal((await store.history('a', { hours: 1, points: 1, now: before + 3000 }))[0].cpu, 10);
  assert.equal((await store.timestamps(['a'])).a, before);
  storage.db.exec('DROP TRIGGER fail_second_hour');
  assert.equal((await store.ingest(samples, options)).duplicate, false);
  assert.equal((await store.ingest(samples, options)).duplicate, true);
});

test('former minute SQL aggregates and retry IDs migrate without inventing subminute details', async () => {
  const storage = makeSqlStorage();
  const store = new SqlMetricsStore(storage);
  store.init();
  const now = origin + 50 * MINUTE;
  const ts = now - MINUTE;
  const legacy = { timestamp: ts, data: { cpu: 30, net_in_speed: 100 }, max: { net_in_speed: 900 }, avg: { cpu: { sum: 120, count: 3 } }, seen: [ts - 2000, ts - 1000, ts] };
  storage.db.prepare('INSERT INTO metric_history VALUES (?, ?, ?, ?)').run('a', Math.floor(ts / MINUTE) * MINUTE, JSON.stringify(legacy.data), JSON.stringify(legacy));
  storage.db.prepare('INSERT INTO metric_reports VALUES (?, ?, ?)').run('a:legacy', 'same', now + MINUTE);
  assert.equal((await store.history('a', { hours: 0.167, now })).length, 1);
  const [row] = await store.history('a', { hours: 1, now });
  assert.equal(row.cpu, 40);
  assert.equal(row.net_in_speed, 900);
  assert.equal((await store.ingest(report([[ts, { cpu: 0 }]]), { now, reportKey: 'a:legacy', fingerprint: 'same' })).duplicate, true);
  assert.equal((await new SqlMetricsStore(storage).history('a', { hours: 1, now }))[0].cpu, 40);
});

test('oversized hourly blocks split before the row limit and decode without changing statistics', () => {
  const block = emptyBlock();
  // Large, varied GPU-like column names force the uncompressed-memory guard.
  for (let index = 0; index < 360; index++) {
    const state = emptyAggregate();
    const values = Object.fromEntries(Array.from({ length: 500 }, (_, field) => [`gpu:${JSON.stringify([field, 'info'])}`, index * 31.234 + field]));
    addValues(state, origin + index * 10_000, values);
    block.f[index * 10_000] = state;
  }
  // Force enough decoded state to exercise the adaptive time partition.
  for (const state of Object.values(block.f)) for (const cell of Object.values(state.a)) cell[4] = 12.345678901234567;
  const parts = encodeMetricParts(block, origin);
  assert.ok(parts.size > 1);
  assert.ok([...parts.values()].every(bytes => bytes.byteLength < METRIC_PART_MAX_BYTES));
  const restored = {};
  for (const bytes of parts.values()) Object.assign(restored, decodeMetricPart(bytes, origin).f);
  assert.deepEqual(restored, block.f);
});
