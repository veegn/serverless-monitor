import { AppError } from '../utils/errors.js';
import { historySampling, HISTORY_FINE_INTERVAL_MS, HISTORY_FINE_RETENTION_MS } from '../utils/historyPolicy.js';
import { emptyBlock, emptyAggregate, addValues, metricValues, mergeAggregate, materializeAggregate, legacyAggregate } from './metricAggregates.js';
import { encodeMetricParts, decodeMetricPart, equalMetricBytes } from './metricCodec.js';

export const HISTORY_RETENTION_MS = 7 * 24 * 3600_000;
const MINUTE = 60_000;
const HOUR = 3600_000;
const REPORT_RETENTION_MS = 10 * MINUTE;
const LEGACY_HISTORY_PREFIX = 'durable_history_v1:';
const LEGACY_LATEST_KEY = 'cfsm:latest_report_updates';
const hourOf = ts => Math.floor(ts / HOUR) * HOUR;

// History, status, receipt time and retry journal normally share one hourly row.
// Every ACK follows a synchronous SQLite transaction; there is no volatile flush.
export class SqlMetricsStore {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage?.sql;
    this.initialized = false;
    this.migrations = new Map();
    this.latestMigration = null;
    this.generation = 0;
  }

  init() {
    if (this.initialized) return;
    if (!this.sql || typeof this.storage.transactionSync !== 'function') throw new AppError('SQLite metrics storage unavailable', 503);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS metric_blocks (
        server_id TEXT NOT NULL, bucket INTEGER NOT NULL, part INTEGER NOT NULL,
        received_at INTEGER NOT NULL DEFAULT 0, sample_ts INTEGER NOT NULL DEFAULT 0,
        compact_at INTEGER NOT NULL DEFAULT 0, payload BLOB NOT NULL,
        PRIMARY KEY (bucket, server_id, part)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS metric_blocks_server ON metric_blocks(server_id, bucket, part);
      CREATE TABLE IF NOT EXISTS metric_migrations (key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS metric_history (
        server_id TEXT NOT NULL, bucket INTEGER NOT NULL, data TEXT NOT NULL,
        aggregate TEXT NOT NULL, PRIMARY KEY(server_id, bucket)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS metric_latest (
        server_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL,
        sample_ts INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS metric_reports (
        report_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
    `);
    this.initialized = true;
  }

  rows(query, ...bindings) { this.init(); return this.sql.exec(query, ...bindings).toArray(); }

  readBlock(serverId, hour) {
    const rows = this.rows('SELECT * FROM metric_blocks WHERE server_id = ? AND bucket = ? ORDER BY part', serverId, hour);
    const block = emptyBlock();
    for (const row of rows) {
      const decoded = decodeMetricPart(row.payload, hour);
      Object.assign(block.m, decoded.m); Object.assign(block.f, decoded.f); Object.assign(block.g, decoded.g);
      if (row.part === 0) { block.l = decoded.l; block.r = decoded.r; }
    }
    return { serverId, hour, block, rows, receivedAt: rows[0]?.received_at || 0, sampleTs: rows[0]?.sample_ts || 0 };
  }

  writeBlock(entry, now) {
    const { serverId, hour, block, rows, receivedAt, sampleTs } = entry;
    if (hour + HOUR <= now - HISTORY_FINE_RETENTION_MS) block.f = {};
    const compactAt = hour + 2 * HOUR > now ? hour + 2 * HOUR : 0;
    const parts = encodeMetricParts(block, hour);
    const previous = new Map(rows.map(row => [row.part, row]));
    for (const [part, bytes] of parts) {
      const row = previous.get(part);
      const receipt = part === 0 ? receivedAt : 0;
      const sample = part === 0 ? sampleTs : 0;
      if (row && row.received_at === receipt && row.sample_ts === sample && row.compact_at === compactAt && equalMetricBytes(row.payload, bytes)) continue;
      this.sql.exec(`INSERT INTO metric_blocks VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(bucket, server_id, part) DO UPDATE SET received_at = excluded.received_at,
        sample_ts = excluded.sample_ts, compact_at = excluded.compact_at, payload = excluded.payload`,
      serverId, hour, part, receipt, sample, compactAt, bytes);
    }
    for (const part of previous.keys()) if (!parts.has(part)) {
      this.sql.exec('DELETE FROM metric_blocks WHERE server_id = ? AND bucket = ? AND part = ?', serverId, hour, part);
    }
  }

  latestRow(serverId) {
    return this.rows(`SELECT bucket, received_at, sample_ts FROM metric_blocks
      WHERE server_id = ? AND part = 0 AND received_at > 0 ORDER BY bucket DESC LIMIT 1`, serverId)[0];
  }

  async migrateLatest() {
    this.init();
    if (this.latestMigration) return this.latestMigration;
    const generation = this.generation;
    this.latestMigration = (async () => {
      if (this.rows("SELECT key FROM metric_migrations WHERE key = '__latest__'").length) return;
      const legacy = await this.storage.get(LEGACY_LATEST_KEY);
      if (generation !== this.generation) return;
      this.storage.transactionSync(() => {
        for (const [serverId, update] of Array.isArray(legacy) ? legacy : []) {
          const sampleTs = Number(update?.samples?.at(-1)?.ts);
          if (!Number.isFinite(sampleTs) || !Number.isFinite(Number(update?.reportTs))) continue;
          this.sql.exec('INSERT OR IGNORE INTO metric_latest VALUES (?, ?, ?, ?)', String(serverId), Number(update.reportTs), sampleTs, JSON.stringify(update));
        }
        this.sql.exec("INSERT OR IGNORE INTO metric_migrations VALUES ('__latest__')");
      });
      if (legacy !== undefined && legacy !== null) await this.storage.delete(LEGACY_LATEST_KEY);
    })();
    try { await this.latestMigration; } catch (error) { this.latestMigration = null; throw error; }
  }

  async migrateServer(serverId, now = Date.now()) {
    await this.migrateLatest();
    if (this.migrations.has(serverId)) return this.migrations.get(serverId);
    const generation = this.generation;
    const promise = (async () => {
      if (this.rows('SELECT key FROM metric_migrations WHERE key = ?', `v2:${serverId}`).length) return;
      const legacy = await this.storage.get(`${LEGACY_HISTORY_PREFIX}${serverId}`);
      if (generation !== this.generation) return;
      this.storage.transactionSync(() => {
        if (this.rows('SELECT key FROM metric_migrations WHERE key = ?', `v2:${serverId}`).length) return;
        const hours = this.rows(`SELECT DISTINCT CAST(bucket / ? AS INTEGER) * ? AS hour FROM metric_history
          WHERE server_id = ? AND bucket >= ? AND bucket <= ? ORDER BY hour`, HOUR, HOUR, serverId, now - HISTORY_RETENTION_MS - MINUTE, now);
        const importState = (entry, bucket, state, profiles = {}) => {
          const offset = bucket - entry.hour;
          const previous = entry.block.m[offset];
          if (!previous) entry.block.m[offset] = state;
          else if (!state.s.every(ts => previous.s.includes(ts))) {
            const fresh = state.s.filter(ts => !previous.s.includes(ts));
            if (fresh.length === state.s.length) { mergeAggregate(previous, state); previous.s.push(...fresh); }
          }
          Object.assign(entry.block.g, profiles);
        };
        for (const { hour } of hours) {
          const entry = this.readBlock(serverId, hour);
          for (const row of this.rows('SELECT bucket, aggregate FROM metric_history WHERE server_id = ? AND bucket >= ? AND bucket < ?', serverId, hour, hour + HOUR)) {
            const { state, profiles } = legacyAggregate(JSON.parse(row.aggregate));
            importState(entry, row.bucket, state, profiles);
          }
          this.writeBlock(entry, now);
        }
        const snapshots = new Map();
        for (const point of Array.isArray(legacy) ? legacy : []) {
          const ts = Number(point?.timestamp);
          if (!Number.isFinite(ts) || ts < now - HISTORY_RETENTION_MS || ts > now) continue;
          const hour = hourOf(ts);
          if (!snapshots.has(hour)) snapshots.set(hour, this.readBlock(serverId, hour));
          const { state, profiles } = legacyAggregate({ timestamp: ts, data: point, seen: [ts] });
          importState(snapshots.get(hour), Math.floor(ts / MINUTE) * MINUTE, state, profiles);
        }
        for (const entry of snapshots.values()) this.writeBlock(entry, now);
        const latest = this.rows('SELECT * FROM metric_latest WHERE server_id = ?', serverId)[0];
        if (latest) {
          const entry = this.readBlock(serverId, hourOf(latest.received_at));
          if (latest.received_at >= entry.receivedAt) {
            entry.block.l = JSON.parse(latest.data); entry.receivedAt = latest.received_at; entry.sampleTs = latest.sample_ts;
            this.writeBlock(entry, now);
          }
        }
        this.sql.exec('INSERT OR IGNORE INTO metric_migrations VALUES (?)', `v2:${serverId}`);
      });
      if (legacy !== undefined && legacy !== null) await this.storage.delete(`${LEGACY_HISTORY_PREFIX}${serverId}`);
    })();
    this.migrations.set(serverId, promise);
    try { await promise; } catch (error) { this.migrations.delete(serverId); throw error; }
  }

  async ingest(updates, { now = Date.now(), reportKey = null, fingerprint = '' } = {}) {
    for (const update of updates) await this.migrateServer(update.serverId, now);
    return this.storage.transactionSync(() => {
      const entries = new Map();
      const get = (id, hour) => {
        const key = JSON.stringify([id, hour]);
        if (!entries.has(key)) entries.set(key, this.readBlock(id, hour));
        return entries.get(key);
      };
      const currentHour = hourOf(now);
      for (const update of updates) {
        const active = get(update.serverId, currentHour);
        if (!active.receivedAt) {
          const row = this.latestRow(update.serverId);
          if (row && row.bucket !== currentHour) {
            const previous = get(update.serverId, row.bucket);
            active.block.l = previous.block.l;
            active.sampleTs = previous.sampleTs;
            active.block.r = previous.block.r.filter(report => report[2] > now);
          }
        }
      }
      const journal = updates.length ? get(updates[0].serverId, currentHour).block.r : [];
      if (reportKey) {
        const previous = journal.find(report => report[0] === reportKey && report[2] > now)
          || this.rows('SELECT report_key, fingerprint, expires_at FROM metric_reports WHERE report_key = ? AND expires_at > ?', reportKey, now)
            .map(row => [row.report_key, row.fingerprint, row.expires_at])[0];
        if (previous) {
          if (previous[1] !== fingerprint) throw new AppError('Conflicting reportId with different content', 409);
          return { persisted: true, duplicate: true };
        }
      }
      const dirty = new Set();
      for (const update of updates) {
        let latestSampleTs = 0;
        for (const sample of update.samples) {
          const ts = Number(sample.ts);
          if (!Number.isFinite(ts)) continue;
          latestSampleTs = Math.max(latestSampleTs, ts);
          if (ts < now - HISTORY_RETENTION_MS || ts > now + MINUTE) continue;
          const entry = get(update.serverId, hourOf(ts));
          const offset = Math.floor((ts - entry.hour) / MINUTE) * MINUTE;
          const state = entry.block.m[offset] ||= emptyAggregate();
          if (state.s.includes(ts)) continue;
          const values = metricValues(sample.data || sample.payload || sample.metrics || {}, entry.block.g);
          addValues(state, ts, values); state.s.push(ts);
          if (ts >= now - HISTORY_FINE_RETENTION_MS) {
            const fineOffset = Math.floor((ts - entry.hour) / HISTORY_FINE_INTERVAL_MS) * HISTORY_FINE_INTERVAL_MS;
            addValues(entry.block.f[fineOffset] ||= emptyAggregate(), ts, values);
          }
          dirty.add(entry);
        }
        const active = get(update.serverId, currentHour);
        if (!active.block.l || latestSampleTs >= active.sampleTs) {
          active.block.l = { ...update, reportTs: now };
          active.sampleTs = latestSampleTs || now;
        }
        active.receivedAt = now;
        active.block.r = active.block.r.filter(report => report[2] > now);
        dirty.add(active);
      }
      if (reportKey && updates.length) get(updates[0].serverId, currentHour).block.r.push([reportKey, fingerprint, now + REPORT_RETENTION_MS]);
      for (const entry of dirty) this.writeBlock(entry, now);
      return { persisted: true, duplicate: false };
    });
  }

  async latest(serverIds, since = 0) {
    const results = [];
    for (const serverId of serverIds) {
      await this.migrateServer(serverId);
      const row = this.latestRow(serverId);
      if (!row || row.received_at < since) continue;
      const { block } = this.readBlock(serverId, row.bucket);
      if (block.l) results.push({ ...block.l, reportTs: row.received_at });
    }
    return results;
  }

  async timestamps(serverIds) {
    const result = {};
    for (const serverId of serverIds) {
      await this.migrateServer(serverId);
      const row = this.latestRow(serverId);
      if (row) result[serverId] = row.received_at;
    }
    return result;
  }

  async history(serverId, { hours = 1, points = null, now = Date.now() } = {}) {
    await this.migrateServer(serverId, now);
    const { durationMs, intervalMs, sourceIntervalMs, points: pointLimit } = historySampling(hours, points);
    const start = now - durationMs;
    const buckets = new Map();
    const profiles = {};
    // At most 169 ordinary hourly rows for seven days. Every minute participates;
    // choosing only the final minute in a window would lose spikes.
    const rows = this.rows('SELECT bucket, part, payload FROM metric_blocks WHERE server_id = ? AND bucket >= ? AND bucket <= ? ORDER BY bucket, part', serverId, hourOf(start), hourOf(now));
    const consume = (hour, block) => {
      Object.assign(profiles, block.g);
      const fineByMinute = new Map();
      for (const [offset, state] of Object.entries(block.f)) {
        const minute = Math.floor(Number(offset) / MINUTE) * MINUTE;
        if (!fineByMinute.has(minute)) fineByMinute.set(minute, []);
        fineByMinute.get(minute).push([offset, state]);
      }
      for (const [offset, minute] of Object.entries(block.m)) {
        const fine = fineByMinute.get(Number(offset)) || [];
        const useFine = sourceIntervalMs < MINUTE && fine.reduce((count, [, state]) => count + state.n, 0) === minute.n;
        for (const [position, state] of useFine ? fine : [[offset, minute]]) {
          if (state.t < start || state.t > now) continue;
          const key = Math.min(pointLimit - 1, Math.floor((Math.max(start, hour + Number(position)) - start) / intervalMs));
          if (!buckets.has(key)) buckets.set(key, emptyAggregate());
          mergeAggregate(buckets.get(key), state);
        }
      }
    };
    let currentHour = null;
    let block = emptyBlock();
    for (const row of rows) {
      if (currentHour !== null && row.bucket !== currentHour) { consume(currentHour, block); block = emptyBlock(); }
      currentHour = row.bucket;
      const decoded = decodeMetricPart(row.payload, row.bucket);
      Object.assign(block.m, decoded.m); Object.assign(block.f, decoded.f); Object.assign(block.g, decoded.g);
    }
    if (currentHour !== null) consume(currentHour, block);
    return [...buckets].sort((a, b) => a[0] - b[0]).map(([, state]) => materializeAggregate(state, profiles));
  }

  cleanup(now = Date.now()) {
    this.init();
    return this.storage.transactionSync(() => {
      const cutoffHour = hourOf(now - HISTORY_RETENTION_MS);
      this.sql.exec(`DELETE FROM metric_blocks WHERE (server_id, bucket, part) IN (
        SELECT server_id, bucket, part FROM metric_blocks AS old WHERE bucket < ?
        AND (received_at = 0 OR EXISTS (SELECT 1 FROM metric_blocks AS newer WHERE newer.server_id = old.server_id
          AND newer.bucket > old.bucket AND newer.received_at > 0)) LIMIT 1000)`, cutoffHour);
      const due = this.rows('SELECT server_id, bucket FROM metric_blocks WHERE part = 0 AND compact_at > 0 AND compact_at <= ? LIMIT 32', now);
      for (const row of due) {
        const entry = this.readBlock(row.server_id, row.bucket);
        entry.block.f = {};
        entry.block.r = entry.block.r.filter(report => report[2] > now);
        const latest = this.latestRow(row.server_id);
        if (!latest || latest.bucket !== row.bucket) { entry.block.l = null; entry.receivedAt = 0; entry.sampleTs = 0; }
        this.writeBlock(entry, now);
      }
      const stale = this.rows(`SELECT server_id, bucket FROM metric_blocks AS old
        WHERE bucket < ? AND part = 0 AND received_at > 0 AND sample_ts > 0
        AND NOT EXISTS (SELECT 1 FROM metric_blocks AS newer WHERE newer.server_id = old.server_id
          AND newer.bucket > old.bucket AND newer.received_at > 0) LIMIT 32`, cutoffHour);
      for (const row of stale) {
        const entry = this.readBlock(row.server_id, row.bucket);
        entry.block = emptyBlock(); entry.sampleTs = 0;
        this.writeBlock(entry, now);
      }
      this.sql.exec(`DELETE FROM metric_history WHERE (server_id, bucket) IN
        (SELECT server_id, bucket FROM metric_history WHERE bucket < ? LIMIT 1000)`, now - HISTORY_RETENTION_MS);
      this.sql.exec('DELETE FROM metric_reports WHERE report_key IN (SELECT report_key FROM metric_reports WHERE expires_at <= ? LIMIT 1000)', now);
      return this.rows('SELECT 1 FROM metric_blocks WHERE part = 0 AND compact_at > 0 AND compact_at <= ? LIMIT 1', now).length > 0
        || this.rows(`SELECT 1 FROM metric_blocks AS old WHERE bucket < ? AND (received_at = 0 OR EXISTS
          (SELECT 1 FROM metric_blocks AS newer WHERE newer.server_id = old.server_id AND newer.bucket > old.bucket AND newer.received_at > 0)) LIMIT 1`, cutoffHour).length > 0
        || this.rows('SELECT 1 FROM metric_history WHERE bucket < ? LIMIT 1', now - HISTORY_RETENTION_MS).length > 0
        || this.rows('SELECT 1 FROM metric_blocks WHERE bucket < ? AND part = 0 AND received_at > 0 AND sample_ts > 0 LIMIT 1', cutoffHour).length > 0
        || this.rows('SELECT 1 FROM metric_reports WHERE expires_at <= ? LIMIT 1', now).length > 0;
    });
  }

  async clear() {
    this.init(); this.generation++;
    this.storage.transactionSync(() => {
      for (const table of ['metric_blocks', 'metric_history', 'metric_latest', 'metric_reports', 'metric_migrations']) this.sql.exec(`DELETE FROM ${table}`);
    });
    const legacy = await this.storage.list({ prefix: LEGACY_HISTORY_PREFIX });
    if (legacy.size) await this.storage.delete([...legacy.keys()]);
    await this.storage.delete(LEGACY_LATEST_KEY);
    this.migrations.clear(); this.latestMigration = null;
  }
}
