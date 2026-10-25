import assert from 'node:assert/strict';
import test from 'node:test';
import { MetricsBroadcaster } from '../src/durable/MetricsBroadcaster.js';
import { DashboardController } from '../src/handlers/DashboardController.js';
import { AdminController } from '../src/handlers/AdminController.js';
import { UpdateController } from '../src/handlers/UpdateController.js';
import { clearServersListCache } from '../src/utils/cache.js';
import { clearSiteSettingsCache } from '../src/utils/settings.js';

if (!globalThis.WebSocketRequestResponsePair) {
  globalThis.WebSocketRequestResponsePair = class WebSocketRequestResponsePair {};
}

function makeMockStorage() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? structuredClone(store.get(key)) : null;
    },
    async put(key, val) {
      store.set(key, structuredClone(val));
    },
    async delete(key) {
      store.delete(key);
    },
    async list(options = {}) {
      const result = new Map();
      const prefix = options.prefix || '';
      for (const [k, v] of store.entries()) {
        if (k.startsWith(prefix)) {
          result.set(k, v);
        }
      }
      return result;
    },
    store
  };
}

function makeBroadcasterWithStorage(storage) {
  return new MetricsBroadcaster({
    setWebSocketAutoResponse() {},
    acceptWebSocket() {},
    getWebSockets() { return []; },
    storage
  }, { DB: {} });
}

test('DO History: Ingests, persists to DO storage, and responds to GET /history', async () => {
  const storage = makeMockStorage();
  const broadcaster = makeBroadcasterWithStorage(storage);

  const baseTs = Math.floor((Date.now() - 120000) / 60000) * 60000;
  const updates = [{
    serverId: 'server-do-01',
    samples: [
      { ts: baseTs + 1000, payload: { cpu: 10, net_in_speed: 1000, ram_used: 1024 } },
      { ts: baseTs + 2000, payload: { cpu: 30, net_in_speed: 5000, ram_used: 2048 } },
      { ts: baseTs + 62000, payload: { cpu: 50, net_in_speed: 8000, ram_used: 4096 } }
    ]
  }];

  // 1. Ingest updates into DO
  await broadcaster._ingestHistoryUpdatesAsync(updates, baseTs + 65000);

  // Verify memory history window
  const window = broadcaster.historyWindows.get('server-do-01');
  assert.ok(Array.isArray(window));
  assert.equal(window.length, 2); // 2 minute buckets

  // Minute 1: cpu avg (10, 30) = 20, net_in_speed max = 5000
  assert.equal(window[0].cpu, 20);
  assert.equal(window[0].net_in_speed, 5000);
  assert.equal(window[0].ram_used, 1536);

  // Minute 2:
  assert.equal(window[1].cpu, 50);
  assert.equal(window[1].net_in_speed, 8000);

  // 2. Persist to storage
  await broadcaster._persistHistorySnapshotIfNeeded(baseTs + 65000, true);
  assert.ok(storage.store.has('durable_history_v1:server-do-01'));
  const stored = storage.store.get('durable_history_v1:server-do-01');
  assert.equal(stored.length, 2);

  // 3. Query via GET /history
  const req = new Request(`http://internal/history?serverId=server-do-01&hours=1&columns=cpu,net_in_speed`);
  const res = await broadcaster.fetch(req);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.length, 2);
  assert.equal(body.data[0].cpu, 20);
  assert.equal(body.data[0].net_in_speed, 5000);
  assert.equal(body.data[0].ram_used, undefined); // Excluded by columns filter

  // 4. Test decimation / sampling
  const decimateReq = new Request(`http://internal/history?serverId=server-do-01&hours=1&points=1`);
  const decimateRes = await broadcaster.fetch(decimateReq);
  const decimateBody = await decimateRes.json();
  assert.equal(decimateBody.data.length, 1);
});

test('DO History: Restores lazily from storage on cold start', async () => {
  const storage = makeMockStorage();
  const baseTs = Date.now();
  // Pre-seed storage as if from a previous session
  storage.store.set('durable_history_v1:server-reboot-01', [
    { timestamp: baseTs - 120000, cpu: 12 },
    { timestamp: baseTs - 60000, cpu: 25 }
  ]);

  const newBroadcaster = makeBroadcasterWithStorage(storage);
  assert.equal(newBroadcaster.historyWindows.has('server-reboot-01'), false);

  // Querying /history restores it lazily
  const req = new Request(`http://internal/history?serverId=server-reboot-01&hours=1`);
  const res = await newBroadcaster.fetch(req);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.length, 2);
  assert.equal(body.data[0].cpu, 12);
  assert.equal(body.data[1].cpu, 25);
  assert.equal(newBroadcaster.historyWindows.has('server-reboot-01'), true);
});

test('HTTP Update: D1 quota error is gracefully caught and does not block broadcast', async () => {
  clearSiteSettingsCache();
  clearServersListCache();

  const failingDb = {
    prepare() {
      return {
        bind() {
          return {
            async run() { throw new Error('D1_ERROR: storage limit exceeded'); },
            async first() { return { id: 'srv-fail-01', history_partition_id: 1, secret: 'sec123' }; },
            async all() { return { results: [] }; }
          };
        },
        async first() { return { id: 'srv-fail-01', history_partition_id: 1, secret: 'sec123' }; },
        async all() { return { results: [] }; },
        async run() { throw new Error('D1_ERROR: storage limit exceeded'); }
      };
    },
    async batch() {
      throw new Error('D1_ERROR: storage limit exceeded');
    }
  };

  const req = new Request('https://example.com/update', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'cfsm',
      'X-Agent-Version': '1.0.0'
    },
    body: JSON.stringify({
      id: 'srv-fail-01',
      secret: 'sec123',
      metrics: { cpu: '45.5', ram_used: 2048, net_in_speed: 1000 }
    })
  });

  const res = await UpdateController.handleUpdate(req, { DB: failingDb }, { waitUntil() {} });
  // Must return 200 OK despite D1 write failure
  assert.equal(res.status, 200);
});

test('DashboardController: handleHistory returns DO history directly when available', async () => {
  const fakeBroadcaster = {
    async fetch(url) {
      return new Response(JSON.stringify({
        ok: true,
        data: [
          { timestamp: 1730000000000, cpu: 15 },
          { timestamp: 1730000060000, cpu: 25 }
        ]
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  };

  const server = { id: 'srv-test-do', name: 'test-do', history_partition_id: 1 };
  const fakeEnv = {
    DB: {
      prepare() {
        return {
          bind() {
            return {
              async first() { return server; },
              async all() { return { results: [server] }; }
            };
          },
          async first() { return server; },
          async all() { return { results: [server] }; }
        };
      }
    },
    METRICS_BROADCASTER: {
      idFromName() { return 'global'; },
      get() { return fakeBroadcaster; }
    }
  };

  const controller = new DashboardController(fakeEnv);
  const req = new Request('https://monitor.test/api/history?id=srv-test-do&hours=1');
  const res = await controller.handleHistory(req, 'srv-test-do', 1, 'cpu', { is_public: 'true' });
  assert.equal(res.status, 200);

  const json = await res.json();
  assert.equal(json.length, 2);
  assert.equal(json[0].cpu, 15);
  assert.equal(json[1].cpu, 25);
});

test('DO History: Clears history on POST /clear-history', async () => {
  const storage = makeMockStorage();
  const broadcaster = makeBroadcasterWithStorage(storage);
  storage.store.set('durable_history_v1:server-clear-01', [{ timestamp: Date.now(), cpu: 10 }]);
  broadcaster.historyWindows.set('server-clear-01', [{ timestamp: Date.now(), cpu: 10 }]);

  const req = new Request('http://internal/clear-history', { method: 'POST' });
  const res = await broadcaster.fetch(req);
  assert.equal(res.status, 200);
  assert.equal(broadcaster.historyWindows.size, 0);
  assert.equal(storage.store.size, 0);
});

test('AdminController: handleListAction reads latest metrics from DO and sets is_online=true', async () => {
  clearServersListCache();
  const now = Date.now();
  const server = { id: 'srv-admin-online-1', name: 'Admin Online Server', is_hidden: 0 };

  const fakeBroadcaster = {
    async fetch(request, init) {
      const urlStr = typeof request === 'string' ? request : request.url;
      const url = new URL(urlStr);
      if (url.pathname === '/latest-report-updates') {
        return new Response(JSON.stringify({
          updates: [{
            serverId: 'srv-admin-online-1',
            reportTs: now,
            samples: [{ ts: now, data: { cpu: 42, ram_used: 1024, agent_version: '2.8.6', ip_v4: '198.51.100.2' } }]
          }]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }
  };

  const fakeEnv = {
    DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() { return null; },
              async all() { return { results: [server] }; }
            };
          },
          async first() { return null; },
          async all() { return { results: [server] }; }
        };
      },
      async batch() {
        return [{ results: [] }];
      }
    },
    METRICS_BROADCASTER: {
      idFromName() { return 'global'; },
      get() { return fakeBroadcaster; }
    }
  };

  const res = await AdminController.handleListAction({ env: fakeEnv });
  assert.equal(res.status, 200);

  const json = await res.json();
  assert.equal(json.success, true);
  assert.equal(json.servers.length, 1);
  const item = json.servers[0];
  assert.equal(item.id, 'srv-admin-online-1');
  assert.equal(item.is_online, true);
  assert.equal(item.cpu, 42);
  assert.equal(item.agent_version, '2.8.6');
  assert.equal(item.ip_v4, '198.51.100.2');
  assert.equal(json.stats.online, 1);
  assert.equal(json.stats.offline, 0);
});

test('DO /batch-push: Caches updates and ingests history even when subscribers=0 and maintainState=false', async () => {
  const storage = makeMockStorage();
  const broadcaster = makeBroadcasterWithStorage(storage);
  const now = Date.now();

  const res = await broadcaster.fetch(new Request('http://internal/batch-push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      updates: [{
        serverId: 'srv-no-subscribers',
        samples: [{ ts: now, data: { cpu: 25, ram_used: 512, ip_v4: '203.0.113.10' } }]
      }]
    })
  }));

  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.subscribers, 0);
  assert.equal(json.latestReportOnly, true);

  // Check DO cached latest reports
  const latest = broadcaster.latestReportUpdates.get('srv-no-subscribers');
  assert.ok(latest);
  assert.equal(latest.samples[0].data.ip_v4, '203.0.113.10');
});
