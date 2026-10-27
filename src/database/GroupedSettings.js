import { AppError } from '../utils/errors.js';
import { logEvent } from '../utils/observability.js';
import { APPEARANCE_FIELDS, SETTINGS_GROUPS, FIELD_SETTINGS_GROUP } from '../utils/settingFields.js';
import { SITE_SETTINGS_CACHE_TTL_MS, JWT_SECRET_MIN_LENGTH } from '../utils/config.js';
import { migrationVersion, migrationRecord } from './SchemaMigrations.js';

const SCHEMA_KEY = 'settings.schema';
const GROUP_KEYS = Object.keys(SETTINGS_GROUPS);
const FIELDS = Object.keys(FIELD_SETTINGS_GROUP);
const LEGACY_KEYS = ['site_options', 'appearance_options', 'servers_optimized', ...FIELDS];
const READ_KEYS = [...GROUP_KEYS, SCHEMA_KEY, ...LEGACY_KEYS];
const slots = new WeakMap();
const sqlString = value => `'${value.replaceAll("'", "''")}'`;
const appearanceList = APPEARANCE_FIELDS.map(sqlString).join(',');
const jsonToken = alias => `CASE ${alias}.type WHEN 'true' THEN 'true' WHEN 'false' THEN 'false'
  WHEN 'null' THEN 'null' WHEN 'object' THEN ${alias}.value WHEN 'array' THEN ${alias}.value ELSE json_quote(${alias}.value) END`;

function slot(db) {
  if (!slots.has(db)) slots.set(db, { version: 0, groups: new Map(), pending: new Map() });
  return slots.get(db);
}
export function clearGroupedSettingsCache(db, groups = GROUP_KEYS) {
  const state = slot(db);
  state.version++;
  for (const group of groups) state.groups.delete(group);
}
function objectValue(value, key) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new AppError(`Invalid settings group: ${key}`, 503); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AppError(`Invalid settings group: ${key}`, 503);
  return parsed;
}

const readRows = async db => (await db.prepare(`SELECT key, value FROM settings WHERE key IN (${READ_KEYS.map(() => '?').join(',')})`).bind(...READ_KEYS).all()).results || [];

function migrationStatement(db, group, fields, defaults) {
  // Read legacy values inside D1's transaction, rather than copying an earlier
  // JavaScript snapshot over a concurrent settings update. The -> operator keeps
  // JSON booleans, nulls, objects and arrays intact.
  return db.prepare(`WITH fields(name) AS (SELECT value FROM json_each(?2)),
    source(name, encoded) AS (
      SELECT name, COALESCE(
        (SELECT value -> ('$.' || name) FROM settings WHERE key = ?1),
        (SELECT value -> ('$.' || name) FROM settings
          WHERE key = CASE WHEN name IN (${appearanceList}) THEN 'appearance_options' ELSE 'site_options' END),
        (SELECT json_quote(value) FROM settings WHERE key = name), ?3 -> ('$.' || name)) FROM fields
    ), combined(name, encoded) AS (
      SELECT name, encoded FROM source WHERE encoded IS NOT NULL
      UNION ALL SELECT old.key, ${jsonToken('old')} FROM settings, json_each(settings.value) AS old
        WHERE settings.key = ?1 AND old.key NOT IN (SELECT name FROM fields)
    ) INSERT INTO settings (key, value)
      SELECT ?1, json_group_object(name, json(encoded)) FROM combined
      HAVING NOT EXISTS (SELECT 1 FROM settings WHERE key = '${SCHEMA_KEY}')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(group, JSON.stringify(fields), JSON.stringify(defaults));
}

const initialized = new WeakMap();
export function ensureGroupedSettings(db, defaults, attempt = 0) {
  if (initialized.has(db)) return initialized.get(db);
  const promise = (async () => {
    let marker;
    try { marker = await db.prepare("SELECT value FROM settings WHERE key='settings.schema'").first(); }
    catch (error) {
      if (!/no such table: settings/i.test(error.message)) throw error;
      await db.prepare('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY NOT NULL,value TEXT)').run();
    }
    const schema = marker ? objectValue(marker.value, SCHEMA_KEY).version : 0;
    if (![0, 1, 2].includes(schema)) throw new AppError('Unsupported settings storage version', 503);
    const version = await migrationVersion(db, 'settings', 2);
    if (version === 2 && schema === 2) return;
    const statements = [];
    if (!marker) {
      const rows = await readRows(db);
      for (const row of rows) if (GROUP_KEYS.includes(row.key) || ['site_options', 'appearance_options'].includes(row.key)) objectValue(row.value, row.key);
      statements.push(...Object.entries(SETTINGS_GROUPS).map(([group, fields]) => migrationStatement(db, group, fields, defaults)));
    }
    const columns = (await db.prepare('PRAGMA table_info(settings)').all()).results || [];
    for (const field of ['updated_at', 'revision']) if (!columns.some(column => column.name === field)) {
      statements.push(db.prepare(`ALTER TABLE settings ADD COLUMN ${field} INTEGER NOT NULL DEFAULT 0`));
    }
    for (const event of ['INSERT', 'UPDATE']) statements.push(db.prepare(`CREATE TRIGGER IF NOT EXISTS validate_settings_${event.toLowerCase()}
      BEFORE ${event} ON settings WHEN NEW.key IS NULL OR length(trim(NEW.key))=0 OR (NEW.key LIKE 'settings.%' AND
        CASE WHEN json_valid(NEW.value) THEN json_type(NEW.value)<>'object' ELSE 1 END)
      BEGIN SELECT RAISE(ABORT,'Settings group must be a JSON object'); END`));
    statements.push(db.prepare(`INSERT INTO settings(key,value) VALUES('${SCHEMA_KEY}','{"version":2}') ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value`),
      db.prepare(`DELETE FROM settings WHERE key IN (${LEGACY_KEYS.map(() => '?').join(',')})`).bind(...LEGACY_KEYS),
      migrationRecord(db, 'settings', 1, 'functional-settings-groups'), migrationRecord(db, 'settings', 2, 'group-constraints-and-metadata'));
    await db.batch(statements);
    if (!marker) logEvent('database', 'settings.migrated', 'Settings split into functional groups', { groupCount: GROUP_KEYS.length });
  })().catch(async error => {
    if (attempt < 3 && /duplicate column name|already exists/i.test(error.message)) {
      initialized.delete(db);
      return ensureGroupedSettings(db, defaults, attempt + 1);
    }
    throw error;
  });
  initialized.set(db, promise);
  promise.catch(() => { if (initialized.get(db) === promise) initialized.delete(db); });
  return promise;
}

export async function readGroupedSettings(db, defaults, { forceRefresh = false, groups = GROUP_KEYS } = {}) {
  const requested = [...new Set(groups)].sort();
  if (requested.some(group => !SETTINGS_GROUPS[group])) throw new AppError('Unknown settings group', 500);
  await ensureGroupedSettings(db, defaults);
  const state = slot(db);
  const missing = requested.filter(group => forceRefresh || !state.groups.has(group) || state.groups.get(group).expiry <= Date.now());
  if (missing.length) {
    const version = state.version;
    const key = `${version}:${missing.join(',')}`;
    let promise = state.pending.get(key);
    if (!promise) {
      promise = (async () => {
        const keys = [...missing, SCHEMA_KEY];
        const rows = (await db.prepare(`SELECT key,value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`).bind(...keys).all()).results || [];
        const schema = rows.find(row => row.key === SCHEMA_KEY);
        if (!schema || objectValue(schema.value, SCHEMA_KEY).version !== 2) throw new AppError('Unsupported settings storage version', 503);
        const found = new Map(rows.filter(row => missing.includes(row.key)).map(row => [row.key, objectValue(row.value, row.key)]));
        if (found.size !== missing.length) throw new AppError('Incomplete grouped settings', 503);
        if (state.version !== version) return false;
        for (const [group, value] of found) state.groups.set(group, { value, expiry: Date.now() + SITE_SETTINGS_CACHE_TTL_MS });
        return true;
      })();
      state.pending.set(key, promise);
    }
    let current;
    try { current = await promise; }
    finally { if (state.pending.get(key) === promise) state.pending.delete(key); }
    if (!current) return readGroupedSettings(db, defaults, { groups: requested, forceRefresh: true });
  }
  const values = {};
  for (const group of requested) {
    const value = state.groups.get(group).value;
    for (const field of SETTINGS_GROUPS[group]) if (value[field] !== undefined) values[field] = value[field];
  }
  return values;
}

// Patch supplied top-level fields against the live row, preserving JSON nulls.
function updateStatement(db, group, patch) {
  return db.prepare(`INSERT INTO settings(key,value,updated_at,revision) VALUES(?1,?2,?3,1)
    ON CONFLICT(key) DO UPDATE SET value=(
      SELECT json_group_object(name,json(encoded)) FROM (
        SELECT field.key AS name,excluded.value -> ('$.' || field.key) AS encoded FROM json_each(excluded.value) field
        UNION ALL SELECT old.key,${jsonToken('old')} FROM json_each(settings.value) old
          WHERE old.key NOT IN (SELECT key FROM json_each(excluded.value))
      )),updated_at=excluded.updated_at,revision=settings.revision+1
    WHERE EXISTS(SELECT 1 FROM json_each(excluded.value) field
      WHERE (settings.value -> ('$.' || field.key)) IS NOT (excluded.value -> ('$.' || field.key)))`)
    .bind(group, JSON.stringify(patch), Date.now());
}

export async function saveGroupedSettings(db, updates, defaults) {
  await ensureGroupedSettings(db, defaults);
  const patches = new Map();
  for (const [field, value] of Object.entries(updates)) {
    const group = FIELD_SETTINGS_GROUP[field];
    if (!group || value === undefined) continue;
    if (!patches.has(group)) patches.set(group, {});
    patches.get(group)[field] = value;
  }
  if (!patches.size) return [];
  const entries = [...patches];
  const results = await db.batch(entries.map(([group, patch]) => updateStatement(db, group, patch)));
  const changed = entries.filter((_, i) => Number(results[i]?.meta?.changes) > 0).map(([group]) => group);
  if (changed.length) clearGroupedSettingsCache(db, changed);
  return changed;
}

export async function ensureGroupedJwtSecret(db, candidate) {
  await db.prepare(`INSERT INTO settings(key,value,updated_at,revision) VALUES('settings.security',json_object('jwt_secret',?1),?3,1)
    ON CONFLICT(key) DO UPDATE SET value=json_set(settings.value,'$.jwt_secret',?1),updated_at=excluded.updated_at,revision=settings.revision+1
    WHERE json_type(settings.value,'$.jwt_secret') IS NOT 'text' OR length(json_extract(settings.value,'$.jwt_secret')) < ?2`)
    .bind(candidate, JWT_SECRET_MIN_LENGTH, Date.now()).run();
  const row = await db.prepare("SELECT value FROM settings WHERE key='settings.security'").first();
  const value = objectValue(row?.value, 'settings.security');
  if (typeof value.jwt_secret !== 'string' || value.jwt_secret.length < JWT_SECRET_MIN_LENGTH) throw new AppError('JWT secret persistence failed', 503);
  const state = slot(db);
  state.groups.set('settings.security', { value, expiry: Date.now() + SITE_SETTINGS_CACHE_TTL_MS });
  return value.jwt_secret;
}
