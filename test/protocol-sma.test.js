import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleUpdate,
  AGENT_AUTO_DISCOVERY_HEADER,
  AGENT_AUTO_DISCOVERY_SERVER_ID_HEADER,
  AGENT_AUTO_DISCOVERY_CREATED,
  AGENT_AUTO_DISCOVERY_REUSED,
  AGENT_AUTO_DISCOVERY_FAILED,
  AGENT_AUTO_DISCOVERY_DISABLED,
  AGENT_WSS_MODE_HEADER
} from '../src/handlers/update.js';
import { clearSiteSettingsCache } from '../src/utils/settings.js';
import { clearServersListCache } from '../src/utils/cache.js';

function makeMockEnv(siteSettings = {}, existingServers = []) {
  const writes = [];
  const servers = [...existingServers];
  const historyInserts = [];

  const env = {
    API_SECRET: 'master_secret',
    DB: {
      batch: async (statements) => {
        for (const s of statements) {
          if (s._sql.includes('INSERT OR REPLACE INTO metrics_history') || s._sql.includes('INSERT INTO metrics_history')) {
            historyInserts.push({ sql: s._sql, args: s._args });
          }
        }
        return statements.map(() => ({ success: true }));
      },
      prepare(sql) {
        return {
          _sql: sql,
          bind(...args) {
            this._args = args;
            return this;
          },
          async first() {
            if (sql.includes("key = 'site_options'")) {
              return { value: JSON.stringify(siteSettings) };
            }
            if (sql.includes('SELECT COALESCE(MAX(sort_order)')) {
              return { max_order: 1 };
            }
            if (sql.includes('SELECT COALESCE(MAX(history_partition_id)')) {
              return { max_id: 1 };
            }
            if (sql.includes('SELECT id FROM servers WHERE name = ?')) {
              const nameArg = this._args[0];
              const found = servers.find(s => s.name === nameArg);
              return found ? { id: found.id } : null;
            }
            if (sql.includes('SELECT') && sql.includes('FROM servers WHERE id = ?')) {
              const idArg = this._args[0];
              const found = servers.find(s => s.id === idArg);
              return found || null;
            }
            return null;
          },
          async all() {
            if (sql.includes('SELECT') && sql.includes('FROM servers')) {
              return { results: servers };
            }
            if (sql.includes('PRAGMA table_info')) {
              return { results: [{ name: 'secret' }, { name: 'interface' }] };
            }
            return { results: [] };
          },
          async run() {
            writes.push({ sql, args: this._args || [] });
            if (sql.includes('INSERT INTO servers')) {
              const [id, name, server_group, region, sort_order, history_partition_id, timestamp, secret] = this._args;
              servers.push({
                id,
                name,
                server_group,
                region,
                sort_order,
                history_partition_id,
                timestamp,
                secret
              });
            }
            if (sql.includes('INSERT OR REPLACE INTO metrics_history') || sql.includes('INSERT INTO metrics_history')) {
              historyInserts.push({ sql, args: this._args });
            }
            return { success: true, meta: { changes: 1 } };
          }
        };
      }
    }
  };
  return { env, writes, servers, historyInserts };
}

test('PROTOCOL: auto-discovery registration creates new node when id is empty', async () => {
  clearSiteSettingsCache();
  clearServersListCache();
  const token = 'cfsm_token_12345';
  const { env, servers } = makeMockEnv({
    auto_register_enabled: 'true',
    auto_register_token: token,
    auto_register_token_expires: Date.now() + 30 * 60 * 1000
  });

  const req = new Request('https://example.com/update', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'cfsm',
      'X-Agent-Version': '1.0.0'
    },
    body: JSON.stringify({
      id: '',
      secret: token,
      name: 'hk-node-prod-01',
      time: { local_ts: Date.now(), offset_ms: 0, calibrated: false },
      collect_interval: 0,
      report_interval: 60,
      config_schema: '1',
      config_md5: 'none',
      metrics: {
        os: 'Linux',
        arch: 'amd64',
        cpu_cores: '4',
        ram_total: '8192',
        ram_used: '1024',
        net_rx: '100',
        net_tx: '50'
      }
    })
  });

  const res = await handleUpdate(req, env, { waitUntil() {} });
  assert.equal(res.status, 200);

  // Response headers validation
  assert.equal(AGENT_AUTO_DISCOVERY_HEADER, 'x-sma-auto-discovery');
  assert.equal(AGENT_AUTO_DISCOVERY_SERVER_ID_HEADER, 'x-sma-server-id');
  assert.equal(res.headers.get(AGENT_AUTO_DISCOVERY_HEADER), AGENT_AUTO_DISCOVERY_CREATED);
  assert.equal(res.headers.get('x-sma-auto-discovery'), AGENT_AUTO_DISCOVERY_CREATED);
  assert.equal(res.headers.get('x-cfsm-auto-discovery'), AGENT_AUTO_DISCOVERY_CREATED);
  const newServerId = res.headers.get(AGENT_AUTO_DISCOVERY_SERVER_ID_HEADER);
  assert.ok(newServerId, 'x-sma-server-id header must be present');
  assert.equal(res.headers.get('x-sma-server-id'), newServerId);
  assert.equal(res.headers.get('x-cfsm-server-id'), newServerId);
  assert.match(newServerId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.ok(res.headers.get('date'), 'Date header must be present for clock calibration');
  assert.ok(res.headers.get(AGENT_WSS_MODE_HEADER), 'x-agent-wss-mode header must be present');

  // Verify server was created in database
  const created = servers.find(s => s.id === newServerId);
  assert.ok(created, 'Server should be inserted into database');
  assert.equal(created.name, 'hk-node-prod-01');
  assert.equal(created.secret, token);
});

test('PROTOCOL: auto-discovery returns 404 disabled when auto_register is disabled', async () => {
  clearSiteSettingsCache();
  clearServersListCache();
  const { env } = makeMockEnv({
    auto_register_enabled: 'false',
    auto_register_token: 'cfsm_token'
  });

  const req = new Request('https://example.com/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: '',
      secret: 'cfsm_token',
      name: 'any-node',
      metrics: { cpu: 10 }
    })
  });

  const res = await handleUpdate(req, env, { waitUntil() {} });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get(AGENT_AUTO_DISCOVERY_HEADER), AGENT_AUTO_DISCOVERY_DISABLED);
  assert.ok(res.headers.get('date'));
});

test('PROTOCOL: auto-discovery returns 200 reused when node name already exists', async () => {
  clearSiteSettingsCache();
  clearServersListCache();
  const token = 'cfsm_token_12345';
  const existingServer = {
    id: 'existing-srv-id-01',
    name: 'conflict-node-name',
    history_partition_id: 1,
    secret: 'old_secret'
  };
  const { env, servers } = makeMockEnv({
    auto_register_enabled: 'true',
    auto_register_token: token,
    auto_register_token_expires: Date.now() + 30 * 60 * 1000
  }, [existingServer]);

  const req = new Request('https://example.com/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: '',
      secret: token,
      name: 'conflict-node-name',
      metrics: { cpu: 10 }
    })
  });

  const res = await handleUpdate(req, env, { waitUntil() {} });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get(AGENT_AUTO_DISCOVERY_HEADER), AGENT_AUTO_DISCOVERY_REUSED);
  assert.ok(res.headers.get('date'));

  // Ensure no new server was added
  assert.equal(servers.length, 1);
  assert.equal(servers[0].id, 'existing-srv-id-01');
});

test('PROTOCOL: auto-discovery rejects when token is expired', async () => {
  clearSiteSettingsCache();
  clearServersListCache();
  const token = 'cfsm_token_expired';
  const { env } = makeMockEnv({
    auto_register_enabled: 'true',
    auto_register_token: token,
    auto_register_token_expires: Date.now() - 1000 // expired
  });

  const req = new Request('https://example.com/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: '',
      secret: token,
      name: 'test-node',
      metrics: { cpu: 10 }
    })
  });

  const res = await handleUpdate(req, env, { waitUntil() {} });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get(AGENT_AUTO_DISCOVERY_HEADER), `${AGENT_AUTO_DISCOVERY_FAILED}:key_expired`);
});

test('PROTOCOL: auto-discovery rejects when server name cannot be determined', async () => {
  clearSiteSettingsCache();
  clearServersListCache();
  const token = 'cfsm_token_valid';
  const { env } = makeMockEnv({
    auto_register_enabled: 'true',
    auto_register_token: token,
    auto_register_token_expires: Date.now() + 30 * 60 * 1000
  });

  const req = new Request('https://example.com/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: '',
      secret: token,
      name: '',
      metrics: { cpu: 10 }
    })
  });

  const res = await handleUpdate(req, env, { waitUntil() {} });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get(AGENT_AUTO_DISCOVERY_HEADER), `${AGENT_AUTO_DISCOVERY_FAILED}:no_name`);
});

test('PROTOCOL: batch backfill (batch: true) persists all samples', async () => {
  clearSiteSettingsCache();
  clearServersListCache();
  const server = {
    id: 'srv-us-east-01',
    name: 'us-east-01',
    history_partition_id: 1,
    secret: 'node_secret_abc'
  };
  const { env, historyInserts } = makeMockEnv({
    auto_register_enabled: 'false'
  }, [server]);

  // Construct 50 samples
  const now = Date.now();
  const samples = [];
  for (let i = 0; i < 50; i++) {
    samples.push({
      ts: now - (50 - i) * 60000,
      metrics: {
        cpu: `${10 + (i % 20)}`,
        ram_total: '8192',
        ram_used: `${1000 + i * 10}`,
        swap_total: '2048',
        swap_used: '0',
        net_in_speed: '50000',
        net_out_speed: '40000'
      }
    });
  }

  const req = new Request('https://example.com/update', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'cfsm',
      'X-Agent-Version': '1.0.0'
    },
    body: JSON.stringify({
      id: 'srv-us-east-01',
      secret: 'node_secret_abc',
      batch: true,
      time: { local_ts: now, offset_ms: 10, calibrated: true },
      samples
    })
  });

  const res = await handleUpdate(req, env, { waitUntil() {} });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('date'));
  assert.ok(res.headers.get(AGENT_WSS_MODE_HEADER));

  // Verify that all 50 samples were persisted into metrics_history
  assert.equal(historyInserts.length, 50, 'All 50 samples must be persisted to database');
});

test('PROTOCOL: WebSocket Ack frame contains realtimeHint', async () => {
  if (!globalThis.WebSocketRequestResponsePair) {
    globalThis.WebSocketRequestResponsePair = class WebSocketRequestResponsePair {};
  }
  const { MetricsBroadcaster } = await import('../src/durable/MetricsBroadcaster.js');
  const sent = [];
  const fakeWs = {
    send(str) { sent.push(JSON.parse(str)); },
    close() {},
    serializeAttachment() {},
    deserializeAttachment() { return {}; }
  };
  const broadcaster = new MetricsBroadcaster({
    setWebSocketAutoResponse() {},
    getWebSockets() { return []; },
    storage: { async get() { return null; }, async put() {} }
  }, { DB: {} });

  // Test _sendWsJson output
  broadcaster._sendWsJson(fakeWs, {
    type: 'ack',
    ts: 1729700000000,
    persisted: true,
    nextWssReportAfterMs: 1000,
    realtimeHint: false
  });

  assert.equal(sent.length, 1);
  const ack = sent[0];
  assert.equal(ack.type, 'ack');
  assert.equal(ack.persisted, true);
  assert.equal(ack.nextWssReportAfterMs, 1000);
  assert.equal(ack.realtimeHint, false);
});
