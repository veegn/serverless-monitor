// Immutable compatibility migration for the original combined servers table.
import { logEvent } from '../../utils/observability.js';
import { detectBillingCycle, detectCurrencySymbol, normalizeBillingCycle, normalizeCurrency, normalizePrice } from '../../utils/serverBilling.js';

export const SERVER_CORE_COLUMNS = Object.freeze({
  id: 'TEXT PRIMARY KEY', name: 'TEXT', server_group: "TEXT DEFAULT 'Default'", region: "TEXT DEFAULT ''",
  tags: "TEXT DEFAULT ''", note: "TEXT DEFAULT ''", price: "TEXT DEFAULT ''", billing_cycle: "TEXT DEFAULT 'month'",
  auto_renewal: "TEXT DEFAULT '0'", currency: "TEXT DEFAULT '¥'", expire_date: "TEXT DEFAULT ''",
  traffic_limit: "TEXT DEFAULT ''", traffic_calc_type: "TEXT DEFAULT 'total'", interface: "TEXT DEFAULT ''",
  reset_day: 'INTEGER DEFAULT 1', collect_interval: 'INTEGER DEFAULT 0', report_interval: 'INTEGER DEFAULT 60',
  wss_report_interval: 'INTEGER DEFAULT 2', connection_mode: "TEXT DEFAULT 'auto'", auto_update: "TEXT DEFAULT '0'",
  rx_correction: 'REAL DEFAULT NULL', tx_correction: 'REAL DEFAULT NULL', is_hidden: "TEXT DEFAULT '0'",
  sort_order: 'INTEGER DEFAULT 0', secret: 'TEXT DEFAULT NULL', timestamp: 'INTEGER DEFAULT 0'
});
export const SERVER_PING_COLUMNS = Object.freeze({ ping_mode: "TEXT DEFAULT 'tcp'",
  custom_ct: "TEXT DEFAULT ''", custom_cu: "TEXT DEFAULT ''", custom_cm: "TEXT DEFAULT ''", custom_bd: "TEXT DEFAULT ''",
  node_1: "TEXT DEFAULT ''", node_2: "TEXT DEFAULT ''", node_3: "TEXT DEFAULT ''", node_4: "TEXT DEFAULT ''" });
export const SERVER_NOTIFICATION_COLUMNS = Object.freeze({ offline_notify_disabled: "TEXT DEFAULT '0'", traffic_alert_percent: 'INTEGER DEFAULT NULL' });
const CHILD_TABLES = Object.freeze({
  server_ping_settings: SERVER_PING_COLUMNS,
  server_notification_settings: SERVER_NOTIFICATION_COLUMNS,
  server_notification_state: { traffic_alert_state: 'TEXT DEFAULT NULL' }
});
export const OBSOLETE_SERVER_COLUMNS = Object.freeze([
  'history_partition_id', 'cpu', 'ram', 'disk', 'load_avg', 'uptime', 'last_updated', 'ram_total', 'net_rx', 'net_tx',
  'net_in_speed', 'net_out_speed', 'os', 'cpu_info', 'cpu_cores', 'gpu', 'gpu_info', 'arch', 'boot_time', 'ram_used',
  'swap_total', 'swap_used', 'disk_total', 'disk_used', 'ram_percent', 'swap_percent', 'disk_percent',
  'kernel_version', 'agent_version', 'processes', 'tcp_conn', 'udp_conn', 'country', 'ip_v4', 'ip_v6',
  'ping_ct', 'ping_cu', 'ping_cm', 'ping_bd', 'ping_node_1', 'ping_node_2', 'ping_node_3', 'ping_node_4',
  'loss_ct', 'loss_cu', 'loss_cm', 'loss_bd', 'loss_node_1', 'loss_node_2', 'loss_node_3', 'loss_node_4',
  'monthly_rx', 'monthly_tx', 'net_rx_monthly', 'net_tx_monthly', 'last_rx', 'last_tx', 'reset_month', 'bandwidth',
  'traffic_snapshots', 'disk_read_bps', 'disk_write_bps', 'disk_read_iops', 'disk_write_iops', 'disk_await_ms', 'disk_util'
]);

const quote = name => `"${name.replaceAll('"', '""')}"`;
const columnsSql = columns => Object.entries(columns).map(([name, definition]) => `${quote(name)} ${definition}`).join(', ');
const defaultSql = definition => definition.match(/ DEFAULT (.+)$/)?.[1] || 'NULL';

export async function migrateLegacyServerSchema(db, completionStatements = []) {
  const { results: columns = [] } = await db.prepare('PRAGMA table_info(servers)').all();
  const existing = new Set(columns.map(column => column.name));
  const moved = Object.values(CHILD_TABLES).flatMap(value => Object.keys(value));
  const removed = [...new Set([...moved, ...OBSOLETE_SERVER_COLUMNS])].filter(name => existing.has(name));
  if (columns.length && !removed.length && Object.keys(SERVER_CORE_COLUMNS).every(name => existing.has(name))) {
    const marker = await db.prepare("SELECT value FROM settings WHERE key = 'schema.servers'").first().catch(error => {
      if (/no such table/i.test(error.message)) return null;
      throw error;
    });
    if (marker?.value === '{"version":2}') return { success: true, removedColumns: [] };
  }
  const statements = [db.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)')];
  if (!columns.length) statements.push(db.prepare(`CREATE TABLE IF NOT EXISTS servers (${columnsSql(SERVER_CORE_COLUMNS)})`));
  else for (const [name, definition] of Object.entries(SERVER_CORE_COLUMNS)) {
    if (!existing.has(name)) statements.push(db.prepare(`ALTER TABLE servers ADD COLUMN ${quote(name)} ${definition}`));
  }
  if (columns.length && !existing.has('billing_cycle') && existing.has('price')) {
    const { results: servers = [] } = await db.prepare('SELECT id, price FROM servers').all();
    for (const server of servers) statements.push(db.prepare('UPDATE servers SET price = ?, billing_cycle = ?, currency = ? WHERE id = ? AND price IS ?')
      .bind(normalizePrice(server.price), normalizeBillingCycle(detectBillingCycle(server.price)),
        normalizeCurrency(detectCurrencySymbol(server.price) || '¥'), server.id, server.price));
  }
  for (const [table, fields] of Object.entries(CHILD_TABLES)) {
    statements.push(db.prepare(`CREATE TABLE IF NOT EXISTS ${table} (
      server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE, ${columnsSql(fields)}
    ) WITHOUT ROWID`));
    const names = Object.keys(fields);
    statements.push(db.prepare(`INSERT INTO ${table} (server_id, ${names.map(quote).join(', ')})
      SELECT id, ${names.map(name => existing.has(name) ? quote(name) : defaultSql(fields[name])).join(', ')} FROM servers WHERE true
      ON CONFLICT(server_id) DO NOTHING`));
  }
  statements.push(db.prepare('DROP VIEW IF EXISTS server_details'));
  if (removed.length) {
    const { results: indexes = [] } = await db.prepare('PRAGMA index_list(servers)').all();
    for (const index of indexes) {
      if (index.origin !== 'c') continue;
      const { results: fields = [] } = await db.prepare(`PRAGMA index_info(${quote(index.name)})`).all();
      if (fields.some(field => removed.includes(field.name))) statements.push(db.prepare(`DROP INDEX ${quote(index.name)}`));
    }
    for (const name of removed) statements.push(db.prepare(`ALTER TABLE servers DROP COLUMN ${quote(name)}`));
  }
  const selected = Object.entries(CHILD_TABLES).flatMap(([table, fields]) => Object.keys(fields).map(name => `${table}.${quote(name)}`));
  statements.push(db.prepare(`CREATE VIEW server_details AS SELECT servers.*, ${selected.join(', ')} FROM servers
    ${Object.keys(CHILD_TABLES).map(table => `LEFT JOIN ${table} ON ${table}.server_id = servers.id`).join('\n')}`));
  statements.push(db.prepare(`CREATE TRIGGER IF NOT EXISTS servers_initialize_config AFTER INSERT ON servers BEGIN
    ${Object.keys(CHILD_TABLES).map(table => `INSERT OR IGNORE INTO ${table} (server_id) VALUES (NEW.id);`).join('\n')}
    END`));
  statements.push(db.prepare("INSERT INTO settings (key, value) VALUES ('schema.servers', '{\"version\":2}') ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value"));
  await db.batch([...statements, ...completionStatements]);
  if (removed.length) logEvent('database', 'database.servers.migrated', 'Server settings separated; obsolete columns removed',
    { removedColumns: removed, pingTable: 'server_ping_settings', notificationTable: 'server_notification_settings' });
  return { success: true, removedColumns: removed, recorded: completionStatements.length > 0 };
}
