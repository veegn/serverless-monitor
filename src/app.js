import { DatabaseService } from './database/DatabaseService.js';
import { NotificationService } from './services/NotificationService.js';
import { UpdateController } from './handlers/UpdateController.js';
import { DashboardController } from './handlers/DashboardController.js';
import { AdminController } from './handlers/AdminController.js';
import { FrontendController } from './handlers/FrontendController.js';
import { ThemeController } from './handlers/ThemeController.js';
import { updateDatabase } from './database/updateDatabase.js';
import {
  loadSettings,
  loadSiteSettings,
  loadAppearanceOptions,
  normalizeFrontendWsTimeoutMinutes,
  normalizeLongHistoryPoints,
  setDebug,
  debug
} from './utils/settings.js';
import { checkAuth, simpleAuthResponse } from './middleware/auth.js';
import {
  AppError,
  createSuccessResponse,
  createBadRequestResponse,
  createErrorResponse
} from './utils/errors.js';
import { verifyTurnstileToken } from './utils/common.js';
import { getCorsAllowedOrigins, createOptionsResponse, applyCors } from './utils/cors.js';
import { getRemoteVersion } from './utils/version.js';
import { HISTORY_ALL_QUERY_COLUMNS } from './utils/historyFields.js';
import {
  CURRENT_VERSION,
  DASHBOARD_LATENCY_WINDOW_HOURS,
  DASHBOARD_LATENCY_WINDOW_POINTS
} from './utils/config.js';

/**
 * ServerlessMonitorApp
 * 核心 ES6 Class 应用类，统一编排路由分发、中间件（CORS/Turnstile/Auth）、控制器与定时巡检任务
 */
export class ServerlessMonitorApp {
  constructor(env, ctx = null) {
    this.env = env;
    this.ctx = ctx;
    this.db = env?.DB;

    // 核心服务实例化 (Dependency Injection)
    this.dbService = new DatabaseService(this.db);
    this.notificationService = new NotificationService(env);

    // 控制器实例化
    this.updateController = new UpdateController(env, ctx);
    this.dashboardController = new DashboardController(env, ctx);
    this.adminController = new AdminController(env, ctx);
    this.frontendController = new FrontendController(env, ctx);
    this.themeController = new ThemeController(env, ctx);

    // 请求上下文缓存
    this._sys = null;
    this._fullSettings = null;
  }

  async ensureSiteSettings() {
    if (!this._sys) {
      this._sys = await loadSiteSettings(this.db);
    }
    return this._sys;
  }

  async ensureFullSettings() {
    this._fullSettings = await loadSettings(this.db);
    this._sys = this._fullSettings;
    return this._fullSettings;
  }

  cleanThemeAssetResponse(response) {
    const headers = new Headers(response.headers);
    headers.delete('X-CFSM-Theme-Asset');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }

  async getEncryptionKey(sys) {
    let secret = (sys && sys.jwt_secret) || this.env.TURNSTILE_SECRET_KEY || this.env.API_SECRET || 'default_secret_key_for_turnstile_encryption';
    secret += '_turnstile';
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
    return crypto.subtle.importKey(
      'raw',
      new Uint8Array(hash).slice(0, 32),
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async encryptTurnstileData(data, sys) {
    const key = await this.getEncryptionKey(sys);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const encodedData = encoder.encode(JSON.stringify(data));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encodedData
    );
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return btoa(String.fromCharCode(...combined));
  }

  async decryptTurnstileData(encoded, sys) {
    try {
      const key = await this.getEncryptionKey(sys);
      const decoded = new Uint8Array(atob(encoded).split('').map(c => c.charCodeAt(0)));
      const iv = decoded.slice(0, 12);
      const ciphertext = decoded.slice(12);
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        ciphertext
      );
      return JSON.parse(new TextDecoder().decode(decrypted));
    } catch (e) {
      debug('Cookie decryption error:', e);
      return null;
    }
  }

  async isTurnstileVerified(request, sys) {
    const verifiedHeader = request.headers.get('X-Turnstile-Verified');
    if (!verifiedHeader) return false;
    try {
      const decrypted = await this.decryptTurnstileData(verifiedHeader, sys);
      return decrypted && decrypted.expires && Date.now() < decrypted.expires * 1000;
    } catch {
      return false;
    }
  }

  async handleConfig(request, sys, setTurnstileVerified) {
    const appearanceOptions = await loadAppearanceOptions(this.db);
    const turnstileEnabled = sys.turnstile_enabled === 'true';
    const turnstileLoginEnabled = sys.turnstile_login_enabled === 'true';
    let verified = false;
    let turnstileVerified = null;

    if (turnstileEnabled) {
      verified = await this.isTurnstileVerified(request, sys);
      if (setTurnstileVerified) {
        verified = true;
        const expires = Math.floor(Date.now() / 1000) + 3600;
        const cookieData = { expires, verified: true, timestamp: Date.now() };
        turnstileVerified = await this.encryptTurnstileData(cookieData, sys);
      }
    }

    const isLoggedIn = await checkAuth(request, this.env, sys);
    const remoteVersion = isLoggedIn ? await getRemoteVersion() : null;

    return createSuccessResponse({
      version: CURRENT_VERSION,
      ...(isLoggedIn ? {
        last_workers_version: remoteVersion?.workers || null,
        last_agent_version: remoteVersion?.agent || null
      } : {}),
      is_public: sys.is_public === 'true',
      authorization: isLoggedIn,
      turnstile_enabled: turnstileEnabled,
      turnstile_login_enabled: turnstileEnabled || turnstileLoginEnabled,
      turnstile_site_key: sys.turnstile_site_key || '',
      custom_ct_name: sys.custom_ct_name || '电信',
      custom_cu_name: sys.custom_cu_name || '联通',
      custom_cm_name: sys.custom_cm_name || '移动',
      custom_bd_name: sys.custom_bd_name || 'BGP',
      node_1_name: sys.node_1_name || 'Node 1',
      node_2_name: sys.node_2_name || 'Node 2',
      node_3_name: sys.node_3_name || 'Node 3',
      node_4_name: sys.node_4_name || 'Node 4',
      site_title: appearanceOptions.site_title || '',
      display_mode: appearanceOptions.display_mode || 'bar',
      preferred_theme: appearanceOptions.preferred_theme || 'auto',
      default_language: appearanceOptions.default_language || 'auto',
      theme_options: appearanceOptions.theme_options || {},
      verified,
      turnstile_verified: turnstileVerified,
      frontend_ws_timeout_minutes: Number(normalizeFrontendWsTimeoutMinutes(sys.frontend_ws_timeout_minutes)),
      long_history_points: Number(normalizeLongHistoryPoints(sys.long_history_points)),
      latency_window: {
        points: DASHBOARD_LATENCY_WINDOW_POINTS,
        hours: DASHBOARD_LATENCY_WINDOW_HOURS
      }
    });
  }

  async handleDoHealth() {
    if (!this.env.METRICS_BROADCASTER) {
      return createSuccessResponse({ ok: false, reason: 'DO not bound' });
    }
    try {
      const id = this.env.METRICS_BROADCASTER.idFromName('global');
      const stub = this.env.METRICS_BROADCASTER.get(id);
      return await stub.fetch('http://internal/health');
    } catch (e) {
      return createSuccessResponse({ ok: false, reason: e.message });
    }
  }

  async fetch(request) {
    setDebug(this.env.DEBUG);

    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    const corsAllowedOrigins = getCorsAllowedOrigins(this.env);

    if (!this.env.API_SECRET || this.env.API_SECRET.length === 0) {
      const response = createBadRequestResponse('API_SECRET is required');
      return applyCors(response, request, corsAllowedOrigins);
    }

    if (method === 'OPTIONS') {
      return createOptionsResponse(request, corsAllowedOrigins);
    }

    if (method === 'GET' && path === '/admin/') {
      const target = new URL(request.url);
      const search = target.search;
      target.pathname = '/admin';
      target.search = '';
      target.hash = `/admin${search}`;
      return Response.redirect(target.toString(), 302);
    }

    if (method === 'GET' && path.startsWith('/assets/')) {
      try {
        const themeAssetResponse = await this.frontendController.serve(request, await loadSettings(this.db));
        if (themeAssetResponse.headers.get('X-CFSM-Theme-Asset') === '1') {
          return applyCors(this.cleanThemeAssetResponse(themeAssetResponse), request, corsAllowedOrigins);
        }
      } catch (e) {
      }
    }

    const bypassTurnstilePaths = [
      '/admin/api',
      '/api/ws',
    ];

    const isApiRequest = path.startsWith('/api/') || path.startsWith('/admin/api');
    if (path === '/api/config' || path === '/api/theme_options' || path === '/clearHistory') {
      await this.dbService.init();
    }

    const isTurnstileBypassed = (reqPath) => {
      if (bypassTurnstilePaths.includes(reqPath)) return true;
      if (reqPath === '/api/config' && !request.headers.get('X-Turnstile-Token') && !request.headers.get('X-Turnstile-Verified')) return true;
      return false;
    };

    let setTurnstileVerified = false;

    if (isApiRequest && !isTurnstileBypassed(path)) {
      const sys = await this.ensureSiteSettings();
      const turnstileEnabled = sys.turnstile_enabled === 'true';
      const turnstileSecretKey = sys.turnstile_secret_key || '';

      if (turnstileEnabled) {
        const hasValidCookie = await this.isTurnstileVerified(request, sys);

        if (!hasValidCookie) {
          const turnstileToken = request.headers.get('X-Turnstile-Token');
          const isVerified = await verifyTurnstileToken(turnstileToken, turnstileSecretKey);

          if (!isVerified) {
            const response = createErrorResponse(new AppError('Turnstile verification failed', 403));
            return applyCors(response, request, corsAllowedOrigins);
          }

          setTurnstileVerified = true;
        }
      }
    }

    const routes = [
      { method: 'POST', path: '/update', handler: () => this.updateController.handle(request) },
      { method: 'GET', path: '/update', handler: () => this.updateController.handleAgentWebSocket(request) },
      { method: 'GET', path: '/__do/health', handler: () => this.handleDoHealth() },
      { method: 'GET', path: '/api/config', handler: async () => {
        const sys = await this.ensureSiteSettings();
        return this.handleConfig(request, sys, setTurnstileVerified);
      }},
      { method: 'GET', path: '/theme', handler: async () => {
        const themeResult = await this.themeController.handleStore();
        if (!themeResult.ok) {
          return new Response(JSON.stringify({
            error: themeResult.error || 'themeStoreProxyFailed',
            code: 502,
            fallback: 'client'
          }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return createSuccessResponse(themeResult.themeStore, {
          'X-CFSM-Theme-Source': themeResult.cached ? 'cache' : 'raw'
        });
      }},
      { method: 'POST', path: '/api/theme_options', handler: async () => {
        const sys = await this.ensureSiteSettings();
        return this.themeController.handleOptions(request, sys);
      }},
      { method: 'GET', path: '/api/server', handler: async () => {
        const sys = await this.ensureSiteSettings();
        return this.dashboardController.handleServer(request, sys);
      }},
      { method: 'GET', path: '/api/servers', handler: async () => {
        const sys = await this.ensureFullSettings();
        return this.dashboardController.handleServers(request, sys);
      }},
      { method: 'GET', path: '/api/ws', handler: () => this.updateController.handleFrontendWebSocket(request) },
      { method: 'GET', path: '/api/history/all', handler: async () => {
        const sys = await this.ensureSiteSettings();
        const id = url.searchParams.get('id');
        const hours = parseFloat(url.searchParams.get('hours') || '24');
        const allColumns = HISTORY_ALL_QUERY_COLUMNS.join(', ');
        return this.dashboardController.handleHistory(request, id, hours, allColumns, sys);
      }},
      { method: 'POST', path: '/admin/api', handler: async () => {
        const sys = await this.ensureSiteSettings();
        return this.adminController.handle(request, sys, () => this.ensureFullSettings());
      }},
      { method: 'POST', path: '/updateDatabase', handler: async () => {
        const sys = await this.ensureSiteSettings();
        if (!await checkAuth(request, this.env, sys)) {
          return simpleAuthResponse();
        }
        const result = await updateDatabase(this.db);
        return createSuccessResponse(result);
      }},
      { method: 'POST', path: '/clearHistory', handler: async () => {
        const sys = await this.ensureSiteSettings();
        if (!await checkAuth(request, this.env, sys)) {
          return simpleAuthResponse();
        }
        const result = await this.dbService.clearHistory();
        try {
          if (this.env?.METRICS_BROADCASTER) {
            const id = this.env.METRICS_BROADCASTER.idFromName('global');
            const stub = this.env.METRICS_BROADCASTER.get(id);
            await stub.fetch('http://internal/clear-history', { method: 'POST' });
          }
        } catch (_) {}
        return createSuccessResponse(result);
      }}
    ];

    for (const route of routes) {
      if (route.method === method && route.path === path) {
        const response = await route.handler();

        if (response.status === 101) {
          return response;
        }

        if (setTurnstileVerified) {
          const sys = await this.ensureSiteSettings();
          const expires = Math.floor(Date.now() / 1000) + 3600;
          const cookieData = { expires, verified: true, timestamp: Date.now() };
          const encryptedData = await this.encryptTurnstileData(cookieData, sys);

          const finalHeaders = new Headers(response.headers);
          finalHeaders.set('Access-Control-Allow-Origin', request.headers.get('Origin') || '');
          finalHeaders.set('Access-Control-Allow-Credentials', 'true');
          finalHeaders.set('Vary', 'Origin');

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: finalHeaders
          });
        }

        return applyCors(response, request, corsAllowedOrigins);
      }
    }

    const fullSettings = await this.ensureFullSettings();
    const frontendResponse = await this.frontendController.serve(request, fullSettings);
    return applyCors(frontendResponse, request, corsAllowedOrigins);
  }

  async scheduled(event) {
    const cron = event.cron;
    debug(`[Cron] 定时任务触发: ${cron}`);

    const now = new Date();
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();

    if (cron === '*/1 * * * *') {
      if (day === 0 && hour === 0 && minute < 5) {
        debug('[Cron] 每周日0:00-0:05表轮换期间，跳过离线节点检测');
      } else {
        debug('[Cron] 开始执行离线节点检测');
        await this.notificationService.checkOfflineNodes(this.db);
        debug('[Cron] 离线节点检测完成');
        debug('[Cron] 开始执行资源负载告警检测');
        await this.notificationService.checkResourceAlerts({ minute });
        debug('[Cron] 资源负载告警检测完成');
      }
    } else if (cron === '0 * * * *') {
      if (day === 0 && hour === 0) {
        debug('[Cron] 开始执行每周数据清理任务（表轮换）');
        await this.dbService.weeklyCleanup();
        debug('[Cron] 每周数据清理任务完成');
      }
      debug('[Cron] 检查是否到达服务器到期检测时间');
      await this.notificationService.checkExpiringServers({ scheduled: true, now: now.getTime() }, this.db);
    } else if (this.env.DEBUG == 1) {
      if (cron === '0 0 * * 0') {
        debug('[Cron DEBUG] 开始执行每周数据清理任务（表轮换）');
        await this.dbService.weeklyCleanup();
        debug('[Cron DEBUG] 每周数据清理任务完成');
      } else if (cron === '0 12 * * *') {
        debug('[Cron DEBUG] 开始执行服务器到期检测');
        await this.notificationService.checkExpiringServers({}, this.db);
        debug('[Cron DEBUG] 服务器到期检测完成');
      }
    }
  }
}
