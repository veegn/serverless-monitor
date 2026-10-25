import { saveMetricsHistory, saveMetricsHistoryBatch } from '../database/schema.js';
import { getServerDetail, clearServerDetailCache, patchServerDetailCache, clearServersListCache, getAllServers } from '../utils/cache.js';
import { evaluateTrafficAlert, sendNotification } from '../services/notification.js';
import { getNotificationMessages } from '../services/notificationMessages.js';
import { addServerColumns } from '../database/updateDatabase.js';
import {
  DISK_IO_FIELD_TO_COLUMN,
  DISK_IO_METRIC_FIELDS,
  mergeMetricsIntoServer,
  coerceNumericMetricFields
} from '../utils/metrics.js';
import { createErrorResponse, createUnauthorizedResponse, createBadRequestResponse } from '../utils/errors.js';
import { ensureServerOptimization, getNextServerHistoryPartitionId, HISTORY_MAX_PARTITION_ID } from '../database/indexOptimization.js';
import { getResourceAlertConfig, getWssReportScheduleState, isWssReportConfigured, loadSiteSettings, normalizeBooleanSetting } from '../utils/settings.js';
import { cacheLatestReportUpdate } from '../utils/latestReportCache.js';
import {
  hasRecentFrontendRealtimeActivity,
  markFrontendRealtimeActive
} from '../utils/realtimeBroadcastGate.js';
import { checkWebSocketAuth } from '../middleware/auth.js';
import {
  AGENT_CONFIG_MD5_HEADER,
  AGENT_CONFIG_SCHEMA_HEADER,
  describeAgentConfig,
  isValidTrafficCorrection,
  normalizeAgentConfigSchemaVersion,
  serializeCorrection
} from '../utils/agentConfig.js';
import { scheduleAgentConfigChanged } from '../utils/agentConfigNotify.js';
import {
  BROADCAST_DELETE_FIELDS,
  HISTORY_METRIC_AGGREGATION_POLICY
} from '../utils/historyFields.js';
import {
  UPDATE_FRONTEND_SUBSCRIBER_CHECK_INTERVAL_MS,
  UPDATE_MAX_BATCH_SAMPLES,
  UPDATE_MAX_REQUEST_BYTES,
  UPDATE_REALTIME_BATCH_WINDOW_MS,
  UPDATE_RESOURCE_ALERT_BATCH_WINDOW_MS
} from '../utils/config.js';

// 将最新一次上报打包成前端可直接消费的 "当前状态" 对象
// 与 /api/server 和 /api/servers 返回的字段保持一致，便于页面直接合并
function buildPayloadForBroadcast(id, metrics = {}, extra = {}) {
  const payload = {};
  mergeMetricsIntoServer(payload, metrics);
  payload.id = id;
  payload.region = extra.region || '';
  payload.agent_version = extra.agentVersion || metrics.agent_version || '';
  payload.last_updated = extra.timestamp || metrics.timestamp || Date.now();
  payload.timestamp = payload.last_updated;
  return coerceNumericMetricFields(payload);
}

// 批量推送：前端实时使用短窗口；仅资源告警缓存时使用较长窗口降低 DO 请求。
const DISK_IO_COLUMN_TO_FIELD = Object.freeze(Object.fromEntries(
  DISK_IO_METRIC_FIELDS.map(field => [DISK_IO_FIELD_TO_COLUMN[field], field])
));
export const AGENT_AUTO_DISCOVERY_HEADER = 'x-sma-auto-discovery';
export const AGENT_AUTO_DISCOVERY_SERVER_ID_HEADER = 'x-sma-server-id';
export const LEGACY_AGENT_AUTO_DISCOVERY_HEADER = 'x-cfsm-auto-discovery';
export const LEGACY_AGENT_AUTO_DISCOVERY_SERVER_ID_HEADER = 'x-cfsm-server-id';
export const AGENT_AUTO_DISCOVERY_CREATED = 'created';
export const AGENT_AUTO_DISCOVERY_REUSED = 'reused';
export const AGENT_AUTO_DISCOVERY_FAILED = 'failed';
export const AGENT_AUTO_DISCOVERY_DISABLED = 'disabled';
export const AGENT_WSS_MODE_HEADER = 'x-agent-wss-mode';
export const AGENT_WSS_REASON_HEADER = 'x-agent-wss-reason';
export const AGENT_WSS_SCHEDULE_INACTIVE = 'wss_schedule_inactive';
export const AGENT_WSS_SCHEDULE_DISABLED = 'wss_disabled';

export function buildAutoDiscoveryHeaders(status, serverId = null) {
  const headers = {
    [AGENT_AUTO_DISCOVERY_HEADER]: status,
    [LEGACY_AGENT_AUTO_DISCOVERY_HEADER]: status
  };
  if (serverId) {
    headers[AGENT_AUTO_DISCOVERY_SERVER_ID_HEADER] = serverId;
    headers[LEGACY_AGENT_AUTO_DISCOVERY_SERVER_ID_HEADER] = serverId;
  }
  return headers;
}
let batchQueue = new Map();
let flushingPromise = null;
let flushTimer = null;
let flushDueAt = 0;
let resolveFlushingPromise = null;
let frontendSubscriberSnapshot = { checkedAt: 0, count: 0 };

function normalizeTimestamp(value, fallback = Date.now()) {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return fallback;
  return ts < 10000000000 ? ts * 1000 : ts;
}

export function normalizeAgentVersion(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .trim()
    .replace(/[^0-9A-Za-z.+_-]/g, '')
    .slice(0, 64);
}

function logUpdateBadRequest(reason, details = {}) {
  console.warn('[Update] 400 Bad Request:', reason, details);
}

function getDeclaredContentLength(request) {
  const raw = request.headers.get('Content-Length');
  if (!raw) return null;
  const length = Number(raw);
  return Number.isFinite(length) && length >= 0 ? length : null;
}

function createPayloadTooLargeResponse() {
  return new Response(JSON.stringify({
    error: 'Payload too large',
    code: 413,
    text: 'payload_too_large'
  }), {
    status: 413,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-CFSM-Agent-Status': 'payload_too_large',
      // 与 Agent 的 wssProtocolRetryDelay（120s）保持一致；当前 Agent 尚未读取该头，仅作后续兼容。
      'Retry-After': '120'
    }
  });
}

// 保持 404 兼容旧版 Agent：Agent 的 isAuthConfigHTTPStatus 只认 401/403/404，
// 改 410 会让 WSS 失去 120s 协议退避。
function createServerNotFoundResponse() {
  return new Response(JSON.stringify({
    error: 'Server not found',
    code: 404,
    text: 'server_not_found'
  }), {
    status: 404,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-CFSM-Agent-Status': 'server_not_found',
      // 服务器已删除：让 Agent 退避更久（300s），减少僵尸 Agent 的无效请求。
      'Retry-After': '300'
    }
  });
}

export function normalizeCorrectionValue(value) {
  if (value === null || value === undefined || value === '') return 0;
  return isValidTrafficCorrection(value) ? Number(value) : null;
}

export function normalizeMetricSamples(data) {
  const now = Date.now();
  const rawSamples = Array.isArray(data.samples)
    ? data.samples
    : (Array.isArray(data.batch) ? data.batch : []);

  // Agent 按时间顺序追加样本；确认递增时才预截断，避免超大数组在服务端做全量 map/sort。
  // 乱序输入不预截断，交给末尾的 sort + slice 兜底，避免丢掉最新样本。
  const sampleTs = item => Number(item?.ts ?? item?.timestamp ?? item?.metrics?.timestamp);
  const firstTs = sampleTs(rawSamples[0]);
  const lastTs = sampleTs(rawSamples[rawSamples.length - 1]);
  const chronological = Number.isFinite(firstTs) && Number.isFinite(lastTs) && firstTs <= lastTs;
  const boundedSamples = chronological && rawSamples.length > UPDATE_MAX_BATCH_SAMPLES
    ? rawSamples.slice(-UPDATE_MAX_BATCH_SAMPLES)
    : rawSamples;

  const samples = boundedSamples.map(item => {
    if (!item || typeof item !== 'object') return null;
    const metrics = item.metrics || item.data || item.payload || item;
    if (!metrics || typeof metrics !== 'object') return null;
    const ts = normalizeTimestamp(item.ts ?? item.timestamp ?? metrics.timestamp, now);
    return { ts, metrics };
  }).filter(Boolean);

  if (samples.length === 0 && data.metrics && typeof data.metrics === 'object') {
    samples.push({
      ts: normalizeTimestamp(data.metrics.timestamp, now),
      metrics: data.metrics
    });
  }

  samples.sort((a, b) => a.ts - b.ts);
  return samples.slice(-UPDATE_MAX_BATCH_SAMPLES);
}

export function getReportMetrics(data, latestSample) {
  const reportMetrics = data?.metrics && typeof data.metrics === 'object' ? data.metrics : null;
  if (!reportMetrics) return latestSample?.metrics || {};
  return {
    ...reportMetrics,
    ...(latestSample?.metrics || {})
  };
}

function hasOwnMetric(source, field) {
  return !!source && Object.prototype.hasOwnProperty.call(source, field);
}

function isPlainMetricObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function toFiniteHistoryMetricNumber(value) {
  if (value === false || value === 'false' || value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getHistoryMetricSourceValue(source, field) {
  if (!isPlainMetricObject(source)) return null;

  if (hasOwnMetric(source, field)) {
    return source[field];
  }

  const diskField = DISK_IO_COLUMN_TO_FIELD[field];
  if (diskField && isPlainMetricObject(source.disk) && hasOwnMetric(source.disk, diskField)) {
    return source.disk[diskField];
  }

  return null;
}

function getSampleMetricSource(sample) {
  if (!isPlainMetricObject(sample)) return null;
  return sample.metrics || sample.data || sample.payload || sample;
}

function createEmptyHistoryMetricAggregate() {
  return { max: {}, avg: {} };
}

export function mergeHistoryMetricAggregates(...aggregates) {
  const result = createEmptyHistoryMetricAggregate();

  for (const aggregate of aggregates) {
    if (!isPlainMetricObject(aggregate)) continue;

    if (isPlainMetricObject(aggregate.max)) {
      for (const [field, value] of Object.entries(aggregate.max)) {
        const number = toFiniteHistoryMetricNumber(value);
        if (number === null) continue;
        if (!hasOwnMetric(result.max, field) || number > result.max[field]) {
          result.max[field] = number;
        }
      }
    }

    if (isPlainMetricObject(aggregate.avg)) {
      for (const [field, item] of Object.entries(aggregate.avg)) {
        if (!isPlainMetricObject(item)) continue;
        const sum = toFiniteHistoryMetricNumber(item.sum);
        const count = Number(item.count);
        if (sum === null || !Number.isFinite(count) || count <= 0) continue;
        if (!result.avg[field]) {
          result.avg[field] = { sum: 0, count: 0 };
        }
        result.avg[field].sum += sum;
        result.avg[field].count += count;
      }
    }
  }

  return result;
}

function addHistoryMetricAggregateSource(aggregate, source) {
  if (!isPlainMetricObject(source)) return;

  for (const [field, policy] of Object.entries(HISTORY_METRIC_AGGREGATION_POLICY)) {
    const value = toFiniteHistoryMetricNumber(getHistoryMetricSourceValue(source, field));
    if (value === null) continue;

    if (policy === 'max') {
      if (!hasOwnMetric(aggregate.max, field) || value > aggregate.max[field]) {
        aggregate.max[field] = value;
      }
    } else if (policy === 'avg') {
      if (!aggregate.avg[field]) {
        aggregate.avg[field] = { sum: 0, count: 0 };
      }
      aggregate.avg[field].sum += value;
      aggregate.avg[field].count += 1;
    }
  }
}

export function collectHistoryMetricAggregates(samples = [], previousAggregate = null) {
  const aggregate = mergeHistoryMetricAggregates(previousAggregate);
  for (const sample of Array.isArray(samples) ? samples : []) {
    addHistoryMetricAggregateSource(aggregate, getSampleMetricSource(sample));
  }
  return aggregate;
}

function setHistoryMetricResultValue(result, field, value) {
  const diskField = DISK_IO_COLUMN_TO_FIELD[field];
  if (diskField) {
    result[field] = value;
    result.disk = isPlainMetricObject(result.disk)
      ? { ...result.disk, [diskField]: value }
      : { [diskField]: value };
    return;
  }

  result[field] = value;
}

export function applyHistoryMetricAggregates(metrics = {}, aggregate = null) {
  const result = { ...(metrics || {}) };
  const mergedAggregate = mergeHistoryMetricAggregates(aggregate);

  for (const [field, value] of Object.entries(mergedAggregate.max)) {
    setHistoryMetricResultValue(result, field, value);
  }

  for (const [field, item] of Object.entries(mergedAggregate.avg)) {
    if (!item || !Number.isFinite(item.sum) || !Number.isFinite(item.count) || item.count <= 0) continue;
    setHistoryMetricResultValue(result, field, item.sum / item.count);
  }

  return result;
}

export function getHistoryMetrics(data, samples, latestSample) {
  return applyHistoryMetricAggregates(
    getReportMetrics(data, latestSample),
    collectHistoryMetricAggregates(samples)
  );
}

function buildSamplePayloadForBroadcast(metrics = {}, timestamp = Date.now()) {
  const payload = metrics && typeof metrics === 'object' ? { ...metrics } : {};
  BROADCAST_DELETE_FIELDS.forEach(field => delete payload[field]);
  payload.last_updated = timestamp;
  payload.sample_timestamp = timestamp;
  return coerceNumericMetricFields(payload);
}

export function toBroadcastSamples(id, samples, regionCode, agentVersion = '', reportMetrics = null) {
  const lastIndex = samples.length - 1;
  const base = reportMetrics && typeof reportMetrics === 'object' ? reportMetrics : null;
  return samples.map((sample, index) => {
    const metrics = base
      ? { ...base, ...(sample.metrics || {}) }
      : (sample.metrics || {});
    if (index !== lastIndex) {
      return { ts: sample.ts, payload: buildSamplePayloadForBroadcast(metrics, sample.ts) };
    }

    const payload = buildPayloadForBroadcast(id, metrics, {
      region: regionCode,
      agentVersion,
      timestamp: sample.ts
    });
    const filtered = Object.assign({}, payload);
    BROADCAST_DELETE_FIELDS.forEach(field => delete filtered[field]);
    filtered.sample_timestamp = sample.ts;
    return { ts: sample.ts, payload: filtered };
  });
}

function queueBroadcastSamples(serverId, samples) {
  if (!serverId || !Array.isArray(samples) || samples.length === 0) return;
  const existing = batchQueue.get(serverId);
  const merged = existing && Array.isArray(existing.samples)
    ? existing.samples.concat(samples)
    : samples;
  batchQueue.set(serverId, { samples: merged.slice(-UPDATE_MAX_BATCH_SAMPLES) });
}

async function getCachedFrontendSubscriberCount(env) {
  const now = Date.now();
  if (now - frontendSubscriberSnapshot.checkedAt < UPDATE_FRONTEND_SUBSCRIBER_CHECK_INTERVAL_MS) {
    return frontendSubscriberSnapshot.count;
  }

  let count = 0;
  try {
    const id = env.METRICS_BROADCASTER.idFromName('global');
    const stub = env.METRICS_BROADCASTER.get(id);
    const response = await stub.fetch('http://internal/health', {
      headers: { 'Cache-Control': 'no-store' }
    });
    if (response.ok) {
      const data = await response.json();
      count = Math.max(0, Number(data?.subscribers) || 0);
    }
  } catch (e) {
    console.warn('[broadcast] subscriber check failed:', e?.message || e);
  }

  frontendSubscriberSnapshot = { checkedAt: now, count };
  return count;
}

function hasResourceAlertNotificationTarget(settings = {}) {
  if (normalizeBooleanSetting(settings.notification_webhook_enabled) === 'true') {
    return String(settings.notification_webhook_url || '').trim().length > 0;
  }
  return String(settings.tg_bot_token || '').trim().length > 0;
}

async function getRealtimeBatchIntent(env) {
  if (!env?.METRICS_BROADCASTER) return null;

  let resourceAlertEnabled = false;
  try {
    const settings = await loadSiteSettings(env.DB);
    resourceAlertEnabled = hasResourceAlertNotificationTarget(settings) && getResourceAlertConfig(settings).enabled;
  } catch (e) {
    console.warn('[broadcast] failed to load realtime gate settings:', e?.message || e);
  }

  const frontendActive = hasRecentFrontendRealtimeActivity();
  if (frontendActive) {
    return {
      maintainState: resourceAlertEnabled
    };
  }

  if (resourceAlertEnabled) {
    return {
      maintainState: true
    };
  }

  const subscribers = await getCachedFrontendSubscriberCount(env);
  if (subscribers > 0) {
    return {
      maintainState: false
    };
  }

  return {
    maintainState: false,
    latestReportOnly: true
  };
}

async function getBatchFlushDelayMs(env, now = Date.now()) {
  if (hasRecentFrontendRealtimeActivity(now)) return UPDATE_REALTIME_BATCH_WINDOW_MS;

  try {
    const settings = await loadSiteSettings(env.DB);
    if (hasResourceAlertNotificationTarget(settings) && getResourceAlertConfig(settings).enabled) {
      return UPDATE_RESOURCE_ALERT_BATCH_WINDOW_MS;
    }
  } catch (e) {
    console.warn('[broadcast] failed to load batch delay settings:', e?.message || e);
  }

  return UPDATE_REALTIME_BATCH_WINDOW_MS;
}

function buildAgentWssStateHeaders(settings = {}, now = Date.now()) {
  const state = getWssReportScheduleState(settings, now);
  return {
    [AGENT_WSS_MODE_HEADER]: state.mode,
    [AGENT_WSS_REASON_HEADER]: state.reason
  };
}

function createAgentWssScheduleInactiveResponse(settings = {}) {
  return new Response(JSON.stringify({
    error: 'Agent WSS report outside active hours',
    code: 409,
    text: AGENT_WSS_SCHEDULE_INACTIVE,
    connection_mode: 'http'
  }), {
    status: 409,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
      ...buildAgentWssStateHeaders(settings)
    }
  });
}

function createAgentWssDisabledResponse() {
  return new Response(JSON.stringify({
    error: 'Agent WSS report disabled',
    code: 409,
    text: AGENT_WSS_SCHEDULE_DISABLED,
    connection_mode: 'http'
  }), {
    status: 409,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
      [AGENT_WSS_MODE_HEADER]: 'disabled',
      [AGENT_WSS_REASON_HEADER]: AGENT_WSS_SCHEDULE_DISABLED
    }
  });
}

async function _flushBatch(env) {
  if (batchQueue.size === 0) return;

  // 原子性地取出当前队列，避免并发写入干扰
  const queue = batchQueue;
  batchQueue = new Map();

  const updates = [];
  for (const [serverId, item] of queue) {
    if (item && Array.isArray(item.samples) && item.samples.length > 0) {
      updates.push({ serverId, samples: item.samples });
    } else if (item) {
      const filtered = Object.assign({}, item);
      BROADCAST_DELETE_FIELDS.forEach(field => delete filtered[field]);
      updates.push({ serverId, payload: filtered });
    }
  }

  if (updates.length === 0) return;

  try {
    const intent = await getRealtimeBatchIntent(env);
    if (!intent) return;

    const id = env.METRICS_BROADCASTER.idFromName('global');
    const stub = env.METRICS_BROADCASTER.get(id);
    await stub.fetch('http://internal/batch-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        updates,
        maintainState: intent.maintainState,
        latestReportOnly: intent.latestReportOnly === true
      })
    });
  } catch (e) {
    console.warn('[broadcast] batch push failed:', e.message || e);
  }
}

function _ensureBatchFlush(env) {
  const now = Date.now();
  if (flushingPromise) {
    if (
      hasRecentFrontendRealtimeActivity(now) &&
      flushDueAt > now + UPDATE_REALTIME_BATCH_WINDOW_MS
    ) {
      if (flushTimer) clearTimeout(flushTimer);
      flushDueAt = now + UPDATE_REALTIME_BATCH_WINDOW_MS;
      flushTimer = setTimeout(() => {
        const resolve = resolveFlushingPromise;
        flushTimer = null;
        flushDueAt = 0;
        resolveFlushingPromise = null;
        _flushBatch(env).finally(() => {
          flushingPromise = null;
          if (resolve) resolve();
        });
      }, UPDATE_REALTIME_BATCH_WINDOW_MS);
    }
    return flushingPromise;
  }

  flushingPromise = getBatchFlushDelayMs(env, now).then(delayMs => new Promise(resolve => {
    resolveFlushingPromise = resolve;
    const normalizedDelayMs = Math.max(0, Number(delayMs) || UPDATE_REALTIME_BATCH_WINDOW_MS);
    flushDueAt = Date.now() + normalizedDelayMs;
    flushTimer = setTimeout(() => {
      const currentResolve = resolveFlushingPromise;
      flushTimer = null;
      flushDueAt = 0;
      resolveFlushingPromise = null;
      _flushBatch(env).finally(() => {
        flushingPromise = null;
        if (currentResolve) currentResolve();
      });
    }, normalizedDelayMs);
  }));

  return flushingPromise;
}

export function checkSecretAuthorization(secret, serverDetail, settings, env) {
  const isMaster = secret === env?.API_SECRET;
  const isServer = Boolean(serverDetail && serverDetail.secret && secret === serverDetail.secret);
  const token = settings?.auto_register_token;
  const tokenExpires = Number(settings?.auto_register_token_expires) || 0;
  const isTokenMatch = Boolean(token && secret === token);
  const isTokenExpired = !tokenExpires || Date.now() > tokenExpires;
  const isTokenValid = isTokenMatch && !isTokenExpired;

  return {
    isMaster,
    isServer,
    isTokenMatch,
    isTokenExpired,
    isTokenValid,
    isAuthorizedForExisting: isMaster || isServer || isTokenValid,
    isAuthorizedForNew: isMaster || isTokenValid
  };
}

export async function autoRegisterServer(db, serverId, data, secret, settings, regionCode = '') {
  const currentServers = await getAllServers(db, true);
  if (currentServers.length >= HISTORY_MAX_PARTITION_ID) {
    throw new Error('Maximum registered server limit reached');
  }

  const firstSample = Array.isArray(data.samples) && data.samples[0] ? data.samples[0] : null;
  const metrics = data.metrics || firstSample?.metrics || {};
  let serverName = String(data.name || data.hostname || metrics.hostname || '').trim();
  if (!serverName) {
    const osPrefix = metrics.os ? String(metrics.os).trim() : 'Server';
    serverName = `${osPrefix}-${serverId.slice(0, 8)}`;
  }
  if (serverName.length > 100) serverName = serverName.slice(0, 100);

  const group = settings?.auto_register_default_group || 'Default';
  const region = regionCode || '';

  const historyPartitionId = await getNextServerHistoryPartitionId(db);
  const { max_order } = await db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_order FROM servers').first();
  const sortOrder = (max_order || 0) + 1;
  const now = Date.now();

  try {
    await db.prepare(`
      INSERT INTO servers
      (id, name, server_group, region, "interface", sort_order, history_partition_id, timestamp, secret)
      VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)
    `).bind(serverId, serverName, group, region, sortOrder, historyPartitionId, now, secret).run();
  } catch (insertErr) {
    if (/no column named secret|has no column/i.test(insertErr.message)) {
      await addServerColumns(db);
      await db.prepare(`
        INSERT INTO servers
        (id, name, server_group, region, "interface", sort_order, history_partition_id, timestamp, secret)
        VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)
      `).bind(serverId, serverName, group, region, sortOrder, historyPartitionId, now, secret).run();
    } else {
      throw insertErr;
    }
  }

  clearServersListCache();
  const serverDetail = await getServerDetail(db, serverId, true);
  return {
    serverDetail,
    serverName,
    group,
    region
  };
}

export async function handleUpdate(request, env, ctx) {
  try {
    // 必须在 request.json() 之前：超大 body 的解析本身就可能耗尽 Worker CPU。
    // 注意这是防呆而非硬上限：chunked 或缺少 Content-Length 的请求会跳过该检查。
    const declaredLength = getDeclaredContentLength(request);
    if (declaredLength !== null && declaredLength > UPDATE_MAX_REQUEST_BYTES) {
      console.warn('[Update] 413 Payload too large:', {
        content_length: declaredLength,
        limit: UPDATE_MAX_REQUEST_BYTES
      });
      return createPayloadTooLargeResponse();
    }

    const data = await request.json();
    const { id, secret } = data;
    const rawId = typeof id === 'string' ? id.trim() : '';

    let settings = null;
    try {
      settings = await loadSiteSettings(env.DB);
    } catch (_) {
      settings = {};
    }

    const wssStateHeaders = buildAgentWssStateHeaders(settings);
    const dateHeader = { 'Date': new Date().toUTCString() };

    let serverId = '';
    let serverDetail = null;
    let autoRegistered = false;

    if (!rawId) {
      if (normalizeBooleanSetting(settings?.auto_register_enabled) !== 'true') {
        return new Response(JSON.stringify({
          error: 'Auto registration disabled',
          code: 404,
          text: 'auto_discovery_disabled'
        }), {
          status: 404,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            ...dateHeader,
            ...buildAutoDiscoveryHeaders(AGENT_AUTO_DISCOVERY_DISABLED),
            ...wssStateHeaders
          }
        });
      }

      const auth = checkSecretAuthorization(secret, null, settings, env);
      if (auth.isTokenMatch && auth.isTokenExpired) {
        return new Response(JSON.stringify({
          error: 'Auto registration key expired',
          code: 401,
          text: 'auto_register_key_expired'
        }), {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            ...dateHeader,
            ...buildAutoDiscoveryHeaders(`${AGENT_AUTO_DISCOVERY_FAILED}:key_expired`),
            ...wssStateHeaders
          }
        });
      }

      if (!auth.isAuthorizedForNew) {
        return new Response(JSON.stringify({
          error: 'Unauthorized',
          code: 401,
          text: 'unauthorized'
        }), {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            ...dateHeader,
            ...buildAutoDiscoveryHeaders(`${AGENT_AUTO_DISCOVERY_FAILED}:unauthorized`),
            ...wssStateHeaders
          }
        });
      }

      const firstSample = Array.isArray(data.samples) && data.samples[0] ? data.samples[0] : null;
      const metrics = data.metrics || firstSample?.metrics || {};
      let serverName = String(data.name || data.hostname || metrics.hostname || '').trim();
      if (!serverName) {
        return new Response(JSON.stringify({
          error: 'Server name is required for auto-discovery',
          code: 400,
          text: 'no_name'
        }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            ...dateHeader,
            ...buildAutoDiscoveryHeaders(`${AGENT_AUTO_DISCOVERY_FAILED}:no_name`),
            ...wssStateHeaders
          }
        });
      }

      try {
        const existing = await env.DB.prepare('SELECT id FROM servers WHERE name = ?').bind(serverName).first();
        if (existing) {
          return new Response('OK', {
            status: 200,
            headers: {
              'Content-Type': 'text/plain; charset=utf-8',
              'Cache-Control': 'no-store',
              ...dateHeader,
              ...buildAutoDiscoveryHeaders(AGENT_AUTO_DISCOVERY_REUSED),
              ...wssStateHeaders
            }
          });
        }
      } catch (checkErr) {
        console.warn('[AutoDiscovery] duplicate name check failed:', checkErr?.message || checkErr);
      }

      serverId = crypto.randomUUID();
      const initialRegionCode = request.cf?.country || request.headers?.get('cf-ipcountry') || '';
      try {
        const reg = await autoRegisterServer(env.DB, serverId, data, secret, settings, initialRegionCode);
        serverDetail = reg.serverDetail;
        autoRegistered = true;

        if (ctx && ctx.waitUntil) {
          ctx.waitUntil((async () => {
            try {
              const regMsg = `新服务器自动注册成功:\n- 名称: ${reg.serverName}\n- ID: ${serverId}\n- 分组: ${reg.group}${reg.region ? `\n- 属地: ${reg.region}` : ''}`;
              await sendNotification(settings, regMsg, {
                event: 'auto_register',
                emoji: '🎉',
                clients: [reg.serverName],
                count: 1,
                message: regMsg
              });
            } catch (notifyErr) {
              console.warn('[AutoRegister] Notification error:', notifyErr?.message || notifyErr);
            }
          })());
        }
      } catch (regErr) {
        return new Response(JSON.stringify({
          error: regErr.message || 'Auto-registration failed',
          code: 500,
          text: 'db_error'
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            ...dateHeader,
            ...buildAutoDiscoveryHeaders(`${AGENT_AUTO_DISCOVERY_FAILED}:db_error`),
            ...wssStateHeaders
          }
        });
      }
    } else {
      if (!/^[A-Za-z0-9._:-]{1,64}$/.test(rawId)) {
        return createBadRequestResponse('Invalid server ID');
      }
      serverId = rawId;

      serverDetail = await getServerDetail(env.DB, serverId, true);
      const auth = checkSecretAuthorization(secret, serverDetail, settings, env);

      if (!serverDetail) {
        if (normalizeBooleanSetting(settings?.auto_register_enabled) !== 'true') {
          return createServerNotFoundResponse();
        }

        if (auth.isTokenMatch && auth.isTokenExpired) {
          return new Response(JSON.stringify({
            error: 'Auto registration key expired',
            code: 401,
            text: 'auto_register_key_expired'
          }), {
            status: 401,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
              ...dateHeader,
              ...buildAutoDiscoveryHeaders(`${AGENT_AUTO_DISCOVERY_FAILED}:key_expired`),
              ...wssStateHeaders
            }
          });
        }

        if (!auth.isAuthorizedForNew) {
          return createUnauthorizedResponse('Invalid secret');
        }

        const initialRegionCode = request.cf?.country || request.headers?.get('cf-ipcountry') || '';
        try {
          const reg = await autoRegisterServer(env.DB, serverId, data, secret, settings, initialRegionCode);
          serverDetail = reg.serverDetail;
          autoRegistered = true;

          if (ctx && ctx.waitUntil) {
            ctx.waitUntil((async () => {
              try {
                const regMsg = `新服务器自动注册成功:\n- 名称: ${reg.serverName}\n- ID: ${serverId}\n- 分组: ${reg.group}${reg.region ? `\n- 属地: ${reg.region}` : ''}`;
                await sendNotification(settings, regMsg, {
                  event: 'auto_register',
                  emoji: '🎉',
                  clients: [reg.serverName],
                  count: 1,
                  message: regMsg
                });
              } catch (notifyErr) {
                console.warn('[AutoRegister] Notification error:', notifyErr?.message || notifyErr);
              }
            })());
          }
        } catch (regErr) {
          return createBadRequestResponse(regErr.message || 'Auto-registration failed');
        }
      } else {
        if (!auth.isAuthorizedForExisting) {
          return createUnauthorizedResponse('Invalid secret');
        }
      }
    }

    let regionCode = request.cf?.country || request.headers?.get('cf-ipcountry') || '';
    const agentVersion = normalizeAgentVersion(request.headers.get('X-Agent-Version'));

    if (
      Object.prototype.hasOwnProperty.call(data, 'rx_correction') ||
      Object.prototype.hasOwnProperty.call(data, 'tx_correction')
    ) {
      const ackRx = normalizeCorrectionValue(data.rx_correction);
      const ackTx = normalizeCorrectionValue(data.tx_correction);
      if (ackRx === null || ackTx === null) {
        return createBadRequestResponse('Invalid correction');
      }

      await env.DB.prepare(`
        UPDATE servers
        SET rx_correction = NULL, tx_correction = NULL
        WHERE id = ?
          AND (rx_correction IS NOT NULL OR tx_correction IS NOT NULL)
          AND ABS(COALESCE(rx_correction, 0) - ?) < 0.000001
          AND ABS(COALESCE(tx_correction, 0) - ?) < 0.000001
      `).bind(serverId, ackRx, ackTx).run();
      clearServerDetailCache();
      scheduleAgentConfigChanged(env, ctx, serverId);

      return new Response('OK', {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
          ...dateHeader,
          ...wssStateHeaders
        }
      });
    }

    // 从缓存中获取历史记录分区 ID
    const historyPartitionId = serverDetail.history_partition_id;
    if(!historyPartitionId) {
      await ensureServerOptimization(env.DB, serverId);
      logUpdateBadRequest('Missing history_partition_id', {
        id: serverId,
        history_partition_id: serverDetail.history_partition_id
      });
      return createBadRequestResponse('Missing history_partition_id');
    }

    const samples = normalizeMetricSamples(data);
    if (samples.length === 0) {
      logUpdateBadRequest('Missing metrics', {
        id: serverId,
        has_metrics: !!data.metrics,
        has_samples: Array.isArray(data.samples),
        has_batch: Array.isArray(data.batch)
      });
      return createBadRequestResponse('Missing metrics');
    }

    // 获取最后一条插入（如果是批量数据，取最后一个样本）
    const latestSample = samples[samples.length - 1];
    const latestMetrics = getReportMetrics(data, latestSample);
    const isBatchBackfill = data.batch === true && samples.length > 1;

    if (isBatchBackfill) {
      await saveMetricsHistoryBatch(
        env.DB,
        serverId,
        historyPartitionId,
        samples,
        regionCode,
        agentVersion,
        latestMetrics
      );
    } else {
      const historyMetrics = getHistoryMetrics(data, samples, latestSample);
      await saveMetricsHistory(
        env.DB,
        serverId,
        historyPartitionId,
        historyMetrics,
        regionCode,
        latestSample.ts,
        agentVersion
      );
    }

    const broadcastSamples = toBroadcastSamples(serverId, samples, regionCode, agentVersion, latestMetrics);

    cacheLatestReportUpdate(serverId, broadcastSamples, Date.now());
    // 加入批量队列，由后台定时任务统一推送到 DO
    queueBroadcastSamples(serverId, broadcastSamples);
    if (ctx && ctx.waitUntil) {
      ctx.waitUntil(_ensureBatchFlush(env));
      // 月流量阈值告警：复用已加载的 serverDetail 与刚入库的 historyMetrics，非阻塞后台执行
      ctx.waitUntil(evaluateTrafficAlert(env, serverDetail, latestMetrics, {
        patchCache: (sid, value) => patchServerDetailCache(sid, { traffic_alert_state: value })
      }));
    }

    const autoDiscoveryHeaders = autoRegistered
      ? buildAutoDiscoveryHeaders(AGENT_AUTO_DISCOVERY_CREATED, serverId)
      : {};

    const clientConfigSchema = normalizeAgentConfigSchemaVersion(request.headers.get(AGENT_CONFIG_SCHEMA_HEADER));
    if (!clientConfigSchema) {
      return new Response('OK', {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
          ...dateHeader,
          ...autoDiscoveryHeaders,
          ...wssStateHeaders
        }
      });
    }

    try {
      const descriptor = await describeAgentConfig(serverDetail, settings, clientConfigSchema);
      const clientConfigMd5 = (request.headers.get(AGENT_CONFIG_MD5_HEADER) || '').trim().toLowerCase();
      const hasCorrection = descriptor.correction !== null;
      const md5Changed = clientConfigMd5 !== descriptor.md5;
      const responseHeaders = {
        'Cache-Control': 'no-store',
        [AGENT_CONFIG_SCHEMA_HEADER]: String(clientConfigSchema),
        [AGENT_CONFIG_MD5_HEADER]: descriptor.md5,
        ...dateHeader,
        ...autoDiscoveryHeaders,
        ...wssStateHeaders
      };

      if (!md5Changed && !hasCorrection) {
        return new Response(null, { status: 204, headers: responseHeaders });
      }

      let body = descriptor.serialized;
      if (hasCorrection) {
        body += serializeCorrection(descriptor.correction);
      }

      return new Response(body, {
        status: 200,
        headers: {
          ...responseHeaders,
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8'
        }
      });
    } catch (configError) {
      console.warn('[Update] Failed to build agent configuration:', configError?.message || configError);
      return new Response('OK', {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
          ...dateHeader,
          ...autoDiscoveryHeaders,
          ...wssStateHeaders
        }
      });
    }
  } catch (e) {
    return createErrorResponse(e);
  }
}

// 暴露给 index.js 路由使用的 WebSocket 接入函数
function isWebSocketUpgradeRequest(request) {
  const upgradeHeader = request.headers.get('Upgrade');
  return !!upgradeHeader && upgradeHeader.toLowerCase() === 'websocket';
}

async function forwardWebSocketUpgrade(request, env, internalPath, logPrefix) {
  if (!env || !env.METRICS_BROADCASTER) {
    return new Response(JSON.stringify({ error: 'WebSocket not enabled', code: 503 }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!isWebSocketUpgradeRequest(request)) {
    return new Response('Expected WebSocket upgrade request', { status: 426 });
  }

  const url = new URL(request.url);
  const qs = url.search || '';
  try {
    const id = env.METRICS_BROADCASTER.idFromName('global');
    const stub = env.METRICS_BROADCASTER.get(id);
    const realOrigin = new URL(request.url).origin;
    const headers = new Headers(request.headers);
    headers.set('X-Real-Origin', realOrigin);
    if (request.cf?.country && !headers.get('cf-ipcountry')) {
      headers.set('cf-ipcountry', request.cf.country);
    }
    return await stub.fetch(new Request(`http://internal${internalPath}${qs}`, {
      method: request.method,
      headers,
      body: request.body,
      redirect: request.redirect
    }));
  } catch (e) {
    console.error(`${logPrefix} DO upgrade failed:`, e);
    return new Response(JSON.stringify({ error: 'WebSocket error', code: 500 }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

export async function handleWebSocketUpgrade(request, env) {
  const settings = await loadSiteSettings(env.DB, { forceRefresh: true });
  if (settings?.is_public !== 'true' && !await checkWebSocketAuth(request, env, settings)) {
    return new Response(JSON.stringify({ error: 'Unauthorized', code: 401 }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const response = await forwardWebSocketUpgrade(request, env, '/ws', '[ws]');
  if (response?.status === 101) {
    markFrontendRealtimeActive();
  }
  return response;
}

export async function handleUpdateWebSocketUpgrade(request, env) {
  const settings = await loadSiteSettings(env.DB);
  if (!isWssReportConfigured(settings)) {
    return createAgentWssDisabledResponse();
  }
  const scheduleState = getWssReportScheduleState(settings);
  if (!scheduleState.active) {
    return createAgentWssScheduleInactiveResponse(settings);
  }
  return forwardWebSocketUpgrade(request, env, '/update', '[update-ws]');
}
