import test from 'node:test';
import assert from 'node:assert/strict';
import { MetricsBroadcaster } from '../src/durable/MetricsBroadcaster.js';
import { HISTORY_RETENTION_MS } from '../src/durable/SqlMetricsStore.js';
import { UpdateController } from '../src/handlers/UpdateController.js';
import { clearSiteSettingsCache } from '../src/utils/settings.js';
import { clearServerDetailCache, clearServersListCache } from '../src/utils/cache.js';
import { UPDATE_MAX_BATCH_SAMPLES } from '../src/utils/config.js';
import { makeSqlStorage } from './helpers/sql-storage.js';
import { makeD1 } from './helpers/d1.js';

globalThis.WebSocketRequestResponsePair ??= class {};
const now = Date.UTC(2026, 9, 28, 8, 30, 40);

function fixture(t, storage = makeSqlStorage(), restart = false) {
  if (!restart) t.mock.timers.enable({ apis: ['Date'], now });
  const state = { storage, setWebSocketAutoResponse() {}, getWebSockets() { return []; } };
  const env = { API_SECRET: 'master-secret', DB: makeD1({ settings: { site_options: { auto_register_enabled: 'false' } },
    servers: [{ id: 'node', name: 'Node', secret: 'node-secret' }] }) };
  const broadcaster = new MetricsBroadcaster(state, env);
  // Exercise parsing, normalization, SQLite transactions, latest cache and delivery;
  // authentication/configuration have separate protocol tests.
  broadcaster._resolveAgentContext = async () => ({ serverId: 'node', regionCode: 'CN', agentVersion: '1.0.25' });
  broadcaster._buildAgentConfigAck = async () => null;
  broadcaster._getAgentRealtimeState = () => ({ realtimeActive: true });
  broadcaster._evaluateAgentTrafficAlertIfDue = () => {};
  const broadcasts = [];
  broadcaster._broadcastBatch = async updates => broadcasts.push(structuredClone(updates));
  broadcaster._queueFrontendBroadcastBatch = () => {};
  const messages = [], closed = [];
  const ws = { send: text => messages.push(JSON.parse(text)), close: (...args) => closed.push(args) };
  const send = async report => {
    await broadcaster._handleAgentReportMessage(ws, JSON.stringify(report));
    return messages.at(-1);
  };
  env.METRICS_BROADCASTER = { idFromName: () => 'global', get: () => ({
    fetch: (url, init) => broadcaster.fetch(new Request(url, init))
  }) };
  const http = report => UpdateController.handleUpdate(new Request('https://monitor.test/update', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.10' },
    body: JSON.stringify(report)
  }), env, { waitUntil() {} });
  clearSiteSettingsCache();
  clearServerDetailCache();
  clearServersListCache();
  if (!restart) t.after(() => storage.db.close());
  return { broadcaster, storage, env, send, http, messages, closed, broadcasts };
}

const live = (reportId, ts = now, cpu = 90) => ({ id: 'node', secret: 'node-secret', reportId,
  batch: false, time: { local_ts: ts }, metrics: { cpu, ram_total: 8192 } });
const batch = (reportId, ts = now, cpu = 90) => ({ ...live(reportId, ts, cpu), batch: true,
  samples: [{ ts: now - 22_000, metrics: { cpu: 10 } }, { ts: now - 12_000, metrics: { cpu: 20 } }] });
const latest = async broadcaster => (await broadcaster.metricsStore.latest(['node']))[0];
const history = broadcaster => broadcaster.metricsStore.history('node', { now, points: 1000 });

test('live snapshots persist latest state without history; batches store only samples and keep top-level metrics current', async t => {
  const f = fixture(t);
  const ack = await f.send(live('live'));
  assert.equal(ack.accepted, true);
  assert.equal(ack.persisted, undefined);
  assert.equal(ack.acceptedSamples, undefined);
  assert.deepEqual(await history(f.broadcaster), []);
  assert.equal((await latest(f.broadcaster)).samples[0].data.cpu, 90);
  const report = batch('batch', now + 2000, 95);
  report.samples[1].metrics = { cpu: 20, ram_total: 4096, ram_used: 1024, swap_used: 32,
    load_avg: '1.2 2.3 3.4', disk: { read_bps: 1024, write_iops: 12 },
    net_rx: 12345, net_tx: 54321, tcp_conn: 9, processes: 50, ping_ct: 25, loss_ct: 0,
    gpu_info: [{ id: '0', name: 'GPU', info: 42, mem_used: 1024, mem_total: 8192 }] };
  const committed = await f.send(report);
  assert.equal(committed.persisted, true);
  assert.equal(committed.acceptedSamples, 2);
  const rows = await history(f.broadcaster);
  assert.deepEqual(rows.map(row => row.cpu), [10, 20]);
  assert.equal(rows[1].ram_total, 4096);
  assert.equal(rows[1].disk.read_bps, 1024);
  assert.equal(rows[1].disk.write_iops, 12);
  assert.equal(rows[1].load_avg, '1.2 2.3 3.4');
  assert.equal(rows[1].net_rx, 12345);
  assert.equal(rows[1].net_tx, 54321);
  assert.equal(rows[1].processes, 50);
  assert.equal(rows[1].tcp_conn, 9);
  assert.equal(rows[1].ping_ct, 25);
  assert.equal(rows[1].loss_ct, 0);
  assert.equal(rows[1].gpu_info[0].mem_used, 1024);
  assert.equal((await latest(f.broadcaster)).samples[0].data.cpu, 95);
  assert.equal(f.broadcasts.at(-1)[0].samples.length, 1);
  assert.equal(f.broadcasts.at(-1)[0].samples[0].ts, now + 2000);
});

test('a maximum-size batch acknowledges and stores all 300 samples exactly once', async t => {
  const f = fixture(t);
  const report = batch('limit');
  report.samples = Array.from({ length: UPDATE_MAX_BATCH_SAMPLES }, (_, i) => ({
    ts: now - (UPDATE_MAX_BATCH_SAMPLES - i) * 2000, metrics: { cpu: i % 100 }
  }));
  assert.equal((await f.send(report)).acceptedSamples, UPDATE_MAX_BATCH_SAMPLES);
  assert.equal((await f.send(report)).acceptedSamples, UPDATE_MAX_BATCH_SAMPLES);
  const { block } = f.broadcaster.metricsStore.readBlock('node', Math.floor(now / 3600_000) * 3600_000);
  assert.equal(Object.values(block.m).reduce((sum, aggregate) => sum + aggregate.n, 0), UPDATE_MAX_BATCH_SAMPLES);
});

test('retry identity survives receipt-time changes, missing clocks, canonical key ordering and a DO restart', async t => {
  const f = fixture(t);
  const report = live('stable');
  delete report.time;
  assert.equal((await f.send(report)).accepted, true);
  t.mock.timers.setTime(now + 15_000);
  const restarted = fixture(t, f.storage, true);
  const retry = { ...report, metrics: { ram_total: 8192, cpu: 90 } };
  assert.equal((await restarted.send(retry)).accepted, true);
  assert.equal(restarted.closed.length, 0);
  assert.equal(restarted.broadcasts.length, 0);
  assert.equal((await latest(restarted.broadcaster)).samples[0].ts, now);
  await restarted.send({ ...report, metrics: { cpu: 91 } });
  assert.equal(restarted.closed.at(-1)[0], 1008);
});

test('observation times prefer accurate_ts, then calibrated local_ts, rather than receipt time', async t => {
  const f = fixture(t);
  const report = live('clock');
  report.time = { accurate_ts: now - 3000, local_ts: now - 5000, calibrated: true, offset_ms: 1000 };
  await f.send(report);
  assert.equal((await latest(f.broadcaster)).samples[0].ts, now - 3000);
  await f.send({ ...report, reportId: 'clock-2', time: { local_ts: now - 2000, calibrated: true, offset_ms: 1000 } });
  assert.equal((await latest(f.broadcaster)).samples[0].ts, now - 1000);
});

test('late history commits without rolling latest state, memory cache or broadcasts back, including after restart', async t => {
  const f = fixture(t);
  await f.send(live('newest'));
  const report = batch('late', now - 10_000, 30);
  assert.equal((await f.send(report)).persisted, true);
  assert.equal(f.broadcasts.length, 1);
  assert.equal(f.broadcaster.latestReportUpdates.get('node').samples[0].data.cpu, 90);
  t.mock.timers.setTime(now + 10_000);
  const restarted = fixture(t, f.storage, true);
  assert.equal((await restarted.send({ ...report, reportId: 'late-after-restart' })).persisted, true);
  assert.equal(restarted.broadcasts.length, 0);
  const stored = await latest(restarted.broadcaster);
  assert.equal(stored.samples[0].data.cpu, 90);
  assert.equal(stored.reportTs, now, 'replay keeps the original latest-snapshot receipt time');
  assert.equal((await restarted.broadcaster.metricsStore.timestamps(['node'])).node, now + 10_000,
    'online detection still uses the most recent accepted receipt time');
  assert.deepEqual((await history(restarted.broadcaster)).map(row => row.cpu), [10, 20]);
});

const invalidBatches = {
  'future sample': report => report.samples.push({ ts: now + 120_000, metrics: { cpu: 99 } }),
  'expired sample': report => report.samples.unshift({ ts: now - HISTORY_RETENTION_MS - 1, metrics: { cpu: 99 } }),
  'missing timestamp': report => delete report.samples[0].ts,
  'invalid metrics': report => report.samples[0].metrics = [],
  'unsorted samples': report => report.samples.reverse(),
  'duplicate timestamps': report => report.samples[1].ts = report.samples[0].ts,
  'empty batch': report => report.samples = [],
  'oversized sample count': report => report.samples = Array.from({ length: UPDATE_MAX_BATCH_SAMPLES + 1 },
    (_, i) => ({ ts: now - 1000 + i, metrics: { cpu: 99 } }))
};
for (const [name, invalidate] of Object.entries(invalidBatches)) {
  test(`invalid batch rejects every sample and latest update atomically: ${name}`, async t => {
    const f = fixture(t);
    const report = batch('invalid');
    invalidate(report);
    const ack = await f.send(report);
    assert.equal(ack.accepted, false);
    assert.equal(ack.persisted, false);
    assert.equal(ack.acceptedSamples, 0);
    assert.equal(ack.reportId, 'invalid');
    assert.deepEqual(await history(f.broadcaster), []);
    assert.equal(await latest(f.broadcaster), undefined);
    assert.equal(f.broadcasts.length, 0);
    assert.equal(f.closed.length, 0);
    // Rejection must not consume the ID or leave an idempotency entry behind.
    assert.equal((await f.send(batch('invalid'))).acceptedSamples, 2);
  });
}

test('SQLite write failures roll history, latest state and report identity back; retry commits once', async t => {
  const f = fixture(t);
  f.broadcaster.metricsStore.init();
  f.storage.db.exec("CREATE TRIGGER fail_report BEFORE INSERT ON metric_blocks BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  const report = batch('write-failure');
  const ack = await f.send(report);
  assert.equal(ack.accepted, false);
  assert.equal(ack.persisted, false);
  assert.equal(ack.acceptedSamples, 0);
  assert.equal(ack.retryAfterMs, 1000);
  assert.deepEqual(await history(f.broadcaster), []);
  assert.equal(await latest(f.broadcaster), undefined);
  assert.equal(f.broadcasts.length, 0);
  f.storage.db.exec('DROP TRIGGER fail_report');
  assert.equal((await f.send(report)).acceptedSamples, 2);
  t.mock.timers.setTime(now + 5000);
  assert.equal((await f.send(report)).acceptedSamples, 2);
  assert.equal(f.broadcasts.length, 1);
  assert.deepEqual((await history(f.broadcaster)).map(row => row.cpu), [10, 20]);
});

test('HTTP and WSS share snapshot/history semantics and stable report identity', async t => {
  const f = fixture(t);
  const snapshot = live('http-live');
  assert.equal((await f.http(snapshot)).status, 200);
  assert.deepEqual(await history(f.broadcaster), []);
  assert.equal((await latest(f.broadcaster)).samples[0].data.cpu, 90);
  t.mock.timers.setTime(now + 5000);
  assert.equal((await f.send(snapshot)).accepted, true, 'inferred HTTP IPs must not change the fingerprint');
  assert.equal(f.closed.length, 0);
  const report = batch('http-batch', now + 5000, 95);
  assert.equal((await f.http(report)).status, 200);
  assert.equal((await f.send(report)).acceptedSamples, 2);
  assert.equal((await latest(f.broadcaster)).samples[0].data.cpu, 95);
  assert.deepEqual((await history(f.broadcaster)).map(row => row.cpu), [10, 20]);
  const invalid = batch('http-invalid');
  invalid.samples.push({ ts: now + 120_000, metrics: { cpu: 99 } });
  assert.equal((await f.http(invalid)).status, 400);
  assert.equal((await f.http({ ...report, metrics: { cpu: 99 } })).status, 409);
  assert.equal((await latest(f.broadcaster)).samples[0].data.cpu, 95);
});
