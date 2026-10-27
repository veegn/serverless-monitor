import { getAllServers } from '../utils/cache.js';
import { DashboardController } from '../handlers/DashboardController.js';
import { mergeMetricsIntoServer } from '../utils/metrics.js';
import { DASHBOARD_LATENCY_WINDOW_HOURS, DASHBOARD_LATENCY_WINDOW_POINTS } from '../utils/config.js';

/**
 * ServerService
 * 统一服务端服务器状态计算与实时数据合并内核
 * 供用户端 DashboardController 与管理端 AdminController 共享复用
 */
export class ServerService {
  static ONLINE_THRESHOLD_MS = 300000;

  constructor(env) {
    this.env = env;
  }

  /**
   * 统一获取整合了实时指标（DO SQLite）、在线状态判定、字段脱敏与统计汇总的服务器列表
   *
   * @param {Record<string, any>} env - Cloudflare Workers 环境变量与绑定的存储
   * @param {object} [options={}] - 控制选项
   * @param {boolean} [options.isLoggedIn=false] - 是否以管理员身份访问（未登录时过滤隐藏服务器）
   * @param {boolean} [options.includeHidden] - 是否包含隐藏节点（默认根据 isLoggedIn 决定）
   * @param {boolean} [options.maskPublicIp] - 是否掩码公网 IP（用户端为 true，管理后台为 false）
   * @param {boolean} [options.stripPrivateFields] - 是否脱敏备注与私有管理字段（用户端为 true，管理后台为 false）
   * @param {boolean} [options.includeLatencyHistory=false] - 是否附带三网延时历史数据点
   * @returns {Promise<{ servers: Array<object>, latestReportUpdates: Array<object>, stats: object, regionStats: object }>}
   */
  static async getServersWithState(env, options = {}) {
    const {
      isLoggedIn = false,
      includeHidden = isLoggedIn,
      maskPublicIp = !isLoggedIn,
      stripPrivateFields = !isLoggedIn,
      includeLatencyHistory = false
    } = options;

    const rawServers = await getAllServers(env.DB, includeHidden, { scope: stripPrivateFields ? 'public' : 'admin' });
    const serverIds = rawServers.map(server => server.id).filter(Boolean);

    // 优先向 DO 获取实时状态与 3 小时三网延时窗口（指标不读取 D1）
    const [realtimeState, durableLatencyMap] = await Promise.all([
      DashboardController.getRealtimeStateForServers(env, serverIds, { maskPublicIp }),
      includeLatencyHistory
        ? DashboardController.getDurableDashboardLatencyWindows(env, serverIds, {
            hours: DASHBOARD_LATENCY_WINDOW_HOURS,
            points: DASHBOARD_LATENCY_WINDOW_POINTS
          }).catch(() => new Map())
        : Promise.resolve(new Map())
    ]);

    const latencyHistory = durableLatencyMap || new Map();
    const reportsById = new Map((realtimeState?.latestReportUpdates || []).map(update => [update.serverId, update]));

    const now = Date.now();
    let globalOnline = 0;
    let globalTotalCpu = 0;
    let globalSpeedIn = 0;
    let globalSpeedOut = 0;
    let globalNetTx = 0;
    let globalNetRx = 0;
    const regionStats = {};

    const servers = rawServers.map(server => {
      let latestMetrics = null;

      if (realtimeState?.latestReportUpdates) {
        const doReport = reportsById.get(server.id);
        if (doReport && Array.isArray(doReport.samples) && doReport.samples.length > 0) {
          const lastSample = doReport.samples[doReport.samples.length - 1];
          latestMetrics = {
            timestamp: lastSample.ts || doReport.reportTs || now,
            ...(lastSample.data || lastSample.payload || lastSample.metrics || {})
          };
        }
      }

      const item = {
        ...server,
        region_override: server.region || ''
      };

      let isOnline = false;
      if (latestMetrics) {
        isOnline = (now - latestMetrics.timestamp) < ServerService.ONLINE_THRESHOLD_MS;
        mergeMetricsIntoServer(item, latestMetrics);
      } else {
        item.last_updated = 0;
        item.is_online = false;
        item.cpu_cores = 0;
        item.cpu_info = '';
        item.arch = '';
        item.os = '';
        item.agent_version = '';
        item.ip_v4 = '0';
        item.ip_v6 = '0';
        item.boot_time = '';
      }

      if (maskPublicIp) {
        DashboardController.normalizePublicIpFields(item);
      }

      item.is_online = isOnline;
      if (!item.region) item.region = server.region || '';

      // 绝不暴露探针明文 secret 与废弃的 bandwidth 字段
      delete item.secret;
      delete item.bandwidth;

      // 访客端脱敏管理员私有备注与管理操作配置
      if (stripPrivateFields) {
        delete item.note;
        delete item.auto_update;
      }

      // 统计数据聚合
      if (isOnline) {
        globalOnline++;
        globalTotalCpu += parseFloat(item.cpu) || 0;
        globalSpeedIn += parseFloat(item.net_in_speed) || 0;
        globalSpeedOut += parseFloat(item.net_out_speed) || 0;
      }
      globalNetRx += parseFloat(item.net_rx || 0);
      globalNetTx += parseFloat(item.net_tx || 0);

      const cCode = (item.region || '').toUpperCase();
      if (cCode !== '') {
        regionStats[cCode] = (regionStats[cCode] || 0) + 1;
      }

      return item;
    });

    if (includeLatencyHistory && latencyHistory?.size > 0) {
      DashboardController.attachLatencyHistoryToServers(servers, latencyHistory);
    }

    const globalOffline = servers.length - globalOnline;
    const stats = {
      total: servers.length,
      online: globalOnline,
      offline: globalOffline,
      total_cpu: globalTotalCpu,
      avg_cpu: globalOnline > 0 ? (globalTotalCpu / globalOnline).toFixed(2) : 0,
      total_net_in: globalSpeedIn,
      total_net_out: globalSpeedOut,
      globalSpeedIn,
      globalSpeedOut,
      globalNetTx,
      globalNetRx
    };

    return {
      servers,
      latestReportUpdates: realtimeState?.latestReportUpdates || [],
      stats,
      regionStats
    };
  }

  async getServersWithState(options = {}) {
    return ServerService.getServersWithState(this.env, options);
  }
}
