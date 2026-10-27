import { makeD1 } from './helpers/d1.js';
import { FIELD_SETTINGS_GROUP } from '../src/utils/settingFields.js';
import { makeSqlStorage } from './helpers/sql-storage.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { MetricsBroadcaster } from '../src/durable/MetricsBroadcaster.js';
import { UpdateController } from '../src/handlers/UpdateController.js';
import { buildAuthCookie, generateToken } from '../src/middleware/auth.js';
import { NotificationService } from '../src/services/NotificationService.js';

const { getHistoryMetrics, handleUpdateWebSocketUpgrade, handleWebSocketUpgrade } = UpdateController;
const { buildResourceAlertNotificationPayloads } = NotificationService;
import { clearSiteSettingsCache, DEFAULT_NOTIFICATION_TEMPLATE, normalizeNotificationTemplate, normalizeResourceAlertRules } from '../src/utils/settings.js';
import { UPDATE_MAX_REQUEST_BYTES } from '../src/utils/config.js';

const NativeResponse = globalThis.Response;
globalThis.Response = class CustomResponse extends NativeResponse {
  constructor(body, init) {
    if (init && init.status === 101) {
      super(body, { ...init, status: 200 });
      Object.defineProperty(this, 'status', { value: 101, configurable: true });
      if (init.webSocket) this.webSocket = init.webSocket;
      return;
    }
    super(body, init);
  }
};

globalThis.WebSocketRequestResponsePair = class WebSocketRequestResponsePair {
  constructor(request, response) {
    this.request = request;
    this.response = response;
  }
};

globalThis.WebSocketPair = class WebSocketPair {
  constructor() {
    let attachment = null;
    const client = { send() {}, close() {} };
    const server = {
      send(data) {
        if (!this.sent) this.sent = [];
        this.sent.push(data);
      },
      close() {},
      serializeAttachment(val) { attachment = val; },
      deserializeAttachment() { return attachment; }
    };
    this[0] = client;
    this[1] = server;
  }
};

function makeBroadcaster(webSockets = [], env = { DB: {} }) {
  return new MetricsBroadcaster({
    setWebSocketAutoResponse() {},
    acceptWebSocket(ws) {
      webSockets.push(ws);
    },
    getWebSockets() {
      return webSockets;
    },
    storage: makeSqlStorage()
  }, env);
}

function makeSettingsDb(settingsSource) {
  const read = () => ({ jwt_secret: 'x'.repeat(32), ...(typeof settingsSource === 'function' ? settingsSource() : settingsSource || {}) });
  let previous = JSON.stringify(read());
  const db = makeD1({ settings: { site_options: previous } });
  const prepare = db.prepare.bind(db);
  db.prepare = sql => {
    const current = read();
    if (JSON.stringify(current) !== previous) {
      if (db.store.has('settings.schema')) {
        for (const [field, value] of Object.entries(current)) {
          const group = FIELD_SETTINGS_GROUP[field];
          if (!group) continue;
          db.store.set(group, JSON.stringify({ ...JSON.parse(db.store.get(group) || '{}'), [field]: value }));
        }
      } else db.store.set('site_options', JSON.stringify(current));
      previous = JSON.stringify(current);
    }
    return prepare(sql);
  };
  return db;
}

function makeDescriptor(md5 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', schemaVersion = 7) {
  const serialized = schemaVersion >= 7
    ? `collect_interval=2&report_interval=60&reset_day=1&schema_version=${schemaVersion}&custom_ct=&custom_cu=&custom_cm=&custom_bd=&interface=&node_1=&node_2=&node_3=&node_4=&connection_mode=auto&wss_report_interval=2&ping_mode=tcp`
    : schemaVersion >= 6
    ? `collect_interval=2&report_interval=60&reset_day=1&schema_version=${schemaVersion}&custom_ct=&custom_cu=&custom_cm=&custom_bd=&interface=&connection_mode=auto&wss_report_interval=2&ping_mode=tcp`
    : schemaVersion >= 5
    ? `collect_interval=2&report_interval=60&reset_day=1&schema_version=${schemaVersion}&custom_ct=&custom_cu=&custom_cm=&custom_bd=&interface=&connection_mode=auto&wss_report_interval=2`
    : schemaVersion >= 4
      ? `collect_interval=0&report_interval=60&reset_day=1&schema_version=${schemaVersion}&custom_ct=&custom_cu=&custom_cm=&custom_bd=&interface=&connection_mode=auto`
      : `collect_interval=0&report_interval=60&reset_day=1&schema_version=${schemaVersion}&custom_ct=&custom_cu=&custom_cm=&custom_bd=&interface=`;
  const config = {
    collect_interval: schemaVersion >= 5 ? 2 : 0,
    report_interval: 60,
    reset_day: 1,
    schema_version: schemaVersion,
    custom_ct: '',
    custom_cu: '',
    custom_cm: '',
    custom_bd: '',
    interface: ''
  };
  if (schemaVersion >= 4) {
    config.connection_mode = 'auto';
  }
  if (schemaVersion >= 5) {
    config.wss_report_interval = 2;
  }
  if (schemaVersion >= 6) {
    config.ping_mode = 'tcp';
  }
  if (schemaVersion >= 7) {
    config.node_1 = '';
    config.node_2 = '';
    config.node_3 = '';
    config.node_4 = '';
  }
  return {
    serialized,
    md5,
    config,
    correction: null
  };
}

function makeWebSocketUpgradeRequest(url, headers = {}) {
  return new Request(url, {
    headers: {
      Upgrade: 'websocket',
      ...headers
    }
  });
}

function makeWebSocketEnv(settings, onFetch = null) {
  return {
    API_SECRET: 'test-secret',
    DB: makeSettingsDb(settings),
    METRICS_BROADCASTER: {
      idFromName() {
        return 'global';
      },
      get() {
        return {
          async fetch(request) {
            if (onFetch) onFetch(request);
            return { status: 101 };
          }
        };
      }
    }
  };
}

test('private frontend WebSocket rejects unauthenticated clients', async () => {
  let forwarded = false;
  const env = makeWebSocketEnv({ is_public: 'false' }, () => {
    forwarded = true;
  });

  const response = await handleWebSocketUpgrade(
    makeWebSocketUpgradeRequest('https://example.com/api/ws?subscribe=all'),
    env
  );

  assert.equal(response.status, 401);
  assert.equal(forwarded, false);
});

test('Agent WSS upgrade rejects disabled state with fast-switch envelope', async () => {
  clearSiteSettingsCache();
  let forwarded = false;
  const response = await handleUpdateWebSocketUpgrade(
    makeWebSocketUpgradeRequest('https://example.com/update'),
    makeWebSocketEnv({
      wss_report_enabled: 'false'
    }, () => {
      forwarded = true;
    })
  );

  assert.equal(response.status, 409);
  assert.equal(response.headers.get('X-Agent-Wss-Mode'), 'disabled');
  assert.equal(response.headers.get('X-Agent-Wss-Reason'), 'wss_disabled');
  const body = await response.json();
  assert.equal(body.code, 409);
  assert.equal(body.text, 'wss_disabled');
  assert.equal(body.connection_mode, 'http');
  assert.equal(forwarded, false);
});

test('private frontend WebSocket accepts query token auth', async () => {
  let forwardedUrl = '';
  const env = makeWebSocketEnv({ is_public: 'false' }, request => {
    forwardedUrl = request.url;
  });
  const token = await generateToken(env, { jwt_secret: 'x'.repeat(32) });

  const response = await handleWebSocketUpgrade(
    makeWebSocketUpgradeRequest(`https://example.com/api/ws?subscribe=all&token=${encodeURIComponent(token)}`),
    env
  );

  assert.equal(response.status, 101);
  assert.equal(new URL(forwardedUrl).pathname, '/ws');
});

test('private frontend WebSocket accepts auth cookie', async () => {
  let forwarded = false;
  const env = makeWebSocketEnv({ is_public: 'false' }, () => {
    forwarded = true;
  });
  const token = await generateToken(env, { jwt_secret: 'x'.repeat(32) });
  const cookie = buildAuthCookie(new Request('https://example.com/admin'), token);

  const response = await handleWebSocketUpgrade(
    makeWebSocketUpgradeRequest('https://example.com/api/ws?subscribe=all', {
      Cookie: cookie
    }),
    env
  );

  assert.equal(response.status, 101);
  assert.equal(forwarded, true);
});

test('Agent WSS upgrade follows the configured report enabled setting', async () => {
  let forwarded = false;
  clearSiteSettingsCache();
  const enabledResponse = await handleUpdateWebSocketUpgrade(
    makeWebSocketUpgradeRequest('https://example.com/update'),
    makeWebSocketEnv({
      wss_report_enabled: 'true'
    }, () => {
      forwarded = true;
    })
  );

  assert.equal(enabledResponse.status, 101);
  assert.equal(forwarded, true);

  clearSiteSettingsCache();
  forwarded = false;
  const disabledResponse = await handleUpdateWebSocketUpgrade(
    makeWebSocketUpgradeRequest('https://example.com/update'),
    makeWebSocketEnv({
      wss_report_enabled: 'false'
    }, () => {
      forwarded = true;
    })
  );

  assert.equal(disabledResponse.status, 409);
  assert.equal(disabledResponse.headers.get('X-Agent-Wss-Mode'), 'disabled');
  assert.equal(disabledResponse.headers.get('X-Agent-Wss-Reason'), 'wss_disabled');
  const disabledBody = await disabledResponse.json();
  assert.equal(disabledBody.text, 'wss_disabled');
  assert.equal(disabledBody.connection_mode, 'http');
  assert.equal(forwarded, false);
});

test('Durable Object accepts Agent WSS upgrade when report is enabled', async () => {
  clearSiteSettingsCache();
  const sockets = [];
  const broadcaster = makeBroadcaster(sockets, {
    DB: makeSettingsDb({
      wss_report_enabled: 'true'
    })
  });

  const response = await broadcaster._handleAgentReportWebSocket(
    makeWebSocketUpgradeRequest('http://internal/update'),
    new URL('http://internal/update')
  );

  assert.equal(response.status, 101);
  assert.equal(broadcaster._getAgentReportWebSockets().length, 1);
});

test('Durable Object rejects Agent WSS upgrade when report is disabled', async () => {
  clearSiteSettingsCache();
  const broadcaster = makeBroadcaster([], {
    DB: makeSettingsDb({
      wss_report_enabled: 'false'
    })
  });

  const response = await broadcaster._handleAgentReportWebSocket(
    makeWebSocketUpgradeRequest('http://internal/update'),
    new URL('http://internal/update')
  );

  assert.equal(response.status, 409);
  assert.equal(response.headers.get('X-Agent-Wss-Mode'), 'disabled');
  assert.equal(response.headers.get('X-Agent-Wss-Reason'), 'wss_disabled');
  const body = await response.json();
  assert.equal(body.code, 409);
  assert.equal(body.text, 'wss_disabled');
  assert.equal(body.connection_mode, 'http');
  assert.equal(broadcaster._getAgentReportWebSockets().length, 0);
});

test('WSS agent config state only requests ack for fields in current report', () => {
  const broadcaster = makeBroadcaster();
  assert.deepEqual(
    broadcaster._getAgentConfigState({}, { configSchema: '3', configMd5: 'none' }),
    { schema: '3', md5: 'none', requested: false }
  );
  assert.deepEqual(
    broadcaster._getAgentConfigState({ config_md5: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, { configSchema: '3', configMd5: 'none' }),
    { schema: '3', md5: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', requested: true }
  );
});

test('WSS agent hibernation WebSocket preserves attachment state', async () => {
  const sockets = [];
  const broadcaster = makeBroadcaster(sockets);
  const sent = [];
  let attachment = { kind: 'agent-report' };
  const ws = {
    serializeAttachment(value) {
      attachment = value;
    },
    deserializeAttachment() {
      return attachment;
    },
    send(message) {
      sent.push(message);
    },
    close() {}
  };
  sockets.push(ws);

  broadcaster._handleAgentReportMessage = async (socket, rawMessage, att) => {
    assert.equal(rawMessage, '{"metrics":{}}');
    assert.equal(att.kind, 'agent-report');
    socket.serializeAttachment({ ...att, authenticated: true, serverId: 'server-1' });
    socket.send('ok');
  };

  await broadcaster.webSocketMessage(ws, '{"metrics":{}}');

  assert.equal(ws.deserializeAttachment().serverId, 'server-1');
  assert.deepEqual(sent, ['ok']);
});

test('WSS agent ack suggests configured realtime or idle report interval', () => {
  const broadcaster = makeBroadcaster();
  assert.equal(broadcaster._getAgentNextWssReportAfterMs(4000, 60000, true), 4000);
  assert.equal(broadcaster._getAgentNextWssReportAfterMs(4000, 30000, false), 60000);
  assert.equal(broadcaster._getAgentNextWssReportAfterMs(10_000, 120000, false), 120000);
  assert.equal(broadcaster._getAgentNextWssReportAfterMs(1000, 60000, true), 1000);
  assert.equal(broadcaster._getAgentNextWssReportAfterMs(3000, 60000, true), 3000);
  assert.equal(
    broadcaster._getAgentNextWssReportAfterMs(3000, 30000, {
      frontendActive: false,
      resourceAlertActive: true,
      realtimeActive: true
    }),
    60000
  );
  assert.equal(
    broadcaster._getAgentNextWssReportAfterMs(10_000, 120000, {
      frontendActive: false,
      resourceAlertActive: true,
      realtimeActive: true
    }),
    120000
  );
  assert.equal(
    broadcaster._getAgentNextWssReportAfterMs(4000, 120000, {
      frontendActive: true,
      resourceAlertActive: true,
      realtimeActive: true
    }),
    4000
  );
});

test('frontend realtime hint pushes active interval to connected agents', async () => {
  const sent = [];
  const agentWs = {
    deserializeAttachment() {
      return {
        kind: 'agent-report',
        authenticated: true,
        serverId: 'server-1',
        reportIntervalMs: 60000
      };
    },
    send(message) {
      sent.push(JSON.parse(message));
    }
  };
  const broadcaster = makeBroadcaster([agentWs]);
  broadcaster._getAgentHintReportIntervalMs = async () => 30000;

  const hinted = await broadcaster._hintAgentRealtimeIntervals({
    frontendActive: true,
    resourceAlertActive: false,
    realtimeActive: true
  });

  assert.equal(hinted, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'ack');
  assert.equal(sent[0].realtimeHint, true);
  assert.equal(sent[0].nextWssReportAfterMs, 30000);
});

test('WSS agent context uses current report interval from payload', async () => {
  const broadcaster = makeBroadcaster();
  broadcaster.agentServerDetails.set('server-1', {
    data: {
      id: 'server-1',
      history_partition_id: 42,
      report_interval: 60,
      wss_report_interval: 2
    },
    time: Date.now()
  });
  let serialized = null;
  const context = await broadcaster._resolveAgentContext({
    serializeAttachment(value) {
      serialized = value;
    }
  }, {
    kind: 'agent-report',
    authenticated: true,
    serverId: 'server-1',
    historyPartitionId: 42,
    reportIntervalMs: 60000,
    configSchema: '6',
    configMd5: 'none'
  }, {
    id: 'server-1',
    report_interval: 120
  });

  assert.equal(context.reportIntervalMs, 120000);
  assert.equal(context.wssReportIntervalMs, 2000);
  assert.equal(serialized.reportIntervalMs, 120000);
  assert.equal(serialized.wssReportIntervalMs, 2000);
});

test('WSS agent context keeps an authenticated session when server lookup throws', async () => {
  const closed = [];
  const broadcaster = makeBroadcaster([], {
    DB: {
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            throw new Error('D1_ERROR');
          }
        };
      }
    }
  });
  let serialized = null;

  const context = await broadcaster._resolveAgentContext({
    serializeAttachment(value) {
      serialized = value;
    },
    send() {},
    close(code, reason) {
      closed.push({ code, reason });
    }
  }, {
    kind: 'agent-report',
    authenticated: true,
    serverId: 'degraded-server',
    historyPartitionId: 12
  }, {
    id: 'degraded-server'
  });

  assert.ok(context);
  assert.equal(context.serverId, 'degraded-server');
  assert.equal(serialized.authenticated, true);
  assert.equal(closed.length, 0);
});

test('WSS agent context asks the agent to retry when lookup throws before auth', async () => {
  const sent = [];
  const closed = [];
  const broadcaster = makeBroadcaster([], {
    DB: {
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            throw new Error('D1_ERROR');
          }
        };
      }
    }
  });

  const context = await broadcaster._resolveAgentContext({
    serializeAttachment() {},
    send(message) {
      sent.push(JSON.parse(message));
    },
    close(code, reason) {
      closed.push({ code, reason });
    }
  }, {
    kind: 'agent-report',
    authenticated: false,
    serverId: ''
  }, {
    id: 'degraded-server-2'
  });

  assert.equal(context, null);
  assert.equal(sent[0].code, 503);
  assert.equal(closed[0].code, 1013);
});

test('WSS agent report rejects oversized frames before parsing', async () => {
  const sent = [];
  const closed = [];
  const broadcaster = makeBroadcaster();

  await broadcaster._handleAgentReportMessage({
    send(message) {
      sent.push(JSON.parse(message));
    },
    close(code, reason) {
      closed.push({ code, reason });
    }
  }, 'x'.repeat(UPDATE_MAX_REQUEST_BYTES + 1), {});

  assert.equal(sent[0].code, 413);
  assert.equal(sent[0].text, 'payload_too_large');
  assert.equal(closed[0].code, 1009);
});

test('WSS agent context closes and clears caches when server no longer exists', async () => {
  const sent = [];
  const closed = [];
  const broadcaster = makeBroadcaster([], {
    DB: makeD1()
  });
  broadcaster.agentServerDetails.set('deleted-server-test', {
    data: { id: 'deleted-server-test' },
    time: Date.now() - 121 * 1000
  });
  broadcaster.agentHistoryWrites.set('deleted-server-test', {});
  broadcaster.latestReportUpdates.set('deleted-server-test', {});

  const context = await broadcaster._resolveAgentContext({
    serializeAttachment() {
      throw new Error('attachment should not be serialized for a deleted server');
    },
    send(message) {
      sent.push(JSON.parse(message));
    },
    close(code, reason) {
      closed.push({ code, reason });
    }
  }, {
    kind: 'agent-report',
    authenticated: true,
    serverId: 'deleted-server-test'
  }, {
    id: 'deleted-server-test'
  });

  assert.equal(context, null);
  assert.equal(sent[0].type, 'error');
  assert.equal(sent[0].code, 404);
  assert.equal(sent[0].text, 'server_not_found');
  assert.equal(closed[0].code, 1008);
  assert.equal(broadcaster.agentServerDetails.has('deleted-server-test'), false);
  assert.equal(broadcaster.agentHistoryWrites.has('deleted-server-test'), false);
  assert.equal(broadcaster.latestReportUpdates.has('deleted-server-test'), false);
});

test('WSS agent config ack is skipped when report omits config state', async () => {
  const broadcaster = makeBroadcaster();
  let loads = 0;
  broadcaster._loadAgentConfigDescriptor = async () => {
    loads += 1;
    return makeDescriptor();
  };

  const ack = await broadcaster._buildAgentConfigAck({
    attachment: {
      configSchema: '3',
      configMd5: 'none'
    },
    serverId: 'server-1',
    agentConfig: { schema: '6', md5: 'none', requested: false }
  });

  assert.equal(loads, 0);
  assert.equal(ack, null);
});

test('WSS agent config ack is built when report includes config state', async () => {
  const broadcaster = makeBroadcaster();
  let loads = 0;
  broadcaster._loadAgentConfigDescriptor = async () => {
    loads += 1;
    return makeDescriptor();
  };

  const ack = await broadcaster._buildAgentConfigAck({
    attachment: {},
    serverId: 'server-1',
    agentConfig: { schema: '6', md5: 'none', requested: true }
  });

  assert.equal(loads, 1);
  assert.equal(ack.has_config, true);
  assert.equal(ack.config_md5, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(ack.body, makeDescriptor().serialized);
  assert.equal(ack.config_body, makeDescriptor().serialized);
  assert.equal(ack.payload.report_interval, 60);
  assert.equal(ack.payload.connection_mode, 'auto');
  assert.equal(ack.payload.ping_mode, 'tcp');
  assert.equal(Object.prototype.hasOwnProperty.call(ack, 'config'), false);
});

test('WSS schema 4 agent with matching legacy MD5 does not receive config again', async () => {
  const descriptor = makeDescriptor('dddddddddddddddddddddddddddddddd', 4);
  const broadcaster = makeBroadcaster();
  broadcaster._loadAgentConfigDescriptor = async (_serverId, _forceRefresh, schemaVersion) => {
    assert.equal(schemaVersion, 4);
    return descriptor;
  };

  const ack = await broadcaster._buildAgentConfigAck({
    attachment: {},
    serverId: 'server-1',
    agentConfig: { schema: '4', md5: descriptor.md5, requested: true }
  });

  assert.equal(ack.has_config, false);
  assert.equal(ack.config_md5, descriptor.md5);
  assert.equal(Object.prototype.hasOwnProperty.call(ack, 'body'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(ack, 'payload'), false);
});

test('WSS agent config push uses string body and structured payload', () => {
  const sent = [];
  const ws = {
    deserializeAttachment() {
      return {
        kind: 'agent-report',
        authenticated: true,
        serverId: 'server-1',
        configSchema: '7',
        configMd5: 'none'
      };
    },
    send(message) {
      sent.push(JSON.parse(message));
    }
  };
  const broadcaster = makeBroadcaster([ws]);

  const result = broadcaster._pushAgentConfigFrame('server-1', makeDescriptor());

  assert.deepEqual(result, { matched: 1, delivered: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'config');
  assert.equal(sent[0].body, makeDescriptor().serialized);
  assert.equal(sent[0].config_body, makeDescriptor().serialized);
  assert.equal(sent[0].payload.report_interval, 60);
  assert.equal(sent[0].payload.connection_mode, 'auto');
  assert.equal(sent[0].payload.ping_mode, 'tcp');
  assert.equal(Object.prototype.hasOwnProperty.call(sent[0], 'config'), false);
});

test('WSS agent config push keeps legacy schema without connection mode', () => {
  const sent = [];
  const ws = {
    deserializeAttachment() {
      return {
        kind: 'agent-report',
        authenticated: true,
        serverId: 'server-1',
        configSchema: '3',
        configMd5: 'none'
      };
    },
    send(message) {
      sent.push(JSON.parse(message));
    }
  };
  const broadcaster = makeBroadcaster([ws]);
  const descriptors = new Map([
    [7, makeDescriptor('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 7)],
    [5, makeDescriptor('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 5)],
    [4, makeDescriptor('dddddddddddddddddddddddddddddddd', 4)],
    [3, makeDescriptor('cccccccccccccccccccccccccccccccc', 3)]
  ]);

  const result = broadcaster._pushAgentConfigFrame('server-1', descriptors);

  assert.deepEqual(result, { matched: 1, delivered: 1 });
  assert.equal(sent[0].config_schema, 3);
  assert.equal(sent[0].body, makeDescriptor('cccccccccccccccccccccccccccccccc', 3).serialized);
  assert.equal(Object.prototype.hasOwnProperty.call(sent[0].payload, 'connection_mode'), false);
});

test('WSS agent config descriptor force refreshes site settings', async () => {
  let wssReportEnabled = 'true';
  const broadcaster = makeBroadcaster([], {
    DB: makeSettingsDb(() => ({ wss_report_enabled: wssReportEnabled }))
  });
  broadcaster._getAgentServerDetail = async () => ({
    id: 'server-1',
    collect_interval: 0,
    report_interval: 60,
    reset_day: 1,
    connection_mode: 'auto'
  });

  let descriptor = await broadcaster._loadAgentConfigDescriptor('server-1', true, 4);
  assert.equal(descriptor.config.connection_mode, 'auto');

  wssReportEnabled = 'false';
  descriptor = await broadcaster._loadAgentConfigDescriptor('server-1', true, 4);
  assert.equal(descriptor.config.connection_mode, 'http');
});

test('agent report mode change closes existing Agent WSS when disabled', async () => {
  const sent = [];
  const closed = [];
  const agentWs = {
    deserializeAttachment() {
      return {
        kind: 'agent-report',
        authenticated: true,
        serverId: 'server-1'
      };
    },
    send(message) {
      sent.push(JSON.parse(message));
    },
    close(code, reason) {
      closed.push({ code, reason });
    }
  };
  const frontendWs = {
    deserializeAttachment() {
      return { scope: 'all' };
    },
    send() {
      throw new Error('frontend socket should not receive agent mode messages');
    },
    close() {
      throw new Error('frontend socket should not be closed');
    }
  };
  const broadcaster = makeBroadcaster([agentWs, frontendWs], {
    DB: makeSettingsDb({ wss_report_enabled: 'false' })
  });

  const response = await broadcaster._handleAgentConfigChanged(new Request('http://internal/agent-config-changed', {
    method: 'POST',
    body: JSON.stringify({ agentReportModeChanged: true })
  }));
  const body = await response.json();

  assert.deepEqual(body, {
    ok: true,
    wssReportEnabled: false,
    matched: 1,
    closed: 1
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'error');
  assert.equal(sent[0].code, 409);
  assert.equal(sent[0].text, 'wss_disabled');
  assert.equal(sent[0].connection_mode, 'http');
  assert.deepEqual(closed, [{
    code: 1013,
    reason: 'wss_disabled'
  }]);
});

test('alarm closes existing Agent WSS when report is disabled', async () => {
  clearSiteSettingsCache();
  const sent = [];
  const closed = [];
  let attachment = {
    kind: 'agent-report',
    authenticated: true,
    serverId: 'server-1'
  };
  const ws = {
    serializeAttachment(value) {
      attachment = value;
    },
    deserializeAttachment() {
      return attachment;
    },
    send(message) {
      sent.push(JSON.parse(message));
    },
    close(code, reason) {
      closed.push({ code, reason });
    }
  };
  const broadcaster = makeBroadcaster([ws], {
    DB: makeSettingsDb({
      wss_report_enabled: 'false'
    })
  });

  await broadcaster.alarm();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'error');
  assert.equal(sent[0].code, 409);
  assert.equal(sent[0].text, 'wss_disabled');
  assert.equal(sent[0].connection_mode, 'http');
  assert.deepEqual(closed, [{
    code: 1013,
    reason: 'wss_disabled'
  }]);
});

test('batch push latestReportOnly keeps latest report updates without subscribers', async () => {
  const broadcaster = makeBroadcaster([]);
  const response = await broadcaster.fetch(new Request('http://internal/batch-push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      latestReportOnly: true,
      updates: [{
        serverId: 'server-1',
        samples: [
          { ts: 1_000, payload: { cpu: 10, net_in_speed: 100 } },
          { ts: 2_000, payload: { cpu: 20, net_in_speed: 200 } }
        ]
      }]
    })
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.latestReportOnly, true);
  assert.equal(body.subscribers, 0);

  const latestResponse = await broadcaster.fetch(new Request('http://internal/latest-report-updates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverIds: ['server-1'] })
  }));
  const latest = await latestResponse.json();

  assert.equal(latestResponse.status, 200);
  assert.equal(latest.updates.length, 1);
  assert.equal(latest.updates[0].serverId, 'server-1');
  assert.equal(latest.updates[0].samples.length, 2);
  assert.deepEqual(latest.updates[0].samples.map(sample => sample.data.cpu), [10, 20]);
  assert.equal(Number.isFinite(latest.updates[0].reportAgeMs), true);
});

test('Agent WSS batches all-scope subscribers while single-server subscribers stay realtime', async () => {
  const allMessages = [];
  const singleMessages = [];
  const makeFrontendSocket = (attachment, messages) => ({
    deserializeAttachment() {
      return attachment;
    },
    send(message) {
      messages.push(JSON.parse(message));
    }
  });
  const broadcaster = makeBroadcaster([
    makeFrontendSocket({ scope: 'all', serverIds: ['server-1', 'server-2'], accessVersion: 1, allowedServerIds: ['server-1', 'server-2'] }, allMessages),
    makeFrontendSocket({ scope: 'server-1', serverIds: [], accessVersion: 1, allowedServerIds: ['server-1'] }, singleMessages)
  ]);

  await broadcaster._ingestRealtimeUpdates([{
    serverId: 'server-1',
    samples: [{ ts: 2_000, data: { cpu: 20 } }]
  }], 10_000, { batchFrontend: true });
  await broadcaster._ingestRealtimeUpdates([{
    serverId: 'server-1',
    samples: [{ ts: 1_000, data: { cpu: 10 } }]
  }, {
    serverId: 'server-2',
    samples: [{ ts: 3_000, data: { cpu: 30 } }]
  }], 20_000, { batchFrontend: true });

  assert.equal(allMessages.length, 0);
  assert.equal(singleMessages.length, 2);
  assert.deepEqual(singleMessages.map(message => message.updates[0].samples[0].data.cpu), [20, 10]);
  assert.equal(singleMessages.every(message => message.updates.length === 1), true);
  assert.notEqual(broadcaster.frontendBroadcastTimer, null);

  await broadcaster._flushFrontendBroadcastBatch();

  assert.equal(allMessages.length, 1);
  assert.equal(allMessages[0].type, 'batchUpdate');
  assert.equal(allMessages[0].ts, 20_000);
  assert.deepEqual(allMessages[0].updates.map(update => update.serverId), ['server-1', 'server-2']);
  assert.deepEqual(allMessages[0].updates[0].samples.map(sample => sample.ts), [1_000, 2_000]);
  assert.deepEqual(allMessages[0].updates[0].samples.map(sample => sample.data.cpu), [10, 20]);

  assert.equal(singleMessages.length, 2);
  assert.equal(broadcaster.pendingFrontendBroadcasts.size, 0);
  assert.equal(broadcaster.frontendBroadcastTimer, null);
});

test('Agent WSS frontend batch queue stays idle without frontend subscribers', () => {
  const broadcaster = makeBroadcaster([]);

  broadcaster._queueFrontendBroadcastBatch([{
    serverId: 'server-1',
    samples: [{ ts: 1_000, data: { cpu: 10 } }]
  }], 10_000);

  assert.equal(broadcaster.pendingFrontendBroadcasts.size, 0);
  assert.equal(broadcaster.frontendBroadcastTimer, null);
});

test('Agent WSS handshake hello frame includes initial realtimeHint and nextWssReportAfterMs', async () => {
  clearSiteSettingsCache();
  // 1. Without frontend subscriber: idle mode
  const sockets1 = [];
  const broadcasterIdle = makeBroadcaster(sockets1, {
    DB: makeSettingsDb({ wss_report_enabled: 'true' })
  });

  const resIdle = await broadcasterIdle._handleAgentReportWebSocket(
    makeWebSocketUpgradeRequest('http://internal/update'),
    new URL('http://internal/update')
  );
  assert.equal(resIdle.status, 101);
  const serverWsIdle = sockets1[0];
  assert.equal(serverWsIdle.sent.length, 1);
  const helloIdle = JSON.parse(serverWsIdle.sent[0]);
  assert.equal(helloIdle.type, 'hello');
  assert.equal(helloIdle.realtimeHint, false);
  assert.equal(helloIdle.nextWssReportAfterMs, 60000);

  // 2. With frontend subscriber: realtime mode
  const sockets2 = [{
    deserializeAttachment() {
      return { scope: 'all' };
    }
  }];
  const broadcasterRealtime = makeBroadcaster(sockets2, {
    DB: makeSettingsDb({ wss_report_enabled: 'true' })
  });

  const resRealtime = await broadcasterRealtime._handleAgentReportWebSocket(
    makeWebSocketUpgradeRequest('http://internal/update'),
    new URL('http://internal/update')
  );
  assert.equal(resRealtime.status, 101);
  const serverWsRealtime = sockets2[1];
  assert.equal(serverWsRealtime.sent.length, 1);
  const helloRealtime = JSON.parse(serverWsRealtime.sent[0]);
  assert.equal(helloRealtime.type, 'hello');
  assert.equal(helloRealtime.realtimeHint, true);
  assert.equal(helloRealtime.nextWssReportAfterMs, 2000);
});

test('webSocketClose of frontend connection hints connected agents to drop to idle batch mode', async () => {
  const agentSent = [];
  const agentWs = {
    deserializeAttachment() {
      return {
        kind: 'agent-report',
        authenticated: true,
        serverId: 'server-1',
        reportIntervalMs: 60000,
        wssReportIntervalMs: 2000
      };
    },
    send(msg) {
      agentSent.push(JSON.parse(msg));
    }
  };
  const frontendWs = {
    deserializeAttachment() {
      return { scope: 'all' };
    }
  };

  const sockets = [agentWs, frontendWs];
  const broadcaster = makeBroadcaster(sockets);

  // Frontend disconnects: remove frontendWs from sockets
  sockets.splice(1, 1);
  await broadcaster.webSocketClose(frontendWs, 1000, 'normal close');

  // Agent should receive ack frame with realtimeHint: false and 60000ms
  assert.equal(agentSent.length, 1);
  assert.equal(agentSent[0].type, 'ack');
  assert.equal(agentSent[0].ackFor, 'mode');
  assert.equal(typeof agentSent[0].modeRevision, 'number');
  assert.equal(agentSent[0].realtimeHint, false);
  assert.equal(agentSent[0].nextWssReportAfterMs, 60000);
  assert.equal(agentSent[0].reportId, undefined);
  assert.equal(agentSent[0].accepted, undefined);
  assert.equal(agentSent[0].persisted, undefined);
});

test('Multi-dashboard subscriptions: mode stays realtime until the last frontend disconnects', async () => {
  const agentSent = [];
  const agentWs = {
    deserializeAttachment() {
      return {
        kind: 'agent-report',
        authenticated: true,
        serverId: 'server-1',
        reportIntervalMs: 60000,
        wssReportIntervalMs: 2000
      };
    },
    send(msg) {
      agentSent.push(JSON.parse(msg));
    }
  };
  const frontendWs1 = {
    deserializeAttachment() {
      return { scope: 'all' };
    }
  };
  const frontendWs2 = {
    deserializeAttachment() {
      return { scope: 'all' };
    }
  };

  const sockets = [agentWs, frontendWs1, frontendWs2];
  const broadcaster = makeBroadcaster(sockets);

  // Set initial active state
  broadcaster.lastModeState = true;
  const initialRevision = broadcaster.modeRevision;

  // First dashboard closes: remaining frontend count is 1 (> 0)
  sockets.splice(1, 1); // remove frontendWs1
  await broadcaster.webSocketClose(frontendWs1, 1000, 'tab closed');

  // Agent should NOT receive mode downgrade because frontendWs2 is still connected!
  assert.equal(agentSent.length, 0);
  assert.equal(broadcaster.lastModeState, true);
  assert.equal(broadcaster.modeRevision, initialRevision);

  // Second (last) dashboard closes: remaining frontend count is 0
  sockets.splice(1, 1); // remove frontendWs2
  await broadcaster.webSocketClose(frontendWs2, 1000, 'tab closed');

  // Agent should now receive mode downgrade
  assert.equal(agentSent.length, 1);
  assert.equal(agentSent[0].type, 'ack');
  assert.equal(agentSent[0].ackFor, 'mode');
  assert.equal(agentSent[0].realtimeHint, false);
  assert.equal(agentSent[0].nextWssReportAfterMs, 60000);
  assert.equal(agentSent[0].modeRevision, initialRevision + 1);
  assert.equal(broadcaster.lastModeState, false);
});

test('modeRevision monotonically increments on visitor state transitions', async () => {
  const agentSent = [];
  const agentWs = {
    deserializeAttachment() {
      return {
        kind: 'agent-report',
        authenticated: true,
        serverId: 'server-1',
        reportIntervalMs: 60000,
        wssReportIntervalMs: 2000
      };
    },
    send(msg) {
      agentSent.push(JSON.parse(msg));
    }
  };
  const sockets = [agentWs];
  const broadcaster = makeBroadcaster(sockets);

  // Start with idle (false)
  broadcaster.lastModeState = false;
  broadcaster.modeRevision = 10;

  // 1. Visitor joins: transition to true
  await broadcaster._hintAgentRealtimeIntervals({ frontendActive: true });
  assert.equal(agentSent.length, 1);
  assert.equal(agentSent[0].ackFor, 'mode');
  assert.equal(agentSent[0].modeRevision, 11);
  assert.equal(agentSent[0].realtimeHint, true);

  // Another hint with the same active state does NOT increment revision
  await broadcaster._hintAgentRealtimeIntervals({ frontendActive: true });
  assert.equal(agentSent.length, 1);

  // 2. Visitor leaves: transition to false
  await broadcaster._hintAgentRealtimeIntervals({ frontendActive: false });
  assert.equal(agentSent.length, 2);
  assert.equal(agentSent[1].ackFor, 'mode');
  assert.equal(agentSent[1].modeRevision, 12);
  assert.equal(agentSent[1].realtimeHint, false);
});

test('reportId batch idempotency and conflict rejection', async () => {
  const savedBatches = [];
  const fakeDb = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              return { success: true };
            },
            async first() {
              return null;
            }
          };
        },
        async first() {
          return null;
        }
      };
    },
    async batch(statements) {
      savedBatches.push(statements);
      return statements.map(() => ({ success: true }));
    }
  };

  const broadcaster = makeBroadcaster([], { DB: fakeDb });
  broadcaster._getAgentServerDetail = async () => ({
    id: 'server-1',
    secret: 'test-secret',
    history_partition_id: 1,
    report_interval: 60,
    wss_report_interval: 2
  });

  const agentSent = [];
  const closed = [];
  const ws = {
    deserializeAttachment() {
      return {
        kind: 'agent-report',
        authenticated: true,
        serverId: 'server-1',
        historyPartitionId: 1
      };
    },
    serializeAttachment() {},
    send(msg) {
      agentSent.push(JSON.parse(msg));
    },
    close(code, reason) {
      closed.push({ code, reason });
    }
  };

  const batchPayload = {
    id: 'server-1',
    secret: 'test-secret',
    reportId: 'rep-001',
    batch: true,
    metrics: { cpu: '10' },
    samples: [
      { ts: 1729800002000, metrics: { cpu: '10' } },
      { ts: 1729800004000, metrics: { cpu: '15' } }
    ]
  };

  // First submission: should succeed and write to D1
  await broadcaster._handleAgentReportMessage(ws, JSON.stringify(batchPayload));
  assert.equal(agentSent.length, 1);
  assert.equal(agentSent[0].type, 'ack');
  assert.equal(agentSent[0].ackFor, 'report');
  assert.equal(agentSent[0].reportId, 'rep-001');
  assert.equal(agentSent[0].accepted, true);
  assert.equal(agentSent[0].persisted, true);
  assert.equal(agentSent[0].acceptedSamples, 2);
  assert.equal(agentSent[0].realtimeHint, undefined);
  assert.equal(agentSent[0].nextWssReportAfterMs, undefined);
  assert.equal(savedBatches.length, 0); // 0 D1 writes (metrics stored exclusively in DO)

  // Duplicate submission with identical content: idempotent retry, no new D1 write
  await broadcaster._handleAgentReportMessage(ws, JSON.stringify(batchPayload));
  assert.equal(agentSent.length, 2);
  assert.equal(agentSent[1].ackFor, 'report');
  assert.equal(agentSent[1].reportId, 'rep-001');
  assert.equal(agentSent[1].accepted, true);
  assert.equal(agentSent[1].persisted, true);
  assert.equal(agentSent[1].acceptedSamples, 2);
  assert.equal(savedBatches.length, 0); // Still 0! No D1 batch written!

  // Conflicting submission with same reportId but altered content: must be rejected with 400
  const conflictingPayload = {
    ...batchPayload,
    samples: [
      { ts: 1729800002000, metrics: { cpu: '99' } }
    ]
  };
  await broadcaster._handleAgentReportMessage(ws, JSON.stringify(conflictingPayload));
  assert.equal(closed.length, 1);
  assert.equal(closed[0].code, 1008);
});

test('Batch persistence succeeds with DO storage regardless of D1 state', async () => {
  const failingDb = {
    prepare() {
      return {
        bind() {
          return {
            async run() {},
            async first() { return null; }
          };
        },
        async first() { return null; }
      };
    },
    async batch() {
      throw new Error('D1 transaction aborted');
    }
  };

  const broadcaster = makeBroadcaster([], { DB: failingDb });
  broadcaster._getAgentServerDetail = async () => ({
    id: 'server-1',
    secret: 'test-secret',
    history_partition_id: 1,
    report_interval: 60,
    wss_report_interval: 2
  });

  const agentSent = [];
  const ws = {
    deserializeAttachment() {
      return {
        kind: 'agent-report',
        authenticated: true,
        serverId: 'server-1',
        historyPartitionId: 1
      };
    },
    serializeAttachment() {},
    send(msg) {
      agentSent.push(JSON.parse(msg));
    },
    close() {}
  };

  const batchPayload = {
    id: 'server-1',
    secret: 'test-secret',
    reportId: 'rep-fail-01',
    batch: true,
    metrics: { cpu: '10' },
    samples: [
      { ts: 1729800002000, metrics: { cpu: '10' } },
      { ts: 1729800004000, metrics: { cpu: '15' } }
    ]
  };

  await broadcaster._handleAgentReportMessage(ws, JSON.stringify(batchPayload));
  assert.equal(agentSent.length, 1);
  assert.equal(agentSent[0].type, 'ack');
  assert.equal(agentSent[0].ackFor, 'report');
  assert.equal(agentSent[0].reportId, 'rep-fail-01');
  assert.equal(agentSent[0].accepted, true);
  assert.equal(agentSent[0].persisted, true);
  assert.equal(agentSent[0].acceptedSamples, 2);
});

test('resource alert rule batches are capped at 20 rules', () => {
  const broadcaster = makeBroadcaster();
  const makeRule = index => ({
    ruleId: `rule-${index}`,
    serverIds: ['server-1'],
    mode: 'average',
    windowMinutes: 5,
    thresholds: { cpuPercent: 80 }
  });

  assert.equal(
    broadcaster._normalizeResourceAlertEvaluationRules(Array.from({ length: 20 }, (_, index) => makeRule(index))).ok,
    true
  );
  assert.equal(
    broadcaster._normalizeResourceAlertEvaluationRules(Array.from({ length: 21 }, (_, index) => makeRule(index))).ok,
    false
  );
});

test('resource alert batch evaluation returns results per rule', async () => {
  const broadcaster = makeBroadcaster();
  const now = Date.now();
  const currentMinute = Math.floor(now / 60_000) * 60_000;
  const samples = [];
  for (let index = 4; index >= 0; index--) {
    const ts = currentMinute - index * 60_000;
    samples.push({
      ts,
      minuteTs: ts,
      cpu: 90,
      ram: 30,
      disk: 40,
      netIn: 0,
      netOut: 0,
      netTotal: 0
    });
  }
  broadcaster.resourceAlertWindows.set('server-1', { samples });

  const result = await broadcaster._evaluateResourceAlertRules([
    {
      ruleId: 'cpu-rule',
      serverIds: ['server-1'],
      mode: 'average',
      windowMinutes: 5,
      thresholds: { cpuPercent: 80 }
    },
    {
      ruleId: 'ram-rule',
      serverIds: ['server-1'],
      mode: 'average',
      windowMinutes: 5,
      thresholds: { ramPercent: 80 }
    }
  ]);

  const byRule = new Map(result.results.map(item => [item.ruleId, item]));
  assert.equal(byRule.get('cpu-rule').alerts.length, 1);
  assert.deepEqual(byRule.get('cpu-rule').evaluatedServerIds, ['server-1']);
  assert.equal(byRule.get('ram-rule').alerts.length, 0);
  assert.deepEqual(byRule.get('ram-rule').evaluatedServerIds, ['server-1']);
});

test('resource alert notification payloads group metrics by server and split long batches', () => {
  const alertNodes = [];
  alertNodes.push({
    rule: { name: 'CPU Alert', intervalMinutes: '5' },
    server: { name: 'shared-server' },
    alert: {
      mode: 'average',
      metrics: [{ metric: 'cpu', mode: 'average', threshold: 1, current: 1.05, triggerValue: 1.05 }]
    }
  });
  alertNodes.push({
    rule: { name: 'RAM Alert', intervalMinutes: '5' },
    server: { name: 'shared-server' },
    alert: {
      mode: 'average',
      metrics: [{ metric: 'ram', mode: 'average', threshold: 1, current: 42.7, triggerValue: 42.7 }]
    }
  });
  for (let index = 0; index < 180; index++) {
    alertNodes.push({
      rule: { name: 'RAM Alert', intervalMinutes: '5' },
      server: { name: `ram-server-${String(index).padStart(2, '0')}` },
      alert: {
        mode: 'average',
        metrics: [{ metric: 'ram', mode: 'average', threshold: 1, current: 80, triggerValue: 80 }]
      }
    });
  }
  alertNodes.push({
    rule: { name: 'CPU Alert', intervalMinutes: '5' },
    server: { name: 'cpu-server' },
    alert: {
      mode: 'average',
      metrics: [{ metric: 'cpu', mode: 'average', threshold: 1, current: 90, triggerValue: 90 }]
    }
  });

  const payloads = buildResourceAlertNotificationPayloads(alertNodes, [], '2026/08/20 12:00:00');

  assert.equal(payloads.length > 1, true);
  assert.equal(payloads.some(payload => payload.msg.includes('shared-server  CPU 1.05%  RAM 42.7%')), true);
  assert.equal(payloads.some(payload => payload.msg.includes('cpu-server  CPU 90.0%')), true);
  assert.equal(payloads.every(payload => payload.msg.length <= 3200), true);
});

test('legacy default notification template normalizes to concise default', () => {
  const legacy = '{{emoji}}【CF Server Monitor】{{event}}\n服务器: {{client}}\n详情:\n{{message}}\n时间: {{time}}';
  const previousConcise = '{{emoji}}【CF Server Monitor】{{event}}\n\n{{message}}\n\n时间: {{time}}';
  assert.equal(normalizeNotificationTemplate(legacy), DEFAULT_NOTIFICATION_TEMPLATE);
  assert.equal(normalizeNotificationTemplate(previousConcise), DEFAULT_NOTIFICATION_TEMPLATE);
  assert.equal(DEFAULT_NOTIFICATION_TEMPLATE.includes('服务器:'), false);
  assert.equal(DEFAULT_NOTIFICATION_TEMPLATE.includes('时间:'), false);
  assert.equal(DEFAULT_NOTIFICATION_TEMPLATE.includes('{{message}}'), true);
});

test('resource alert rule ids remain unique when duplicate ids are already max length', () => {
  const id = 'a'.repeat(64);
  const rules = normalizeResourceAlertRules([
    { id, metric: 'cpu', threshold: 80, servers: ['server-1'], intervalMinutes: 5 },
    { id, metric: 'ram', threshold: 80, servers: ['server-1'], intervalMinutes: 5 }
  ]);

  assert.equal(rules.length, 2);
  assert.notEqual(rules[0].id, rules[1].id);
  assert.equal(rules.every(rule => rule.id.length <= 64), true);
});

test('resource alert cache accepts payload samples from WSS broadcasts', async () => {
  const broadcaster = makeBroadcaster();
  const now = Date.now();
  const currentMinute = Math.floor(now / 60_000) * 60_000;

  await broadcaster._cacheResourceAlertSamples([{
    serverId: 'server-1',
    samples: [
      {
        ts: currentMinute - 60_000,
        payload: {
          cpu: 90,
          ram_total: 100,
          ram_used: 90,
          disk_total: 100,
          disk_used: 40,
          net_in_speed: 0,
          net_out_speed: 0
        }
      },
      {
        ts: currentMinute,
        payload: {
          cpu: 92,
          ram_total: 100,
          ram_used: 91,
          disk_total: 100,
          disk_used: 40,
          net_in_speed: 0,
          net_out_speed: 0
        }
      }
    ]
  }], now);

  const result = broadcaster._evaluateResourceAlertRule({
    ruleId: 'cpu-ram-rule',
    serverIds: ['server-1'],
    mode: 'average',
    windowMinutes: 5,
    thresholds: {
      cpuPercent: 80,
      ramPercent: 80
    }
  }, now);

  assert.deepEqual(result.evaluatedServerIds, ['server-1']);
  assert.equal(result.alerts.length, 1);
  assert.deepEqual(result.alerts[0].metrics.map(metric => metric.metric), ['cpu', 'ram']);
});

test('history metrics apply configured aggregation policies to batched POST samples', () => {
  const samples = [
    {
      ts: 1,
      metrics: {
        cpu: 20,
        ping_ct: 10,
        net_in_speed: 1024,
        net_out_speed: 2048,
        tcp_conn: 10,
        net_rx: 1000,
        disk: { read_bps: 1024 }
      }
    },
    {
      ts: 2,
      metrics: {
        cpu: 30,
        ping_ct: 20,
        net_in_speed: 40 * 1024 * 1024,
        net_out_speed: 4096,
        tcp_conn: 30,
        net_rx: 2000,
        disk: { read_bps: 80 * 1024 * 1024 }
      }
    },
    {
      ts: 3,
      metrics: {
        cpu: 40,
        ping_ct: 30,
        net_in_speed: 8192,
        net_out_speed: 8 * 1024 * 1024,
        tcp_conn: 20,
        net_rx: 3000,
        disk: { read_bps: 4 * 1024 * 1024 }
      }
    }
  ];

  const metrics = getHistoryMetrics({
    metrics: {
      cpu: 10,
      net_in_speed: 512,
      net_out_speed: 512
    }
  }, samples, samples[samples.length - 1]);

  assert.equal(metrics.cpu, 30);
  assert.equal(metrics.ping_ct, 20);
  assert.equal(metrics.net_in_speed, 40 * 1024 * 1024);
  assert.equal(metrics.net_out_speed, 8 * 1024 * 1024);
  assert.equal(metrics.tcp_conn, 30);
  assert.equal(metrics.net_rx, 3000);
  assert.equal(metrics.disk_read_bps, 80 * 1024 * 1024);
  assert.equal(metrics.disk.read_bps, 80 * 1024 * 1024);
});

test('concurrent reports in the same minute retain weighted averages and peak metrics', async () => {
  const broadcaster = makeBroadcaster();
  const now = Math.floor(Date.now() / 60000) * 60000 + 1000;
  await Promise.all([10, 20, 60].map((cpu, index) => broadcaster._persistUpdates([{
    serverId: 'server-1', samples: [{ ts: now + index, data: { cpu, net_in_speed: index === 0 ? 5000 : 1 } }]
  }], `report-${index}`)));
  const rows = await broadcaster.metricsStore.history('server-1', { now: now + 3 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cpu, 30);
  assert.equal(rows[0].net_in_speed, 5000);
});

test('acknowledged reports remain idempotent after the broadcaster is recreated', async () => {
  const broadcaster = makeBroadcaster();
  const now = Date.now();
  const updates = [{ serverId: 'server-1', samples: [{ ts: now, data: { cpu: 10 } }] }];
  await broadcaster._persistUpdates(updates, 'restart-report');
  const restarted = new MetricsBroadcaster(broadcaster.state, broadcaster.env);
  assert.equal((await restarted._persistUpdates(updates, 'restart-report')).duplicate, true);
  const rows = await restarted.metricsStore.history('server-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cpu, 10);
});
