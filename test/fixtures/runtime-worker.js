import worker from '../../src/index.js';
import { MetricsBroadcaster as BaseBroadcaster } from '../../src/durable/MetricsBroadcaster.js';

let capturedLogs = null;

// Test-only fault injection stays outside the production Worker.
export class RuntimeBroadcaster extends BaseBroadcaster {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/test/capture-logs') {
      if (capturedLogs === null) {
        capturedLogs = [];
        for (const level of ['debug', 'info', 'warn', 'error']) {
          const original = console[level].bind(console);
          console[level] = (...args) => {
            if (args[0]?.source === 'cfsm') {
              capturedLogs.push(args[0]);
              if (capturedLogs.length > 500) capturedLogs.shift();
            }
            original(...args);
          };
        }
      }
      capturedLogs.length = 0;
      return new Response('OK');
    }
    if (path === '/test/logs') return Response.json(capturedLogs || []);
    if (path === '/test/store-probe') {
      this.metricsStore.init();
      if (!this.sqlMeter) {
        this.sqlMeter = { reads: 0, writes: 0 };
        const sql = this.metricsStore.sql;
        this.metricsStore.sql = { exec: (...args) => {
          const cursor = sql.exec(...args);
          let read = 0, written = 0;
          const capture = () => {
            this.sqlMeter.reads += cursor.rowsRead - read;
            this.sqlMeter.writes += cursor.rowsWritten - written;
            read = cursor.rowsRead; written = cursor.rowsWritten;
          };
          capture();
          return { toArray: () => { const rows = cursor.toArray(); capture(); return rows; } };
        } };
      }
      const body = await request.json();
      this.sqlMeter.reads = this.sqlMeter.writes = 0;
      let result;
      if (body.action === 'ingest') result = await this.metricsStore.ingest(body.updates, body.options);
      if (body.action === 'cleanup') result = this.metricsStore.cleanup(body.now);
      if (body.action === 'history') result = await this.metricsStore.history(body.serverId, body.options);
      if (body.action === 'stats') result = this.state.storage.sql.exec(`SELECT COUNT(*) AS blocks,
        SUM(length(payload)) AS bytes FROM metric_blocks`).one();
      if (body.action === 'seed-maintenance') {
        const hour = Math.floor(body.now / 3600_000) * 3600_000;
        await this.metricsStore.ingest([{ serverId: 'seed-template', samples: [{ ts: hour, data: { cpu: 1 } }] }], { now: hour });
        this.state.storage.sql.exec(`WITH RECURSIVE hours(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM hours WHERE i < 168),
          nodes(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM nodes WHERE n < 60)
          INSERT INTO metric_blocks SELECT 'load-' || n, ? - i * 3600000, 0,
          CASE WHEN i = 0 THEN ? ELSE 0 END, CASE WHEN i = 0 THEN ? ELSE 0 END,
          CASE WHEN i <= 1 THEN ? - i * 3600000 + 7200000 ELSE 0 END, payload
          FROM hours, nodes, metric_blocks WHERE server_id = 'seed-template' AND bucket = ? AND part = 0`,
        hour, hour, hour, hour, hour);
        result = { nodes: 60, hours: 169 };
      }
      return Response.json({ result, ...this.sqlMeter, databaseBytes: this.state.storage.sql.databaseSize });
    }
    if (path === '/test/fail-writes') {
      this.metricsStore.init();
      this.state.storage.sql.exec(`CREATE TRIGGER fail_latest BEFORE INSERT ON metric_blocks
        BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END`);
      return new Response('OK');
    }
    if (path === '/test/restore-writes') {
      this.state.storage.sql.exec('DROP TRIGGER fail_latest');
      return new Response('OK');
    }
    if (path === '/test/legacy') {
      const { serverId, points } = await request.json();
      await this.state.storage.put(`durable_history_v1:${serverId}`, points);
      return new Response('OK');
    }
    if (path === '/test/forget-sessions') {
      this.frontendSubscriptions = new this.frontendSubscriptions.constructor(this.env, this.state.storage);
      return new Response('OK');
    }
    return super.fetch(request);
  }
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/test/') || ['/history', '/batch-push', '/latest-report-updates', '/ws', '/frontend-access-changed'].includes(path)) {
      const stub = env.METRICS_BROADCASTER.get(env.METRICS_BROADCASTER.idFromName('global'));
      return stub.fetch(request);
    }
    return worker.fetch(request, env, ctx);
  },
  scheduled: worker.scheduled
};
