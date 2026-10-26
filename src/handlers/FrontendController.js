import { logEvent, logError } from '../utils/observability.js';
import { loadSettings } from '../utils/settings.js';
import {
  DEFAULT_SITE_TITLE,
  THEME_ASSET_CACHE_TTL_SECONDS,
  THEME_COMMIT_CACHE_TTL_SECONDS
} from '../utils/config.js';
import {
  parseCspOrigins,
  buildApiDomainsWithWs,
  buildCspHeader,
  buildBackgroundStyle,
  stripCspMeta,
  injectApiBase
} from '../utils/csp.js';
import { checkAuth } from '../middleware/auth.js';

/**
 * FrontendController
 * 负责内置前端 HTML/静态资源加载、主题注入以及 CSP 策略配置
 */
export class FrontendController {
  constructor(env, ctx = null) {
    this.env = env;
    this.ctx = ctx;
  }

  // --- 实例代理方法 ---

  async serve(request, settings = null) {
    return FrontendController.serveFrontend(request, this.env, settings);
  }

static IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
  static PREVIEW_COOKIE = 'cfsm_theme_preview';
  static PREVIEW_AUTH_COOKIE = 'cfsm_theme_preview_auth';

  static filesCache = null;

  static async loadFrontendFiles(env) {
  if (FrontendController.filesCache) return FrontendController.filesCache;

  try {
    const files = {};

    if (env.ASSETS) {
      try {
        const mainFiles = ['dashboard.html', 'style.css'];
        for (const filename of mainFiles) {
          try {
            const res = await env.ASSETS.fetch(new Request(`http://static/${filename}`));
            if (res.ok) {
              files[filename] = await res.text();
            }
          } catch (e) {
            // ignore missing asset binding files
          }
        }
      } catch (e) {
        logEvent('frontend', 'frontend.assets.missing', 'Frontend ASSETS binding is not configured', {}, 'warn');
      }
    }

    FrontendController.filesCache = files;
    return FrontendController.filesCache;
  } catch (e) {
    logError('frontend', 'frontend.assets.failed', 'Frontend assets could not be loaded', e);
    return {};
  }
}

  static escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

  static insertBeforeHeadClose(html, content) {
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${content}\n</head>`);
  }
  return `${content}\n${html}`;
}

  static injectTitle(html, title) {
  const safeTitle = FrontendController.escapeHtml(title || DEFAULT_SITE_TITLE);
  if (/<title>.*?<\/title>/is.test(html)) {
    return html.replace(/<title>.*?<\/title>/is, `<title>${safeTitle}</title>`);
  }
  return FrontendController.insertBeforeHeadClose(html, `<title>${safeTitle}</title>`);
}

  static injectFavicon(html, favicon) {
  const value = String(favicon || '').trim();
  if (!value) return html;

  const withoutExistingIcons = html.replace(/<link\b(?=[^>]*\brel=["'][^"']*(?:shortcut\s+icon|icon)[^"']*["'])[^>]*>\s*/gi, '');
  const safeFavicon = FrontendController.escapeHtml(value);
  return FrontendController.insertBeforeHeadClose(withoutExistingIcons, `<link rel="icon" href="${safeFavicon}">`);
}

  static getEnvApiBases(env) {
  return parseCspOrigins(env?.API_BASE || '');
}

  static injectAppearanceSettings(html, settings, env = {}) {
  let modifiedHtml = stripCspMeta(html);

  modifiedHtml = FrontendController.injectTitle(modifiedHtml, settings.site_title || DEFAULT_SITE_TITLE);
  modifiedHtml = FrontendController.injectFavicon(modifiedHtml, settings.favicon);

  const envApiBases = FrontendController.getEnvApiBases(env);
  modifiedHtml = injectApiBase(modifiedHtml, envApiBases);

  const cspStatic = settings.csp_static || '';
  const cspApi = settings.csp_api || '';
  const staticDomains = parseCspOrigins(cspStatic);
  const rawApiDomains = [
    ...envApiBases,
    ...parseCspOrigins(cspApi)
  ];
  const apiDomains = buildApiDomainsWithWs(rawApiDomains);
  const csp = buildCspHeader({ staticDomains, apiDomains });

  if (settings.custom_head) {
    modifiedHtml = FrontendController.insertBeforeHeadClose(modifiedHtml, settings.custom_head);
  }

  if (settings.custom_script) {
    if (/<\/body>/i.test(modifiedHtml)) {
      modifiedHtml = modifiedHtml.replace(/<\/body>/i, `<script>${settings.custom_script}</script>\n</body>`);
    } else {
      modifiedHtml += `\n<script>${settings.custom_script}</script>`;
    }
  }

  if (settings.custom_bg || settings.custom_bg_mobile) {
    modifiedHtml = FrontendController.insertBeforeHeadClose(modifiedHtml, buildBackgroundStyle(settings.custom_bg, settings.custom_bg_mobile));
  }

  return {
    html: modifiedHtml,
    csp
  };
}

  static getContentType(path) {
  const cleanPath = String(path || '').split('?')[0].toLowerCase();
  if (cleanPath.endsWith('.html')) return 'text/html;charset=UTF-8';
  if (cleanPath.endsWith('.js') || cleanPath.endsWith('.mjs')) return 'application/javascript;charset=UTF-8';
  if (cleanPath.endsWith('.css')) return 'text/css;charset=UTF-8';
  if (cleanPath.endsWith('.json')) return 'application/json;charset=UTF-8';
  if (cleanPath.endsWith('.svg')) return 'image/svg+xml';
  if (cleanPath.endsWith('.png')) return 'image/png';
  if (cleanPath.endsWith('.jpg') || cleanPath.endsWith('.jpeg')) return 'image/jpeg';
  if (cleanPath.endsWith('.webp') || cleanPath.endsWith('.webpg')) return 'image/webp';
  if (cleanPath.endsWith('.gif')) return 'image/gif';
  if (cleanPath.endsWith('.ico')) return 'image/x-icon';
  if (cleanPath.endsWith('.avif')) return 'image/avif';
  if (cleanPath.endsWith('.woff')) return 'font/woff';
  if (cleanPath.endsWith('.woff2')) return 'font/woff2';
  if (cleanPath.endsWith('.ttf')) return 'font/ttf';
  if (cleanPath.endsWith('.otf')) return 'font/otf';
  if (cleanPath.endsWith('.map')) return 'application/json;charset=UTF-8';
  return 'application/octet-stream';
}

  static normalizeThemeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return '';
    if (url.username || url.password || url.search || url.hash) return '';

    const parts = url.pathname.split('/').filter(Boolean);
    const ref = parts[3];
    if (
      parts.length < 4 ||
      parts[2] !== 'tree' ||
      !/^[A-Za-z0-9._-]+$/.test(parts[0]) ||
      !/^[A-Za-z0-9._-]+$/.test(parts[1]) ||
      !/^[A-Za-z0-9._-]+$/.test(ref) ||
      parts.some(part => part === '.' || part === '..' || /[%\\]/.test(part))
    ) {
      return '';
    }

    return `https://github.com/${parts.join('/')}`;
  } catch (_) {
    return '';
  }
}

  static parseThemeUrl(themeUrl) {
  const normalized = FrontendController.normalizeThemeUrl(themeUrl);
  if (!normalized) return null;

  const url = new URL(normalized);
  const parts = url.pathname.split('/').filter(Boolean);
  const owner = parts[0];
  const repo = parts[1];
  const ref = parts[3];
  const themePathParts = parts.slice(4);
  const encodedThemePath = [owner, repo, ref, ...themePathParts]
    .map(part => encodeURIComponent(part))
    .join('/');

  return {
    themeUrl: normalized,
    ref,
    rawBase: `https://raw.githubusercontent.com/${encodedThemePath}`,
    cacheBase: `https://cfsm-theme-cache.local/${encodedThemePath}`
  };
}

  static isCommitRef(ref) {
  return /^[a-f0-9]{40}$/i.test(ref);
}

  static getThemeWorkerCacheTtl(parsedTheme) {
  return FrontendController.isCommitRef(parsedTheme.ref) ? THEME_COMMIT_CACHE_TTL_SECONDS : THEME_ASSET_CACHE_TTL_SECONDS;
}

  static getThemeAssetBrowserCacheControl(parsedTheme) {
  if (FrontendController.isCommitRef(parsedTheme.ref)) {
    return FrontendController.IMMUTABLE_ASSET_CACHE_CONTROL;
  }
  return `public, max-age=${THEME_ASSET_CACHE_TTL_SECONDS}`;
}

  static getCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  for (const part of cookie.split(';')) {
    const [key, ...valueParts] = part.trim().split('=');
    if (key === name) {
      return valueParts.join('=');
    }
  }
  return '';
}

  static getPreviewThemeUrlFromCookie(request) {
  const value = FrontendController.getCookie(request, FrontendController.PREVIEW_COOKIE);
  if (!value) return '';
  try {
    return FrontendController.normalizeThemeUrl(decodeURIComponent(value));
  } catch (_) {
    return '';
  }
}

  static buildPreviewCookie(request, themeUrl) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${FrontendController.PREVIEW_COOKIE}=${encodeURIComponent(themeUrl)}; Max-Age=${THEME_ASSET_CACHE_TTL_SECONDS}; Path=/; SameSite=Lax${secure}`;
}

  static buildClearPreviewCookie(request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${FrontendController.PREVIEW_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax${secure}`;
}

  static async checkPreviewAuth(request, env, settings) {
  const token = FrontendController.getCookie(request, FrontendController.PREVIEW_AUTH_COOKIE);
  if (!token) return false;

  try {
    const authRequest = {
      headers: {
        get: (key) => {
          if (String(key).toLowerCase() === 'authorization') {
            return `Bearer ${decodeURIComponent(token)}`;
          }
          return request.headers.get(key);
        }
      }
    };
    return await checkAuth(authRequest, env, settings);
  } catch (_) {
    return false;
  }
}

  static getPreviewThemeUrlFromQuery(url) {
  if (!url.searchParams.has('theme_url')) return '';
  return FrontendController.normalizeThemeUrl(url.searchParams.get('theme_url'));
}

  static normalizeAssetPath(pathname) {
  const raw = pathname.slice('/assets/'.length);
  if (!raw) return '';

  try {
    const decoded = decodeURIComponent(raw);
    if (decoded.includes('\\')) return '';
    const parts = decoded.split('/').filter(Boolean);
    if (parts.length === 0 || parts.some(part => part === '.' || part === '..')) return '';
    return parts.map(part => encodeURIComponent(part)).join('/');
  } catch (_) {
    return '';
  }
}

  static normalizeThemeAssetUrls(html) {
  return html.replace(/\b(src|href)=(["'])\.?\/?assets\//gi, '$1=$2/assets/');
}

  static stripBrowserCacheHeaders(response) {
  const headers = new Headers(response.headers);
  headers.delete('Cache-Control');
  headers.delete('CDN-Cache-Control');
  headers.delete('Pragma');
  headers.delete('Expires');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

  static async fetchWithCache(rawUrl, contentType, workerCacheUrl, workerCacheTtl = THEME_ASSET_CACHE_TTL_SECONDS) {
  const cacheKey = new Request(workerCacheUrl || rawUrl, { method: 'GET' });
  const cache = typeof caches !== 'undefined' ? caches.default : null;

  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      return FrontendController.stripBrowserCacheHeaders(cached);
    }
  }

  const originResponse = await fetch(rawUrl, {
    headers: { 'User-Agent': 'CFSM-Theme-Proxy' }
  });

  if (!originResponse.ok) {
    return new Response('Theme file not found', {
      status: originResponse.status,
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
    });
  }

  const headers = new Headers();
  headers.set('Content-Type', contentType);
  headers.set('Cache-Control', `public, max-age=${workerCacheTtl}`);
  headers.set('CDN-Cache-Control', `public, max-age=${workerCacheTtl}`);
  headers.set('X-Content-Type-Options', 'nosniff');

  const etag = originResponse.headers.get('ETag');
  if (etag) headers.set('ETag', etag);

  const response = new Response(originResponse.body, {
    status: 200,
    headers
  });

  if (cache) {
    await cache.put(cacheKey, response.clone()).catch(() => {});
  }

  return FrontendController.stripBrowserCacheHeaders(response);
}

  static async serveThemeAsset(request, themeUrl) {
  const parsedTheme = FrontendController.parseThemeUrl(themeUrl);
  const url = new URL(request.url);
  const assetPath = FrontendController.normalizeAssetPath(url.pathname);

  if (!parsedTheme || !assetPath) {
    return new Response('Not Found', {
      status: 404,
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
        'X-CFSM-Theme-Asset': '1'
      }
    });
  }

  const contentType = FrontendController.getContentType(assetPath);
  const response = await FrontendController.fetchWithCache(
    `${parsedTheme.rawBase}/assets/${assetPath}`,
    contentType,
    `${parsedTheme.cacheBase}/assets/${assetPath}`,
    FrontendController.getThemeWorkerCacheTtl(parsedTheme)
  );
  const headers = new Headers(response.headers);
  headers.set('X-CFSM-Theme-Asset', '1');
  if (response.ok) {
    headers.set('Cache-Control', FrontendController.getThemeAssetBrowserCacheControl(parsedTheme));
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

  static async loadThemeIndex(themeUrl) {
  const parsedTheme = FrontendController.parseThemeUrl(themeUrl);
  if (!parsedTheme) return null;

  const response = await FrontendController.fetchWithCache(
    `${parsedTheme.rawBase}/index.html`,
    'text/html;charset=UTF-8',
    `${parsedTheme.cacheBase}/index.html`,
    FrontendController.getThemeWorkerCacheTtl(parsedTheme)
  );

  if (!response.ok) return null;
  return FrontendController.normalizeThemeAssetUrls(await response.text());
}

  static buildHtmlResponse(html, settings, request, env = {}, previewThemeUrl = '') {
  const rendered = FrontendController.injectAppearanceSettings(html, settings, env);
  const headers = new Headers({
    'Content-Type': 'text/html;charset=UTF-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': rendered.csp
  });

  if (previewThemeUrl) {
    headers.append('Set-Cookie', FrontendController.buildPreviewCookie(request, previewThemeUrl));
  } else if (FrontendController.getPreviewThemeUrlFromCookie(request)) {
    headers.append('Set-Cookie', FrontendController.buildClearPreviewCookie(request));
  }

  return new Response(rendered.html, { headers });
}

  static buildThemeIndexErrorResponse() {
  return new Response('Theme index.html is unavailable', {
    status: 502,
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

  static buildPreviewUnauthorizedResponse(request, isAsset = false) {
  const headers = new Headers({
    'Content-Type': 'text/plain;charset=UTF-8',
    'X-Content-Type-Options': 'nosniff',
    'Set-Cookie': FrontendController.buildClearPreviewCookie(request)
  });

  if (isAsset) {
    headers.set('X-CFSM-Theme-Asset', '1');
  }

  return new Response('Theme preview requires admin login', {
    status: 401,
    headers
  });
}

  static resolveThemeUrlForAsset(request, settings) {
  const url = new URL(request.url);
  const queryThemeUrl = FrontendController.getPreviewThemeUrlFromQuery(url);
  if (queryThemeUrl) {
    return { themeUrl: queryThemeUrl, preview: true };
  }

  const cookieThemeUrl = FrontendController.getPreviewThemeUrlFromCookie(request);
  if (cookieThemeUrl) {
    return { themeUrl: cookieThemeUrl, preview: true };
  }

  return {
    themeUrl: FrontendController.normalizeThemeUrl(settings?.theme_url),
    preview: false
  };
}

  static shouldUseBuiltinFrontend(path) {
  return path === '/admin' || path.startsWith('/admin/');
}

  static async serveFrontend(request, env, settings = null) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (!settings) {
    settings = await loadSettings(env.DB);
  }

  if (request.method === 'GET' && path.startsWith('/assets/')) {
    const resolvedTheme = FrontendController.resolveThemeUrlForAsset(request, settings);
    if (!resolvedTheme.themeUrl) {
      return new Response('Not Found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
      });
    }
    if (resolvedTheme.preview && !await FrontendController.checkPreviewAuth(request, env, settings)) {
      return FrontendController.buildPreviewUnauthorizedResponse(request, true);
    }
    return FrontendController.serveThemeAsset(request, resolvedTheme.themeUrl);
  }

  const previewThemeUrl = FrontendController.getPreviewThemeUrlFromQuery(url);
  const configuredThemeUrl = FrontendController.normalizeThemeUrl(settings.theme_url);
  const effectiveThemeUrl = previewThemeUrl || configuredThemeUrl;

  if (previewThemeUrl && !await FrontendController.checkPreviewAuth(request, env, settings)) {
    return FrontendController.buildPreviewUnauthorizedResponse(request);
  }

  if (!FrontendController.shouldUseBuiltinFrontend(path) && effectiveThemeUrl) {
    const themeHtml = await FrontendController.loadThemeIndex(effectiveThemeUrl);
    if (themeHtml) {
      return FrontendController.buildHtmlResponse(themeHtml, settings, request, env, previewThemeUrl);
    }
    return FrontendController.buildThemeIndexErrorResponse();
  }

  const files = await FrontendController.loadFrontendFiles(env);
  const html = files['dashboard.html'];

  if (html) {
    return FrontendController.buildHtmlResponse(html, settings, request, env);
  }

  return new Response('Frontend not available. Please build the frontend first with `npm run build:frontend`.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
  });
}
}
