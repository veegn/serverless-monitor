import test from 'node:test';
import assert from 'node:assert/strict';
import { MetricsBroadcaster } from '../src/durable/MetricsBroadcaster.js';
import { DASHBOARD_LATENCY_WINDOW_HOURS, DASHBOARD_LATENCY_WINDOW_POINTS } from '../src/utils/config.js';
import { makeSqlStorage } from './helpers/sql-storage.js';

globalThis.WebSocketRequestResponsePair ||= class {};
function broadcaster() {
  return new MetricsBroadcaster({ storage: makeSqlStorage(), setWebSocketAutoResponse() {}, getWebSockets() { return []; } },
    { DB: { prepare() { throw new Error('Latency queries must not read D1'); } } });
}

test('dashboard latency exposes three hours in twenty slots from DO SQLite', async () => {
  const instance = broadcaster();
  const now = Date.now();
  await instance._persistUpdates([{ serverId: 'a', samples: [150, 30, 10].map(minutes => ({ ts: now - minutes * 60000,
    data: { ping_ct: minutes, loss_ct: 0 } })) }]);
  const windows = await instance._getDashboardLatencyWindows(['a']);
  assert.equal(DASHBOARD_LATENCY_WINDOW_HOURS, 3);
  assert.equal(DASHBOARD_LATENCY_WINDOW_POINTS, 20);
  assert.equal(windows.a.ping.length, 20);
  assert.equal(windows.a.loss.length, 20);
  assert.ok(windows.a.ping.some(point => point.ct === 150));
});

test('latency windows preserve empty slots instead of filling them with previous samples', async () => {
  const instance = broadcaster();
  await instance._persistUpdates([{ serverId: 'a', samples: [{ ts: Date.now() - 300000, data: { ping_ct: 10, loss_ct: 0 } }] }]);
  const window = (await instance._getDashboardLatencyWindows(['a'])).a;
  assert.equal(window.ping.filter(point => point.ct === 10).length, 1);
  assert.equal(window.ping.filter(point => point.ct === null).length, 19);
});

test('new latency reports become queryable immediately without a stale D1 window cache', async () => {
  const instance = broadcaster();
  assert.deepEqual((await instance._getDashboardLatencyWindows(['a'])).a, { ping: [], loss: [] });
  await instance._persistUpdates([{ serverId: 'a', samples: [{ ts: Date.now() - 1000, data: { ping_ct: 25, loss_ct: 0 } }] }]);
  assert.ok((await instance._getDashboardLatencyWindows(['a'])).a.ping.some(point => point.ct === 25));
});
