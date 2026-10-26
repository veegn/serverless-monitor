// Local workerd/SQLite only; does not use a Cloudflare account or network service.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { metricFixture } from '../test/helpers/metric-fixture.js';
import { HISTORY_AGGREGATION_AVG_FIELDS, HISTORY_AGGREGATION_MAX_FIELDS } from '../src/utils/historyFields.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const bundle = await build({ entryPoints: [path.join(root, 'test/fixtures/runtime-worker.js')],
  bundle: true, format: 'esm', platform: 'browser', external: ['node:*', 'cloudflare:*'], write: false });
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: '2024-12-01', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { METRICS_BROADCASTER: { className: 'RuntimeBroadcaster', useSQLite: true } } });
const HOUR = 3600_000;
const origin = Math.floor(Date.now() / HOUR) * HOUR;
try {
  const probe = async body => {
    const response = await mf.dispatchFetch('https://local/test/store-probe', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  };
  let ordinaryWrites = 0, ordinaryReads = 0, ordinaryReports = 0, legacyHistoryBytes = 0;
  for (let minute = 0; minute < 60; minute++) {
    const samples = Array.from({ length: 60 }, (_, index) => {
      const second = minute * 60 + index;
      return { ts: origin + second * 1000, data: metricFixture(origin + second * 1000, second, index === 59) };
    });
    const now = samples.at(-1).ts + 1;
    const result = await probe({ action: 'ingest', updates: [{ serverId: 'benchmark', samples }],
      options: { now, reportKey: `benchmark:${minute}`, fingerprint: String(minute).padStart(64, '0') } });
    if (minute) { ordinaryWrites += result.writes; ordinaryReads += result.reads; ordinaryReports++; }
    // Former schema: both materialized JSON and aggregation JSON per minute.
    const data = { ...samples.at(-1).data };
    const aggregate = { timestamp: samples.at(-1).ts, data: { ...data }, max: {}, avg: {}, seen: samples.map(sample => sample.ts) };
    for (const field of HISTORY_AGGREGATION_MAX_FIELDS) {
      const values = samples.map(sample => Number(sample.data[field])).filter(Number.isFinite);
      if (values.length) { aggregate.max[field] = Math.max(...values); data[field] = aggregate.max[field]; }
    }
    for (const field of HISTORY_AGGREGATION_AVG_FIELDS) {
      const values = samples.map(sample => Number(sample.data[field])).filter(Number.isFinite);
      if (values.length) {
        const sum = values.reduce((a, b) => a + b, 0);
        aggregate.avg[field] = { sum, count: values.length }; data[field] = sum / values.length;
      }
    }
    legacyHistoryBytes += Buffer.byteLength(JSON.stringify(data)) + Buffer.byteLength(JSON.stringify(aggregate));
  }
  const fine = await probe({ action: 'stats' });
  await probe({ action: 'cleanup', now: origin + 3 * HOUR });
  const archived = await probe({ action: 'stats' });
  const week = await probe({ action: 'history', serverId: 'benchmark', options: { hours: 168, now: origin + 3 * HOUR } });
  await probe({ action: 'seed-maintenance', now: origin });
  let maintenanceReads = 0, maintenanceWrites = 0, maintenancePasses = 0, maintenance;
  do {
    maintenance = await probe({ action: 'cleanup', now: origin + HOUR + 1 });
    maintenanceReads += maintenance.reads; maintenanceWrites += maintenance.writes; maintenancePasses++;
  } while (maintenance.result);
  process.stdout.write(JSON.stringify({ workload: 'one node, 1s collection, 60s reports, 2 GPUs and 8 probes, one hour',
    ordinaryReports, ordinaryWrites, ordinaryReads, writesPerReport: ordinaryWrites / ordinaryReports,
    legacyMinuteJsonBytes: legacyHistoryBytes, fineHourPayloadBytes: fine.result.bytes,
    compactedHourPayloadBytes: archived.result.bytes, compactedReductionPercent: Number((100 * (1 - archived.result.bytes / legacyHistoryBytes)).toFixed(2)),
    fineDatabaseBytes: fine.databaseBytes, compactedDatabaseBytes: archived.databaseBytes,
    queryRowsRead: week.reads, queryPoints: week.result.length,
    maintenanceLoad: '60 nodes with 169 hourly rows each; one hour of retention and compaction',
    maintenanceReads, maintenanceWrites, maintenancePasses,
    projectedDailyMaintenanceReads: maintenanceReads * 24 }, null, 2) + '\n');
} finally { await mf.dispose(); }
