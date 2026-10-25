import test from 'node:test';
import assert from 'node:assert/strict';
import { UpdateController } from '../src/handlers/UpdateController.js';
import { DatabaseService } from '../src/database/DatabaseService.js';

const {
  handleUpdate,
  AGENT_AUTO_DISCOVERY_HEADER,
  AGENT_AUTO_DISCOVERY_SERVER_ID_HEADER,
  AGENT_AUTO_DISCOVERY_CREATED,
  AGENT_AUTO_DISCOVERY_REUSED,
  AGENT_AUTO_DISCOVERY_FAILED,
  AGENT_AUTO_DISCOVERY_DISABLED,
  AGENT_WSS_MODE_HEADER
} = UpdateController;
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

  // Verify that metrics are NOT written to D1; handled exclusively by DO
  assert.equal(historyInserts.length, 0, 'No metrics inserted to D1');
  const queued = UpdateController.batchQueue.get('srv-us-east-01')?.samples || [];
  assert.equal(queued.length, 50, 'All 50 samples must be queued for DO');
});

test('PROTOCOL: Mode Push frame conforms to ADAPTIVE_REPORTING_SPEC', async () => {
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

  broadcaster._sendWsJson(fakeWs, {
    type: 'ack',
    ackFor: 'mode',
    ts: 1729700000000,
    modeRevision: 2,
    nextWssReportAfterMs: 2000,
    realtimeHint: true
  });

  assert.equal(sent.length, 1);
  const ack = sent[0];
  assert.equal(ack.type, 'ack');
  assert.equal(ack.ackFor, 'mode');
  assert.equal(ack.modeRevision, 2);
  assert.equal(ack.nextWssReportAfterMs, 2000);
  assert.equal(ack.realtimeHint, true);
  assert.equal(ack.reportId, undefined);
  assert.equal(ack.accepted, undefined);
  assert.equal(ack.persisted, undefined);
});

test('PROTOCOL: Report ACK frame conforms to ADAPTIVE_REPORTING_SPEC', async () => {
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

  broadcaster._sendWsJson(fakeWs, {
    type: 'ack',
    ackFor: 'report',
    ts: 1729700000000,
    reportId: 'srv-us-east-01-00000042',
    accepted: true,
    persisted: true,
    acceptedSamples: 30,
    nextD1WriteAfterMs: 0
  });

  assert.equal(sent.length, 1);
  const ack = sent[0];
  assert.equal(ack.type, 'ack');
  assert.equal(ack.ackFor, 'report');
  assert.equal(ack.reportId, 'srv-us-east-01-00000042');
  assert.equal(ack.accepted, true);
  assert.equal(ack.persisted, true);
  assert.equal(ack.acceptedSamples, 30);
  assert.equal(ack.nextD1WriteAfterMs, 0);
  assert.equal(ack.realtimeHint, undefined);
  assert.equal(ack.nextWssReportAfterMs, undefined);
});

test('PROTOCOL: batch backfill merges baseline metrics into samples when persisted', async () => {
  clearSiteSettingsCache();
  clearServersListCache();
  const server = {
    id: 'srv-batch-base-01',
    name: 'batch-base-01',
    history_partition_id: 1,
    secret: 'node_secret_abc'
  };
  const { env, historyInserts } = makeMockEnv({
    auto_register_enabled: 'false'
  }, [server]);

  const now = Math.floor(Date.now() / 1000);
  const samples = [
    { cpu: 15, ram_used: 1024, ts: now - 120 },
    { cpu: 20, ram_used: 1024, ts: now - 60 }
  ];

  const req = new Request('https://example.com/update', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'cfsm',
      'X-Agent-Version': '1.0.0'
    },
    body: JSON.stringify({
      id: 'srv-batch-base-01',
      secret: 'node_secret_abc',
      batch: true,
      metrics: {
        disk_total: 50000000,
        disk_used: 20000000,
        tcp_conn: 42,
        load_avg: '1.2 1.5 1.8'
      },
      samples
    })
  });

  const res = await handleUpdate(req, env, { waitUntil() {} });
  assert.equal(res.status, 200);
  assert.equal(historyInserts.length, 0, 'No metrics inserted to D1');

  // Verify that the baseline metrics (disk_total, tcp_conn, load_avg) are preserved across samples queued for DO
  const queued = UpdateController.batchQueue.get('srv-batch-base-01')?.samples || [];
  assert.equal(queued.length, 2);
  for (const sample of queued) {
    const payload = sample.payload;
    assert.equal(payload.load_avg, '1.2 1.5 1.8');
    assert.equal(payload.tcp_conn, 42);
    assert.equal(payload.disk_total, 50000000);
  }
});

test('PROTOCOL: batch backfill downsamples multiple high-frequency samples in the same minute into a single aggregated insert', async () => {
  clearSiteSettingsCache();
  clearServersListCache();
  const server = {
    id: 'srv-batch-downsample-01',
    name: 'batch-downsample-01',
    history_partition_id: 1,
    secret: 'node_secret_abc'
  };
  const { env, historyInserts } = makeMockEnv({
    auto_register_enabled: 'false'
  }, [server]);

  // Use a fixed timestamp aligned to a minute boundary plus 30 seconds
  const baseMinuteSec = Math.floor(Date.now() / 60000) * 60;
  // Send 30 samples within this exact minute window (idle batch scenario)
  const samples = [];
  for (let i = 0; i < 30; i++) {
    samples.push({
      cpu: i % 2 === 0 ? 10 : 20,
      net_in_speed: 1000 + i * 100,
      ram_used: 2048,
      ts: baseMinuteSec + i
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
      id: 'srv-batch-downsample-01',
      secret: 'node_secret_abc',
      batch: true,
      metrics: {
        disk_total: 50000000,
        tcp_conn: 42
      },
      samples
    })
  });

  const res = await handleUpdate(req, env, { waitUntil() {} });
  assert.equal(res.status, 200);
  // D1 is not touched
  assert.equal(historyInserts.length, 0);

  // Downsampling logic verification
  const downsampled = DatabaseService.downsampleHistorySamples(samples, { disk_total: 50000000, tcp_conn: 42 });
  assert.equal(downsampled.length, 1);
  assert.equal(downsampled[0].metrics.cpu, 15);
  assert.equal(downsampled[0].metrics.net_in_speed, 3900);
  assert.equal(downsampled[0].metrics.tcp_conn, 42);
  assert.equal(downsampled[0].metrics.disk_total, 50000000);
});

test('DO WebSocket pushes cached batchUpdate on initial connect', async () => {
  if (!globalThis.WebSocketRequestResponsePair) {
    globalThis.WebSocketRequestResponsePair = class WebSocketRequestResponsePair {};
  }
  const { MetricsBroadcaster } = await import('../src/durable/MetricsBroadcaster.js');
  const sent = [];
  const fakeWs = {
    send(str) { sent.push(JSON.parse(str)); },
    close() {},
    serializeAttachment() {},
    deserializeAttachment() { return { scope: 'all' }; }
  };
  const broadcaster = new MetricsBroadcaster({
    setWebSocketAutoResponse() {},
    getWebSockets() { return []; },
    storage: { async get() { return null; }, async put() {} }
  }, { DB: {} });

  const now = Date.now();
  broadcaster._cacheLatestReportUpdates([{
    serverId: 'srv-cache-01',
    samples: [
      { ts: now - 2000, payload: { cpu: 10 } },
      { ts: now, payload: { cpu: 20 } }
    ]
  }], now);

  await broadcaster._pushLatestUpdatesToSubscriber(fakeWs, 'all');

  assert.equal(sent.length, 1);
  const msg = sent[0];
  assert.equal(msg.type, 'batchUpdate');
  assert.equal(msg.updates.length, 1);
  assert.equal(msg.updates[0].serverId, 'srv-cache-01');
  assert.equal(msg.updates[0].samples.length, 2);
});

test('Observability: logWssEvent produces structured Cloudflare logs', async () => {
  const { logWssEvent, logAgentReport, logModeTransition, LogLevel } = await import('../src/utils/observability.js');
  const logs = [];
  const originalInfo = console.info;
  console.info = (summary, meta) => {
    logs.push({ summary, meta });
  };

  try {
    logAgentReport({
      serverId: 'srv-obs-01',
      mode: 'batch',
      sampleCount: 30,
      reportId: 'rep-1',
      persisted: true,
      durationMs: 15
    });

    assert.equal(logs.length, 1);
    assert.ok(logs[0].summary.includes('[WSS:Agent] REPORT'));
    assert.equal(logs[0].meta.source, 'cfsm.wss');
    assert.equal(logs[0].meta.serverId, 'srv-obs-01');
    assert.equal(logs[0].meta.mode, 'batch');
    assert.equal(logs[0].meta.sampleCount, 30);

    logModeTransition({
      isFrontendActive: true,
      subscribers: 2,
      hintedAgents: 5,
      modeRevision: 3
    });

    assert.equal(logs.length, 2);
    assert.ok(logs[1].summary.includes('[WSS:Mode] HINT'));
    assert.equal(logs[1].meta.targetMode, 'REALTIME');
    assert.equal(logs[1].meta.subscribers, 2);
  } finally {
    console.info = originalInfo;
  }
});

test('DatabaseService.downsampleHistorySamples downsamples, aggregates, and preserves historical data', async () => {
  const { DatabaseService } = await import('../src/database/DatabaseService.js');

  // 1. Empty or invalid input
  assert.deepEqual(DatabaseService.downsampleHistorySamples([]), []);
  assert.deepEqual(DatabaseService.downsampleHistorySamples(null), []);
  assert.deepEqual(DatabaseService.downsampleHistorySamples('invalid'), []);

  // 2. Multi-minute downsampling with accurate aggregation
  const baseTs = 1730000000000; // Aligned base timestamp
  const samples = [
    // Minute 1: 3 samples
    { ts: baseTs + 2000, metrics: { cpu: 10, net_in_speed: 1000, ram_used: 1000, disk_total: 500, tcp_conn: 10, ping_ct: 20 } },
    { ts: baseTs + 4000, metrics: { cpu: 20, net_in_speed: 5000, ram_used: 2000, disk_total: 500, tcp_conn: 25, ping_ct: 30 } },
    { ts: baseTs + 6000, metrics: { cpu: 30, net_in_speed: 2000, ram_used: 3000, disk_total: 500, tcp_conn: 15, ping_ct: 40 } },
    // Minute 2: 2 samples
    { ts: baseTs + 62000, metrics: { cpu: 50, net_in_speed: 8000, ram_used: 4000, disk_total: 500, tcp_conn: 30, ping_ct: 50 } },
    { ts: baseTs + 64000, metrics: { cpu: 70, net_in_speed: 4000, ram_used: 6000, disk_total: 500, tcp_conn: 20, ping_ct: 70 } }
  ];

  const downsampled = DatabaseService.downsampleHistorySamples(samples, { os: 'Linux', arch: 'x86_64' });
  assert.equal(downsampled.length, 2);

  // Minute 1 verification:
  // ts: latest sample ts in minute 1
  assert.equal(downsampled[0].ts, baseTs + 6000);
  // cpu: avg(10, 20, 30) = 20
  assert.equal(downsampled[0].metrics.cpu, 20);
  // net_in_speed: max(1000, 5000, 2000) = 5000
  assert.equal(downsampled[0].metrics.net_in_speed, 5000);
  // ram_used: avg(1000, 2000, 3000) = 2000
  assert.equal(downsampled[0].metrics.ram_used, 2000);
  // tcp_conn: max(10, 25, 15) = 25
  assert.equal(downsampled[0].metrics.tcp_conn, 25);
  // ping_ct: avg(20, 30, 40) = 30
  assert.equal(downsampled[0].metrics.ping_ct, 30);
  // baseline metrics preserved
  assert.equal(downsampled[0].metrics.os, 'Linux');
  assert.equal(downsampled[0].metrics.arch, 'x86_64');

  // Minute 2 verification:
  assert.equal(downsampled[1].ts, baseTs + 64000);
  // cpu: avg(50, 70) = 60
  assert.equal(downsampled[1].metrics.cpu, 60);
  // net_in_speed: max(8000, 4000) = 8000
  assert.equal(downsampled[1].metrics.net_in_speed, 8000);
  // ping_ct: avg(50, 70) = 60
  assert.equal(downsampled[1].metrics.ping_ct, 60);

  // 3. Max buckets bound: verify capping at HISTORY_MAX_BATCH_BUCKETS (120)
  const manySamples = [];
  for (let m = 0; m < 150; m++) {
    manySamples.push({
      ts: baseTs + m * 60000,
      metrics: { cpu: 10 }
    });
  }
  const bounded = DatabaseService.downsampleHistorySamples(manySamples);
  assert.equal(bounded.length, 120);
  // Should keep the newest 120 buckets (m = 30 to 149)
  assert.equal(bounded[0].ts, baseTs + 30 * 60000);
  assert.equal(bounded[bounded.length - 1].ts, baseTs + 149 * 60000);
});
