import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './helpers/d1.js';
import { ensureServerSchema, writeServer, serverQuery } from '../src/database/ServerRepository.js';
import { loadSettingsScope, saveSettings, migrateSettings } from '../src/utils/settings.js';
import { getAllServers, getServerDetail, clearServersListCache } from '../src/utils/cache.js';
import { ensureNotificationStateSchema, readNotificationRuntimeState, saveNotificationRuntimeState,
  claimTrafficNotification, finishTrafficNotification, releaseTrafficNotification, resetTrafficNotification } from '../src/database/NotificationStateRepository.js';
import { NotificationService } from '../src/services/NotificationService.js';

const id = 'optimized-node';
const current = db => ({ ...db.sqlite.prepare('SELECT * FROM server_details WHERE id=?').get(id) });
const changesSince = (db, start) => db.writes.slice(start).filter(write => write.changes > 0 && !/^CREATE|^ALTER|^DROP/.test(write.sql));
const database = (server = {}) => makeD1({ servers: [{ id, name: 'Node', ...server }],
  settings: { site_options: { jwt_secret: 'x'.repeat(32), is_public: 'false' } } });

test('editing one notification option writes only that row, and an unchanged save writes zero rows', async () => {
  const db = database();
  await ensureServerSchema(db);
  const initial = current(db);
  let start = db.writes.length;
  await writeServer(db, { id, name: initial.name, ping_mode: 'tcp', custom_ct: '', offline_notify_disabled: '1', traffic_alert_percent: null });
  assert.equal(changesSince(db, start).length, 1);
  assert.ok(changesSince(db, start)[0].sql.includes('INSERT INTO server_notification_settings'));
  assert.equal(current(db).revision, initial.revision, 'child configuration owns its revision');
  assert.equal(current(db).notification_revision, 1);
  start = db.writes.length;
  await writeServer(db, { id, name: initial.name, ping_mode: 'tcp', custom_ct: null, offline_notify_disabled: '1', traffic_alert_percent: null });
  assert.equal(changesSince(db, start).length, 0);
  await writeServer(db, { id, name: 'Changed' });
  assert.equal(current(db).revision, initial.revision + 1);
  assert.ok(current(db).updated_at >= initial.updated_at);
});

test('default servers have no child rows, and resetting all overrides deletes only the affected rows', async () => {
  const db = database();
  await ensureServerSchema(db);
  for (const table of ['server_ping_settings', 'server_notification_settings', 'server_notification_state']) {
    assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  }
  await writeServer(db, { id, node_1: '0', node_2: 'example.com:443', traffic_alert_percent: 0 });
  assert.equal(current(db).node_1, '0');
  assert.equal(current(db).traffic_alert_percent, 0);
  await writeServer(db, { id, node_1: null });
  assert.equal(current(db).node_2, 'example.com:443', 'partial reset keeps other overrides');
  const start = db.writes.length;
  await writeServer(db, { id, node_2: '', traffic_alert_percent: null });
  assert.equal(changesSince(db, start).length, 2);
  assert.equal(current(db).ping_mode, 'tcp');
  assert.equal(current(db).node_1, null);
  assert.equal(current(db).node_2, null);
  assert.equal(current(db).traffic_alert_percent, null);
});

test('database constraints reject invalid flags, intervals, identities and notification thresholds', async () => {
  const db = database();
  await ensureServerSchema(db);
  for (const sql of ["UPDATE servers SET auto_update=2", "UPDATE servers SET report_interval=31", "UPDATE servers SET collect_interval=NULL",
    "UPDATE servers SET reset_day=32", "UPDATE servers SET wss_report_interval=6", "UPDATE servers SET connection_mode='wss'",
    "UPDATE servers SET rx_correction=-1", "INSERT INTO servers(id) VALUES(NULL)"]) {
    assert.throws(() => db.sqlite.exec(sql), /constraint|Invalid server configuration/i, sql);
  }
  await assert.rejects(writeServer(db, { id, traffic_alert_percent: 80.5 }), /constraint/i);
  await assert.rejects(writeServer(db, { id, ping_mode: 'udp' }), /constraint/i);
  await writeServer(db, { id, auto_update: '1', traffic_alert_percent: 0 });
  assert.equal(db.sqlite.prepare('SELECT typeof(auto_update) AS type FROM servers').get().type, 'integer');
  assert.equal(current(db).auto_update, '1', 'the compatibility view retains the API flag type');
});

test('parent foreign-key dependents survive migration and invalid legacy enums are normalized', async () => {
  const db = database({ report_interval: 99, wss_report_interval: 99, reset_day: -1, auto_update: 'true', timestamp: 123 });
  db.sqlite.exec("CREATE TABLE dependent(server_id TEXT REFERENCES servers(id) ON DELETE CASCADE); INSERT INTO dependent VALUES('optimized-node')");
  await ensureServerSchema(db);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM dependent').get().n, 1);
  const row = current(db);
  assert.equal(row.created_at, 123);
  assert.equal(row.timestamp, 123);
  assert.equal(row.report_interval, 60);
  assert.equal(row.wss_report_interval, 2);
  assert.equal(row.reset_day, 1);
  assert.equal(row.auto_update, '1');
});

test('a failed canonical migration rolls back its phase and resumes after the committed compatibility phase', async () => {
  const db = database({ node_1: '0' });
  const batch = db.batch.bind(db);
  let fail = true;
  db.batch = statements => {
    if (fail && statements.some(statement => statement._sql.includes('CREATE TABLE "_next_'))) {
      return batch([...statements, db.prepare('SELECT nonexistent_migration_function()')]);
    }
    return batch(statements);
  };
  await assert.rejects(ensureServerSchema(db), /nonexistent_migration_function/);
  assert.deepEqual(db.sqlite.prepare("SELECT version FROM schema_migrations WHERE component='servers' ORDER BY version").all().map(row => row.version), [1]);
  assert.equal(db.sqlite.prepare('SELECT node_1 FROM server_ping_settings').get().node_1, '0');
  assert.equal(db.sqlite.prepare('PRAGMA table_info(servers)').all().some(row => row.name === 'timestamp'), true);
  fail = false;
  await ensureServerSchema(db);
  assert.equal(current(db).node_1, '0');
  assert.deepEqual(db.sqlite.prepare("SELECT version FROM schema_migrations WHERE component='servers' ORDER BY version").all().map(row => row.version), [1, 2, 3]);
});

test('cold bindings reject newer schemas and completed schemas issue no DDL', async () => {
  const db = database();
  await ensureServerSchema(db);
  let start = db.calls.length;
  await ensureServerSchema({ ...db });
  assert.equal(db.calls.slice(start).some(call => /CREATE|ALTER|DROP/.test(call.sql)), false);
  db.sqlite.prepare('INSERT INTO schema_migrations VALUES(?,?,?,?)').run('servers', 4, 'future', Date.now());
  await assert.rejects(ensureServerSchema({ ...db }), error => error.code === 503);
});

test('purpose-specific queries read only the required tables and keep private fields out of visitor results', async () => {
  clearServersListCache();
  const db = database({ note: 'private', secret: 'agent-secret', traffic_alert_state: '{"u":100,"th":80,"lim":1}' });
  const publicRows = await getAllServers(db, true, { scope: 'public' });
  assert.equal('secret' in publicRows[0], false);
  assert.equal('note' in publicRows[0], false);
  assert.equal('traffic_alert_state' in publicRows[0], false);
  const agent = await getServerDetail(db, id, true, { scope: 'agent' });
  assert.equal(agent.secret, 'agent-secret');
  assert.equal('note' in agent, false);
  assert.equal('traffic_alert_state' in agent, false);
  assert.equal(serverQuery('identity', true).includes('JOIN'), false);
  assert.equal(serverQuery('resource').includes('JOIN'), false);
  assert.equal(serverQuery('expiry').includes('JOIN'), false);
  assert.equal(serverQuery('public').includes('server_notification'), false);
});

test('name lookup and stable ordering use the intended indexes', async () => {
  const db = database();
  await ensureServerSchema(db);
  const plan = sql => db.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(row => row.detail).join(' ');
  assert.match(plan("SELECT id FROM servers WHERE name='Node'"), /idx_servers_name/);
  assert.match(plan('SELECT id FROM servers ORDER BY sort_order,id'), /idx_servers_sort/);
  assert.doesNotMatch(plan('SELECT id FROM servers ORDER BY sort_order,id'), /TEMP B-TREE/);
});

test('settings scopes fetch only required groups and saving one group preserves other cached groups', async () => {
  const db = database();
  await migrateSettings(db);
  // Use a fresh binding so no group payload is already cached.
  const cold = { ...db };
  await loadSettingsScope(cold, 'monitoring');
  const query = db.calls.findLast(call => call.sql.startsWith('SELECT key,value FROM settings'));
  assert.deepEqual(query.args.sort(), ['settings.monitoring', 'settings.schema'].sort());
  await loadSettingsScope(cold, 'notifications');
  await saveSettings(cold, { username: 'owner' });
  const start = db.calls.length;
  await loadSettingsScope(cold, 'notifications');
  assert.equal(db.calls.length, start, 'unrelated cached groups remain usable');
  assert.equal(JSON.parse(db.store.get('settings.account')).username, 'owner');
});

test('settings database guards reject malformed groups and failed access reads cannot reuse a pre-save public policy', async () => {
  const db = database();
  await migrateSettings(db);
  assert.throws(() => db.sqlite.prepare("UPDATE settings SET value='[]' WHERE key='settings.monitoring'").run(), /JSON object/);
  assert.throws(() => db.sqlite.prepare("INSERT INTO settings(key,value) VALUES(NULL,'{}')").run(), /constraint|JSON object/i);
  await saveSettings(db, { is_public: 'true' });
  await loadSettingsScope(db, 'access');
  await saveSettings(db, { is_public: 'false' });
  db.failed = true;
  await assert.rejects(loadSettingsScope(db, 'access'), error => error.code === 503);
});

test('global notification state migrates independently and unchanged state saves write no rows', async () => {
  const db = makeD1({ settings: { alert_state: { a: true }, resource_alert_state: { signature: 'rule', servers: { a: { status: 'active' } } } } });
  await ensureNotificationStateSchema(db);
  assert.equal(db.store.has('alert_state'), false);
  assert.equal(db.store.has('resource_alert_state'), false);
  assert.deepEqual(JSON.parse((await readNotificationRuntimeState(db, 'alert_state')).value), { a: true });
  const start = db.writes.length;
  await saveNotificationRuntimeState(db, 'alert_state', { a: true });
  assert.equal(changesSince(db, start).length, 0);
  await saveNotificationRuntimeState(db, 'alert_state', { a: true, b: true });
  assert.equal(changesSince(db, start).length, 1);
});

test('traffic notification leases exclude a concurrent sender, expire, and reject a previous owner', async () => {
  const db = database();
  const input = { used: 900, threshold: 80, limit: 1, resetFactor: 0.5 };
  const first = await claimTrafficNotification(db, id, input, 1000);
  assert.ok(first.token);
  assert.equal((await claimTrafficNotification(db, id, input, 1001)).token, null);
  const next = await claimTrafficNotification(db, id, input, 121001);
  assert.ok(next.token);
  assert.notEqual(next.token, first.token);
  assert.equal(await finishTrafficNotification(db, id, first.token, { u: 900, th: 80, lim: 1 }), false);
  assert.equal(await finishTrafficNotification(db, id, next.token, { u: 900, th: 80, lim: 1 }), true);
  assert.equal((await claimTrafficNotification(db, id, input, 130000)).token, null, 'successful delivery suppresses stale callers');
  assert.equal(await resetTrafficNotification(db, id, '{"u":901,"th":80,"lim":1}', 130000), false);
  assert.equal(await resetTrafficNotification(db, id, '{"u":900,"th":80,"lim":1}', 130000), true);
});

test('concurrent traffic evaluations send once and failed delivery releases its lease for retry', async () => {
  const db = database({ traffic_limit: '1' });
  await saveSettings(db, { traffic_alert_threshold: 80, notification_webhook_enabled: 'true', notification_webhook_url: 'https://example.invalid' });
  await ensureServerSchema(db);
  const original = NotificationService.sendNotification;
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let sends = 0;
  let started;
  const start = new Promise(resolve => { started = resolve; });
  NotificationService.sendNotification = async () => { sends++; started(); await waiting; return 'failed'; };
  try {
    const server = current(db);
    const metrics = { net_rx_monthly: 1024 ** 3, net_tx_monthly: 0 };
    const first = NotificationService.evaluateTrafficAlert({ DB: db }, server, metrics);
    await Promise.race([start, first.then(() => { throw new Error('Expected the sender to reach the network boundary'); })]);
    await NotificationService.evaluateTrafficAlert({ DB: db }, server, metrics);
    assert.equal(sends, 1);
    release();
    await first;
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM server_notification_state').get().n, 0);
    NotificationService.sendNotification = async () => { sends++; return undefined; };
    await NotificationService.evaluateTrafficAlert({ DB: db }, server, metrics);
    assert.equal(sends, 2);
    assert.equal(JSON.parse(current(db).traffic_alert_state).th, 80);
  } finally { release(); NotificationService.sendNotification = original; }
});

test('an Agent configuration cold read still resets the previous traffic period before usage reaches the threshold', async () => {
  clearServersListCache();
  const db = database({ traffic_limit: '1', traffic_alert_state: '{"u":900000000,"th":80,"lim":1}' });
  await saveSettings(db, { traffic_alert_threshold: 80, notification_webhook_enabled: 'true', notification_webhook_url: 'https://example.invalid' });
  const server = await getServerDetail(db, id, true, { scope: 'agent' });
  assert.equal(server.traffic_alert_state, undefined);
  await NotificationService.evaluateTrafficAlert({ DB: db }, server, { net_rx_monthly: 0, net_tx_monthly: 0 });
  assert.equal(current(db).traffic_alert_state, null);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM server_notification_state').get().n, 0);
});

test('concurrent cold bindings complete the ordered migrations without losing credentials or overrides', async () => {
  const db = database({ custom_ct: '0', offline_notify_disabled: '1', traffic_alert_percent: 0, secret: 'agent-secret' });
  const other = { ...db };
  await Promise.all([ensureServerSchema(db), ensureServerSchema(other), migrateSettings(db), migrateSettings(other)]);
  assert.equal(current(db).custom_ct, '0');
  assert.equal(current(db).offline_notify_disabled, '1');
  assert.equal(current(db).traffic_alert_percent, 0);
  assert.equal(current(db).secret, 'agent-secret');
  assert.equal(JSON.parse(db.store.get('settings.security')).jwt_secret, 'x'.repeat(32));
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE component='servers'").get().n, 3);
});

test('an existing creation-time column absorbs the legacy timestamp and preserves its value', async () => {
  const db = makeD1({ servers: [{ id, timestamp: 123, created_at: 0 }], legacyColumns: { created_at: 'INTEGER DEFAULT 0' } });
  db.sqlite.exec('CREATE INDEX idx_old_created ON servers(timestamp)');
  await ensureServerSchema(db);
  assert.equal(current(db).created_at, 123);
  assert.equal(current(db).timestamp, 123);
  assert.equal(db.sqlite.prepare('PRAGMA table_info(servers)').all().some(column => column.name === 'timestamp'), false);
});
