import { AppError } from '../../utils/errors.js';
import { applyMigration, migrationRecord, migrationVersion } from '../SchemaMigrations.js';
import { migrateLegacyServerSchema } from './legacyServers.js';
import { SERVER_CORE_COLUMNS, SERVER_PING_COLUMNS, SERVER_NOTIFICATION_COLUMNS, CHILD_TABLES, BOOLEAN_COLUMNS,
  quote, columnsSql, childDdl, detailsView, coreValidationTriggers } from '../serverSchema.js';

export const SERVER_SCHEMA_VERSION = 3;
const columns = async (db, table) => (await db.prepare(`PRAGMA table_info(${quote(table)})`).all()).results || [];
const boolSql = field => `CASE WHEN lower(trim(CAST(${field} AS TEXT))) IN ('1','1.0','true','yes','on') THEN 1 ELSE 0 END`;
const integerSql = (field, fallback, allowed) => `CASE WHEN CAST(${field} AS INTEGER) IN (${allowed.join(',')}) THEN CAST(${field} AS INTEGER) ELSE ${fallback} END`;
const defaultSql = type => type.match(/ DEFAULT ('(?:[^']|'')*'|NULL|-?[\d.]+)/)?.[1] || 'NULL';
const marker = db => db.prepare("INSERT INTO settings(key,value) VALUES('schema.servers','{\"version\":3}') ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value");

async function indexes(db) {
  const rows = (await db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='servers' AND sql IS NOT NULL").all()).results || [];
  for (const row of rows) row.columns = (await db.prepare(`PRAGMA index_info(${quote(row.name)})`).all()).results.map(field => field.name);
  return rows;
}

async function canonicalStatements(db) {
  const fields = await columns(db, 'servers');
  const existing = new Set(fields.map(field => field.name));
  const statements = [db.prepare('DROP VIEW IF EXISTS server_details'), db.prepare('DROP TRIGGER IF EXISTS servers_initialize_config')];
  const replacing = BOOLEAN_COLUMNS.filter(name => !/^INTEGER$/i.test(fields.find(field => field.name === name)?.type || ''));
  const dropTimestamp = existing.has('created_at') && existing.has('timestamp');
  const affected = (await indexes(db)).filter(index => index.columns.some(name => replacing.includes(name) || (dropTimestamp && name === 'timestamp')));
  for (const index of affected) statements.push(db.prepare(`DROP INDEX ${quote(index.name)}`));
  if (!existing.has('created_at')) {
    if (existing.has('timestamp')) statements.push(db.prepare('ALTER TABLE servers RENAME COLUMN timestamp TO created_at'));
    else statements.push(db.prepare(`ALTER TABLE servers ADD COLUMN created_at ${SERVER_CORE_COLUMNS.created_at}`));
  } else if (dropTimestamp) {
    statements.push(db.prepare('UPDATE servers SET created_at=COALESCE(NULLIF(created_at,0),timestamp,0) WHERE COALESCE(created_at,0)=0 AND timestamp>0'),
      db.prepare('ALTER TABLE servers DROP COLUMN timestamp'));
  }
  for (const name of ['updated_at', 'revision']) if (!existing.has(name)) statements.push(db.prepare(`ALTER TABLE servers ADD COLUMN ${name} ${SERVER_CORE_COLUMNS[name]}`));
  for (const name of replacing) {
    const old = quote(`_legacy_${name}`);
    statements.push(db.prepare(`ALTER TABLE servers RENAME COLUMN ${quote(name)} TO ${old}`),
      db.prepare(`ALTER TABLE servers ADD COLUMN ${quote(name)} ${SERVER_CORE_COLUMNS[name]}`),
      db.prepare(`UPDATE servers SET ${quote(name)}=${boolSql(old)} WHERE ${quote(name)} IS NOT (${boolSql(old)})`),
      db.prepare(`ALTER TABLE servers DROP COLUMN ${old}`));
  }
  const normalized = {
    reset_day: 'CASE WHEN CAST(reset_day AS INTEGER) BETWEEN 0 AND 31 THEN CAST(reset_day AS INTEGER) ELSE 1 END',
    collect_interval: integerSql('collect_interval', 0, [0, 1, 2, 5, 10]),
    report_interval: integerSql('report_interval', 60, [30, 60, 120, 180]),
    wss_report_interval: integerSql('wss_report_interval', 2, [1, 2, 3, 4, 5]),
    connection_mode: "CASE WHEN connection_mode IN ('auto','http') THEN connection_mode ELSE 'auto' END",
    sort_order: 'max(0, CAST(COALESCE(sort_order,0) AS INTEGER))', created_at: 'max(0, CAST(COALESCE(created_at,0) AS INTEGER))',
    updated_at: 'max(0, CAST(CASE WHEN updated_at>0 THEN updated_at ELSE COALESCE(created_at,0) END AS INTEGER))',
    revision: 'max(0, CAST(COALESCE(revision,0) AS INTEGER))'
  };
  for (const name of BOOLEAN_COLUMNS) normalized[name] = boolSql(quote(name));
  for (const name of ['rx_correction', 'tx_correction']) normalized[name] = `CASE WHEN typeof(${name}) IN ('integer','real') AND ${name} BETWEEN 0 AND 1000000 THEN ${name} ELSE NULL END`;
  for (const [name, type] of Object.entries(SERVER_CORE_COLUMNS)) {
    if (type.startsWith('TEXT NOT NULL')) normalized[name] = `COALESCE(${quote(name)}, ${defaultSql(type)})`;
  }
  statements.push(db.prepare(`UPDATE servers SET ${Object.entries(normalized).map(([name, sql]) => `${quote(name)}=${sql}`).join(', ')}
    WHERE ${Object.entries(normalized).map(([name, sql]) => `${quote(name)} IS NOT (${sql})`).join(' OR ')}`));
  for (const [table, definition] of Object.entries(CHILD_TABLES)) statements.push(db.prepare(childDdl(table, definition, `_next_${table}`)));

  const ping = Object.keys(SERVER_PING_COLUMNS).map(name => name === 'ping_mode'
    ? "CASE WHEN ping_mode='icmp' THEN 'icmp' ELSE 'tcp' END AS ping_mode"
    : `CASE WHEN ${quote(name)} IS NULL OR trim(${quote(name)})='' THEN NULL WHEN trim(${quote(name)}) IN ('0','0.0') THEN '0' ELSE trim(${quote(name)}) END AS ${quote(name)}`);
  statements.push(db.prepare(`INSERT INTO _next_server_ping_settings(server_id,${Object.keys(SERVER_PING_COLUMNS).map(quote).join(',')})
    SELECT * FROM (SELECT server_id,${ping.join(',')} FROM server_ping_settings)
    WHERE ping_mode<>'tcp' OR ${Object.keys(SERVER_PING_COLUMNS).filter(name => name !== 'ping_mode').map(name => `${quote(name)} IS NOT NULL`).join(' OR ')}`));
  statements.push(db.prepare(`INSERT INTO _next_server_notification_settings(server_id,offline_notify_disabled,traffic_alert_percent)
    SELECT * FROM (SELECT server_id,${boolSql('offline_notify_disabled')} AS disabled,
      CASE WHEN trim(CAST(traffic_alert_percent AS TEXT)) GLOB '[0-9]*' OR trim(CAST(traffic_alert_percent AS TEXT)) GLOB '-[0-9]*'
      THEN max(0,min(100,CAST(traffic_alert_percent AS INTEGER))) ELSE NULL END AS threshold FROM server_notification_settings)
    WHERE disabled<>0 OR threshold IS NOT NULL`));
  const rawState = "CASE WHEN json_valid(traffic_alert_state) THEN traffic_alert_state ELSE '{}' END";
  statements.push(db.prepare(`INSERT INTO _next_server_notification_state(server_id,traffic_used_bytes,traffic_threshold,traffic_limit_gb)
    SELECT server_id,CAST(round(json_extract(${rawState},'$.u')) AS INTEGER),
      max(0,min(100,CAST(COALESCE(json_extract(${rawState},'$.th'),0) AS INTEGER))),CAST(json_extract(${rawState},'$.lim') AS REAL)
    FROM server_notification_state WHERE json_type(${rawState},'$.u') IN ('integer','real') AND round(json_extract(${rawState},'$.u'))>0
      AND CAST(json_extract(${rawState},'$.lim') AS REAL)>0`));
  for (const table of Object.keys(CHILD_TABLES)) statements.push(db.prepare(`DROP TABLE ${quote(table)}`), db.prepare(`ALTER TABLE ${quote(`_next_${table}`)} RENAME TO ${quote(table)}`));
  for (const index of affected) if (!dropTimestamp || !index.columns.includes('timestamp')) statements.push(db.prepare(index.sql));
  const extensions = [...existing].filter(name => !(name in SERVER_CORE_COLUMNS) && name !== 'timestamp');
  statements.push(db.prepare(detailsView(extensions)));
  for (const sql of coreValidationTriggers()) statements.push(db.prepare(sql));
  return statements;
}

async function indexStatements(db) {
  const current = await indexes(db);
  const needed = [['idx_servers_name', ['name']], ['idx_servers_sort', ['sort_order', 'id']]];
  return needed.filter(([, names]) => !current.some(index => names.every((name, i) => index.columns[i] === name)))
    .map(([name, names]) => db.prepare(`CREATE INDEX IF NOT EXISTS ${name} ON servers(${names.map(quote).join(',')})`));
}

export async function migrateServerConfiguration(db) {
  let version = await migrationVersion(db, 'servers', SERVER_SCHEMA_VERSION);
  if (version === SERVER_SCHEMA_VERSION) return { success: true, removedColumns: [], version };
  const existing = await columns(db, 'servers');
  if (!existing.length) {
    await db.batch([
      db.prepare('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY NOT NULL, value TEXT)'),
      db.prepare(`CREATE TABLE servers(${columnsSql(SERVER_CORE_COLUMNS)})`),
      ...Object.entries(CHILD_TABLES).map(([table, definition]) => db.prepare(childDdl(table, definition))),
      db.prepare(detailsView()), ...coreValidationTriggers().map(sql => db.prepare(sql)),
      db.prepare('CREATE INDEX idx_servers_name ON servers(name)'), db.prepare('CREATE INDEX idx_servers_sort ON servers(sort_order,id)'), marker(db),
      ...[[1, 'separate-server-settings'], [2, 'sparse-settings-and-constraints'], [3, 'query-indexes']].map(([v, name]) => migrationRecord(db, 'servers', v, name))
    ]);
    return { success: true, removedColumns: [], version: SERVER_SCHEMA_VERSION };
  }
  const invalidId = await db.prepare("SELECT 1 AS invalid FROM servers WHERE id IS NULL OR length(trim(id))=0 LIMIT 1").first();
  if (invalidId) throw new AppError('Cannot migrate a server with an empty ID', 503);
  let removedColumns = [];
  if (version < 1) {
    const record = migrationRecord(db, 'servers', 1, 'separate-server-settings');
    const result = await migrateLegacyServerSchema(db, [record]);
    // Already-separated v2 databases take the legacy migration's fast path.
    if (!result.recorded) await record.run();
    removedColumns = result.removedColumns;
    version = 1;
  }
  if (version < 2) await applyMigration(db, 'servers', 2, 'sparse-settings-and-constraints', await canonicalStatements(db));
  await applyMigration(db, 'servers', 3, 'query-indexes', [...await indexStatements(db), marker(db)]);
  return { success: true, removedColumns, version: SERVER_SCHEMA_VERSION };
}
