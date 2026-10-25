import { getAllServers, getLatestMetricsCache, setLatestMetricsCache, getMetricsHistoryCache, setMetricsHistoryCache, getCacheDuration, clearAllCaches } from '../utils/cache.js';
import { saveSiteOptions, debug, normalizeLongHistoryPoints, DEFAULT_LONG_HISTORY_POINTS } from '../utils/settings.js';
import {
  attachDiskMetricsObject,
  flattenDiskMetrics,
  isDisabledProbeMetric,
  normalizeProbeMetricRow,
  DISK_IO_FIELD_TO_COLUMN,
  DISK_IO_METRIC_FIELDS
} from '../utils/metrics.js';
import { ensureServerOptimization, buildHistoryId, getServerHistoryInfo, getHistoryIdRange } from './indexOptimization.js';
import { addHistoryColumns } from './updateDatabase.js';
import {
  buildSparseHistoryQuery,
  shouldUseSparseHistorySampling
} from './historySampling.js';
import {
  createHistoryTableSql,
  HISTORY_INSERT_COLUMNS,
  HISTORY_MAX_BATCH_BUCKETS,
  HISTORY_BATCH_BUCKET_INTERVAL_MS,
  HISTORY_AGGREGATION_MAX_FIELDS,
  HISTORY_AGGREGATION_AVG_FIELDS
} from '../utils/historyFields.js';
import {
  DASHBOARD_LATENCY_WINDOW_CACHE_MAX_SERVERS,
  DASHBOARD_LATENCY_WINDOW_CACHE_TTL_MS,
  DASHBOARD_LATENCY_WINDOW_HOURS,
  DASHBOARD_LATENCY_WINDOW_POINTS,
  DASHBOARD_LATENCY_WINDOW_QUERY_CONCURRENCY
} from '../utils/config.js';

/**
 * DatabaseService
 * 负责 Cloudflare D1 数据库相关的持久化、检索与表轮换管理
 */
export class DatabaseService {
  static dbInitialized = false;
  static LOSS_AGG_COLUMNS = new Set(['loss_ct', 'loss_cu', 'loss_cm', 'loss_bd', 'loss_node_1', 'loss_node_2', 'loss_node_3', 'loss_node_4']);
  static DEFAULT_HISTORY_MAX_POINTS = 160;
  static LATENCY_NODE_FIELDS = ['ct', 'cu', 'cm', 'bd', 'node_1', 'node_2', 'node_3', 'node_4'];
  static DASHBOARD_LATENCY_COLUMNS = DatabaseService.LATENCY_NODE_FIELDS
    .flatMap(field => [`ping_${field}`, `loss_${field}`]);
  static dashboardLatencyHistoryCache = new Map();
  static LATEST_QUERY_CHUNK_SIZE = 30;
  static D1_BATCH_CHUNK_SIZE = 25;
  static DISK_IO_COLUMN_TO_FIELD = Object.freeze(Object.fromEntries(
    DISK_IO_METRIC_FIELDS.map(field => [DISK_IO_FIELD_TO_COLUMN[field], field])
  ));

  constructor(db) {
    this.db = db;
  }

  // --- 静态缓存与辅助方法 ---

  static pruneDashboardLatencyHistoryCache(now = Date.now()) {
    for (const [serverId, entry] of DatabaseService.dashboardLatencyHistoryCache) {
      if (!entry || now - entry.cachedAt > DASHBOARD_LATENCY_WINDOW_CACHE_TTL_MS) {
        DatabaseService.dashboardLatencyHistoryCache.delete(serverId);
      }
    }

    while (DatabaseService.dashboardLatencyHistoryCache.size > DASHBOARD_LATENCY_WINDOW_CACHE_MAX_SERVERS) {
      const oldestServerId = DatabaseService.dashboardLatencyHistoryCache.keys().next().value;
      if (oldestServerId === undefined) break;
      DatabaseService.dashboardLatencyHistoryCache.delete(oldestServerId);
    }
  }

  static clearDashboardLatencyHistoryCache() {
    DatabaseService.dashboardLatencyHistoryCache.clear();
  }

  clearDashboardLatencyHistoryCache() {
    DatabaseService.clearDashboardLatencyHistoryCache();
  }

  static buildHistorySourceQuery(tableName, columns) {
    return `
      SELECT timestamp, ${columns} FROM ${tableName}
      WHERE id >= ?
        AND id <= ?
    `;
  }

  static normalizeLatencyHistoryValue(value, metricType) {
    if (isDisabledProbeMetric(value)) return false;
    if (value === null || value === undefined || value === '') return null;

    const number = Number(value);
    if (!Number.isFinite(number)) return null;

    if (metricType === 'loss') {
      return Math.max(0, Math.min(100, Math.round(number)));
    }
    return number > 0 ? Math.round(number) : null;
  }

  static buildLatencyHistoryPoint(row, metricType, { includeEmpty = false } = {}) {
    const timestamp = Number(row?.timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return null;

    const point = { ts: timestamp };
    for (const field of DatabaseService.LATENCY_NODE_FIELDS) {
      const column = `${metricType}_${field}`;
      if (!Object.prototype.hasOwnProperty.call(row, column)) continue;
      const value = DatabaseService.normalizeLatencyHistoryValue(row[column], metricType);
      if (value !== null) point[field] = value;
      else if (includeEmpty) point[field] = null;
    }

    return includeEmpty || Object.keys(point).length > 1 ? point : null;
  }

  static normalizeDashboardLatencyRows(rows, options = {}) {
    const ping = [];
    const loss = [];

    for (const row of rows || []) {
      const pingPoint = DatabaseService.buildLatencyHistoryPoint(row, 'ping', options);
      if (pingPoint) ping.push(pingPoint);

      const lossPoint = DatabaseService.buildLatencyHistoryPoint(row, 'loss', options);
      if (lossPoint) loss.push(lossPoint);
    }

    ping.sort((a, b) => a.ts - b.ts);
    loss.sort((a, b) => a.ts - b.ts);
    return { ping, loss };
  }

  static parseDashboardLatencySample(row) {
    if (!row?.sample_json) return null;
    try {
      return JSON.parse(row.sample_json);
    } catch (_) {
      return null;
    }
  }

  static normalizeDashboardLatencyWindow(sampleRows, { queryStart, intervalMs, points }) {
    const rows = Array.from({ length: points }, (_, index) => {
      const bucketTimestamp = queryStart + index * intervalMs;
      const sample = DatabaseService.parseDashboardLatencySample(sampleRows?.[index]);
      if (!sample || typeof sample !== 'object') {
        return { timestamp: bucketTimestamp };
      }

      return {
        ...sample,
        sample_timestamp: Number(sample.timestamp),
        timestamp: bucketTimestamp
      };
    });

    return DatabaseService.normalizeDashboardLatencyRows(rows, { includeEmpty: true });
  }

  static extractTimestampsFromMetricsCache(cache) {
    const map = new Map();
    if (!cache) return map;
    for (const [id, metrics] of cache) {
      if (metrics) map.set(id, metrics.timestamp);
    }
    return map;
  }

  // --- 静态快捷方法 ---

  static async init(db) {
    return new DatabaseService(db).init();
  }

  static async clearHistory(db) {
    return new DatabaseService(db).clearHistory();
  }

  static async weeklyCleanup(db) {
    return new DatabaseService(db).weeklyCleanup();
  }

  static buildHistoryInsertStatement(db, serverId, historyPartitionId, metrics = {}, regionCode = '', timestamp = null, agentVersion = '') {
    return new DatabaseService(db).buildHistoryInsertStatement(serverId, historyPartitionId, metrics, regionCode, timestamp, agentVersion);
  }

  static async saveMetricsHistory(db, serverId, historyPartitionId, metrics, regionCode = '', timestamp = null, agentVersion = '') {
    return new DatabaseService(db).saveMetricsHistory(serverId, historyPartitionId, metrics, regionCode, timestamp, agentVersion);
  }

  static async saveMetricsHistoryBatch(db, serverId, historyPartitionId, samples = [], regionCode = '', agentVersion = '', baselineMetrics = null, bucketIntervalMs = HISTORY_BATCH_BUCKET_INTERVAL_MS) {
    return new DatabaseService(db).saveMetricsHistoryBatch(serverId, historyPartitionId, samples, regionCode, agentVersion, baselineMetrics, bucketIntervalMs);
  }

  static _extractMetricNumber(source, field) {
    if (!source || typeof source !== 'object') return null;

    let value = Object.prototype.hasOwnProperty.call(source, field) ? source[field] : undefined;
    if (value === undefined && source.disk && typeof source.disk === 'object') {
      const diskField = DatabaseService.DISK_IO_COLUMN_TO_FIELD[field];
      if (diskField && Object.prototype.hasOwnProperty.call(source.disk, diskField)) {
        value = source.disk[diskField];
      }
    }

    if (value === false || value === 'false' || value === null || value === undefined || value === '') {
      return null;
    }
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  static _setMetricValue(target, field, value) {
    target[field] = value;
    const diskField = DatabaseService.DISK_IO_COLUMN_TO_FIELD[field];
    if (diskField) {
      if (target.disk && typeof target.disk === 'object') {
        target.disk[diskField] = value;
      } else {
        target.disk = { [diskField]: value };
      }
    }
  }

  static downsampleHistorySamples(samples = [], baselineMetrics = null, bucketIntervalMs = HISTORY_BATCH_BUCKET_INTERVAL_MS) {
    if (!Array.isArray(samples) || samples.length === 0) return [];

    const base = baselineMetrics && typeof baselineMetrics === 'object' ? baselineMetrics : null;
    const interval = Math.max(1000, Number(bucketIntervalMs) || HISTORY_BATCH_BUCKET_INTERVAL_MS);

    // 1. 按时间窗口分桶收集（保留全部时间戳，不主动丢弃旧数据）
    const buckets = new Map();
    for (const sample of samples) {
      if (!sample || typeof sample !== 'object') continue;
      const rawTs = Number(sample.ts ?? sample.timestamp);
      if (!Number.isFinite(rawTs) || rawTs <= 0) continue;
      const tsMs = rawTs < 1e11 ? Math.floor(rawTs * 1000) : Math.floor(rawTs);

      const bucketKey = Math.floor(tsMs / interval) * interval;
      let bucket = buckets.get(bucketKey);
      if (!bucket) {
        bucket = [];
        buckets.set(bucketKey, bucket);
      }
      bucket.push({
        raw: sample,
        ts: tsMs,
        metrics: sample.metrics || sample.data || sample.payload || sample
      });
    }

    if (buckets.size === 0) return [];

    // 2. 按自然时间排序并限制单批次最大落库桶数
    const sortedBucketKeys = Array.from(buckets.keys()).sort((a, b) => a - b);
    const activeKeys = sortedBucketKeys.length > HISTORY_MAX_BATCH_BUCKETS
      ? sortedBucketKeys.slice(-HISTORY_MAX_BATCH_BUCKETS)
      : sortedBucketKeys;

    const result = [];

    // 3. 逐桶聚合
    for (const key of activeKeys) {
      const bucketSamples = buckets.get(key);
      if (!bucketSamples || bucketSamples.length === 0) continue;

      bucketSamples.sort((a, b) => a.ts - b.ts);
      const latestSample = bucketSamples[bucketSamples.length - 1];

      if (bucketSamples.length === 1) {
        const sampleMetrics = latestSample.metrics && typeof latestSample.metrics === 'object'
          ? latestSample.metrics
          : {};
        result.push({
          ts: latestSample.ts,
          metrics: base ? { ...base, ...sampleMetrics } : sampleMetrics
        });
        continue;
      }

      // 多样本分类型聚合：基础数据继承 base 与 latestSample
      const mergedMetrics = {
        ...(base || {}),
        ...(latestSample.metrics && typeof latestSample.metrics === 'object' ? latestSample.metrics : {})
      };

      const maxValues = {};
      const avgSums = {};
      const avgCounts = {};

      for (const item of bucketSamples) {
        const sMetrics = item.metrics;
        if (!sMetrics || typeof sMetrics !== 'object') continue;

        for (const field of HISTORY_AGGREGATION_MAX_FIELDS) {
          const val = DatabaseService._extractMetricNumber(sMetrics, field);
          if (val !== null) {
            if (maxValues[field] === undefined || val > maxValues[field]) {
              maxValues[field] = val;
            }
          }
        }

        for (const field of HISTORY_AGGREGATION_AVG_FIELDS) {
          const val = DatabaseService._extractMetricNumber(sMetrics, field);
          if (val !== null) {
            avgSums[field] = (avgSums[field] || 0) + val;
            avgCounts[field] = (avgCounts[field] || 0) + 1;
          }
        }
      }

      for (const [field, val] of Object.entries(maxValues)) {
        DatabaseService._setMetricValue(mergedMetrics, field, val);
      }

      for (const [field, sum] of Object.entries(avgSums)) {
        const count = avgCounts[field];
        if (count > 0) {
          const avg = sum / count;
          const finalVal = (field.startsWith('ping_') || field.startsWith('loss_'))
            ? Math.round(avg)
            : Number(avg.toFixed(2));
          DatabaseService._setMetricValue(mergedMetrics, field, finalVal);
        }
      }

      result.push({
        ts: latestSample.ts,
        metrics: mergedMetrics
      });
    }

    return result;
  }

  static async getLatestMetrics(db, serverId, server = null) {
    return new DatabaseService(db).getLatestMetrics(serverId, server);
  }

  static async getLatestMetricsForAllServers(db) {
    return new DatabaseService(db).getLatestMetricsForAllServers();
  }

  static async getLatestTimestampsForAllServers(db) {
    return new DatabaseService(db).getLatestTimestampsForAllServers();
  }

  static async getMetricsHistory(db, serverId, hours, columns, server = null, longHistoryPoints = DEFAULT_LONG_HISTORY_POINTS) {
    return new DatabaseService(db).getMetricsHistory(serverId, hours, columns, server, longHistoryPoints);
  }

  static async getDashboardLatencyHistory(db, servers, options = {}) {
    return new DatabaseService(db).getDashboardLatencyHistory(servers, options);
  }

  // --- 实例方法 ---

  async init() {
    if (DatabaseService.dbInitialized) return;

    debug('初始化数据库');

    try {
      const SettingTableExists = await this.db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='settings'
      `).first();
      if (!SettingTableExists) {
        await this.db.prepare(`
          CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY, 
            value TEXT
          )
        `).run();
        await saveSiteOptions(this.db, { servers_optimized: 'true' });
      }

      // 判断servers表是否存在
      const ServerTableExists = await this.db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='servers'
      `).first();
      if (!ServerTableExists) {
        await this.db.prepare(`
          CREATE TABLE IF NOT EXISTS servers (
            id TEXT PRIMARY KEY,
            name TEXT,
            server_group TEXT DEFAULT 'Default',
            region TEXT DEFAULT '',
            tags TEXT DEFAULT '',
            note TEXT DEFAULT '',
            price TEXT DEFAULT '',
            billing_cycle TEXT DEFAULT 'month',
            auto_renewal TEXT DEFAULT '0',
            currency TEXT DEFAULT '¥',
            expire_date TEXT DEFAULT '',
            traffic_limit TEXT DEFAULT '',
            traffic_calc_type TEXT DEFAULT 'total',
            traffic_alert_percent INTEGER DEFAULT NULL,
            traffic_alert_state TEXT,
            "interface" TEXT DEFAULT '',
            reset_day INTEGER DEFAULT 1,
            collect_interval INTEGER DEFAULT 0,
            report_interval INTEGER DEFAULT 60,
            wss_report_interval INTEGER DEFAULT 2,
            connection_mode TEXT DEFAULT 'auto',
            ping_mode TEXT DEFAULT 'tcp',
            auto_update TEXT DEFAULT '0',
            custom_ct TEXT DEFAULT '',
            custom_cu TEXT DEFAULT '',
            custom_cm TEXT DEFAULT '',
            custom_bd TEXT DEFAULT '',
            node_1 TEXT DEFAULT '',
            node_2 TEXT DEFAULT '',
            node_3 TEXT DEFAULT '',
            node_4 TEXT DEFAULT '',
            rx_correction REAL DEFAULT NULL,
            tx_correction REAL DEFAULT NULL,
            offline_notify_disabled TEXT DEFAULT '0',
            is_hidden TEXT DEFAULT '0',
            sort_order INTEGER DEFAULT 0,
            history_partition_id INTEGER DEFAULT 0,
            secret TEXT DEFAULT NULL,
            timestamp INTEGER DEFAULT 0
          )
        `).run();
      } else {
        debug('检查servers表优化状态');
        await ensureServerOptimization(this.db);
      }

      // 确保 metrics_history 表存在（主键 id 已编码分区与时间，无需二级索引）
      await this.db.prepare(createHistoryTableSql('metrics_history')).run();

      debug('✅ 数据库初始化完成');
      DatabaseService.dbInitialized = true;
    } catch (e) {
      console.error('Failed to initialize database:', e);
    }
  }

  async clearHistory() {
    debug('开始清空历史数据...');

    try {
      await this.db.prepare(`DROP TABLE IF EXISTS metrics_history`).run();
      debug('✅ 已删除 metrics_history 表');

      await this.db.prepare(`DROP TABLE IF EXISTS metrics_history_old`).run();
      debug('✅ 已删除 metrics_history_old 表');

      DatabaseService.dbInitialized = false;

      await this.init();

      await clearAllCaches(this.db);
      DatabaseService.clearDashboardLatencyHistoryCache();

      debug('✅ 数据库重建完成');

      return {
        success: true,
        message: 'databaseRebuiltSuccess'
      };
    } catch (e) {
      console.error('Failed to clean up database:', e);
      return {
        success: false,
        message: 'databaseRebuiltFailed',
        error: e.message
      };
    }
  }

  async weeklyCleanup() {
    try {
      debug('[Cleanup] 开始执行表轮换操作...');

      // 1. 删除旧的 metrics_history_old 表（如果存在）
      await this.db.prepare(`DROP TABLE IF EXISTS metrics_history_old`).run();
      debug('[Cleanup] 已删除旧的 metrics_history_old 表');

      // 2. 将 metrics_history 重命名为 metrics_history_old
      const currentTable = await this.db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='metrics_history'`
      ).first();

      if (currentTable) {
        await this.db.prepare(`ALTER TABLE metrics_history RENAME TO metrics_history_old`).run();
        debug('[Cleanup] 已将 metrics_history 重命名为 metrics_history_old');
      }

      // 3. 重新初始化数据库以创建新的 metrics_history 表
      DatabaseService.dbInitialized = false;
      await this.init();

      debug('[Cleanup] 已创建新的 metrics_history 表');

      return {
        success: true,
        message: '表轮换成功'
      };
    } catch (e) {
      console.error('[Cleanup] Table rotation failed:', e);
      return { success: false, error: e.message };
    }
  }

  buildHistoryInsertStatement(serverId, historyPartitionId, metrics = {}, regionCode = '', timestamp = null, agentVersion = '') {
    const historyId = buildHistoryId(historyPartitionId, timestamp);
    const rawTimestamp = Number(timestamp);
    const now = Number.isFinite(rawTimestamp) && rawTimestamp > 0
      ? (rawTimestamp < 10000000000 ? rawTimestamp * 1000 : rawTimestamp)
      : Date.now();

    const parsePing = (val) => {
      if (isDisabledProbeMetric(val)) return 'false';
      const num = parseInt(val);
      return (num > 0) ? num : null;
    };

    const parseLoss = (val) => {
      if (isDisabledProbeMetric(val)) return 'false';
      const num = parseInt(val);
      if (Number.isNaN(num)) return null;
      return Math.max(0, Math.min(100, num));
    };

    const diskMetrics = flattenDiskMetrics(metrics);

    return this.db.prepare(`
      INSERT OR REPLACE INTO metrics_history (
        ${HISTORY_INSERT_COLUMNS.join(', ')}
      ) VALUES (
        ${HISTORY_INSERT_COLUMNS.map(() => '?').join(', ')}
      )
    `).bind(
      historyId,
      serverId,
      now,
      agentVersion || '',
      parseFloat(metrics.cpu) || 0,
      metrics.load || metrics.load_avg || '0 0 0',
      parseFloat(metrics.net_in_speed) || 0,
      parseFloat(metrics.net_out_speed) || 0,
      parseFloat(metrics.net_rx) || 0,
      parseFloat(metrics.net_tx) || 0,
      parseInt(metrics.processes) || 0,
      parseInt(metrics.tcp_conn) || 0,
      parseInt(metrics.udp_conn) || 0,
      parsePing(metrics.ping_ct),
      parsePing(metrics.ping_cu),
      parsePing(metrics.ping_cm),
      parsePing(metrics.ping_bd),
      parsePing(metrics.ping_node_1),
      parsePing(metrics.ping_node_2),
      parsePing(metrics.ping_node_3),
      parsePing(metrics.ping_node_4),
      parseLoss(metrics.loss_ct),
      parseLoss(metrics.loss_cu),
      parseLoss(metrics.loss_cm),
      parseLoss(metrics.loss_bd),
      parseLoss(metrics.loss_node_1),
      parseLoss(metrics.loss_node_2),
      parseLoss(metrics.loss_node_3),
      parseLoss(metrics.loss_node_4),
      parseFloat(metrics.ram_total) || 0,
      parseFloat(metrics.ram_used) || 0,
      parseFloat(metrics.swap_total) || 0,
      parseFloat(metrics.swap_used) || 0,
      parseFloat(metrics.disk_total) || 0,
      parseFloat(metrics.disk_used) || 0,
      diskMetrics.disk_read_bps,
      diskMetrics.disk_write_bps,
      diskMetrics.disk_read_iops,
      diskMetrics.disk_write_iops,
      diskMetrics.disk_await_ms,
      diskMetrics.disk_util,
      parseInt(metrics.cpu_cores) || 0,
      metrics.cpu_info || '',
      Array.isArray(metrics.gpu_info) ? JSON.stringify(metrics.gpu_info) : (metrics.gpu_info || ''),
      metrics.arch || '',
      metrics.os || '',
      metrics.kernel_version || '',
      regionCode,
      metrics.ip_v4 || '0',
      metrics.ip_v6 || '0',
      metrics.boot_time || '',
      parseFloat(metrics.net_rx_monthly) || 0,
      parseFloat(metrics.net_tx_monthly) || 0
    );
  }

  async _executeStatementsBatch(statements) {
    if (!Array.isArray(statements) || statements.length === 0) return;
    if (typeof this.db.batch === 'function') {
      for (let i = 0; i < statements.length; i += DatabaseService.D1_BATCH_CHUNK_SIZE) {
        await this.db.batch(statements.slice(i, i + DatabaseService.D1_BATCH_CHUNK_SIZE));
      }
    } else {
      for (const stmt of statements) {
        await stmt.run();
      }
    }
  }

  async saveMetricsHistory(serverId, historyPartitionId, metrics, regionCode = '', timestamp = null, agentVersion = '') {
    try {
      await this.buildHistoryInsertStatement(serverId, historyPartitionId, metrics, regionCode, timestamp, agentVersion).run();
    } catch (e) {
      if (e?.message && /has no column/i.test(e.message)) {
        console.warn('Detected missing database columns, attempting to add them...');
        await addHistoryColumns(this.db);
        try {
          await this.buildHistoryInsertStatement(serverId, historyPartitionId, metrics, regionCode, timestamp, agentVersion).run();
        } catch (retryError) {
          console.error('Failed to save metrics history:', retryError?.message || retryError);
        }
        return;
      }
      console.error('Failed to save metrics history:', e?.message || e);
    }
  }

  async saveMetricsHistoryBatch(serverId, historyPartitionId, samples = [], regionCode = '', agentVersion = '', baselineMetrics = null, bucketIntervalMs = HISTORY_BATCH_BUCKET_INTERVAL_MS) {
    if (!Array.isArray(samples) || samples.length === 0) return;

    const downsampled = DatabaseService.downsampleHistorySamples(samples, baselineMetrics, bucketIntervalMs);
    if (!downsampled || downsampled.length === 0) return;

    const buildStatements = () => downsampled.map(s => {
      return this.buildHistoryInsertStatement(
        serverId,
        historyPartitionId,
        s.metrics,
        regionCode,
        s.ts,
        agentVersion
      );
    });

    try {
      await this._executeStatementsBatch(buildStatements());
    } catch (e) {
      if (e?.message && /has no column/i.test(e.message)) {
        console.warn('Detected missing database columns, attempting to add them...');
        await addHistoryColumns(this.db);
        try {
          await this._executeStatementsBatch(buildStatements());
        } catch (retryError) {
          console.error('Failed to save batch metrics history:', retryError?.message || retryError);
          throw retryError;
        }
        return;
      }
      console.error('Failed to save batch metrics history:', e?.message || e);
      throw e;
    }
  }

  async getLatestMetrics(serverId, server = null) {
    try {
      const historyInfo = await getServerHistoryInfo(this.db, serverId, server);
      if (!historyInfo.partitionId) {
        throw new Error('Invalid history partition id');
      }

      const rangeStart = historyInfo.startTimestamp > 0 ? historyInfo.startTimestamp : null;
      const { startId, endId } = getHistoryIdRange(historyInfo.partitionId, rangeStart);
      debug(`Server ${serverId} history_id_range: ${startId} - ${endId}`);

      const result = await this.db.prepare(`
        SELECT * FROM metrics_history
        WHERE id >= ?
          AND id <= ?
        ORDER BY id DESC
        LIMIT 1
      `).bind(startId, endId).first();
      return result ? normalizeProbeMetricRow(result) : null;
    } catch (e) {
      console.error('Failed to get latest metrics:', e);
      return null;
    }
  }

  async getLatestMetricsForAllServers() {
    const now = Date.now();
    const cacheInfo = getLatestMetricsCache();
    if (cacheInfo.cache && now - cacheInfo.time < cacheInfo.ttl) {
      return cacheInfo.cache;
    }

    const result = new Map();
    try {
      const servers = await getAllServers(this.db);
      if (servers.length === 0) {
        setLatestMetricsCache(result);
        return result;
      }

      const items = [];
      for (const server of servers) {
        try {
          const historyInfo = await getServerHistoryInfo(this.db, server.id, server);
          if (!historyInfo.partitionId) continue;
          const rangeStart = historyInfo.startTimestamp > 0 ? historyInfo.startTimestamp : null;
          const { startId, endId } = getHistoryIdRange(historyInfo.partitionId, rangeStart);
          items.push({ server, startId, endId });
        } catch (err) {
          debug(`Server ${server.id} history 范围计算失败，跳过: ${err.message}`);
        }
      }

      for (let offset = 0; offset < items.length; offset += DatabaseService.LATEST_QUERY_CHUNK_SIZE) {
        const chunk = items.slice(offset, offset + DatabaseService.LATEST_QUERY_CHUNK_SIZE);
        let batchResults;
        try {
          batchResults = await this.db.batch(chunk.map(item =>
            this.db.prepare(
              'SELECT * FROM metrics_history WHERE id >= ? AND id <= ? ORDER BY id DESC LIMIT 1'
            ).bind(item.startId, item.endId)
          ));
        } catch (batchError) {
          debug(`批量获取最新指标失败，回退逐台查询: ${batchError.message}`);
          for (const item of chunk) {
            const metrics = await this.getLatestMetrics(item.server.id, item.server);
            if (metrics) result.set(item.server.id, metrics);
          }
          continue;
        }
        for (let index = 0; index < chunk.length; index++) {
          const rows = batchResults[index] && batchResults[index].results;
          if (rows && rows.length > 0) {
            result.set(chunk[index].server.id, normalizeProbeMetricRow(rows[0]));
          }
        }
      }

      setLatestMetricsCache(result);
      return result;
    } catch (e) {
      console.error('Failed to get latest metrics for all servers:', e);
      const fallback = getLatestMetricsCache();
      return fallback.cache || new Map();
    }
  }

  async getLatestTimestampsForAllServers() {
    const now = Date.now();
    const cacheInfo = getLatestMetricsCache();
    if (cacheInfo.cache && now - cacheInfo.time < cacheInfo.ttl) {
      return DatabaseService.extractTimestampsFromMetricsCache(cacheInfo.cache);
    }

    const collected = new Map();
    try {
      const servers = await getAllServers(this.db);
      if (servers.length === 0) return collected;

      const items = [];
      for (const server of servers) {
        try {
          const historyInfo = await getServerHistoryInfo(this.db, server.id, server);
          if (!historyInfo.partitionId) continue;
          const rangeStart = historyInfo.startTimestamp > 0 ? historyInfo.startTimestamp : null;
          const { startId, endId } = getHistoryIdRange(historyInfo.partitionId, rangeStart);
          items.push({ serverId: server.id, startId, endId });
        } catch (err) {
          debug(`Server ${server.id} history 范围计算失败，跳过: ${err.message}`);
        }
      }

      for (let offset = 0; offset < items.length; offset += DatabaseService.LATEST_QUERY_CHUNK_SIZE) {
        const chunk = items.slice(offset, offset + DatabaseService.LATEST_QUERY_CHUNK_SIZE);
        const batchResults = await this.db.batch(chunk.map(item =>
          this.db.prepare(
            'SELECT timestamp FROM metrics_history WHERE id >= ? AND id <= ? ORDER BY id DESC LIMIT 1'
          ).bind(item.startId, item.endId)
        ));
        for (let index = 0; index < chunk.length; index++) {
          const rows = batchResults[index] && batchResults[index].results;
          if (rows && rows.length > 0) {
            collected.set(chunk[index].serverId, rows[0].timestamp);
          }
        }
      }
      return collected;
    } catch (e) {
      console.error('Failed to get latest timestamps for all servers:', e);
      return cacheInfo.cache ? DatabaseService.extractTimestampsFromMetricsCache(cacheInfo.cache) : null;
    }
  }

  async getMetricsHistory(serverId, hours, columns, server = null, longHistoryPoints = DEFAULT_LONG_HISTORY_POINTS) {
    const now = Date.now();
    const cacheDuration = getCacheDuration(hours);
    const queryHours = Math.min(hours, 168);
    const configuredLongHistoryPoints = queryHours > 1
      ? Number(normalizeLongHistoryPoints(longHistoryPoints))
      : null;

    const cached = getMetricsHistoryCache(serverId, hours, columns, configuredLongHistoryPoints);
    if (cached && now - cached.timestamp < cacheDuration) {
      debug(`[History] CACHE HIT: ${serverId}, hours: ${hours}`);
      return cached.data;
    }

    const totalMs = queryHours * 60 * 60 * 1000;
    const cutoff = now - queryHours * 60 * 60 * 1000;
    const historyInfo = await getServerHistoryInfo(this.db, serverId, server);
    const queryStart = Math.max(cutoff, historyInfo.startTimestamp);

    const nowDate = new Date(now);
    const day = nowDate.getUTCDay();
    const thisSunday = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate() - day));
    const needOldTable = queryStart < thisSunday.getTime();

    const oldTableExists = needOldTable && !!await this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='metrics_history_old'`
    ).first();

    if (!historyInfo.partitionId) {
      throw new Error('Invalid history partition id');
    }
    const idRange = getHistoryIdRange(historyInfo.partitionId, queryStart);

    const columnList = columns.split(',').map(c => c.trim()).filter(c => c && c !== 'timestamp');
    const sourceColumns = columnList.join(', ');
    const lossColumns = columnList.filter(col => DatabaseService.LOSS_AGG_COLUMNS.has(col));
    const lossWindowExpressions = lossColumns.map(col =>
      `MAX(${col}) OVER (PARTITION BY bucket) AS ${col}_bucket_max`
    );
    const selectColumns = columnList.map(col =>
      DatabaseService.LOSS_AGG_COLUMNS.has(col) ? `${col}_bucket_max AS ${col}` : col
    );

    const useSparseSampling = shouldUseSparseHistorySampling(queryHours);
    const sparseQueryEnd = Math.floor(now / 1000) * 1000 + 1000;
    const maxPoints = queryHours > 1
      ? configuredLongHistoryPoints
      : DatabaseService.DEFAULT_HISTORY_MAX_POINTS;
    const samplingDurationMs = useSparseSampling
      ? Math.max(0, sparseQueryEnd - queryStart)
      : totalMs;
    const intervalMs = Math.max(10_000, Math.ceil(samplingDurationMs / maxPoints));

    debug(
      '[History]',
      'server:', serverId,
      'hours:', hours,
      'queryHours:', queryHours,
      'maxPoints:', maxPoints,
      'interval:', intervalMs,
      'cutoff:', new Date(cutoff).toISOString(),
      'start:', new Date(queryStart).toISOString()
    );

    let rawResult;

    if (useSparseSampling) {
      const queryEnd = sparseQueryEnd;
      const firstRangeEnd = Math.min(
        queryEnd,
        queryStart + intervalMs
      );
      const idPrefix = getHistoryIdRange(historyInfo.partitionId).startId;
      const sparseQuery = buildSparseHistoryQuery({
        columns: sourceColumns,
        queryStart,
        queryEnd,
        firstRangeEnd,
        intervalMs,
        idPrefix,
        oldTableExists,
        tableBoundary: thisSunday.getTime()
      });

      debug('[History] SPARSE ID SAMPLING:', sparseQuery.bindValues.length, 'bind values');
      const sparseResult = await this.db.prepare(sparseQuery.sql).bind(...sparseQuery.bindValues).all();
      rawResult = {
        ...sparseResult,
        results: sparseResult.results
          .filter(row => row.sample_json)
          .map(row => JSON.parse(row.sample_json))
      };
    } else {
      const sourceQueries = [];
      const bindValues = [];

      sourceQueries.push(DatabaseService.buildHistorySourceQuery('metrics_history', sourceColumns));
      bindValues.push(idRange.startId, idRange.endId);

      if (oldTableExists) {
        debug('[History] 跨周查询，合并 metrics_history 和 metrics_history_old');
        sourceQueries.push(DatabaseService.buildHistorySourceQuery('metrics_history_old', sourceColumns));
        bindValues.push(idRange.startId, idRange.endId);
      }

      bindValues.push(intervalMs);

      rawResult = await this.db.prepare(`
        WITH history_rows AS (
          ${sourceQueries.join('\n        UNION ALL\n')}
        ),
        bucketed AS (
          SELECT
            timestamp,
            ${sourceColumns},
            CAST(timestamp / ? AS INTEGER) AS bucket
          FROM history_rows
        ),
        sampled AS (
          SELECT
            timestamp,
            ${sourceColumns},
            ROW_NUMBER() OVER (
              PARTITION BY bucket
              ORDER BY timestamp
            ) AS rn
            ${lossWindowExpressions.length ? `,\n          ${lossWindowExpressions.join(',\n          ')}` : ''}
          FROM bucketed
        )
        SELECT timestamp, ${selectColumns.join(', ')}
        FROM sampled
        WHERE rn = 1
      `).bind(...bindValues).all();
    }

    const result = rawResult.results.map(row => attachDiskMetricsObject(normalizeProbeMetricRow({
      ...row,
      timestamp: Number(row.timestamp)
    })));

    result.sort((a, b) => a.timestamp - b.timestamp);

    setMetricsHistoryCache(serverId, hours, columns, result, configuredLongHistoryPoints);

    debug(`[History] FINAL: ${result.length}, interval: ${intervalMs}ms`);

    return result;
  }

  async getDashboardLatencyHistory(servers, options = {}) {
    const serverList = Array.isArray(servers) ? servers : [];
    const serverIds = serverList.map(server => String(server?.id || '').trim()).filter(Boolean);
    if (serverIds.length === 0) return new Map();

    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
    const useCache = options.cache !== false;
    const result = new Map();
    const serversToFetch = [];

    if (useCache) {
      DatabaseService.pruneDashboardLatencyHistoryCache(now);
    }

    for (const server of serverList) {
      const serverId = String(server?.id || '').trim();
      if (!serverId) continue;

      const cached = DatabaseService.dashboardLatencyHistoryCache.get(serverId);
      if (useCache && cached && now - cached.cachedAt < DASHBOARD_LATENCY_WINDOW_CACHE_TTL_MS) {
        result.set(serverId, cached.window);
        continue;
      }
      serversToFetch.push(server);
    }

    if (serversToFetch.length === 0) return result;

    const points = Number.isInteger(options.points) && options.points > 0
      ? options.points
      : DASHBOARD_LATENCY_WINDOW_POINTS;
    const queryEnd = Math.floor(now / 1000) * 1000 + 1000;
    const cutoff = now - DASHBOARD_LATENCY_WINDOW_HOURS * 60 * 60 * 1000;
    const columns = DatabaseService.DASHBOARD_LATENCY_COLUMNS.join(', ');

    const nowDate = new Date(now);
    const day = nowDate.getUTCDay();
    const thisSunday = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate() - day));
    const oldTableExists = cutoff < thisSunday.getTime() && !!await this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='metrics_history_old'`
    ).first();

    const fetchServerLatency = async server => {
      const serverId = String(server?.id || '').trim();
      if (!serverId) return;

      try {
        const historyInfo = await getServerHistoryInfo(this.db, serverId, server);
        if (!historyInfo.partitionId) {
          result.set(serverId, { ping: [], loss: [] });
          return;
        }

        const queryStart = cutoff;
        if (queryStart >= queryEnd) {
          result.set(serverId, { ping: [], loss: [] });
          return;
        }

        const intervalMs = Math.max(10_000, Math.ceil((queryEnd - queryStart) / points));
        const idPrefix = getHistoryIdRange(historyInfo.partitionId).startId;
        const querySparseHistory = async queryColumns => {
          const sparseQuery = buildSparseHistoryQuery({
            columns: queryColumns,
            queryStart,
            queryEnd,
            firstRangeEnd: Math.min(queryEnd, queryStart + intervalMs),
            intervalMs,
            idPrefix,
            oldTableExists,
            tableBoundary: thisSunday.getTime(),
            sampleOrder: 'DESC'
          });
          return this.db.prepare(sparseQuery.sql).bind(...sparseQuery.bindValues).all();
        };

        const rawResult = await querySparseHistory(columns);
        const window = DatabaseService.normalizeDashboardLatencyWindow(rawResult.results, { queryStart, intervalMs, points });
        result.set(serverId, window);
        if (useCache) {
          DatabaseService.dashboardLatencyHistoryCache.set(serverId, { cachedAt: now, window });
        }
      } catch (e) {
        debug('[DashboardLatency] query failed:', serverId, e?.message || e);
        const empty = { ping: [], loss: [] };
        result.set(serverId, empty);
        if (useCache) {
          DatabaseService.dashboardLatencyHistoryCache.set(serverId, { cachedAt: now, window: empty });
        }
      }
    };

    for (let offset = 0; offset < serversToFetch.length; offset += DASHBOARD_LATENCY_WINDOW_QUERY_CONCURRENCY) {
      await Promise.all(
        serversToFetch
          .slice(offset, offset + DASHBOARD_LATENCY_WINDOW_QUERY_CONCURRENCY)
          .map(fetchServerLatency)
      );
    }

    return result;
  }
}
