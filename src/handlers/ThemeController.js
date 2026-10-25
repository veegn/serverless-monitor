import {
  THEME_STORE_CACHE_TTL_SECONDS,
  THEME_STORE_URL
} from '../utils/config.js';
import { checkAuth, simpleAuthResponse } from '../middleware/auth.js';
import { isValidThemeOptions, saveThemeOptions } from '../utils/settings.js';
import { createBadRequestResponse, createSuccessResponse } from '../utils/errors.js';

/**
 * ThemeController
 * 负责主题商店代理、主题配置读取与保存
 */
export class ThemeController {
  static cachedThemeStore = null;
  static cacheTime = 0;

  constructor(env, ctx = null) {
    this.env = env;
    this.ctx = ctx;
  }

  static createEmptyThemeStore() {
    return { schema: 1, themes: [] };
  }

  static normalizeThemeStore(data) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return {
        ...data,
        schema: data.schema || 1,
        themes: Array.isArray(data.themes) ? data.themes : []
      };
    }

    return ThemeController.createEmptyThemeStore();
  }

  static async handleTheme() {
    const now = Math.floor(Date.now() / 1000);
    if (ThemeController.cachedThemeStore && (now - ThemeController.cacheTime) < THEME_STORE_CACHE_TTL_SECONDS) {
      return { ok: true, themeStore: ThemeController.cachedThemeStore, cached: true };
    }

    try {
      const res = await fetch(THEME_STORE_URL, {
        headers: { 'User-Agent': 'CFSM-Theme-Store' }
      });

      if (!res.ok) {
        return { ok: false, status: res.status, error: 'themeStoreProxyFailed' };
      }

      const data = await res.json();
      const themeStore = ThemeController.normalizeThemeStore(data);

      ThemeController.cachedThemeStore = themeStore;
      ThemeController.cacheTime = now;
      return { ok: true, themeStore, cached: false };
    } catch (e) {
      return { ok: false, status: 0, error: 'themeStoreProxyFailed' };
    }
  }

  static async handleThemeOptions(request, env, sys) {
    if (!await checkAuth(request, env, sys)) {
      return simpleAuthResponse();
    }

    let data;
    try {
      data = await request.json();
    } catch (_) {
      return createBadRequestResponse('invalidJson');
    }

    const themeOptions = data?.theme_options;
    if (!isValidThemeOptions(themeOptions)) {
      return createBadRequestResponse('invalidThemeOptionsFormat');
    }

    await saveThemeOptions(env.DB, themeOptions);
    sys.theme_options = themeOptions;
    return createSuccessResponse({
      success: true,
      theme_options: themeOptions,
      message: 'updateSuccess'
    });
  }

  async handleStore() {
    return ThemeController.handleTheme();
  }

  async handleOptions(request, sys) {
    return ThemeController.handleThemeOptions(request, this.env, sys);
  }
}
