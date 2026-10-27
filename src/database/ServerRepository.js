import { AppError } from '../utils/errors.js';
import { migrateServerConfiguration } from './migrations/serverConfiguration.js';
import { SERVER_CORE_COLUMNS, SERVER_PING_COLUMNS, SERVER_NOTIFICATION_COLUMNS, BOOLEAN_COLUMNS,
  PING_DEFAULTS, NOTIFICATION_DEFAULTS, quote, coreProjection } from './serverSchema.js';
export { SERVER_CORE_COLUMNS, SERVER_PING_COLUMNS, SERVER_NOTIFICATION_COLUMNS } from './serverSchema.js';
export { OBSOLETE_SERVER_COLUMNS } from './migrations/legacyServers.js';

const initialized = new WeakMap();
export function ensureServerSchema(db) {
  if (initialized.has(db)) return initialized.get(db);
  const promise = (async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await migrateServerConfiguration(db); }
      catch (error) {
        if (attempt >= 3 || !/no such column|duplicate column name|already exists|no such index|no such table: _next_/i.test(error.message)) throw error;
      }
    }
  })();
  initialized.set(db, promise);
  promise.catch(() => { if (initialized.get(db) === promise) initialized.delete(db); });
  return promise;
}

const flag = value => [true, 1, '1', 'true'].includes(value) ? 1 : 0;
export const normalizeProbeOverride = value => value === null || value === undefined || String(value).trim() === ''
  ? null : Number(value) === 0 ? '0' : String(value).trim();
const literal = value => value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${value.replaceAll("'", "''")}'`;

function changedUpdate(db, table, idColumn, id, fields) {
  const names = Object.keys(fields);
  if (!names.length) return null;
  const values = names.map(name => fields[name]);
  const references = Object.fromEntries(names.map((name, i) => [name, `?${i + 1}`]));
  const now = `?${values.push(Date.now())}`;
  const recordId = `?${values.push(id)}`;
  return db.prepare(`UPDATE ${table} SET ${names.map(name => `${quote(name)}=${references[name]}`).join(',')}, updated_at=${now}, revision=revision+1
    WHERE ${idColumn}=${recordId} AND (${names.map(name => `${quote(name)} IS NOT ${references[name]}`).join(' OR ')})`).bind(...values);
}

function sparsePatch(db, table, id, patch, defaults) {
  const names = Object.keys(patch);
  if (!names.length) return [];
  const values = names.map(name => patch[name]);
  const references = Object.fromEntries(names.map((name, i) => [name, `?${i + 1}`]));
  const recordId = `?${values.push(id)}`;
  const now = `?${values.push(Date.now())}`;
  const isDefault = Object.entries(defaults).map(([name, fallback]) => `(${references[name] || quote(name)}) IS ${literal(fallback)}`).join(' AND ');
  const nonDefault = names.map(name => `${references[name]} IS NOT ${literal(defaults[name])}`).join(' OR ');
  // Deleting an override restores defaults in one write. No empty child row is created.
  return [
    db.prepare(`DELETE FROM ${table} WHERE server_id=${recordId} AND ${isDefault}`).bind(...values.slice(0, -1)),
    db.prepare(`INSERT INTO ${table}(server_id,${names.map(quote).join(',')},updated_at,revision)
      SELECT ${recordId},${names.map(name => references[name]).join(',')},${now},1
      WHERE (${nonDefault}) OR EXISTS(SELECT 1 FROM ${table} WHERE server_id=${recordId})
      ON CONFLICT(server_id) DO UPDATE SET ${names.map(name => `${quote(name)}=excluded.${quote(name)}`).join(',')},
        updated_at=excluded.updated_at, revision=${table}.revision+1
      WHERE ${names.map(name => `${table}.${quote(name)} IS NOT excluded.${quote(name)}`).join(' OR ')}`).bind(...values)
  ];
}

export function parseStoredTrafficState(value) {
  try {
    const state = typeof value === 'string' ? JSON.parse(value) : value;
    if (state && Number.isFinite(state.u) && Math.round(state.u) > 0 && Number.isFinite(Number(state.lim)) && Number(state.lim) > 0) {
      return { u: Math.round(state.u), th: Math.max(0, Math.min(100, Math.trunc(Number(state.th) || 0))), lim: Number(state.lim) };
    }
  } catch { /* Invalid legacy state behaves as an unset notification. */ }
  return null;
}

export async function writeServer(db, server, { create = false } = {}) {
  await ensureServerSchema(db);
  const fields = {};
  for (const name of Object.keys(SERVER_CORE_COLUMNS)) {
    if (name === 'id' || ['updated_at', 'revision', 'created_at'].includes(name) || server[name] === undefined) continue;
    fields[name] = BOOLEAN_COLUMNS.includes(name) ? flag(server[name]) : server[name];
  }
  const statements = [];
  if (create) {
    fields.created_at = server.created_at ?? server.timestamp ?? Date.now();
    fields.updated_at = server.updated_at ?? fields.created_at;
    fields.revision = server.revision ?? 0;
    const names = ['id', ...Object.keys(fields)];
    statements.push(db.prepare(`INSERT INTO servers(${names.map(quote).join(',')}) VALUES(${names.map(() => '?').join(',')})`)
      .bind(server.id, ...Object.values(fields)));
  } else {
    const statement = changedUpdate(db, 'servers', 'id', server.id, fields);
    if (statement) statements.push(statement);
  }
  const ping = Object.fromEntries(Object.keys(SERVER_PING_COLUMNS).filter(name => server[name] !== undefined)
    .map(name => [name, name === 'ping_mode' ? server[name] || 'tcp' : normalizeProbeOverride(server[name])]));
  const notifications = Object.fromEntries(Object.keys(SERVER_NOTIFICATION_COLUMNS).filter(name => server[name] !== undefined)
    .map(name => [name, name === 'offline_notify_disabled' ? flag(server[name]) : server[name]]));
  statements.push(...sparsePatch(db, 'server_ping_settings', server.id, ping, PING_DEFAULTS),
    ...sparsePatch(db, 'server_notification_settings', server.id, notifications, NOTIFICATION_DEFAULTS));
  if (create && server.traffic_alert_state !== undefined) {
    const state = parseStoredTrafficState(server.traffic_alert_state);
    if (state) statements.push(db.prepare(`INSERT INTO server_notification_state(server_id,traffic_used_bytes,traffic_threshold,traffic_limit_gb)
      VALUES(?,?,?,?)`).bind(server.id, state.u, state.th, state.lim));
  }
  if (statements.length) await db.batch(statements);
}

const PUBLIC_COLUMNS = Object.keys(SERVER_CORE_COLUMNS).filter(name => !['secret', 'note', 'auto_update'].includes(name));
const AGENT_COLUMNS = ['id', 'name', 'region', 'secret', 'traffic_limit', 'traffic_calc_type', 'interface', 'reset_day', 'collect_interval',
  'report_interval', 'wss_report_interval', 'connection_mode', 'rx_correction', 'tx_correction'];
const SCOPES = Object.freeze({
  public: { columns: PUBLIC_COLUMNS, ping: true },
  admin: { columns: Object.keys(SERVER_CORE_COLUMNS).filter(name => name !== 'secret'), ping: true, notifications: true },
  agent: { columns: AGENT_COLUMNS, ping: true, notifications: true },
  identity: { columns: ['id', 'is_hidden'] },
  offline: { columns: ['id', 'name'], offline: true },
  resource: { columns: ['id', 'name'] },
  expiry: { columns: ['id', 'name', 'price', 'billing_cycle', 'auto_renewal', 'expire_date'] }
});
export function serverQuery(scope = 'full', detail = false) {
  if (scope === 'full') return `SELECT * FROM server_details ${detail ? 'WHERE id=?' : 'ORDER BY sort_order,id'}`;
  const options = SCOPES[scope];
  if (!options) throw new AppError('Unknown server query scope', 500);
  const selected = [coreProjection('s', options.columns)];
  const joins = [];
  if (options.columns.includes('created_at')) selected.push('s.created_at AS timestamp');
  if (options.ping) {
    joins.push('LEFT JOIN server_ping_settings p ON p.server_id=s.id');
    selected.push("COALESCE(p.ping_mode,'tcp') AS ping_mode", ...Object.keys(SERVER_PING_COLUMNS).filter(name => name !== 'ping_mode').map(name => `p.${name}`));
  }
  if (options.notifications || options.offline) {
    joins.push('LEFT JOIN server_notification_settings c ON c.server_id=s.id');
    selected.push('CAST(COALESCE(c.offline_notify_disabled,0) AS TEXT) AS offline_notify_disabled');
    if (options.notifications) selected.push('c.traffic_alert_percent');
  }
  return `SELECT ${selected.join(',')} FROM servers s ${joins.join(' ')} ${detail ? 'WHERE s.id=?' : 'ORDER BY s.sort_order,s.id'}`;
}

export async function deleteServer(db, id) {
  await ensureServerSchema(db);
  await db.prepare('DELETE FROM servers WHERE id=?').bind(id).run();
}
