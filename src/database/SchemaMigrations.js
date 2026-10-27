import { AppError } from '../utils/errors.js';

const ready = new WeakMap();
export function ensureMigrationTable(db) {
  if (!ready.has(db)) {
    const promise = db.prepare(`CREATE TABLE IF NOT EXISTS schema_migrations (
      component TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, applied_at INTEGER NOT NULL,
      PRIMARY KEY (component, version)
    ) WITHOUT ROWID`).run();
    ready.set(db, promise);
    promise.catch(() => { if (ready.get(db) === promise) ready.delete(db); });
  }
  return ready.get(db);
}

export async function migrationVersion(db, component, supported) {
  const read = () => db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations WHERE component = ?').bind(component).first();
  let row;
  try { row = await read(); }
  catch (error) {
    if (!/no such table: schema_migrations/i.test(error.message)) throw error;
    await ensureMigrationTable(db);
    row = await read();
  }
  const version = Number(row?.version || 0);
  if (version > supported) throw new AppError(`Unsupported ${component} schema version`, 503);
  return version;
}

export function migrationRecord(db, component, version, name) {
  return db.prepare('INSERT OR IGNORE INTO schema_migrations (component, version, name, applied_at) VALUES (?, ?, ?, ?)')
    .bind(component, version, name, Date.now());
}

export async function applyMigration(db, component, version, name, statements) {
  return db.batch([...statements, migrationRecord(db, component, version, name)]);
}
