import { ensureServerSchema, parseStoredTrafficState } from './ServerRepository.js';
import { migrationRecord, migrationVersion } from './SchemaMigrations.js';
import { AppError } from '../utils/errors.js';

const initialized = new WeakMap();
const RUNTIME_KEYS = ['alert_state', 'resource_alert_state'];
export function ensureNotificationStateSchema(db) {
  if (initialized.has(db)) return initialized.get(db);
  const promise = (async () => {
    await ensureServerSchema(db);
    if (await migrationVersion(db, 'notification_runtime', 1) === 1) return;
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS notification_runtime_state (
        key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL CHECK (json_valid(value) AND json_type(value)='object'),
        updated_at INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID`),
      ...RUNTIME_KEYS.map(key => db.prepare(`INSERT INTO notification_runtime_state(key,value)
        SELECT key,value FROM settings WHERE key=? AND value IS NOT NULL AND value<>''
        ON CONFLICT(key) DO NOTHING`).bind(key)),
      db.prepare('DELETE FROM settings WHERE key IN (?,?)').bind(...RUNTIME_KEYS),
      migrationRecord(db, 'notification_runtime', 1, 'separate-global-notification-state')
    ]);
  })();
  initialized.set(db, promise);
  promise.catch(() => { if (initialized.get(db) === promise) initialized.delete(db); });
  return promise;
}

export async function readNotificationRuntimeState(db, key) {
  await ensureNotificationStateSchema(db);
  return db.prepare('SELECT value,revision FROM notification_runtime_state WHERE key=?').bind(key).first();
}

export async function saveNotificationRuntimeState(db, key, value) {
  if (!RUNTIME_KEYS.includes(key)) throw new AppError('Invalid notification state key', 400);
  await ensureNotificationStateSchema(db);
  return db.prepare(`INSERT INTO notification_runtime_state(key,value,updated_at,revision) VALUES(?,?,?,1)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,revision=notification_runtime_state.revision+1
    WHERE notification_runtime_state.value IS NOT excluded.value`).bind(key, JSON.stringify(value), Date.now()).run();
}

export async function clearNotificationRuntimeState(db, key) {
  await ensureNotificationStateSchema(db);
  return db.prepare('DELETE FROM notification_runtime_state WHERE key=?').bind(key).run();
}

const decodedState = row => row?.traffic_used_bytes > 0
  ? { u: Number(row.traffic_used_bytes), th: Number(row.traffic_threshold), lim: Number(row.traffic_limit_gb) } : null;

export async function readTrafficNotification(db, serverId) {
  await ensureServerSchema(db);
  return decodedState(await db.prepare('SELECT traffic_used_bytes,traffic_threshold,traffic_limit_gb FROM server_notification_state WHERE server_id=?').bind(serverId).first());
}

export async function resetTrafficNotification(db, serverId, old, now = Date.now()) {
  await ensureServerSchema(db);
  const state = parseStoredTrafficState(old);
  if (!state) return false;
  const result = await db.prepare(`DELETE FROM server_notification_state WHERE server_id=?
    AND traffic_used_bytes=? AND traffic_threshold=? AND traffic_limit_gb=? AND claim_until<=?`)
    .bind(serverId, state.u, state.th, state.lim, now).run();
  return Number(result.meta?.changes) > 0;
}

export async function claimTrafficNotification(db, serverId, { used, threshold, limit, resetFactor }, now = Date.now()) {
  await ensureServerSchema(db);
  const token = crypto.randomUUID();
  const [result, snapshot] = await db.batch([
    db.prepare(`INSERT INTO server_notification_state(server_id,claim_token,claim_until)
      SELECT id,?1,?2 FROM servers WHERE id=?3
      ON CONFLICT(server_id) DO UPDATE SET claim_token=excluded.claim_token,claim_until=excluded.claim_until,revision=revision+1
      WHERE claim_until<=?4 AND (traffic_used_bytes IS NULL OR traffic_threshold IS NOT ?5 OR traffic_limit_gb IS NOT ?6 OR ?7 < traffic_used_bytes * ?8)`)
      .bind(token, now + 120_000, serverId, now, threshold, limit, used, resetFactor),
    db.prepare('SELECT traffic_used_bytes,traffic_threshold,traffic_limit_gb FROM server_notification_state WHERE server_id=?').bind(serverId)
  ]);
  return { token: Number(result.meta?.changes) > 0 ? token : null, state: decodedState(snapshot.results?.[0]) };
}

export async function finishTrafficNotification(db, serverId, token, state) {
  const result = await db.prepare(`UPDATE server_notification_state SET traffic_used_bytes=?,traffic_threshold=?,traffic_limit_gb=?,
    claim_token=NULL,claim_until=0,revision=revision+1 WHERE server_id=? AND claim_token=?`)
    .bind(state.u, state.th, state.lim, serverId, token).run();
  return Number(result.meta?.changes) > 0;
}

export async function releaseTrafficNotification(db, serverId, token) {
  await db.batch([
    db.prepare('DELETE FROM server_notification_state WHERE server_id=? AND claim_token=? AND traffic_used_bytes IS NULL').bind(serverId, token),
    db.prepare('UPDATE server_notification_state SET claim_token=NULL,claim_until=0,revision=revision+1 WHERE server_id=? AND claim_token=?').bind(serverId, token)
  ]);
}
