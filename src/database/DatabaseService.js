import { clearAllCaches } from '../utils/cache.js';
import { saveSiteOptions, debug } from '../utils/settings.js';
import { isDisabledProbeMetric, DISK_IO_FIELD_TO_COLUMN, DISK_IO_METRIC_FIELDS } from '../utils/metrics.js';
import { ensureServerOptimization } from './indexOptimization.js';
import {
  HISTORY_MAX_BATCH_BUCKETS, HISTORY_BATCH_BUCKET_INTERVAL_MS,
  HISTORY_AGGREGATION_MAX_FIELDS, HISTORY_AGGREGATION_AVG_FIELDS
} from '../utils/historyFields.js';

/**
 * DatabaseService
 * 负责 D1 配置表初始化、维护及共用指标格式化；指标存储与查询由 DO SQLite 负责
 */
export class DatabaseService {
  static dbInitialized = false;
  static LATENCY_NODE_FIELDS = ['ct', 'cu', 'cm', 'bd', 'node_1', 'node_2', 'node_3', 'node_4'];
  static DISK_IO_COLUMN_TO_FIELD = Object.freeze(Object.fromEntries(
    DISK_IO_METRIC_FIELDS.map(field => [DISK_IO_FIELD_TO_COLUMN[field], field])
  ));

  constructor(db) {
    this.db = db;
  }

  // --- 静态缓存与辅助方法 ---

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
      if (!Object.prototype.hasOwnProperty.call(row, column)) {
        if (includeEmpty) point[field] = null;
        continue;
      }
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

      // metrics 数据已完全移至 Durable Objects（DO），D1 中不再创建或维护 metrics_history 表
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
      debug('[Cleanup] 开始执行每周数据库维护...');

      // metrics 数据已完全移至 DO，清理遗留的 D1 历史表
      await this.db.prepare(`DROP TABLE IF EXISTS metrics_history_old`).run();
      await this.db.prepare(`DROP TABLE IF EXISTS metrics_history`).run();
      debug('[Cleanup] 已清理 D1 metrics_history 表');

      return {
        success: true,
        message: '维护成功'
      };
    } catch (e) {
      console.error('[Cleanup] Table cleanup failed:', e);
      return { success: false, error: e.message };
    }
  }

}
