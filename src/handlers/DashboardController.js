import { logError, setLogContext, correlationHeaders } from '../utils/observability.js';
import { checkAuth, simpleAuthResponse } from '../middleware/auth.js';
import { ServerService } from '../services/ServerService.js';
import { getAllServers, getServerDetail, getMetricsHistoryCache, setMetricsHistoryCache, getCacheDuration } from '../utils/cache.js';
import { mergeMetricsIntoServer, coerceNumericMetricFields } from '../utils/metrics.js';
import { normalizeLongHistoryPoints, loadSettingsScope, debug } from '../utils/settings.js';
import { HISTORY_RANGES, historySampling } from '../utils/historyPolicy.js';
import { AppError, createSuccessResponse, createBadRequestResponse, createNotFoundResponse, createUnauthorizedResponse } from '../utils/errors.js';
import {
  cacheLatestReportUpdate,
  getLatestReportSampleTimestamp,
  getWorkerLatestReportUpdates
} from '../utils/latestReportCache.js';
import {
  DASHBOARD_LATENCY_WINDOW_HOURS,
  DASHBOARD_LATENCY_WINDOW_POINTS,
  DASHBOARD_LATEST_REPORT_ID_CHUNK_SIZE
} from '../utils/config.js';

/**
 * DashboardController
 * 负责仪表盘概览、单机详情以及历史指标检索 API
 */
export class DashboardController {
  static PROBE_FIELDS = ['ct', 'cu', 'cm', 'bd', 'node_1', 'node_2', 'node_3', 'node_4'];

  constructor(env, ctx = null) {
    this.env = env;
    this.ctx = ctx;
  }

  // --- 实例代理方法 ---

  async handleServer(request, sys) {
    return DashboardController.handleServerAPI(request, this.env, sys);
  }

  async handleServers(request, sys) {
    return DashboardController.handleServersAPI(request, this.env, sys);
  }

  async handleHistory(request, id, hours, columns, sys) {
    setLogContext({ serverId: id });
    return DashboardController.fetchHistoryData(this.env, request, id, hours, columns, sys);
  }

// REST 接口中，丢包值为 null 表示该探针没有可用样本；此时隐藏对应的延迟和丢包字段。
  static omitNullLossProbeFields(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const result = { ...item };
  for (const field of DashboardController.PROBE_FIELDS) {
    if (result[`loss_${field}`] === null) {
      delete result[`loss_${field}`];
      delete result[`ping_${field}`];
    }
  }
  return result;
}

  static createEmptyLatencyWindow() {
  return { ping: [], loss: [] };
}

  static toPublicIpReachability(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized && normalized !== '0' && normalized !== 'false' ? '1' : '0';
}

  static normalizePublicIpFields(item, ensureFields = true) {
  if (ensureFields || Object.prototype.hasOwnProperty.call(item, 'ip_v4')) {
    item.ip_v4 = DashboardController.toPublicIpReachability(item.ip_v4);
  }
  if (ensureFields || Object.prototype.hasOwnProperty.call(item, 'ip_v6')) {
    item.ip_v6 = DashboardController.toPublicIpReachability(item.ip_v6);
  }
  for (const field of ['data', 'payload', 'metrics']) {
    if (item[field] && typeof item[field] === 'object' && !Array.isArray(item[field])) {
      item[field] = DashboardController.normalizePublicIpFields({ ...item[field] }, false);
    }
  }
  return item;
}

  static withoutPrivateServerFields(server) {
  const item = { ...server };
  delete item.bandwidth;
  delete item.note;
  delete item.auto_update;
  delete item.secret;
  return DashboardController.normalizePublicIpFields(item);
}

  static normalizeLatestReportSample(sample, maskPublicIp = true) {
  if (!sample || typeof sample !== 'object') return null;
  const data = sample?.data || sample?.payload || sample?.metrics;
  if (!data || typeof data !== 'object') return null;

  const formattedData = maskPublicIp
    ? DashboardController.normalizePublicIpFields({ ...data }, false)
    : { ...data };
  const publicData = coerceNumericMetricFields(formattedData);
  const ts = sample.ts ?? sample.timestamp;
  return ts === undefined ? { data: publicData } : { ts, data: publicData };
}

  static normalizeLatestReportUpdate(update, maskPublicIp = true) {
  if (!update || !Array.isArray(update.samples)) return null;

  const samples = update.samples
    .map(sample => DashboardController.normalizeLatestReportSample(sample, maskPublicIp))
    .filter(Boolean);
  if (samples.length === 0) return null;

  return {
    ...update,
    samples
  };
}

  static attachLatencyHistoryToServers(servers, latencyHistory) {
  for (const server of servers || []) {
    const window = latencyHistory?.get(String(server.id)) || DashboardController.createEmptyLatencyWindow();
    server.ping = window.ping;
    server.loss = window.loss;
  }
}

  static async getDurableRealtimeState(env, serverIds) {
  const empty = { latestReportUpdates: [] };
  if (!env.METRICS_BROADCASTER || !Array.isArray(serverIds) || serverIds.length === 0) return empty;

  try {
    const id = env.METRICS_BROADCASTER.idFromName('global');
    const stub = env.METRICS_BROADCASTER.get(id);
    const updates = [];

    for (let offset = 0; offset < serverIds.length; offset += DASHBOARD_LATEST_REPORT_ID_CHUNK_SIZE) {
      const chunk = serverIds.slice(offset, offset + DASHBOARD_LATEST_REPORT_ID_CHUNK_SIZE);
      const response = await stub.fetch('http://internal/latest-report-updates', {
        method: 'POST',
        headers: correlationHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ serverIds: chunk })
      });
      if (!response.ok) throw new AppError('Realtime metrics unavailable', 503);
      const data = await response.json();
      if (Array.isArray(data?.updates)) updates.push(...data.updates);
    }

    return { latestReportUpdates: updates };
  } catch (e) {
    logError('dashboard', 'dashboard.latest.failed', 'Latest report lookup failed', e, {}, 'warn');
    throw new AppError('Realtime metrics unavailable', 503);
  }
}

  static async getDurableDashboardLatencyWindows(env, serverIds, options = {}) {
    const empty = new Map();
    if (!env?.METRICS_BROADCASTER || !Array.isArray(serverIds) || serverIds.length === 0) return empty;

    const hours = options.hours || DASHBOARD_LATENCY_WINDOW_HOURS;
    const points = options.points || DASHBOARD_LATENCY_WINDOW_POINTS;

    try {
      const id = env.METRICS_BROADCASTER.idFromName('global');
      const stub = env.METRICS_BROADCASTER.get(id);
      const latencyMap = new Map();

      for (let offset = 0; offset < serverIds.length; offset += DASHBOARD_LATEST_REPORT_ID_CHUNK_SIZE) {
        const chunk = serverIds.slice(offset, offset + DASHBOARD_LATEST_REPORT_ID_CHUNK_SIZE);
        const response = await stub.fetch('http://internal/dashboard-latency-windows', {
          method: 'POST',
          headers: correlationHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ serverIds: chunk, hours, points })
        });
        if (!response.ok) continue;
        const data = await response.json();
        if (data?.windows && typeof data.windows === 'object') {
          for (const [sId, window] of Object.entries(data.windows)) {
            if (window && (window.ping?.length > 0 || window.loss?.length > 0)) {
              latencyMap.set(String(sId), window);
            }
          }
        }
      }

      return latencyMap;
    } catch (e) {
      logError('dashboard', 'dashboard.latency.failed', 'Latency window lookup failed', e, {}, 'warn');
      return empty;
    }
  }

  static async getDurableHistory(env, serverId, hours = 1, columns = '', points = null) {
    if (!env?.METRICS_BROADCASTER || !serverId) return null;
    try {
      const id = env.METRICS_BROADCASTER.idFromName('global');
      const stub = env.METRICS_BROADCASTER.get(id);
      const url = `http://internal/history?serverId=${encodeURIComponent(serverId)}&hours=${encodeURIComponent(hours)}&columns=${encodeURIComponent(columns)}&points=${encodeURIComponent(points)}`;
      const response = await stub.fetch(url, { headers: correlationHeaders() });
      if (!response.ok) throw new AppError('History storage unavailable', 503);
      const json = await response.json();
      return Array.isArray(json?.data) ? json.data : null;
    } catch (e) {
      logError('dashboard', 'dashboard.history.failed', 'History lookup failed', e, { serverId }, 'warn');
      throw new AppError('History storage unavailable', 503);
    }
  }

  static mergeLatestReportUpdates(serverIds, durableUpdates, workerUpdates, maskPublicIp = true) {
  const merged = new Map();

  for (const update of durableUpdates) {
    if (!update?.serverId || !Array.isArray(update.samples)) continue;
    merged.set(String(update.serverId), update);
  }

  // Worker 缓存后合并：样本更新时取更新的一包；同一包优先使用更准确的 Worker 接收时间。
  for (const update of workerUpdates) {
    if (!update?.serverId || !Array.isArray(update.samples)) continue;
    const serverId = String(update.serverId);
    const existing = merged.get(serverId);
    if (!existing || getLatestReportSampleTimestamp(update) >= getLatestReportSampleTimestamp(existing)) {
      merged.set(serverId, update);
    }
  }

  const now = Date.now();
  return serverIds.map(serverId => merged.get(String(serverId)))
    .filter(Boolean)
    .map(update => DashboardController.normalizeLatestReportUpdate({
      ...update,
      reportAgeMs: Math.max(0, now - Number(update.reportTs || now))
    }, maskPublicIp))
    .filter(Boolean);
}

  static async getRealtimeStateForServers(env, serverIds, options = {}) {
  const maskPublicIp = options.maskPublicIp !== false;
  const normalizedServerIds = Array.from(new Set(
    (Array.isArray(serverIds) ? serverIds : [])
      .map(serverId => String(serverId || '').trim())
      .filter(Boolean)
  ));
  if (normalizedServerIds.length === 0) {
    return { latestReportUpdates: [] };
  }

  const durableState = await DashboardController.getDurableRealtimeState(env, normalizedServerIds);
  const durableLatestReportUpdates = durableState.latestReportUpdates;

  // DO 命中后反向预热当前 Worker isolate，降低随后 DO 休眠造成的空缓存概率。
  for (const update of durableLatestReportUpdates) {
    cacheLatestReportUpdate(update.serverId, update.samples, update.reportTs);
  }

  return {
    latestReportUpdates: DashboardController.mergeLatestReportUpdates(
      normalizedServerIds,
      durableLatestReportUpdates,
      getWorkerLatestReportUpdates(normalizedServerIds),
      maskPublicIp
    )
  };
}

  static async handleServerAPI(request, env, sys) {
  const isLoggedIn = await checkAuth(request, env, sys);

  if (sys.is_public !== 'true' && !isLoggedIn) {
    return simpleAuthResponse();
  }

  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  if (!id) return createBadRequestResponse('Missing ID');

  const server = await getServerDetail(env.DB, id, isLoggedIn, { scope: 'public' });
  if (!server) return createNotFoundResponse('Server not found');

  const realtimeState = await DashboardController.getRealtimeStateForServers(env, [id]);
  let effectiveMetrics = null;
  if (realtimeState?.latestReportUpdates?.length > 0) {
    const doReport = realtimeState.latestReportUpdates.find(u => u.serverId === id) || realtimeState.latestReportUpdates[0];
    if (doReport && Array.isArray(doReport.samples) && doReport.samples.length > 0) {
      const lastSample = doReport.samples[doReport.samples.length - 1];
      effectiveMetrics = {
        timestamp: lastSample.ts || doReport.reportTs || Date.now(),
        ...(lastSample.data || lastSample.payload || lastSample.metrics || {})
      };
    }
  }
  mergeMetricsIntoServer(server, effectiveMetrics);
  let latestReportUpdates = realtimeState.latestReportUpdates;
  if ((!latestReportUpdates || latestReportUpdates.length === 0) && effectiveMetrics) {
    const reportTs = effectiveMetrics.timestamp || Date.now();
    latestReportUpdates = [{
      serverId: id,
      reportTs,
      reportAgeMs: Math.max(0, Date.now() - reportTs),
      samples: [{
        ts: reportTs,
        data: { ...effectiveMetrics, id }
      }]
    }];
  }
  server.latestReportUpdates = latestReportUpdates;
  server.sysConfig = {
    long_history_points: normalizeLongHistoryPoints(sys.long_history_points) === 'auto'
      ? 'auto' : Number(normalizeLongHistoryPoints(sys.long_history_points))
  };

  return createSuccessResponse(DashboardController.omitNullLossProbeFields(DashboardController.withoutPrivateServerFields(server)));
}

  static async handleServersAPI(request, env, sys) {
    const isLoggedIn = await checkAuth(request, env, sys);

    if (sys.is_public !== 'true' && !isLoggedIn) {
      return simpleAuthResponse();
    }

    const shouldIncludeLatencyHistory = sys.show_three_net_details === 'true';
    const { servers, latestReportUpdates, stats, regionStats } = await ServerService.getServersWithState(env, {
      includeHidden: isLoggedIn,
      maskPublicIp: true,
      stripPrivateFields: true,
      includeLatencyHistory: shouldIncludeLatencyHistory
    });

    const data = {
      servers,
      latestReportUpdates,
      stats,
      regionStats,
      sysConfig: {
        show_price: sys.show_price === 'true',
        show_expire: sys.show_expire === 'true',
        show_tf: sys.show_tf === 'true',
        show_three_net_details: sys.show_three_net_details === 'true',
        custom_ct_name: sys.custom_ct_name || '电信',
        custom_cu_name: sys.custom_cu_name || '联通',
        custom_cm_name: sys.custom_cm_name || '移动',
        custom_bd_name: sys.custom_bd_name || 'BGP',
        display_mode: sys.display_mode || 'bar',
        latency_window: {
          points: DASHBOARD_LATENCY_WINDOW_POINTS,
          hours: DASHBOARD_LATENCY_WINDOW_HOURS
        }
      }
    };

    return createSuccessResponse(data);
  }

  static async fetchHistoryData(env, request, id, hours, columns, sys = null) {
  if (!id) return createBadRequestResponse('Missing ID');

  const ALLOWED_HOURS = HISTORY_RANGES.map(range => range.hours);
  if (!ALLOWED_HOURS.includes(hours)) {
    return createBadRequestResponse('Invalid hours parameter');
  }

  if (!sys) {
    sys = await loadSettingsScope(env.DB, 'public');
  }
  const isLoggedIn = await checkAuth(request, env, sys);

  if (sys.is_public !== 'true' && !isLoggedIn) {
    return simpleAuthResponse();
  }

  if (hours > 24 && !isLoggedIn) {
    return createUnauthorizedResponse();
  }

  const server = await getServerDetail(env.DB, id, isLoggedIn, { scope: 'identity' });
  if (!server) return createNotFoundResponse();

  // 最多查询7天数据
  const clampedHours = Math.min(hours, 168);
  const longHistoryPoints = clampedHours > 1
    ? normalizeLongHistoryPoints(sys.long_history_points)
    : null;
  const cacheDuration = getCacheDuration(clampedHours, longHistoryPoints);
  const sampling = historySampling(clampedHours, longHistoryPoints);
  const headers = { 'X-History-Interval-Seconds': String(sampling.intervalMs / 1000) };

  const cached = getMetricsHistoryCache(id, clampedHours, columns, longHistoryPoints);
  if (cached && Date.now() - cached.timestamp < cacheDuration) {
    const cachedData = Array.isArray(cached.data)
      ? cached.data.map(DashboardController.omitNullLossProbeFields)
      : cached.data;
    return createSuccessResponse(cachedData, { ...headers, 'X-Cache': 'HIT' });
  }

  let data = await DashboardController.getDurableHistory(env, id, clampedHours, columns, longHistoryPoints);
  if (!Array.isArray(data)) {
    data = [];
  }

  const sanitizedData = Array.isArray(data)
    ? data.map(DashboardController.omitNullLossProbeFields)
    : data;
  setMetricsHistoryCache(id, clampedHours, columns, sanitizedData, longHistoryPoints);

  return createSuccessResponse(sanitizedData, { ...headers, 'X-Cache': 'MISS' });
}
}
