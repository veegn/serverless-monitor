import { makeD1 } from './helpers/d1.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlMetricsStore } from '../src/durable/SqlMetricsStore.js';
import { MetricsBroadcaster } from '../src/durable/MetricsBroadcaster.js';
import { FrontendSubscriptions } from '../src/durable/FrontendSubscriptions.js';
import { NotificationService } from '../src/services/NotificationService.js';
import { UpdateController } from '../src/handlers/UpdateController.js';
import { loadSiteSettings, clearSiteSettingsCache, SITE_FIELDS } from '../src/utils/settings.js';
import { clearServersListCache } from '../src/utils/cache.js';
import { readLimitedJson } from '../src/utils/requestBody.js';
import { makeSqlStorage } from './helpers/sql-storage.js';
import { ReportReplayCache } from '../src/utils/ReportReplayCache.js';
import { ServerlessMonitorApp } from '../src/app.js';

globalThis.WebSocketRequestResponsePair ||= class {};
const minute = 60_000;
const update = (serverId, samples) => ({ serverId, samples: samples.map(([ts, cpu, speed = 0]) => ({ ts, data: { cpu, net_in_speed: speed } })) });

function settingsDb(options = {}, servers = []) {
  return makeD1({ settings: { site_options: { jwt_secret: 'x'.repeat(32), is_public: 'true', ...options } }, servers });
}

test('settings failures preserve the last private policy and cold starts fail closed', async () => {
  clearSiteSettingsCache();
  const db = settingsDb({ is_public: 'false', turnstile_enabled: 'true' });
  const trusted = await loadSiteSettings(db);
  db.failed = true;
  const stale = await loadSiteSettings(db, { forceRefresh: true });
  assert.equal(stale, trusted);
  assert.equal(stale.is_public, 'false');
  assert.equal(stale.turnstile_enabled, 'true');
  const cold = settingsDb();
  cold.failed = true;
  await assert.rejects(loadSiteSettings(cold), error => error.code === 503);
});

test('SQL history retains seven days and aggregates overlapping minute reports without losing peaks', async () => {
  const store = new SqlMetricsStore(makeSqlStorage());
  const now = Math.floor(Date.now() / minute) * minute + 50_000;
  const ts = now - 40_000;
  await store.ingest([update('a', [[now - 30 * 3600_000, 7], [ts, 10, 100], [ts + 1000, 20, 500]])], { now });
  await store.ingest([update('a', [[ts + 1000, 20, 500], [ts + 2000, 60, 1]])], { now });
  const history = await store.history('a', { hours: 168, points: 1000, now });
  assert.equal(history.length, 2);
  assert.equal(history[0].cpu, 7);
  assert.equal(history[1].cpu, 30);
  assert.equal(history[1].net_in_speed, 500);
});

test('a failed commit rolls history, latest state and deduplication back together, then accepts a retry', async () => {
  const storage = makeSqlStorage();
  const store = new SqlMetricsStore(storage);
  store.init();
  storage.db.exec(`CREATE TRIGGER fail_latest BEFORE INSERT ON metric_blocks BEGIN SELECT RAISE(ABORT, 'disk failure'); END;`);
  const now = Date.now();
  const report = [update('a', [[now - 1000, 10]])];
  const identity = { now, reportKey: 'a:r1', fingerprint: 'content-1' };
  await assert.rejects(store.ingest(report, identity), /disk failure/);
  assert.equal(store.rows('SELECT * FROM metric_blocks').length, 0);
  assert.equal(store.rows('SELECT * FROM metric_reports').length, 0);
  storage.db.exec('DROP TRIGGER fail_latest');
  assert.equal((await store.ingest(report, identity)).persisted, true);
  const restarted = new SqlMetricsStore(storage);
  assert.equal((await restarted.ingest(report, identity)).duplicate, true);
  await assert.rejects(restarted.ingest(report, { ...identity, fingerprint: 'different-content' }), error => error.code === 409);
  assert.equal((await restarted.history('a', { now })).length, 1);
});

test('old DO snapshots migrate once and a failed migration read can be retried', async () => {
  const storage = makeSqlStorage();
  const now = Date.now();
  storage.store.set('durable_history_v1:a', [{ timestamp: now - minute, cpu: 12 }]);
  const get = storage.get;
  let fail = true;
  storage.get = async key => { if (fail) throw new Error('temporary storage failure'); return get(key); };
  const store = new SqlMetricsStore(storage);
  await assert.rejects(store.history('a'), /temporary storage failure/);
  assert.equal(storage.store.has('durable_history_v1:a'), true);
  fail = false;
  assert.equal((await store.history('a'))[0].cpu, 12);
  assert.equal(storage.store.has('durable_history_v1:a'), false);
  await store.ingest([update('a', [[now, 24]])], { now });
  assert.equal((await new SqlMetricsStore(storage).history('a', { now })).length, 2);
});

test('long SQL history queries use a bounded number of indexed samples', async () => {
  const storage = makeSqlStorage();
  const store = new SqlMetricsStore(storage);
  const now = Date.now();
  await store.ingest([update('a', Array.from({ length: 120 }, (_, i) => [now - i * minute, i]))], { now });
  const data = await store.history('a', { hours: 168, points: 60, now });
  assert.ok(data.length <= 60);
  const plan = storage.db.prepare('EXPLAIN QUERY PLAN SELECT payload FROM metric_blocks WHERE server_id = ? AND bucket >= ? AND bucket < ?').all('a', now - minute, now);
  assert.ok(plan.some(row => row.detail.includes('SEARCH') && /INDEX|PRIMARY KEY/.test(row.detail)));
});

test('hidden nodes cannot appear in initial replay, live broadcast, or subscription changes', async () => {
  const db = settingsDb({}, [{ id: 'visible', is_hidden: '0' }, { id: 'hidden', is_hidden: '1' }]);
  const env = { DB: db };
  const access = await new FrontendSubscriptions(env).authorize(new Request('https://test/ws'));
  assert.deepEqual(access.allowedServerIds, ['visible']);
  const messages = [];
  let attachment = { ...access, scope: 'all', serverIds: [] };
  const socket = { send(text) { messages.push(JSON.parse(text)); }, deserializeAttachment() { return attachment; }, serializeAttachment(value) { attachment = value; }, close() {} };
  const broadcaster = new MetricsBroadcaster({ storage: makeSqlStorage(), setWebSocketAutoResponse() {}, getWebSockets() { return [socket]; } }, env);
  const now = Date.now();
  const updates = [update('visible', [[now, 10]]), update('hidden', [[now, 99]])];
  await broadcaster._persistUpdates(updates);
  await broadcaster._pushLatestUpdatesToSubscriber(socket, 'all');
  await broadcaster._broadcastBatch(updates);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.flatMap(message => message.updates.map(item => item.serverId)), ['visible', 'visible']);
  assert.equal(broadcaster.frontendSubscriptions.canSubscribe(attachment, 'hidden'), false);
  assert.equal(broadcaster.frontendSubscriptions.canSubscribe(attachment, 'all', ['hidden']), false);
});

test('offline checks use durable receipt timestamps, retry failed notifications, and send recovery', async () => {
  clearSiteSettingsCache(); clearServersListCache();
  const db = settingsDb({ tg_notify: '10', notification_webhook_enabled: 'true', notification_webhook_url: 'https://example.invalid' }, [{ id: 'a', name: 'A' }]);
  let reportedAt = Date.now() - 9 * minute;
  const env = { DB: db, METRICS_BROADCASTER: { idFromName() { return 'global'; }, get() { return { async fetch() { return Response.json({ timestamps: { a: reportedAt } }); } }; } } };
  const service = new NotificationService(env);
  const original = NotificationService.sendNotification;
  const events = [];
  let fail = true;
  NotificationService.sendNotification = async (settings, message, context) => { events.push(context); return fail ? 'failed' : undefined; };
  try {
    await service.checkOfflineNodes();
    assert.equal(events.length, 0, 'nine minutes must not trip a ten-minute threshold');
    reportedAt = Date.now() - 12 * minute;
    await service.checkOfflineNodes();
    assert.deepEqual(db.alertState, {}, 'failed delivery must remain retryable');
    fail = false;
    await service.checkOfflineNodes();
    assert.equal(db.alertState.a, true);
    reportedAt = Date.now();
    await service.checkOfflineNodes();
    assert.deepEqual(db.alertState, {});
    assert.equal(events.length, 3);
  } finally { NotificationService.sendNotification = original; }
});

test('streaming bodies without Content-Length still enforce the byte limit', async () => {
  const request = new Request('https://test/update', { method: 'POST', body: JSON.stringify({ metrics: 'x'.repeat(1024) }) });
  assert.equal(request.headers.has('Content-Length'), false);
  await assert.rejects(readLimitedJson(request, 512), error => error.code === 413);
});

test('a newer sample inside a disordered batch is retained even if its endpoints are ordered', () => {
  const samples = Array.from({ length: 500 }, (_, index) => ({ ts: 1700000000000 + index, metrics: { cpu: index } }));
  samples[1].ts += 10000;
  const result = UpdateController.normalizeMetricSamples({ samples });
  assert.equal(result.at(-1).ts, samples[1].ts);
});

test('HTTP ingestion retries failed DO responses and never acknowledges an unconfirmed write', async () => {
  let calls = 0;
  const env = { METRICS_BROADCASTER: { idFromName() { return 'global'; }, get() { return { async fetch() {
    calls++;
    return calls < 2 ? new Response('unavailable', { status: 503 }) : Response.json({ ok: true, persisted: true });
  } }; } } };
  await UpdateController.commitReport(env, update('a', [[Date.now(), 10]]), 'r1');
  assert.equal(calls, 2);
  env.METRICS_BROADCASTER.get = () => ({ async fetch() { return Response.json({ ok: true, persisted: false }); } });
  await assert.rejects(UpdateController.commitReport(env, update('a', [[Date.now(), 10]])), error => error.code === 503);
});

test('replay cache evicts large batches by retained size and releases accounting on clear', () => {
  const cache = new ReportReplayCache({ maxServers: 1000, maxBytes: 1000 });
  cache.set('a', { samples: [{ data: 'x'.repeat(300) }] });
  cache.set('b', { samples: [{ data: 'x'.repeat(300) }] });
  assert.equal(cache.size, 1);
  assert.equal(cache.has('b'), true);
  assert.ok(cache.estimatedBytes <= 1000);
  cache.clear();
  assert.equal(cache.estimatedBytes, 0);
});

test('HTTP resource-alert sampling remains active after a cold start with no frontend subscribers', async () => {
  const storage = makeSqlStorage();
  const create = () => new MetricsBroadcaster({ storage, setWebSocketAutoResponse() {}, getWebSockets() { return []; } }, { DB: {} });
  const instance = create();
  assert.equal(instance._shouldCacheResourceAlertSamples(), false);
  const report = new Request('http://internal/batch-push', { method: 'POST', body: JSON.stringify({
    maintainState: true, updates: [update('a', [[Date.now(), 90]])]
  }) });
  assert.equal((await instance.fetch(report)).status, 200);
  assert.equal(instance.resourceAlertWindows.get('a').samples[0].cpu, 90);
});

test('Sunday maintenance no longer suppresses minute-level offline and resource checks', async () => {
  const app = new ServerlessMonitorApp({ DB: {} });
  const calls = [];
  app.notificationService = {
    async checkOfflineNodes() { calls.push('offline'); },
    async checkResourceAlerts(options) { calls.push(`resources:${options.minute}`); }
  };
  await app.scheduled({ cron: '*/1 * * * *', scheduledTime: Date.UTC(2026, 9, 25, 0, 2) });
  assert.deepEqual(calls, ['offline', 'resources:2']);
});

test('large subscriptions persist outside the attachment and survive a new session manager', async () => {
  const storage = makeSqlStorage();
  let attachment = null;
  const ws = {
    deserializeAttachment() { return attachment; },
    serializeAttachment(value) {
      assert.ok(Buffer.byteLength(JSON.stringify(value)) < 2048);
      attachment = value;
    }
  };
  const ids = Array.from({ length: 500 }, (_, index) => `node-${index}-${'x'.repeat(40)}`);
  const state = { accessVersion: 1, allowedServerIds: ids, scope: 'all', serverIds: ids };
  await new FrontendSubscriptions({}, storage).save(ws, state);
  assert.deepEqual(await new FrontendSubscriptions({}, storage).load(ws), state);
});
