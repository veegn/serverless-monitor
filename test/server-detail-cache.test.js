import { makeD1 } from './helpers/d1.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getServerDetail, clearServerDetailCache } from '../src/utils/cache.js';

function makeDb(first) {
  const db = makeD1();
  const prepare = db.prepare.bind(db);
  db.prepare = sql => sql.includes('SELECT * FROM server_details WHERE id') ? { bind() { return { first }; } } : prepare(sql);
  return db;
}

test('getServerDetail falls back to the last known value when D1 throws', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  clearServerDetailCache();

  let failing = false;
  const db = makeDb(async () => {
    if (failing) throw new Error('D1_ERROR');
    return { id: 'cache-fallback-server', report_interval: 120 };
  });

  const first = await getServerDetail(db, 'cache-fallback-server', true);
  assert.equal(first.report_interval, 120);

  failing = true;
  t.mock.timers.tick(121 * 1000);

  const fallback = await getServerDetail(db, 'cache-fallback-server', true);
  assert.equal(fallback.report_interval, 120);
});

test('getServerDetail rethrows when there is no cached value to fall back to', async () => {
  clearServerDetailCache();
  const db = makeDb(async () => {
    throw new Error('D1_ERROR');
  });

  await assert.rejects(() => getServerDetail(db, 'cache-no-entry-server', true), /D1_ERROR/);
});
