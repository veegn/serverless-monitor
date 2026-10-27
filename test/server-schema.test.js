import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './helpers/d1.js';
import { ensureServerSchema, writeServer, deleteServer, SERVER_CORE_COLUMNS, SERVER_PING_COLUMNS, SERVER_NOTIFICATION_COLUMNS } from '../src/database/ServerRepository.js';
import { getAllServers, getServerDetail, clearServersListCache } from '../src/utils/cache.js';
import { AdminController } from '../src/handlers/AdminController.js';
import { UpdateController } from '../src/handlers/UpdateController.js';
import { NotificationService } from '../src/services/NotificationService.js';
import { generateToken } from '../src/middleware/auth.js';

const id = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const row = (db, table, serverId = id) => ({ ...db.sqlite.prepare(`SELECT * FROM ${table} WHERE ${table === 'servers' || table === 'server_details' ? 'id' : 'server_id'}=?`).get(serverId) });

test('server migration separates Ping, notification configuration and notification runtime state', async () => {
  const state = JSON.stringify({ u: 100, th: 80, lim: 10 });
  const db = makeD1({ servers: [{ id, name: 'Node', ping_mode: 'icmp', custom_ct: '0', custom_cu: null,
    custom_cm: '', custom_bd: 'example.com:443', node_1: '1.1.1.1:443', node_2: '0',
    offline_notify_disabled: '1', traffic_alert_percent: 0, traffic_alert_state: state, history_partition_id: 9,
    price: '10', currency: '$', secret: 'node-secret', timestamp: 123, rx_correction: 10 }],
    legacyColumns: { cpu: 'REAL', net_rx: 'REAL', ram_percent: 'REAL', kernel_version: 'TEXT', agent_version: 'TEXT',
      traffic_snapshots: 'TEXT', custom_extension: 'TEXT' } });
  db.sqlite.exec('CREATE UNIQUE INDEX idx_history_partition ON servers(history_partition_id); CREATE INDEX idx_cpu ON servers(cpu)');
  db.sqlite.exec("UPDATE servers SET cpu=30, net_rx=99, traffic_snapshots='[]', custom_extension='keep'");
  await ensureServerSchema(db);
  const columns = db.sqlite.prepare('PRAGMA table_info(servers)').all().map(field => field.name);
  assert.deepEqual(columns.sort(), [...Object.keys(SERVER_CORE_COLUMNS), 'custom_extension'].sort());
  const ping = row(db, 'server_ping_settings');
  assert.equal(ping.ping_mode, 'icmp');
  assert.equal(ping.custom_ct, '0');
  assert.equal(ping.custom_cu, null);
  assert.equal(ping.custom_cm, null);
  assert.equal(ping.node_1, '1.1.1.1:443');
  assert.equal(ping.node_2, '0');
  assert.equal(row(db, 'server_notification_settings').traffic_alert_percent, 0);
  assert.equal(row(db, 'server_notification_settings').offline_notify_disabled, 1);
  assert.equal(row(db, 'server_details').traffic_alert_state, state);
  const joined = row(db, 'server_details');
  assert.equal(joined.secret, 'node-secret');
  assert.equal(joined.timestamp, 123);
  assert.equal(joined.rx_correction, 10);
  assert.equal(joined.custom_extension, 'keep');
  assert.equal(joined.cpu, undefined);
  assert.equal(joined.history_partition_id, undefined);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('idx_cpu', 'idx_history_partition')").get().count, 0);
  const writes = db.writes.length;
  const newBinding = { ...db };
  await ensureServerSchema(newBinding);
  assert.equal(db.writes.length, writes, 'later cold starts only check the completed schema');
});

test('failed server migration leaves original columns and values intact and can be retried', async () => {
  const db = makeD1({ servers: [{ id, custom_ct: '0', traffic_alert_percent: null }] });
  db.sqlite.exec('CREATE TABLE server_notification_settings (server_id TEXT PRIMARY KEY)');
  await assert.rejects(ensureServerSchema(db), /no column named/);
  assert.equal(row(db, 'servers').custom_ct, '0');
  assert.equal(db.store.has('schema.servers'), false);
  assert.equal(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='server_ping_settings'").get(), undefined);
  db.sqlite.exec('DROP TABLE server_notification_settings');
  await ensureServerSchema(db);
  assert.equal(row(db, 'server_ping_settings').custom_ct, '0');
  assert.equal(row(db, 'server_details').traffic_alert_percent, null);
});

test('very old billing data is normalized while core settings and independent defaults are initialized', async () => {
  const db = makeD1();
  db.sqlite.exec("DROP TABLE servers; CREATE TABLE servers (id TEXT PRIMARY KEY, name TEXT, price TEXT); INSERT INTO servers VALUES ('old', 'Legacy', '$12/year')");
  await ensureServerSchema(db);
  const server = row(db, 'server_details', 'old');
  assert.equal(server.price, '12.00');
  assert.equal(server.currency, '$');
  assert.equal(server.billing_cycle, 'year');
  assert.equal(server.report_interval, 60);
  assert.equal(server.ping_mode, 'tcp');
  assert.equal(server.traffic_alert_percent, null);
});

test('new servers store overrides only and deletion cascades without orphan settings', async () => {
  const db = makeD1();
  await writeServer(db, { id, name: 'New', custom_ct: '0', traffic_alert_percent: 0 }, { create: true });
  assert.equal(row(db, 'server_details').custom_ct, '0');
  assert.equal(row(db, 'server_details').traffic_alert_state, null);
  await deleteServer(db, id);
  for (const table of ['servers', 'server_ping_settings', 'server_notification_settings', 'server_notification_state']) {
    assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
  }
});

test('configuration initializes on an empty database before the first admin server insert', async () => {
  const db = makeD1();
  db.sqlite.exec('DROP TABLE servers; DROP TABLE settings');
  const sys = { jwt_secret: 'x'.repeat(32) };
  const token = await generateToken({}, sys);
  const response = await AdminController.handleAdminAPI(new Request('https://monitor.test/admin/api', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'add', name: 'First node' })
  }), { DB: db }, sys);
  assert.equal(response.status, 200);
  const created = await response.json();
  assert.equal(row(db, 'server_details', created.id).name, 'First node');
  assert.equal(row(db, 'server_details', created.id).sort_order, 0);
  assert.equal(row(db, 'server_details', created.id).traffic_alert_percent, null);
});

test('server changes across parent and child tables commit or roll back together', async () => {
  const db = makeD1({ servers: [{ id, name: 'Old', custom_ct: 'old.example:443', offline_notify_disabled: '0' }] });
  await ensureServerSchema(db);
  db.sqlite.exec("CREATE TRIGGER reject_notification BEFORE INSERT ON server_notification_settings BEGIN SELECT RAISE(ABORT, 'settings fault'); END");
  await assert.rejects(writeServer(db, { id, name: 'New', custom_ct: 'new.example:443', offline_notify_disabled: '1' }), /settings fault/);
  assert.equal(row(db, 'servers').name, 'Old');
  assert.equal(row(db, 'server_ping_settings').custom_ct, 'old.example:443');
  const newId = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  await assert.rejects(writeServer(db, { id: newId, name: 'New', offline_notify_disabled: '1' }, { create: true }), /settings fault/);
  assert.deepEqual(row(db, 'servers', newId), {});
  assert.deepEqual(row(db, 'server_ping_settings', newId), {});
  db.sqlite.exec('DROP TRIGGER reject_notification');
  await writeServer(db, { id, name: 'New', custom_ct: '0', traffic_alert_percent: null });
  assert.equal(row(db, 'server_details').name, 'New');
  assert.equal(row(db, 'server_details').custom_ct, '0');
  assert.equal(row(db, 'server_details').traffic_alert_percent, null);
});

test('joined read caches are isolated between database bindings', async () => {
  clearServersListCache();
  const first = makeD1({ servers: [{ id, name: 'First', node_1: '0' }] });
  const second = makeD1({ servers: [{ id, name: 'Second', node_1: 'second.example:443' }] });
  assert.equal((await getServerDetail(first, id)).node_1, '0');
  assert.equal((await getServerDetail(second, id)).node_1, 'second.example:443');
  assert.equal((await getAllServers(first))[0].name, 'First');
  assert.equal((await getAllServers(second))[0].name, 'Second');
  const unavailable = makeD1(); unavailable.failed = true;
  await assert.rejects(getAllServers(unavailable), /D1 unavailable/);
});

test('flat admin export/import round trip preserves server configuration and Agent credentials', async () => {
  clearServersListCache();
  const source = makeD1({ servers: [{ id, name: 'Exported', ping_mode: 'icmp', custom_ct: '0', custom_cu: null, node_1: '1.1.1.1:443',
    traffic_alert_percent: 0, offline_notify_disabled: '1', traffic_alert_state: '{"u":99,"th":80,"lim":1}', secret: 'agent-secret', timestamp: 12345 }] });
  const destination = makeD1();
  const sys = { jwt_secret: 'x'.repeat(32) };
  const token = await generateToken({}, sys);
  const call = (db, body) => AdminController.handleAdminAPI(new Request('https://monitor.test/admin/api', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }), { DB: db }, sys);
  const exported = await (await call(source, { action: 'export_servers' })).json();
  assert.equal(exported.servers.length, 1);
  assert.equal(exported.servers[0].history_partition_id, undefined);
  const imported = await (await call(destination, { action: 'import_servers', servers: exported.servers })).json();
  assert.equal(imported.imported, 1);
  const restored = row(destination, 'server_details');
  for (const field of [...Object.keys(SERVER_PING_COLUMNS), ...Object.keys(SERVER_NOTIFICATION_COLUMNS), 'secret', 'timestamp', 'traffic_alert_state']) {
    assert.equal(restored[field], exported.servers[0][field], field);
  }
});

test('automatic registration is independent of the obsolete 900-partition ceiling', async () => {
  clearServersListCache();
  const db = makeD1({ servers: Array.from({ length: 901 }, (_, i) => ({ id: `node-${i}`, name: `Node ${i}` })) });
  const registered = await UpdateController.autoRegisterServer(db, id, { name: 'Node 902' }, 'secret', {}, 'CN');
  assert.equal(registered.serverDetail.name, 'Node 902');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 902);
  assert.equal(row(db, 'server_details').ping_mode, 'tcp');
});

test('traffic alert state persists and resets in its own table with compare-and-set protection', async () => {
  const db = makeD1({ settings: { site_options: { jwt_secret: 'x'.repeat(32), traffic_alert_threshold: 80, tg_bot_token: 'configured' } },
    servers: [{ id, name: 'Traffic', traffic_limit: '1', traffic_alert_percent: null }] });
  await ensureServerSchema(db);
  const send = NotificationService.sendNotification;
  NotificationService.sendNotification = async () => undefined;
  try {
    let state;
    await NotificationService.evaluateTrafficAlert({ DB: db }, row(db, 'server_details'), { net_rx_monthly: 1024 ** 3, net_tx_monthly: 0 }, {
      patchCache(serverId, value) { assert.equal(serverId, id); state = value; }
    });
    assert.equal(row(db, 'server_details').traffic_alert_state, state);
    assert.equal(JSON.parse(state).th, 80);
    assert.equal(row(db, 'servers').traffic_alert_state, undefined);
    const stale = await db.prepare('DELETE FROM server_notification_state WHERE server_id=? AND traffic_used_bytes=?').bind(id, 0).run();
    assert.equal(stale.meta.changes, 0);
    await NotificationService.evaluateTrafficAlert({ DB: db }, row(db, 'server_details'), { net_rx_monthly: 0, net_tx_monthly: 0 });
    assert.equal(row(db, 'server_details').traffic_alert_state, null);
  } finally { NotificationService.sendNotification = send; }
});
