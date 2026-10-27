import { DatabaseSync } from 'node:sqlite';
import { SERVER_CORE_COLUMNS, SERVER_PING_COLUMNS, SERVER_NOTIFICATION_COLUMNS } from '../../src/database/migrations/legacyServers.js';

export function makeD1({ settings = {}, servers = [], legacyColumns = {} } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  const columns = { ...SERVER_CORE_COLUMNS, ...SERVER_PING_COLUMNS, ...SERVER_NOTIFICATION_COLUMNS,
    traffic_alert_state: 'TEXT', history_partition_id: 'INTEGER DEFAULT 0', ...legacyColumns };
  sqlite.exec(`CREATE TABLE servers (${Object.entries(columns).map(([name, definition]) => `"${name}" ${definition}`).join(',')})`);
  for (const [key, value] of Object.entries(settings)) {
    sqlite.prepare('INSERT INTO settings VALUES (?, ?)').run(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  for (const server of servers) {
    const names = Object.keys(server).filter(name => name in columns && server[name] !== undefined);
    sqlite.prepare(`INSERT INTO servers (${names.map(name => `"${name}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`)
      .run(...names.map(name => server[name] !== null && /TEXT/.test(columns[name]) ? String(server[name]) : server[name]));
  }
  const calls = [];
  const writes = [];
  const db = {
    sqlite, calls, writes, failed: false,
    prepare(sql) { if (db.failed) throw new Error('D1 unavailable'); return statement(sql); },
    async batch(statements) {
      if (db.failed) throw new Error('D1 unavailable');
      sqlite.exec('BEGIN');
      try { const result = statements.map(item => item._execute('batch')); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
  function statement(sql, args = []) {
    return {
      _sql: sql, _args: args,
      bind(...values) { return statement(sql, values); },
      _execute(type) {
        if (db.failed) throw new Error('D1 unavailable');
        calls.push({ type, sql, args, params: args });
        const compiled = sqlite.prepare(sql);
        const hasColumns = compiled.columns().length > 0;
        if (hasColumns) return { success: true, results: compiled.all(...args).map(row => ({ ...row })), meta: { changes: 0 } };
        const result = compiled.run(...args);
        if (/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i.test(sql)) writes.push({ sql, args, changes: Number(result.changes) });
        return { success: true, results: [], meta: { changes: Number(result.changes) } };
      },
      async all() { return this._execute('all'); },
      async first(column) { const row = this._execute('first').results[0] || null; return column ? row?.[column] ?? null : row; },
      async run() { return this._execute('run'); }
    };
  }
  db.store = {
    get: key => sqlite.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value,
    set(key, value) { sqlite.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); return this; },
    has: key => !!sqlite.prepare('SELECT 1 FROM settings WHERE key=?').get(key)
  };
  Object.defineProperty(db, 'alertState', {
    get() { const table = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='notification_runtime_state'").get(); return JSON.parse((table ? sqlite.prepare("SELECT value FROM notification_runtime_state WHERE key='alert_state'").get()?.value : db.store.get('alert_state')) || '{}'); },
    set(value) { const table = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='notification_runtime_state'").get(); if (table) sqlite.prepare("INSERT INTO notification_runtime_state(key,value) VALUES('alert_state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value)); else db.store.set('alert_state', JSON.stringify(value)); }
  });
  return db;
}
