import { readLimitedJson } from '../utils/requestBody.js';
import { logEvent, logError, setLogContext, markResponseLogged, correlationHeaders } from '../utils/observability.js';
import { getServerDetail, clearServerDetailCache, patchServerDetailCache, clearServersListCache, getAllServers } from '../utils/cache.js';
import { NotificationService } from '../services/NotificationService.js';
import { getNotificationMessages } from '../services/notificationMessages.js';
import { addServerColumns } from '../database/updateDatabase.js';
import {
  DISK_IO_FIELD_TO_COLUMN,
  DISK_IO_METRIC_FIELDS,
  mergeMetricsIntoServer,
  coerceNumericMetricFields
} from '../utils/metrics.js';
import { AppError, createErrorResponse, createUnauthorizedResponse, createBadRequestResponse } from '../utils/errors.js';
import { ensureServerOptimization, getNextServerHistoryPartitionId, HISTORY_MAX_PARTITION_ID } from '../database/indexOptimization.js';
import { getResourceAlertConfig, getWssReportScheduleState, isWssReportConfigured, loadSiteSettings, normalizeBooleanSetting } from '../utils/settings.js';
import { cacheLatestReportUpdate } from '../utils/latestReportCache.js';
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
  UPDATE_MAX_BATCH_SAMPLES,
  UPDATE_MAX_REQUEST_BYTES,
} from '../utils/config.js';

/**
 * UpdateController
 * 负责 Agent 指标上报、自动注册以及 Agent/Frontend WebSocket 协议升级
 */
export class UpdateController {
  constructor(env, ctx = null) {
    this.env = env;
    this.ctx = ctx;
  }

  // --- 实例代理方法 ---

  async handle(request) {
    return UpdateController.handleUpdate(request, this.env, this.ctx);
  }

  async handleFrontendWebSocket(request) {
    return UpdateController.handleWebSocketUpgrade(request, this.env);
  }

  async handleAgentWebSocket(request) {
    return UpdateController.handleUpdateWebSocketUpgrade(request, this.env);
  }

  async autoRegister(serverId, data, secret, settings, regionCode = '') {
    return UpdateController.autoRegisterServer(this.env.DB, serverId, data, secret, settings, regionCode);
  }

// 将最新一次上报打包成前端可直接消费的 "当前状态" 对象
// 与 /api/server 和 /api/servers 返回的字段保持一致，便于页面直接合并
  static buildPayloadForBroadcast(id, metrics = {}, extra = {}) {
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
  static DISK_IO_COLUMN_TO_FIELD = Object.freeze(Object.fromEntries(
  DISK_IO_METRIC_FIELDS.map(field => [DISK_IO_FIELD_TO_COLUMN[field], field])
));
  static AGENT_AUTO_DISCOVERY_HEADER = 'x-sma-auto-discovery';
  static AGENT_AUTO_DISCOVERY_SERVER_ID_HEADER = 'x-sma-server-id';
  static LEGACY_AGENT_AUTO_DISCOVERY_HEADER = 'x-cfsm-auto-discovery';
  static LEGACY_AGENT_AUTO_DISCOVERY_SERVER_ID_HEADER = 'x-cfsm-server-id';
  static AGENT_AUTO_DISCOVERY_CREATED = 'created';
  static AGENT_AUTO_DISCOVERY_REUSED = 'reused';
  static AGENT_AUTO_DISCOVERY_FAILED = 'failed';
  static AGENT_AUTO_DISCOVERY_DISABLED = 'disabled';
  static AGENT_WSS_MODE_HEADER = 'x-agent-wss-mode';
  static AGENT_WSS_REASON_HEADER = 'x-agent-wss-reason';
  static AGENT_WSS_SCHEDULE_INACTIVE = 'wss_schedule_inactive';
  static AGENT_WSS_SCHEDULE_DISABLED = 'wss_disabled';

  static buildAutoDiscoveryHeaders(status, serverId = null) {
  const headers = {
    [UpdateController.AGENT_AUTO_DISCOVERY_HEADER]: status,
    [UpdateController.LEGACY_AGENT_AUTO_DISCOVERY_HEADER]: status
  };
  if (serverId) {
    headers[UpdateController.AGENT_AUTO_DISCOVERY_SERVER_ID_HEADER] = serverId;
    headers[UpdateController.LEGACY_AGENT_AUTO_DISCOVERY_SERVER_ID_HEADER] = serverId;
  }
  return headers;
}
  static normalizeTimestamp(value, fallback = Date.now()) {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return fallback;
  return ts < 10000000000 ? ts * 1000 : ts;
}

  static normalizeAgentVersion(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .trim()
    .replace(/[^0-9A-Za-z.+_-]/g, '')
    .slice(0, 64);
}

  static logUpdateBadRequest(reason, details = {}) {
  markResponseLogged();
  logEvent('agent', 'agent.report.rejected', 'Agent report rejected', { reason, ...details, status: 400 }, 'warn');
}

  static getDeclaredContentLength(request) {
  const raw = request.headers.get('Content-Length');
  if (!raw) return null;
  const length = Number(raw);
  return Number.isFinite(length) && length >= 0 ? length : null;
}

  static createPayloadTooLargeResponse() {
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
  static createServerNotFoundResponse() {
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

  static normalizeCorrectionValue(value) {
  if (value === null || value === undefined || value === '') return 0;
  return isValidTrafficCorrection(value) ? Number(value) : null;
}

  static normalizeMetricSamples(data) {
  const now = Date.now();
  const rawSamples = Array.isArray(data.samples)
    ? data.samples
    : (Array.isArray(data.batch) ? data.batch : []);

  // Agent 按时间顺序追加样本；确认递增时才预截断，避免超大数组在服务端做全量 map/sort。
  // 乱序输入不预截断，交给末尾的 sort + slice 兜底，避免丢掉最新样本。
  const sampleTs = item => Number(item?.ts ?? item?.timestamp ?? item?.metrics?.timestamp);
  const chronological = rawSamples.every((sample, index) => Number.isFinite(sampleTs(sample)) &&
    (index === 0 || sampleTs(rawSamples[index - 1]) <= sampleTs(sample)));
  const boundedSamples = chronological && rawSamples.length > UPDATE_MAX_BATCH_SAMPLES
    ? rawSamples.slice(-UPDATE_MAX_BATCH_SAMPLES)
    : rawSamples;

  const samples = boundedSamples.map(item => {
    if (!item || typeof item !== 'object') return null;
    const metrics = item.metrics || item.data || item.payload || item;
    if (!metrics || typeof metrics !== 'object') return null;
    const ts = UpdateController.normalizeTimestamp(item.ts ?? item.timestamp ?? metrics.timestamp, now);
    return { ts, metrics };
  }).filter(Boolean);

  if (samples.length === 0 && data.metrics && typeof data.metrics === 'object') {
    samples.push({
      ts: UpdateController.normalizeTimestamp(data.metrics.timestamp, now),
      metrics: data.metrics
    });
  }

  samples.sort((a, b) => a.ts - b.ts);
  return samples.slice(-UPDATE_MAX_BATCH_SAMPLES);
}

  static getReportMetrics(data, latestSample) {
  const reportMetrics = data?.metrics && typeof data.metrics === 'object' ? data.metrics : null;
  if (!reportMetrics) return latestSample?.metrics || {};
  return {
    ...reportMetrics,
    ...(latestSample?.metrics || {})
  };
}

  static hasOwnMetric(source, field) {
  return !!source && Object.prototype.hasOwnProperty.call(source, field);
}

  static isPlainMetricObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

  static toFiniteHistoryMetricNumber(value) {
  if (value === false || value === 'false' || value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

  static getHistoryMetricSourceValue(source, field) {
  if (!UpdateController.isPlainMetricObject(source)) return null;

  if (UpdateController.hasOwnMetric(source, field)) {
    return source[field];
  }

  const diskField = UpdateController.DISK_IO_COLUMN_TO_FIELD[field];
  if (diskField && UpdateController.isPlainMetricObject(source.disk) && UpdateController.hasOwnMetric(source.disk, diskField)) {
    return source.disk[diskField];
  }

  return null;
}

  static getSampleMetricSource(sample) {
  if (!UpdateController.isPlainMetricObject(sample)) return null;
  return sample.metrics || sample.data || sample.payload || sample;
}

  static createEmptyHistoryMetricAggregate() {
  return { max: {}, avg: {} };
}

  static mergeHistoryMetricAggregates(...aggregates) {
  const result = UpdateController.createEmptyHistoryMetricAggregate();

  for (const aggregate of aggregates) {
    if (!UpdateController.isPlainMetricObject(aggregate)) continue;

    if (UpdateController.isPlainMetricObject(aggregate.max)) {
      for (const [field, value] of Object.entries(aggregate.max)) {
        const number = UpdateController.toFiniteHistoryMetricNumber(value);
        if (number === null) continue;
        if (!UpdateController.hasOwnMetric(result.max, field) || number > result.max[field]) {
          result.max[field] = number;
        }
      }
    }

    if (UpdateController.isPlainMetricObject(aggregate.avg)) {
      for (const [field, item] of Object.entries(aggregate.avg)) {
        if (!UpdateController.isPlainMetricObject(item)) continue;
        const sum = UpdateController.toFiniteHistoryMetricNumber(item.sum);
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

  static addHistoryMetricAggregateSource(aggregate, source) {
  if (!UpdateController.isPlainMetricObject(source)) return;

  for (const [field, policy] of Object.entries(HISTORY_METRIC_AGGREGATION_POLICY)) {
    const value = UpdateController.toFiniteHistoryMetricNumber(UpdateController.getHistoryMetricSourceValue(source, field));
    if (value === null) continue;

    if (policy === 'max') {
      if (!UpdateController.hasOwnMetric(aggregate.max, field) || value > aggregate.max[field]) {
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

  static collectHistoryMetricAggregates(samples = [], previousAggregate = null) {
  const aggregate = UpdateController.mergeHistoryMetricAggregates(previousAggregate);
  for (const sample of Array.isArray(samples) ? samples : []) {
    UpdateController.addHistoryMetricAggregateSource(aggregate, UpdateController.getSampleMetricSource(sample));
  }
  return aggregate;
}

  static setHistoryMetricResultValue(result, field, value) {
  const diskField = UpdateController.DISK_IO_COLUMN_TO_FIELD[field];
  if (diskField) {
    result[field] = value;
    result.disk = UpdateController.isPlainMetricObject(result.disk)
      ? { ...result.disk, [diskField]: value }
      : { [diskField]: value };
    return;
  }

  result[field] = value;
}

  static applyHistoryMetricAggregates(metrics = {}, aggregate = null) {
  const result = { ...(metrics || {}) };
  const mergedAggregate = UpdateController.mergeHistoryMetricAggregates(aggregate);

  for (const [field, value] of Object.entries(mergedAggregate.max)) {
    UpdateController.setHistoryMetricResultValue(result, field, value);
  }

  for (const [field, item] of Object.entries(mergedAggregate.avg)) {
    if (!item || !Number.isFinite(item.sum) || !Number.isFinite(item.count) || item.count <= 0) continue;
    UpdateController.setHistoryMetricResultValue(result, field, item.sum / item.count);
  }

  return result;
}

  static getHistoryMetrics(data, samples, latestSample) {
  return UpdateController.applyHistoryMetricAggregates(
    UpdateController.getReportMetrics(data, latestSample),
    UpdateController.collectHistoryMetricAggregates(samples)
  );
}

  static buildSamplePayloadForBroadcast(metrics = {}, timestamp = Date.now()) {
  const payload = metrics && typeof metrics === 'object' ? { ...metrics } : {};
  BROADCAST_DELETE_FIELDS.forEach(field => delete payload[field]);
  payload.last_updated = timestamp;
  payload.sample_timestamp = timestamp;
  return coerceNumericMetricFields(payload);
}

  static toBroadcastSamples(id, samples, regionCode, agentVersion = '', reportMetrics = null) {
  const lastIndex = samples.length - 1;
  const base = reportMetrics && typeof reportMetrics === 'object' ? reportMetrics : null;
  return samples.map((sample, index) => {
    const metrics = base
      ? { ...base, ...(sample.metrics || {}) }
      : (sample.metrics || {});
    if (index !== lastIndex) {
      return { ts: sample.ts, payload: UpdateController.buildSamplePayloadForBroadcast(metrics, sample.ts) };
    }

    const payload = UpdateController.buildPayloadForBroadcast(id, metrics, {
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

  static buildAgentWssStateHeaders(settings = {}, now = Date.now()) {
  const state = getWssReportScheduleState(settings, now);
  return {
    [UpdateController.AGENT_WSS_MODE_HEADER]: state.mode,
    [UpdateController.AGENT_WSS_REASON_HEADER]: state.reason
  };
}

  static createAgentWssScheduleInactiveResponse(settings = {}) {
  return new Response(JSON.stringify({
    error: 'Agent WSS report outside active hours',
    code: 409,
    text: UpdateController.AGENT_WSS_SCHEDULE_INACTIVE,
    connection_mode: 'http'
  }), {
    status: 409,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
      ...UpdateController.buildAgentWssStateHeaders(settings)
    }
  });
}

  static createAgentWssDisabledResponse() {
  return new Response(JSON.stringify({
    error: 'Agent WSS report disabled',
    code: 409,
    text: UpdateController.AGENT_WSS_SCHEDULE_DISABLED,
    connection_mode: 'http'
  }), {
    status: 409,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
      [UpdateController.AGENT_WSS_MODE_HEADER]: 'disabled',
      [UpdateController.AGENT_WSS_REASON_HEADER]: UpdateController.AGENT_WSS_SCHEDULE_DISABLED
    }
  });
}

  static async commitReport(env, update, reportId = null, maintainState = false) {
    if (!env.METRICS_BROADCASTER) throw new AppError('Metrics storage unavailable', 503);
    const stub = env.METRICS_BROADCASTER.get(env.METRICS_BROADCASTER.idFromName('global'));
    const body = JSON.stringify({ updates: [update], reportId, maintainState });
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await stub.fetch('http://internal/batch-push', {
          method: 'POST', headers: correlationHeaders({ 'Content-Type': 'application/json', 'X-CFSM-Attempt': String(attempt + 1) }), body,
          signal: AbortSignal.timeout(5000)
        });
        if (response.ok) {
          const result = await response.json();
          if (result.ok === true && result.persisted === true) {
            if (attempt) logEvent('storage', 'metrics.commit.recovered', 'Metrics commit succeeded after retry', { serverId: update.serverId, reportId, attempts: attempt + 1, persisted: true });
            return;
          }
          throw new Error('Metrics commit was not confirmed');
        }
        if (response.status >= 400 && response.status < 500) {
          throw new AppError('Metrics report rejected', response.status);
        }
        throw new Error(`Metrics storage returned HTTP ${response.status}`);
      } catch (error) {
        if (error instanceof AppError && error.code < 500) throw error;
        lastError = error;
      }
      if (attempt < 2) {
        logError('storage', 'metrics.commit.retry', 'Metrics commit unconfirmed; retrying', lastError,
          { serverId: update.serverId, reportId, attempt: attempt + 1, nextAttempt: attempt + 2, retryAfterMs: 100 * (attempt + 1) }, 'warn');
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
    const error = new AppError('Metrics storage unavailable; retry report', 503, { attempts: 3, retryable: true });
    error.cause = lastError;
    throw error;
  }

  static checkSecretAuthorization(secret, serverDetail, settings, env) {
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

  static async autoRegisterServer(db, serverId, data, secret, settings, regionCode = '') {
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

  static async handleUpdate(request, env, ctx) {
  try {
    // 必须在 request.json() 之前：超大 body 的解析本身就可能耗尽 Worker CPU。
    // Content-Length is an early rejection; readLimitedJson also bounds streaming bodies.
    const declaredLength = UpdateController.getDeclaredContentLength(request);
    if (declaredLength !== null && declaredLength > UPDATE_MAX_REQUEST_BYTES) {
      markResponseLogged();
      logEvent('agent', 'agent.report.too_large', 'Agent report exceeds body limit', {
        bodyBytes: declaredLength,
        limitBytes: UPDATE_MAX_REQUEST_BYTES, status: 413
      }, 'warn');
      return UpdateController.createPayloadTooLargeResponse();
    }

    const data = await readLimitedJson(request, UPDATE_MAX_REQUEST_BYTES);
    const { id, secret } = data;
    const rawId = typeof id === 'string' ? id.trim() : '';
    setLogContext({ transport: 'http', ...(rawId ? { serverId: rawId } : {}), reportId: data.reportId });

    let settings = null;
    try {
      settings = await loadSiteSettings(env.DB);
    } catch (_) {
      settings = {};
    }

    const wssStateHeaders = UpdateController.buildAgentWssStateHeaders(settings);
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
            ...UpdateController.buildAutoDiscoveryHeaders(UpdateController.AGENT_AUTO_DISCOVERY_DISABLED),
            ...wssStateHeaders
          }
        });
      }

      const auth = UpdateController.checkSecretAuthorization(secret, null, settings, env);
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
            ...UpdateController.buildAutoDiscoveryHeaders(`${UpdateController.AGENT_AUTO_DISCOVERY_FAILED}:key_expired`),
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
            ...UpdateController.buildAutoDiscoveryHeaders(`${UpdateController.AGENT_AUTO_DISCOVERY_FAILED}:unauthorized`),
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
            ...UpdateController.buildAutoDiscoveryHeaders(`${UpdateController.AGENT_AUTO_DISCOVERY_FAILED}:no_name`),
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
              ...UpdateController.buildAutoDiscoveryHeaders(UpdateController.AGENT_AUTO_DISCOVERY_REUSED),
              ...wssStateHeaders
            }
          });
        }
      } catch (checkErr) {
        logError('agent', 'agent.discovery.lookup_failed', 'Existing node lookup failed', checkErr, {}, 'warn');
      }

      serverId = crypto.randomUUID();
      const initialRegionCode = request.cf?.country || request.headers?.get('cf-ipcountry') || '';
      try {
        const reg = await UpdateController.autoRegisterServer(env.DB, serverId, data, secret, settings, initialRegionCode);
        serverDetail = reg.serverDetail;
        autoRegistered = true;

        if (ctx && ctx.waitUntil) {
          ctx.waitUntil((async () => {
            try {
              const regMsg = `新服务器自动注册成功:\n- 名称: ${reg.serverName}\n- ID: ${serverId}\n- 分组: ${reg.group}${reg.region ? `\n- 属地: ${reg.region}` : ''}`;
              await NotificationService.sendNotification(settings, regMsg, {
                event: 'auto_register',
                emoji: '🎉',
                clients: [reg.serverName],
                count: 1,
                message: regMsg
              });
            } catch (notifyErr) {
              logError('notification', 'notification.registration.failed', 'Auto-registration notification failed', notifyErr, {}, 'warn');
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
            ...UpdateController.buildAutoDiscoveryHeaders(`${UpdateController.AGENT_AUTO_DISCOVERY_FAILED}:db_error`),
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
      const auth = UpdateController.checkSecretAuthorization(secret, serverDetail, settings, env);

      if (!serverDetail) {
        if (normalizeBooleanSetting(settings?.auto_register_enabled) !== 'true') {
          return UpdateController.createServerNotFoundResponse();
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
              ...UpdateController.buildAutoDiscoveryHeaders(`${UpdateController.AGENT_AUTO_DISCOVERY_FAILED}:key_expired`),
              ...wssStateHeaders
            }
          });
        }

        if (!auth.isAuthorizedForNew) {
          return createUnauthorizedResponse('Invalid secret');
        }

        const initialRegionCode = request.cf?.country || request.headers?.get('cf-ipcountry') || '';
        try {
          const reg = await UpdateController.autoRegisterServer(env.DB, serverId, data, secret, settings, initialRegionCode);
          serverDetail = reg.serverDetail;
          autoRegistered = true;

          if (ctx && ctx.waitUntil) {
            ctx.waitUntil((async () => {
              try {
                const regMsg = `新服务器自动注册成功:\n- 名称: ${reg.serverName}\n- ID: ${serverId}\n- 分组: ${reg.group}${reg.region ? `\n- 属地: ${reg.region}` : ''}`;
                await NotificationService.sendNotification(settings, regMsg, {
                  event: 'auto_register',
                  emoji: '🎉',
                  clients: [reg.serverName],
                  count: 1,
                  message: regMsg
                });
              } catch (notifyErr) {
                logError('notification', 'notification.registration.failed', 'Auto-registration notification failed', notifyErr, {}, 'warn');
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

    setLogContext({ serverId });
    let regionCode = request.cf?.country || request.headers?.get('cf-ipcountry') || '';
    const agentVersion = UpdateController.normalizeAgentVersion(request.headers.get('X-Agent-Version'));

    if (
      Object.prototype.hasOwnProperty.call(data, 'rx_correction') ||
      Object.prototype.hasOwnProperty.call(data, 'tx_correction')
    ) {
      const ackRx = UpdateController.normalizeCorrectionValue(data.rx_correction);
      const ackTx = UpdateController.normalizeCorrectionValue(data.tx_correction);
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

    const samples = UpdateController.normalizeMetricSamples(data);
    if (samples.length === 0) {
      UpdateController.logUpdateBadRequest('Missing metrics', {
        id: serverId,
        has_metrics: !!data.metrics,
        has_samples: Array.isArray(data.samples),
        has_batch: Array.isArray(data.batch)
      });
      return createBadRequestResponse('Missing metrics');
    }

    // 获取最后一条插入（如果是批量数据，取最后一个样本）
    const latestSample = samples[samples.length - 1];
    const latestMetrics = UpdateController.getReportMetrics(data, latestSample);

    // 当探针未提供或仅上报可达性标记（0 或 1）时，通过 Cloudflare 连接 IP 自动补全公网 IP
    const clientIp = request.headers.get('cf-connecting-ip') || '';
    if (clientIp) {
      if (!clientIp.includes(':')) {
        if (!latestMetrics.ip_v4 || latestMetrics.ip_v4 === '0' || latestMetrics.ip_v4 === '1') {
          latestMetrics.ip_v4 = clientIp;
        }
      } else {
        if (!latestMetrics.ip_v6 || latestMetrics.ip_v6 === '0' || latestMetrics.ip_v6 === '1') {
          latestMetrics.ip_v6 = clientIp;
        }
      }
    }

    // 交给 DO SQLite 事务保存；未确认写入时由 Agent 重试。
    const broadcastSamples = UpdateController.toBroadcastSamples(serverId, samples, regionCode, agentVersion, latestMetrics);

    const maintainAlertState = NotificationService.hasNotificationTarget(settings) && getResourceAlertConfig(settings).enabled;
    await UpdateController.commitReport(env, { serverId, samples: broadcastSamples }, data.reportId ?? null, maintainAlertState);
    cacheLatestReportUpdate(serverId, broadcastSamples, Date.now());
    if (ctx?.waitUntil) {
      ctx.waitUntil(NotificationService.evaluateTrafficAlert(env, serverDetail, latestMetrics, {
        patchCache: (sid, value) => patchServerDetailCache(sid, { traffic_alert_state: value })
      }));
    }

    const autoDiscoveryHeaders = autoRegistered
      ? UpdateController.buildAutoDiscoveryHeaders(UpdateController.AGENT_AUTO_DISCOVERY_CREATED, serverId)
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
      logError('agent', 'agent.config.build_failed', 'Agent configuration response could not be built', configError, {}, 'warn');
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
    if (e instanceof AppError && e.code === 413) {
      markResponseLogged();
      logEvent('agent', 'agent.report.too_large', 'Agent report stream exceeds body limit', { limitBytes: UPDATE_MAX_REQUEST_BYTES, status: 413 }, 'warn');
      return UpdateController.createPayloadTooLargeResponse();
    }
    return createErrorResponse(e);
  }
}

// 暴露给 index.js 路由使用的 WebSocket 接入函数
  static isWebSocketUpgradeRequest(request) {
  const upgradeHeader = request.headers.get('Upgrade');
  return !!upgradeHeader && upgradeHeader.toLowerCase() === 'websocket';
}

  static async forwardWebSocketUpgrade(request, env, internalPath, logPrefix) {
  if (!env || !env.METRICS_BROADCASTER) {
    return new Response(JSON.stringify({ error: 'WebSocket not enabled', code: 503 }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!UpdateController.isWebSocketUpgradeRequest(request)) {
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
    const requestId = correlationHeaders()['X-CFSM-Request-ID'];
    if (requestId) headers.set('X-CFSM-Request-ID', requestId);
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
    logError('websocket', 'websocket.upgrade.failed', 'WebSocket upgrade failed', e, { transport: 'wss', path: internalPath });
    return new Response(JSON.stringify({ error: 'WebSocket error', code: 500 }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

  static async handleWebSocketUpgrade(request, env) {
  const settings = await loadSiteSettings(env.DB, { forceRefresh: true });
  if (settings?.is_public !== 'true' && !await checkWebSocketAuth(request, env, settings)) {
    return new Response(JSON.stringify({ error: 'Unauthorized', code: 401 }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const response = await UpdateController.forwardWebSocketUpgrade(request, env, '/ws', '[ws]');
  return response;
}

  static async handleUpdateWebSocketUpgrade(request, env) {
  const settings = await loadSiteSettings(env.DB);
  if (!isWssReportConfigured(settings)) {
    return UpdateController.createAgentWssDisabledResponse();
  }
  const scheduleState = getWssReportScheduleState(settings);
  if (!scheduleState.active) {
    return UpdateController.createAgentWssScheduleInactiveResponse(settings);
  }
  return UpdateController.forwardWebSocketUpgrade(request, env, '/update', '[update-ws]');
}
}
