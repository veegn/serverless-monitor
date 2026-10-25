import { checkAuth, simpleAuthResponse } from '../middleware/auth.js';
import { DatabaseService } from '../database/DatabaseService.js';
import { getAllServers, getServerDetail, getMetricsHistoryCache, setMetricsHistoryCache, getCacheDuration } from '../utils/cache.js';
import { mergeMetricsIntoServer, coerceNumericMetricFields } from '../utils/metrics.js';
import { normalizeLongHistoryPoints, loadSiteSettings, debug } from '../utils/settings.js';
import { createSuccessResponse, createBadRequestResponse, createNotFoundResponse, createUnauthorizedResponse } from '../utils/errors.js';
import {
  cacheLatestReportUpdate,
  getLatestReportSampleTimestamp,
  getWorkerLatestReportUpdates
} from '../utils/latestReportCache.js';
import { markFrontendRealtimeActive } from '../utils/realtimeBroadcastGate.js';
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverIds: chunk })
      });
      if (!response.ok) continue;
      const data = await response.json();
      if (Array.isArray(data?.updates)) updates.push(...data.updates);
    }

    return { latestReportUpdates: updates };
  } catch (e) {
    console.warn('[Dashboard] Failed to read realtime state:', e?.message || e);
    return empty;
  }
}

  static async getDurableHistory(env, serverId, hours = 1, columns = '', points = 160) {
    if (!env?.METRICS_BROADCASTER || !serverId) return null;
    try {
      const id = env.METRICS_BROADCASTER.idFromName('global');
      const stub = env.METRICS_BROADCASTER.get(id);
      const url = `http://internal/history?serverId=${encodeURIComponent(serverId)}&hours=${encodeURIComponent(hours)}&columns=${encodeURIComponent(columns)}&points=${encodeURIComponent(points)}`;
      const response = await stub.fetch(url);
      if (!response.ok) return null;
      const json = await response.json();
      return Array.isArray(json?.data) ? json.data : null;
    } catch (e) {
      console.warn('[Dashboard] Failed to read history from DO:', e?.message || e);
      return null;
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
  markFrontendRealtimeActive();
  
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  
  if (!id) return createBadRequestResponse('Missing ID');
  
  const server = await getServerDetail(env.DB, id, isLoggedIn);
  if (!server) return createNotFoundResponse('Server not found');
  
  const [latestMetrics, realtimeState] = await Promise.all([
    DatabaseService.getLatestMetrics(env.DB, id, server).catch(() => null),
    DashboardController.getRealtimeStateForServers(env, [id])
  ]);
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
  if (!effectiveMetrics) {
    effectiveMetrics = latestMetrics;
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
    long_history_points: Number(normalizeLongHistoryPoints(sys.long_history_points))
  };
  
  return createSuccessResponse(DashboardController.omitNullLossProbeFields(DashboardController.withoutPrivateServerFields(server)));
}

  static async handleServersAPI(request, env, sys) {
  const isLoggedIn = await checkAuth(request, env, sys);
  
  if (sys.is_public !== 'true' && !isLoggedIn) {
    return simpleAuthResponse();
  }
  markFrontendRealtimeActive();
  
  const results = (await getAllServers(env.DB, isLoggedIn)).map(DashboardController.withoutPrivateServerFields);
  const shouldIncludeLatencyHistory = sys.show_three_net_details === 'true';
  
  const serverIds = results.map(server => server.id).filter(Boolean);
  const [latestMetricsMap, realtimeState, latencyHistory] = await Promise.all([
    DatabaseService.getLatestMetricsForAllServers(env.DB).catch(() => new Map()),
    DashboardController.getRealtimeStateForServers(env, serverIds).catch(() => ({ latestReportUpdates: [] })),
    shouldIncludeLatencyHistory
      ? DatabaseService.getDashboardLatencyHistory(env.DB, results).catch(() => new Map())
      : Promise.resolve(new Map())
  ]);
  DashboardController.attachLatencyHistoryToServers(results, latencyHistory);
  
  const now = Date.now();
  let globalOnline = 0;
  let globalSpeedIn = 0, globalSpeedOut = 0, globalNetTx = 0, globalNetRx = 0;
  const regionStats = {};
  
  for (const server of results) {
    let latestMetrics = null;
    if (realtimeState?.latestReportUpdates) {
      const doReport = realtimeState.latestReportUpdates.find(u => u.serverId === server.id);
      if (doReport && Array.isArray(doReport.samples) && doReport.samples.length > 0) {
        const lastSample = doReport.samples[doReport.samples.length - 1];
        latestMetrics = {
          timestamp: lastSample.ts || doReport.reportTs || now,
          ...(lastSample.data || lastSample.payload || lastSample.metrics || {})
        };
      }
    }
    if (!latestMetrics) {
      latestMetrics = latestMetricsMap.get(server.id);
    }
    
    let isOnline = false;
    
    if (latestMetrics) {
      isOnline = (now - latestMetrics.timestamp) < 300000;
      mergeMetricsIntoServer(server, latestMetrics);
    }
    DashboardController.normalizePublicIpFields(server);
    
    if (isOnline) {
      globalOnline++;
      globalSpeedIn += parseFloat(server.net_in_speed) || 0;
      globalSpeedOut += parseFloat(server.net_out_speed) || 0;
    }
    
    globalNetRx += parseFloat(server.net_rx || 0);
    globalNetTx += parseFloat(server.net_tx || 0);
    
    let cCode = (server.region || '').toUpperCase();
    if (cCode !== '') {
      regionStats[cCode] = (regionStats[cCode] || 0) + 1;
    }
  }
  
  const globalOffline = results.length - globalOnline;

  const data = {
    servers: results,
    latestReportUpdates: realtimeState.latestReportUpdates,
    stats: {
      total: results.length,
      online: globalOnline,
      offline: globalOffline,
      globalSpeedIn,
      globalSpeedOut,
      globalNetTx,
      globalNetRx
    },
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

  const ALLOWED_HOURS = [0.167, 0.5, 1, 6, 12, 24, 48, 96, 168];
  if (!ALLOWED_HOURS.includes(hours)) {
    return createBadRequestResponse('Invalid hours parameter');
  }

  if (!sys) {
    sys = await loadSiteSettings(env.DB);
  }
  const isLoggedIn = await checkAuth(request, env, sys);

  if (sys.is_public !== 'true' && !isLoggedIn) {
    return simpleAuthResponse();
  }

  if (hours > 24 && !isLoggedIn) {
    return createUnauthorizedResponse();
  }

  const server = await getServerDetail(env.DB, id, isLoggedIn);
  if (!server) return createNotFoundResponse();

  // 最多查询7天数据
  const clampedHours = Math.min(hours, 168);
  const cacheDuration = getCacheDuration(clampedHours);
  const longHistoryPoints = clampedHours > 1
    ? Number(normalizeLongHistoryPoints(sys.long_history_points))
    : null;

  const cached = getMetricsHistoryCache(id, clampedHours, columns, longHistoryPoints);
  if (cached && Date.now() - cached.timestamp < cacheDuration) {
    const cachedData = Array.isArray(cached.data)
      ? cached.data.map(DashboardController.omitNullLossProbeFields)
      : cached.data;
    return createSuccessResponse(cachedData, { 'X-Cache': 'HIT' });
  }

  let data = await DashboardController.getDurableHistory(env, id, clampedHours, columns, longHistoryPoints);
  if (!Array.isArray(data) || data.length === 0) {
    try {
      data = await DatabaseService.getMetricsHistory(
        env.DB,
        id,
        clampedHours,
        columns,
        server,
        longHistoryPoints
      );
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      if (/invalid history partition id/i.test(message)) {
        debug('[History] 服务器未分配历史分区，无法按主键范围查询:', message);
        return new Response(JSON.stringify({
          message: 'historyPartitionNotAssigned'
        }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (/no such column/i.test(message)) {
        debug('[History] 数据库字段缺失，可能尚未升级数据库:', message);
        return new Response(JSON.stringify({
          message: 'databaseUpgradeRequired'
        }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      console.warn('[History] D1 history query failed, returning empty:', message);
      data = [];
    }
  }

  const sanitizedData = Array.isArray(data)
    ? data.map(DashboardController.omitNullLossProbeFields)
    : data;
  setMetricsHistoryCache(id, clampedHours, columns, sanitizedData, longHistoryPoints);

  return createSuccessResponse(sanitizedData, { 'X-Cache': 'MISS' });
}
}
