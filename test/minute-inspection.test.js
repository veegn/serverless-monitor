import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './helpers/d1.js';
import { ServerlessMonitorApp } from '../src/app.js';
import { NotificationService } from '../src/services/NotificationService.js';
import { ensureNotificationStateSchema } from '../src/database/NotificationStateRepository.js';
import { ensureSettingsStorage, clearSiteSettingsCache, saveSettings, loadSettingsScope } from '../src/utils/settings.js';
import { clearServersListCache } from '../src/utils/cache.js';
import { SITE_SETTINGS_CACHE_TTL_MS } from '../src/utils/config.js';

const now = Date.UTC(2026, 9, 30, 8, 0);
const cpuRule = { id: 'cpu-rule', metric: 'cpu', threshold: 80, intervalMinutes: 5, mode: 'average', servers: [] };

async function fixture(t, { settings = {}, runtime = {} } = {}) {
  const seed = makeD1({ settings: { site_options: { jwt_secret: 'x'.repeat(32), tg_notify: '5',
    notification_webhook_enabled: 'true', notification_webhook_url: 'https://example.invalid', ...settings }, ...runtime },
    servers: [{ id: 'a', name: 'A' }] });
  await ensureSettingsStorage(seed);
  await ensureNotificationStateSchema(seed);
  // A new binding reproduces cold process caches against an already migrated database.
  const db = { ...seed };
  clearSiteSettingsCache();
  clearServersListCache();
  const requests = [], notifications = [];
  const control = { offline: false, cpu: 20, failTimestamps: false, deliveryError: undefined };
  t.mock.method(NotificationService, 'sendNotification', async (_settings, _message, context) => {
    notifications.push(context);
    return control.deliveryError;
  });
  const env = { DB: db, METRICS_BROADCASTER: { idFromName: () => 'global', get: () => ({
    async fetch(url, init) {
      const body = JSON.parse(init.body);
      requests.push({ url, body });
      if (url.endsWith('/latest-timestamps')) {
        if (control.failTimestamps) return new Response('Unavailable', { status: 503 });
        return Response.json({ timestamps: { a: Date.now() - (control.offline ? 10 * 60_000 : 0) } });
      }
      assert.ok(url.endsWith('/evaluate-resource-alerts'));
      return Response.json({ results: body.rules.map(rule => {
        const metrics = [{ metric: 'cpu', threshold: 80, current: control.cpu, triggerValue: control.cpu, mode: 'average', unit: '%' }];
        return { ruleId: rule.ruleId, evaluatedServerIds: rule.serverIds,
          alerts: control.cpu >= 80 ? rule.serverIds.map(serverId => ({ serverId, metrics })) : [],
          evaluations: rule.serverIds.map(serverId => ({ serverId, metrics })) };
      }) });
    }
  }) } };
  const app = new ServerlessMonitorApp(env);
  const tick = minute => app.runScheduled({ cron: '*/1 * * * *', scheduledTime: now + minute * 60_000 });
  const readState = key => {
    const row = seed.sqlite.prepare('SELECT value FROM notification_runtime_state WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : null;
  };
  seed.calls.length = 0;
  t.after(() => seed.sqlite.close());
  return { db, app, tick, requests, notifications, control, readState, calls: seed.calls };
}

for (const minute of [1, 2]) {
  test(`cold minute ${minute}: disabled notifications need two reads and no node/state queries`, async t => {
    const f = await fixture(t, { settings: { notification_webhook_enabled: 'false' } });
    await f.tick(minute);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls.every(call => call.sql.startsWith('SELECT')), true);
    assert.equal(f.calls.some(call => /FROM servers|FROM notification_runtime_state/.test(call.sql)), false);
    assert.equal(f.requests.length, 0);
  });
}

for (const rules of [[], [cpuRule]]) {
  test(`offline and resource checks share cold reads (${rules.length ? 'resource rules enabled' : 'resource rules disabled'})`, async t => {
    const f = await fixture(t, { settings: { resource_alert_rules: rules } });
    await f.tick(2);
    assert.equal(f.calls.length, 6);
    assert.equal(f.calls.filter(call => /FROM servers s/.test(call.sql)).length, 1);
    assert.equal(f.calls.filter(call => /SELECT key,value,revision FROM notification_runtime_state/.test(call.sql)).length, 1);
    assert.equal(f.calls.filter(call => /^SELECT key,value FROM settings/.test(call.sql)).length, 1);
    assert.equal(f.calls.some(call => /DELETE|INSERT|UPDATE/.test(call.sql)), false, 'empty state must not cause a write');
    const start = f.calls.length;
    await f.tick(3);
    assert.equal(f.calls.length - start, 1, 'a warm inspection rereads runtime state, but reuses node/settings caches');
    assert.equal(f.notifications.length, 0);
  });
}

test('offline notification failure remains retryable and the next inspection sees persisted state and recovery', async t => {
  const f = await fixture(t);
  f.control.offline = true;
  f.control.deliveryError = 'delivery failed';
  await f.tick(1);
  assert.equal(f.readState('alert_state'), null);
  f.control.deliveryError = undefined;
  await f.tick(2);
  assert.deepEqual(f.readState('alert_state'), { a: true });
  f.control.offline = false;
  await f.tick(3);
  assert.deepEqual(f.readState('alert_state'), {});
  assert.equal(f.notifications.length, 3);
});

test('resource alerts still trigger and recover, and offline lookup failure does not suppress evaluation', async t => {
  const f = await fixture(t, { settings: { resource_alert_rules: [cpuRule] } });
  f.control.failTimestamps = true;
  f.control.cpu = 90;
  await f.tick(1);
  assert.equal(f.readState('resource_alert_state').servers['cpu-rule:a'].status, 'active');
  f.control.cpu = 20;
  await f.tick(2);
  assert.equal(f.readState('resource_alert_state').servers['cpu-rule:a'].status, 'recovered');
  assert.equal(f.notifications.length, 2);
  assert.equal(f.requests.filter(request => request.url.endsWith('/evaluate-resource-alerts')).length, 2);
});

test('known-empty resource state is isolated by database and existing stale state is cleaned once', async t => {
  const first = await fixture(t);
  await first.tick(1);
  const second = await fixture(t, { runtime: { resource_alert_state: { signature: 'old', servers: { stale: {} } } } });
  await second.tick(2);
  assert.equal(second.readState('resource_alert_state'), null);
  assert.equal(second.calls.filter(call => /^DELETE FROM notification_runtime_state/.test(call.sql)).length, 1);
  const start = second.calls.length;
  await second.tick(3);
  assert.equal(second.calls.slice(start).some(call => /^DELETE/.test(call.sql)), false);
});

test('empty-state caching expires so state written by another isolate is eventually cleaned', async t => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const f = await fixture(t, { settings: { tg_notify: '0' } });
  await f.tick(1);
  f.db.sqlite.prepare('INSERT INTO notification_runtime_state(key,value) VALUES(?,?)')
    .run('resource_alert_state', '{"signature":"external","servers":{"stale":{}}}');
  t.mock.timers.setTime(now + SITE_SETTINGS_CACHE_TTL_MS + 1);
  await f.tick(3);
  assert.equal(f.readState('resource_alert_state'), null);
  assert.equal(f.calls.some(call => /FROM servers s/.test(call.sql)), false, 'disabled checks never scan nodes');
});

test('settings changes invalidate the inspection cache and TTL also refreshes changes from another isolate', async t => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const f = await fixture(t, { settings: { tg_notify: '0', notification_webhook_enabled: 'false' } });
  await f.tick(1);
  await saveSettings(f.db, { notification_webhook_enabled: 'true', resource_alert_rules: [cpuRule] });
  await f.tick(2);
  assert.equal(f.requests.filter(request => request.url.endsWith('/evaluate-resource-alerts')).length, 1);
  f.db.sqlite.prepare("UPDATE settings SET value=json_set(value,'$.notification_webhook_enabled','false') WHERE key='settings.notifications'").run();
  t.mock.timers.setTime(now + SITE_SETTINGS_CACHE_TTL_MS + 1);
  const start = f.requests.length;
  await f.tick(3);
  assert.equal(f.requests.length, start, 'external configuration changes become visible within 120 seconds');
});

test('cold combined schema checks still reject a future migration version', async t => {
  const f = await fixture(t);
  f.db.sqlite.prepare('INSERT INTO schema_migrations VALUES(?,?,?,?)').run('settings', 3, 'future', now);
  await assert.rejects(loadSettingsScope(f.db, 'notifications'), error => error.code === 503);
  assert.equal(f.calls.some(call => /CREATE|ALTER|DROP|DELETE|INSERT|UPDATE/.test(call.sql)), false);
});

test('unbound metric storage skips minute inspections without touching D1', async () => {
  const app = new ServerlessMonitorApp({ DB: { prepare() { throw new Error('Unexpected D1 query'); } } });
  await app.runScheduled({ cron: '*/1 * * * *', scheduledTime: now });
});
