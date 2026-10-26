import { DatabaseSync } from 'node:sqlite';

export function makeSqlStorage() {
  const db = new DatabaseSync(':memory:');
  const store = new Map();
  return {
    db,
    store,
    sql: {
      exec(query, ...bindings) {
        if (!bindings.length && query.includes('CREATE TABLE')) {
          db.exec(query);
          return { toArray: () => [] };
        }
        const statement = db.prepare(query);
        const rows = statement.columns().length ? statement.all(...bindings) : (statement.run(...bindings), []);
        return { toArray: () => rows.map(row => ({ ...row })) };
      }
    },
    transactionSync(callback) {
      db.exec('BEGIN');
      try {
        const result = callback();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async get(key) { return store.has(key) ? structuredClone(store.get(key)) : undefined; },
    async put(key, value) { store.set(key, structuredClone(value)); },
    async delete(key) {
      if (Array.isArray(key)) { for (const item of key) store.delete(item); }
      else store.delete(key);
    },
    async list({ prefix = '' } = {}) { return new Map([...store].filter(([key]) => key.startsWith(prefix))); }
  };
}
