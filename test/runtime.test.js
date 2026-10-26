import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('workerd: HTTP persistence, restart, retry, legacy migration and WebSocket visibility', { timeout: 60_000 }, async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const directory = await mkdtemp(path.join(tmpdir(), 'cfsm-runtime-'));
  const bundle = await build({ entryPoints: [path.join(root, 'test/fixtures/runtime-worker.js')],
    bundle: true, format: 'esm', platform: 'browser', external: ['node:*', 'cloudflare:*'], write: false });
  const options = {
    name: 'cfsm-runtime',
    modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2024-12-01', compatibilityFlags: ['nodejs_compat'],
    bindings: { API_SECRET: 'runtime-secret', LOG_LEVEL: 'debug' },
    d1Databases: { DB: '11111111-1111-1111-1111-111111111111' },
    durableObjects: { METRICS_BROADCASTER: { className: 'RuntimeBroadcaster', useSQLite: true, unsafeUniqueKey: 'cfsm-runtime-metrics' } },
    resourcePersistencePath: directory
  };
  let mf;
  const sockets = [];
  try {
    mf = new Miniflare(options);
    const db = await mf.getD1Database('DB');
    await db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE servers (id TEXT PRIMARY KEY, name TEXT, is_hidden TEXT DEFAULT '0', secret TEXT, history_partition_id INTEGER, sort_order INTEGER DEFAULT 0);`);
    await db.prepare('INSERT INTO settings VALUES (?, ?)').bind('site_options', JSON.stringify({ jwt_secret: 'x'.repeat(32), is_public: 'true', wss_report_enabled: 'true' })).run();
    await db.prepare('INSERT INTO servers (id, name, is_hidden, secret, history_partition_id) VALUES (?, ?, ?, ?, ?)').bind('visible', 'Visible', '0', 'node-secret', 1).run();
    await db.prepare('INSERT INTO servers (id, name, is_hidden, secret, history_partition_id) VALUES (?, ?, ?, ?, ?)').bind('hidden', 'Hidden', '1', 'node-secret', 2).run();
    const now = Date.now();
    const post = (url, body) => mf.dispatchFetch(`https://monitor.test${url}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const report = { id: 'visible', secret: 'node-secret', reportId: 'http-r1', batch: true,
      samples: [{ ts: now - 30 * 3600_000, metrics: { cpu: 7 } }, { ts: now - 1000, metrics: { cpu: 20, disk: { read_bps: 100 } } }] };
    await post('/test/capture-logs', {});
    const committedResponse = await post('/update', report);
    assert.equal(committedResponse.status, 200);
    const traceId = committedResponse.headers.get('X-Request-ID');
    assert.ok(traceId);
    let logs = await (await mf.dispatchFetch('https://monitor.test/test/logs')).json();
    const committedLog = logs.find(entry => entry.event === 'metrics.committed' && entry.reportId === 'http-r1');
    assert.equal(committedLog.requestId, traceId, 'Worker and DO must share a correlation ID');
    assert.equal(committedLog.transport, 'http');
    assert.equal(committedLog.serverId, 'visible');
    assert.equal(committedLog.attempt, 1);
    let history = await (await mf.dispatchFetch('https://monitor.test/history?serverId=visible&hours=168&points=1000')).json();
    assert.deepEqual(history.data.map(point => point.cpu), [7, 20]);
    const publicHistory = await mf.dispatchFetch('https://monitor.test/api/history/all?id=visible&hours=1');
    assert.equal(publicHistory.status, 200);
    assert.equal(publicHistory.headers.get('X-History-Interval-Seconds'), '30');
    const publicRows = await publicHistory.json();
    assert.equal(publicRows.at(-1).peaks.cpu, 20);
    assert.equal(publicRows.at(-1).disk.read_bps, 100);
    assert.equal('gpu_info' in publicRows.at(-1), false, 'missing report-level fields remain absent');

    await mf.dispose();
    mf = new Miniflare(options);
    await post('/test/capture-logs', {});
    assert.equal((await post('/update', report)).status, 200);
    history = await (await mf.dispatchFetch('https://monitor.test/history?serverId=visible&hours=168&points=1000')).json();
    assert.equal(history.data.length, 2, 'retry after restart must not duplicate history');
    const conflict = await post('/update', { ...report, samples: [{ ts: now - 1000, metrics: { cpu: 99 } }] });
    assert.equal(conflict.status, 409);

    await post('/test/fail-writes', {});
    const failedReport = { ...report, reportId: 'http-r2', samples: [{ ts: now - 61_000, metrics: { cpu: 50 } }] };
    assert.equal((await post('/update', failedReport)).status, 503);
    await post('/test/restore-writes', {});
    assert.equal((await post('/update', failedReport)).status, 200);

    const agentResponse = await mf.dispatchFetch('https://monitor.test/update', { headers: { Upgrade: 'websocket' } });
    assert.equal(agentResponse.status, 101);
    const agent = agentResponse.webSocket;
    sockets.push(agent);
    agent.accept();
    const sendAgentReport = body => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { agent.removeEventListener('message', listener); reject(new Error('No report ACK')); }, 5000);
      const listener = event => {
        const message = JSON.parse(event.data);
        if (message.ackFor === 'report' && message.reportId === body.reportId) {
          clearTimeout(timer);
          agent.removeEventListener('message', listener);
          resolve(message);
        }
      };
      agent.addEventListener('message', listener);
      agent.send(JSON.stringify(body));
    });
    const wsReport = { id: 'visible', secret: 'node-secret', reportId: 'ws-r1', batch: true,
      samples: [{ ts: now - 500, metrics: { cpu: 35 } }] };
    assert.equal((await sendAgentReport(wsReport)).persisted, true);
    await post('/test/fail-writes', {});
    const wsRetry = { ...wsReport, reportId: 'ws-r2', samples: [{ ts: now - 200, metrics: { cpu: 45 } }] };
    const negativeAck = await sendAgentReport(wsRetry);
    assert.equal(negativeAck.accepted, false);
    assert.equal(negativeAck.persisted, false);
    await post('/test/restore-writes', {});
    assert.equal((await sendAgentReport(wsRetry)).accepted, true);
    logs = await (await mf.dispatchFetch('https://monitor.test/test/logs')).json();
    const wsCommitted = logs.find(entry => entry.event === 'metrics.committed' && entry.reportId === 'ws-r1');
    const wsFailed = logs.find(entry => entry.event === 'metrics.commit.failed' && entry.reportId === 'ws-r2');
    assert.equal(wsCommitted.transport, 'wss');
    assert.ok(wsCommitted.connectionId);
    assert.equal(wsFailed.connectionId, wsCommitted.connectionId, 'connection identity survives separate hibernation callbacks');
    assert.notEqual(wsFailed.requestId, wsCommitted.requestId);
    assert.equal(wsFailed.persisted, false);
    assert.ok(wsFailed.error.message.includes('simulated storage failure'));
    assert.equal(JSON.stringify(logs).includes('node-secret'), false);
    assert.equal(JSON.stringify(logs).includes('runtime-secret'), false);

    await post('/test/legacy', { serverId: 'legacy', points: [{ timestamp: now - 120_000, cpu: 42 }] });
    const legacy = await (await mf.dispatchFetch('https://monitor.test/history?serverId=legacy&hours=1')).json();
    assert.equal(legacy.data[0].cpu, 42);
    await post('/batch-push', { updates: [{ serverId: 'hidden', samples: [{ ts: now, data: { cpu: 99 } }] }] });
    const response = await mf.dispatchFetch('https://monitor.test/ws?subscribe=all', { headers: { Upgrade: 'websocket' } });
    assert.equal(response.status, 101);
    const socket = response.webSocket;
    sockets.push(socket);
    const messages = [];
    const initial = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No initial replay')), 5000);
      socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        messages.push(message);
        if (message.type === 'batchUpdate') { clearTimeout(timer); resolve(message); }
      });
    });
    socket.accept();
    const replay = await initial;
    assert.deepEqual(replay.updates.map(update => update.serverId), ['visible']);
    assert.equal((await mf.dispatchFetch('https://monitor.test/ws?subscribe=hidden', { headers: { Upgrade: 'websocket' } })).status, 403);
    const closed = new Promise(resolve => socket.addEventListener('close', resolve, { once: true }));
    socket.send(JSON.stringify({ type: 'subscribe', scope: 'all', ids: ['hidden'] }));
    await closed;
    assert.equal(messages.some(message => message.updates?.some(update => update.serverId === 'hidden')), false);

    const restoredDb = await mf.getD1Database('DB');
    await restoredDb.prepare(`WITH RECURSIVE nodes(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM nodes WHERE i < 500)
      INSERT INTO servers (id, name, is_hidden, history_partition_id)
      SELECT printf('node-%04d-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', i), 'Bulk node', '0', i + 2 FROM nodes`).run();
    await post('/frontend-access-changed', {});
    const largeResponse = await mf.dispatchFetch('https://monitor.test/ws?subscribe=all', { headers: { Upgrade: 'websocket' } });
    assert.equal(largeResponse.status, 101, 'large permission sets must fit through a small WebSocket attachment');
    const largeSocket = largeResponse.webSocket;
    sockets.push(largeSocket);
    largeSocket.accept();
    const { results: nodes } = await restoredDb.prepare("SELECT id FROM servers WHERE id LIKE 'node-%' ORDER BY id").all();
    const subscribe = body => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { largeSocket.removeEventListener('message', listener); reject(new Error('No subscription ACK')); }, 5000);
      const listener = event => {
        const message = JSON.parse(event.data);
        if (message.type === 'subscribed') {
          clearTimeout(timer);
          largeSocket.removeEventListener('message', listener);
          resolve(message);
        }
      };
      largeSocket.addEventListener('message', listener);
      largeSocket.send(JSON.stringify(body));
    });
    assert.equal((await subscribe({ type: 'subscribe', scope: 'all', ids: nodes.map(node => node.id) })).count, 500);
    await post('/test/forget-sessions', {});
    assert.equal((await subscribe({ type: 'subscribe', scope: nodes[0].id })).subscribed, nodes[0].id,
      'a re-created subscription manager restores permissions and filters from storage');
  } finally {
    for (const socket of sockets) { try { socket.close(); } catch {} }
    await mf?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
