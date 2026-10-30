import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { ensureServerSchema, writeServer, deleteServer, serverQuery } from '../src/database/ServerRepository.js';
import { claimTrafficNotification, finishTrafficNotification, ensureNotificationStateSchema } from '../src/database/NotificationStateRepository.js';
import { ensureSettingsStorage, saveSettings } from '../src/utils/settings.js';
import { ServerlessMonitorApp } from '../src/app.js';

test('workerd D1: sparse defaults, one-row notification edits, zero-write saves and indexed scoped reads', { timeout: 30_000 }, async () => {
  const mf = new Miniflare({ modules: true,
    script: 'export default { async fetch(request,env) { return new Response("OK"); } };',
    compatibilityDate: '2024-12-01', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: '22222222-2222-4222-8222-222222222222' }
  });
  try {
    const native = await mf.getD1Database('DB');
    let batch;
    const db = { prepare: native.prepare.bind(native), async batch(statements) { batch = await native.batch(statements); return batch; } };
    await ensureServerSchema(db);
    const written = () => batch.reduce((sum, result) => sum + result.meta.rows_written, 0);
    await writeServer(db, { id: 'probe', name: 'Probe' }, { create: true });
    const createWrites = written();
    for (const table of ['server_ping_settings', 'server_notification_settings', 'server_notification_state']) {
      assert.equal((await native.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n, 0);
    }
    const settings = { id: 'probe', name: 'Probe', ping_mode: 'tcp', custom_ct: null, offline_notify_disabled: '1', traffic_alert_percent: null };
    await writeServer(db, settings);
    const editWrites = written();
    assert.equal(editWrites, 1, 'only the notification row changes, including actual SQLite index accounting');
    await writeServer(db, settings);
    assert.equal(written(), 0);
    await writeServer(db, { id: 'probe', offline_notify_disabled: '0' });
    assert.equal(written(), 1, 'resetting an override deletes its single row');
    await writeServer(db, { id: 'probe', custom_ct: '0', traffic_alert_percent: 80 });
    const claim = await claimTrafficNotification(db, 'probe', { used: 900, threshold: 80, limit: 1, resetFactor: 0.5 });
    assert.ok(claim.token);
    assert.equal((await claimTrafficNotification(db, 'probe', { used: 900, threshold: 80, limit: 1, resetFactor: 0.5 })).token, null);
    assert.equal(await finishTrafficNotification(db, 'probe', claim.token, { u: 900, th: 80, lim: 1 }), true);
    const full = await native.prepare(serverQuery('full', true)).bind('probe').all();
    const publicResult = await native.prepare(serverQuery('public', true)).bind('probe').all();
    const identity = await native.prepare(serverQuery('identity', true)).bind('probe').all();
    assert.ok(full.meta.rows_read > publicResult.meta.rows_read);
    assert.ok(publicResult.meta.rows_read > identity.meta.rows_read);
    assert.equal('traffic_alert_state' in publicResult.results[0], false);
    await assert.rejects(native.prepare('UPDATE servers SET report_interval=31 WHERE id=?').bind('probe').run(), /constraint|Invalid server configuration/i);
    console.log('D1 configuration measurements', JSON.stringify({ createWrites, notificationEditWrites: editWrites,
      unchangedSaveWrites: 0, fullReads: full.meta.rows_read, publicReads: publicResult.meta.rows_read, identityReads: identity.meta.rows_read }));
    await deleteServer(db, 'probe');
    assert.equal((await native.prepare('SELECT COUNT(*) AS n FROM server_notification_state').first()).n, 0);
  } finally { await mf.dispose(); }
});

test('workerd D1: minute inspections share settings, nodes and runtime reads without empty writes', { timeout: 30_000 }, async () => {
  const mf = new Miniflare({ modules: true,
    script: 'export default { async fetch() { return new Response("OK"); } };',
    compatibilityDate: '2024-12-01', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: '33333333-3333-4333-8333-333333333333' }
  });
  try {
    const native = await mf.getD1Database('DB');
    await ensureSettingsStorage(native);
    await ensureNotificationStateSchema(native);
    await writeServer(native, { id: 'probe', name: 'Probe' }, { create: true });
    await saveSettings(native, { tg_notify: '5', notification_webhook_enabled: 'true', notification_webhook_url: 'https://example.invalid',
      resource_alert_rules: [{ id: 'cpu', metric: 'cpu', threshold: 80, intervalMinutes: 5 }] });
    const calls = [];
    function measured(sql, statement) {
      const execute = async method => {
        const result = await statement[method]();
        calls.push({ sql, rowsRead: result.meta.rows_read, rowsWritten: result.meta.rows_written });
        return result;
      };
      return { bind: (...args) => measured(sql, statement.bind(...args)), all: () => execute('all'), run: () => execute('run'),
        async first(column) { const result = await execute('all'); return column ? result.results[0]?.[column] ?? null : result.results[0] || null; } };
    }
    const db = { prepare: sql => measured(sql, native.prepare(sql)), batch() { throw new Error('Completed schemas must not migrate again'); } };
    const app = new ServerlessMonitorApp({ DB: db, METRICS_BROADCASTER: { idFromName: () => 'global', get: () => ({
      async fetch(url, init) {
        if (url.endsWith('/latest-timestamps')) return Response.json({ timestamps: { probe: Date.now() } });
        return Response.json({ results: JSON.parse(init.body).rules.map(rule => ({
          ruleId: rule.ruleId, evaluatedServerIds: rule.serverIds, alerts: [], evaluations: []
        })) });
      }
    }) } });
    await app.runScheduled({ cron: '*/1 * * * *', scheduledTime: Date.UTC(2026, 9, 30, 8, 2) });
    assert.equal(calls.length, 6);
    assert.equal(calls.reduce((sum, call) => sum + call.rowsWritten, 0), 0);
    const coldRowsRead = calls.reduce((sum, call) => sum + call.rowsRead, 0);
    calls.length = 0;
    await app.runScheduled({ cron: '*/1 * * * *', scheduledTime: Date.UTC(2026, 9, 30, 8, 3) });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].rowsWritten, 0);
    console.log('D1 minute inspection measurements', JSON.stringify({ coldSql: 6, coldRowsRead,
      warmSql: 1, warmRowsRead: calls[0].rowsRead, rowsWritten: 0 }));
  } finally { await mf.dispose(); }
});
