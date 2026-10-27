import {
  DEFAULT_SITE_TITLE,
  JWT_SECRET_MIN_LENGTH,
  SITE_SETTINGS_CACHE_TTL_MS
} from './config.js';
import { normalizePct } from './traffic.js';
import { AppError } from './errors.js';
import { logEvent, logError, hasLogContext, withLogContext } from './observability.js';
import { APPEARANCE_FIELDS, SETTINGS_GROUPS, SETTINGS_SCOPES, FIELD_SETTINGS_GROUP } from './settingFields.js';
import { readGroupedSettings, saveGroupedSettings, ensureGroupedJwtSecret, ensureGroupedSettings } from '../database/GroupedSettings.js';
export { APPEARANCE_FIELDS } from './settingFields.js';
import { LONG_HISTORY_POINT_OPTIONS, DEFAULT_LONG_HISTORY_POINTS } from './historyPolicy.js';
export { LONG_HISTORY_POINT_OPTIONS, DEFAULT_LONG_HISTORY_POINTS } from './historyPolicy.js';


export const SITE_FIELDS = ['is_public', 'show_price', 'show_expire', 'show_tf', 'show_three_net_details', 'wss_report_enabled', 'frontend_ws_timeout_minutes', 'long_history_points', 'tg_notify', 'tg_bot_token', 'tg_chat_id', 'notification_timezone', 'notification_language', 'expire_notification_time', 'notification_webhook_enabled', 'notification_webhook_url', 'notification_webhook_method', 'notification_webhook_format', 'notification_webhook_headers', 'notification_webhook_body', 'notification_template', 'turnstile_enabled', 'turnstile_login_enabled', 'turnstile_site_key', 'turnstile_secret_key', 'jwt_secret', 'username', 'password', 'cloudflare_account_id', 'cloudflare_token', 'custom_ct', 'custom_cu', 'custom_cm', 'custom_bd', 'node_1', 'node_2', 'node_3', 'node_4', 'custom_ct_name', 'custom_cu_name', 'custom_cm_name', 'custom_bd_name', 'node_1_name', 'node_2_name', 'node_3_name', 'node_4_name', 'expire_reminder', 'resource_alert_rules', 'traffic_alert_threshold', 'theme_url', 'auto_register_enabled', 'auto_register_default_group', 'auto_register_token', 'auto_register_token_expires'];

export const TG_NOTIFY_MINUTES_MIN = 2;
export const TG_NOTIFY_MINUTES_MAX = 30;
export const TG_NOTIFY_LEGACY_TRUE_MINUTES = 5;
export const EXPIRE_REMINDER_DAYS_MAX = 365;
export const FRONTEND_WS_TIMEOUT_MINUTES_MAX = 1440;
export const DEFAULT_NOTIFICATION_TIMEZONE = 'UTC';
export const NOTIFICATION_LANGUAGES = ['zh', 'en', 'es'];
export const DEFAULT_NOTIFICATION_LANGUAGE = 'zh';
export const DEFAULT_EXPIRE_NOTIFICATION_TIME = '12';
export const ALL_WSS_REPORT_HOURS = Object.freeze(Array.from({ length: 24 }, (_, hour) => hour));
export const RESOURCE_ALERT_WINDOW_MIN = 5;
export const RESOURCE_ALERT_WINDOW_MAX = 10;
export const RESOURCE_ALERT_MODE_CONTINUOUS = 'continuous';
export const RESOURCE_ALERT_MODE_AVERAGE = 'average';
export const RESOURCE_ALERT_RULES_MAX = 20;
export const DEFAULT_NOTIFICATION_TEMPLATE = '{{emoji}}【Serverless Monitor】{{event}}\n\n{{message}}\n\n{{time}}';
export const DEFAULT_NOTIFICATION_WEBHOOK_BODY = '{\n  "title": "{{emoji}} {{event}}",\n  "content": "{{notification}}"\n}';
const LEGACY_DEFAULT_NOTIFICATION_TEMPLATES = [
  '{{emoji}}【CF Server Monitor】{{event}}\n\n{{message}}\n\n{{time}}',
  '{{emoji}}【CF Server Monitor】{{event}}\n\n{{message}}\n\n时间: {{time}}',
  '{{emoji}}【CF Server Monitor】{{event}}\n服务器: {{client}}\n详情:\n{{message}}\n时间: {{time}}',
  '事件: {{event}}\n服务名: {{client}}\n消息: {{message}}\n时间: {{time}}',
  '【CF Server Monitor】{{event}}\n服务器: {{client}}\n数量: {{count}}\n详情:\n{{message}}\n时间: {{time}}',
  '{{emoji}}【CF Server Monitor】{{event}}\n服务器: {{client}}\n数量: {{count}}\n详情:\n{{message}}\n时间: {{time}}',
  '{{emoji}}【Serverless Monitor】{{event}}\n\n{{message}}\n\n时间: {{time}}',
  '{{emoji}}【Serverless Monitor】{{event}}\n服务器: {{client}}\n详情:\n{{message}}\n时间: {{time}}'
];
const LEGACY_DEFAULT_NOTIFICATION_WEBHOOK_BODIES = [
  '{\n  "event": "{{event}}",\n  "client": "{{client}}",\n  "message": "{{message}}",\n  "time": "{{time}}"\n}',
  '{\n  "title": "{{title}}",\n  "event": "{{event}}",\n  "client": "{{client}}",\n  "clients": "{{clients}}",\n  "count": "{{count}}",\n  "message": "{{message}}",\n  "notification": "{{notification}}",\n  "time": "{{time}}"\n}',
  '{\n  "title": "{{event}}",\n  "content": "{{notification}}"\n}'
];
export const NOTIFICATION_WEBHOOK_METHODS = ['GET', 'POST'];
export const NOTIFICATION_WEBHOOK_FORMATS = ['json', 'form', 'text'];
export const RESOURCE_ALERT_METRIC_CPU = 'cpu';
export const RESOURCE_ALERT_METRIC_RAM = 'ram';
export const RESOURCE_ALERT_METRIC_DISK = 'disk';
export const RESOURCE_ALERT_METRIC_NET_IN = 'netIn';
export const RESOURCE_ALERT_METRIC_NET_OUT = 'netOut';
export const RESOURCE_ALERT_METRICS = [
  RESOURCE_ALERT_METRIC_CPU,
  RESOURCE_ALERT_METRIC_RAM,
  RESOURCE_ALERT_METRIC_DISK,
  RESOURCE_ALERT_METRIC_NET_IN,
  RESOURCE_ALERT_METRIC_NET_OUT
];
const BYTES_PER_MEGABIT = 1000 * 1000 / 8;
let cachedSiteSettings = null;
let cachedSiteSettingsDb = null;
const lastKnownSiteSettings = new WeakMap();
let siteSettingsCacheExpiry = 0;
let cachedAppearanceOptions = null;
let cachedAppearanceDb = null;
let appearanceOptionsCacheExpiry = 0;
const scopedResults = new Map();
const lastKnownScoped = new WeakMap();

const defaults = {
  site_title: DEFAULT_SITE_TITLE,
  custom_bg: '',
  custom_bg_mobile: '',
  favicon: '',
  custom_head: '',
  custom_script: '',
  csp_static: '',
  csp_api: '',
  display_mode: 'ring',
  preferred_theme: 'auto',
  default_language: 'auto',
  theme_options: {},
  is_public: 'true',
  show_price: 'true',
  show_expire: 'true',
  show_tf: 'true',
  show_three_net_details: 'true',
  wss_report_enabled: 'true',
  frontend_ws_timeout_minutes: '0',
  long_history_points: String(DEFAULT_LONG_HISTORY_POINTS),
  tg_notify: '0',
  tg_bot_token: '',
  tg_chat_id: '',
  notification_timezone: DEFAULT_NOTIFICATION_TIMEZONE,
  notification_language: DEFAULT_NOTIFICATION_LANGUAGE,
  expire_notification_time: DEFAULT_EXPIRE_NOTIFICATION_TIME,
  notification_webhook_enabled: 'false',
  notification_webhook_url: '',
  notification_webhook_method: 'POST',
  notification_webhook_format: 'json',
  notification_webhook_headers: '',
  notification_webhook_body: DEFAULT_NOTIFICATION_WEBHOOK_BODY,
  notification_template: DEFAULT_NOTIFICATION_TEMPLATE,
  turnstile_enabled: 'false',
  turnstile_login_enabled: 'false',
  turnstile_site_key: '',
  turnstile_secret_key: '',
  jwt_secret: '',
  cloudflare_account_id: '',
  cloudflare_token: '',
  custom_ct: 'gd-ct-dualstack.ip.zstaticcdn.com',
  custom_cu: 'gd-cu-dualstack.ip.zstaticcdn.com',
  custom_cm: 'gd-cm-dualstack.ip.zstaticcdn.com',
  custom_bd: '',
  node_1: '',
  node_2: '',
  node_3: '',
  node_4: '',
  custom_ct_name: '电信',
  custom_cu_name: '联通',
  custom_cm_name: '移动',
  custom_bd_name: 'BGP',
  node_1_name: 'Node 1',
  node_2_name: 'Node 2',
  node_3_name: 'Node 3',
  node_4_name: 'Node 4',
  expire_reminder: '0',
  resource_alert_rules: [],
  traffic_alert_threshold: '0',
  theme_url: '',
  auto_register_enabled: 'false',
  auto_register_default_group: 'Default',
  auto_register_token: '',
  auto_register_token_expires: '0'
};

export function normalizeLongHistoryPoints(value) {
  if (value === 'auto') return 'auto';
  const points = Number(value);
  return String(
    LONG_HISTORY_POINT_OPTIONS.includes(points)
      ? points
      : DEFAULT_LONG_HISTORY_POINTS
  );
}

export function normalizeFrontendWsTimeoutMinutes(value) {
  const minutes = Number(value);
  return String(
    Number.isInteger(minutes) && minutes >= 0 && minutes <= FRONTEND_WS_TIMEOUT_MINUTES_MAX
      ? minutes
      : 0
  );
}

export function normalizeTgNotify(value) {
  if (value === true || value === 'true') return String(TG_NOTIFY_LEGACY_TRUE_MINUTES);
  if (
    value === false ||
    value === 'false' ||
    value === undefined ||
    value === null ||
    value === ''
  ) {
    return '0';
  }

  const minutes = Number(value);
  if (
    Number.isInteger(minutes) &&
    (minutes === 0 || (minutes >= TG_NOTIFY_MINUTES_MIN && minutes <= TG_NOTIFY_MINUTES_MAX))
  ) {
    return String(minutes);
  }

  return '0';
}

export function getTgNotifyMinutes(value) {
  return Number(normalizeTgNotify(value));
}

export function normalizeExpireReminder(value) {
  if (value === true || value === 'true') return String(EXPIRE_REMINDER_DAYS_MAX);
  if (
    value === false ||
    value === 'false' ||
    value === undefined ||
    value === null ||
    value === ''
  ) {
    return '0';
  }

  const days = Number(value);
  if (Number.isInteger(days) && days >= 0 && days <= EXPIRE_REMINDER_DAYS_MAX) {
    return String(days);
  }

  return '0';
}

export function getExpireReminderDays(value) {
  return Number(normalizeExpireReminder(value));
}

// 月流量告警全局阈值：百分比整数，夹 0..100（'0'/''=关闭），以字符串存储与其它数值设置一致
export function normalizeTrafficAlertThreshold(value) {
  return String(normalizePct(value));
}

export function normalizeNotificationTimezone(value) {
  const timezone = String(value || '').trim();
  if (!timezone || timezone.length > 64) return DEFAULT_NOTIFICATION_TIMEZONE;

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
    return timezone;
  } catch (_) {
    return DEFAULT_NOTIFICATION_TIMEZONE;
  }
}

export function normalizeExpireNotificationTime(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return DEFAULT_EXPIRE_NOTIFICATION_TIME;
  const legacyTimeMatch = raw.match(/^([01]?\d|2[0-3]):[0-5]\d$/);
  const hour = Number(legacyTimeMatch ? legacyTimeMatch[1] : raw);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23
    ? String(hour)
    : DEFAULT_EXPIRE_NOTIFICATION_TIME;
}

export function normalizeNotificationWebhookMethod(value) {
  const method = String(value || '').trim().toUpperCase();
  return NOTIFICATION_WEBHOOK_METHODS.includes(method) ? method : 'POST';
}

export function normalizeNotificationWebhookFormat(value) {
  const format = String(value || '').trim().toLowerCase();
  return NOTIFICATION_WEBHOOK_FORMATS.includes(format) ? format : 'json';
}

export function normalizeNotificationWebhookHeaders(value) {
  return String(value || '').slice(0, 4000);
}

export function normalizeNotificationWebhookBody(value) {
  const body = String(value || '').trim();
  if (LEGACY_DEFAULT_NOTIFICATION_WEBHOOK_BODIES.includes(body)) {
    return DEFAULT_NOTIFICATION_WEBHOOK_BODY;
  }
  return (body || DEFAULT_NOTIFICATION_WEBHOOK_BODY).slice(0, 8000);
}

export function normalizeNotificationTemplate(value) {
  const template = String(value || '').trim();
  if (LEGACY_DEFAULT_NOTIFICATION_TEMPLATES.includes(template)) {
    return DEFAULT_NOTIFICATION_TEMPLATE;
  }
  return (template || DEFAULT_NOTIFICATION_TEMPLATE).slice(0, 4000);
}

export function normalizeResourceAlertWindowMinutes(value) {
  const minutes = Number(value);
  if (
    Number.isInteger(minutes) &&
    (minutes === 0 || (minutes >= RESOURCE_ALERT_WINDOW_MIN && minutes <= RESOURCE_ALERT_WINDOW_MAX))
  ) {
    return String(minutes);
  }
  return '0';
}

export function normalizeResourceAlertIntervalMinutes(value) {
  const normalized = normalizeResourceAlertWindowMinutes(value);
  return normalized === '0' ? String(RESOURCE_ALERT_WINDOW_MIN) : normalized;
}

export function normalizeResourceAlertPercent(value) {
  if (value === undefined || value === null || value === '') return '0';
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) return '0';
  return String(Math.round(number * 100) / 100);
}

export function normalizeResourceAlertMbps(value) {
  if (value === undefined || value === null || value === '') return '0';
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100000) return '0';
  return String(Math.round(number * 100) / 100);
}

export function normalizeResourceAlertMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return mode === RESOURCE_ALERT_MODE_CONTINUOUS
    ? RESOURCE_ALERT_MODE_CONTINUOUS
    : RESOURCE_ALERT_MODE_AVERAGE;
}

export function normalizeResourceAlertMetric(value) {
  const metric = String(value || '').trim();
  return RESOURCE_ALERT_METRICS.includes(metric) ? metric : RESOURCE_ALERT_METRIC_CPU;
}

function parseResourceAlertRulesValue(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

function hasExplicitResourceAlertRulesValue(value) {
  if (Array.isArray(value)) return true;
  return typeof value === 'string' && value.trim() !== '';
}

function normalizeResourceAlertRuleId(value, index) {
  const id = String(value || '').trim().replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 64);
  return id || `rule_${index + 1}`;
}

function normalizeResourceAlertRuleName(value, metric, index) {
  const name = String(value || '').trim().slice(0, 80);
  if (name) return name;
  const labels = {
    [RESOURCE_ALERT_METRIC_CPU]: 'CPU',
    [RESOURCE_ALERT_METRIC_RAM]: 'RAM',
    [RESOURCE_ALERT_METRIC_DISK]: 'DISK',
    [RESOURCE_ALERT_METRIC_NET_IN]: 'NET In',
    [RESOURCE_ALERT_METRIC_NET_OUT]: 'NET Out'
  };
  return `${labels[metric] || 'Resource'} Alert ${index + 1}`;
}

function normalizeResourceAlertServers(value) {
  const source = Array.isArray(value)
    ? value
    : (Array.isArray(value?.servers) ? value.servers : []);
  const seen = new Set();
  const servers = [];
  for (const item of source) {
    const id = String(item || '').trim();
    if (!id || id.length > 64 || !/^[A-Za-z0-9._:-]+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    servers.push(id);
  }
  return servers.slice(0, 1000);
}

function getDefaultResourceAlertThreshold(metric) {
  return metric === RESOURCE_ALERT_METRIC_NET_IN || metric === RESOURCE_ALERT_METRIC_NET_OUT
    ? '100'
    : '80';
}

export function normalizeResourceAlertThreshold(value, metric) {
  const fallback = getDefaultResourceAlertThreshold(metric);
  const normalized = metric === RESOURCE_ALERT_METRIC_NET_IN || metric === RESOURCE_ALERT_METRIC_NET_OUT
    ? normalizeResourceAlertMbps(value)
    : normalizeResourceAlertPercent(value);
  return Number(normalized) > 0 ? normalized : fallback;
}

export function normalizeResourceAlertRule(rule, index = 0) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
  const metric = normalizeResourceAlertMetric(rule.metric);
  const intervalMinutes = normalizeResourceAlertIntervalMinutes(
    rule.intervalMinutes ?? rule.windowMinutes ?? rule.interval ?? rule.minutes
  );

  return {
    id: normalizeResourceAlertRuleId(rule.id, index),
    name: normalizeResourceAlertRuleName(rule.name, metric, index),
    metric,
    threshold: normalizeResourceAlertThreshold(rule.threshold, metric),
    servers: normalizeResourceAlertServers(rule.servers ?? rule.serverIds),
    intervalMinutes,
    mode: normalizeResourceAlertMode(rule.mode)
  };
}

export function normalizeResourceAlertRules(value) {
  const explicitRulesValue = hasExplicitResourceAlertRulesValue(value);
  const source = parseResourceAlertRulesValue(value);
  const seenIds = new Set();
  const rules = source
    .slice(0, RESOURCE_ALERT_RULES_MAX)
    .map((rule, index) => normalizeResourceAlertRule(rule, index))
    .filter(Boolean)
    .map((rule, index) => {
      let id = rule.id;
      if (seenIds.has(id)) {
        const suffix = `_${index + 1}`;
        id = `${id.slice(0, Math.max(0, 64 - suffix.length))}${suffix}`;
        let attempt = index + 1;
        while (seenIds.has(id)) {
          attempt += 1;
          const nextSuffix = `_${attempt}`;
          id = `${rule.id.slice(0, Math.max(0, 64 - nextSuffix.length))}${nextSuffix}`;
        }
      }
      seenIds.add(id);
      return { ...rule, id };
    });

  if (rules.length > 0 || explicitRulesValue) return rules;
  return [];
}

export function getResourceAlertRuleThresholds(rule) {
  const metric = normalizeResourceAlertMetric(rule?.metric);
  const threshold = Number(normalizeResourceAlertThreshold(rule?.threshold, metric));
  return {
    cpuPercent: metric === RESOURCE_ALERT_METRIC_CPU ? threshold : 0,
    ramPercent: metric === RESOURCE_ALERT_METRIC_RAM ? threshold : 0,
    diskPercent: metric === RESOURCE_ALERT_METRIC_DISK ? threshold : 0,
    netInBps: metric === RESOURCE_ALERT_METRIC_NET_IN ? threshold * BYTES_PER_MEGABIT : 0,
    netOutBps: metric === RESOURCE_ALERT_METRIC_NET_OUT ? threshold * BYTES_PER_MEGABIT : 0,
    netTotalBps: 0
  };
}

export function getResourceAlertConfig(settings = {}) {
  const rules = normalizeResourceAlertRules(settings.resource_alert_rules, settings);

  return {
    enabled: rules.length > 0,
    rules,
    hasRules: rules.length > 0
  };
}

export function generateRandomSecret(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let result = '';
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, '0');
  }
  return result;
}

export function isValidJwtSecret(secret) {
  return typeof secret === 'string' && secret.length >= JWT_SECRET_MIN_LENGTH;
}

function copyFields(target, source, fields) {
  if (!source || typeof source !== 'object') return;
  for (const field of fields) {
    if (source[field] !== undefined) {
      target[field] = source[field];
    }
  }
}

export function normalizeDisplayMode(value, fallback = 'bar') {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'list') return 'table';
  if (mode === 'bar' || mode === 'ring' || mode === 'table') return mode;
  return fallback === 'ring' || fallback === 'table' ? fallback : 'bar';
}

export function normalizePreferredTheme(value, fallback = 'auto') {
  const theme = String(value || '').trim().toLowerCase();
  if (theme === 'dark' || theme === 'light' || theme === 'auto') return theme;
  return fallback === 'dark' || fallback === 'light' ? fallback : 'auto';
}

export function normalizeDefaultLanguage(value, fallback = 'auto') {
  const language = String(value || '').trim().toLowerCase();
  if (language === 'zh' || language === 'en' || language === 'es' || language === 'auto') return language;
  return fallback === 'zh' || fallback === 'en' || fallback === 'es' ? fallback : 'auto';
}

export function normalizeNotificationLanguage(value) {
  const language = String(value || '').trim().toLowerCase();
  return NOTIFICATION_LANGUAGES.includes(language) ? language : DEFAULT_NOTIFICATION_LANGUAGE;
}

export function normalizeBooleanSetting(value, fallback = 'false') {
  if (value === true || value === 1) return 'true';
  if (value === false || value === 0) return 'false';
  if (value === null || value === undefined || value === '') {
    return fallback === 'true' ? 'true' : 'false';
  }

  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return 'true';
  if (['false', '0', 'no', 'off'].includes(normalized)) return 'false';
  return fallback === 'true' ? 'true' : 'false';
}

export function normalizeWssReportHours(value) {
  if (value === undefined || value === null || value === '') {
    return Array.from({ length: 24 }, (_, hour) => hour);
  }

  let source = value;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch (_) {
      source = source.split(',').map(item => item.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(source)) return Array.from({ length: 24 }, (_, hour) => hour);

  return Array.from(new Set(source
    .map(hour => {
      if (typeof hour === 'number') return hour;
      if (typeof hour === 'string' && /^\d{1,2}$/.test(hour.trim())) return Number(hour);
      return NaN;
    })
    .filter(hour => Number.isInteger(hour) && hour >= 0 && hour <= 23)))
    .sort((a, b) => a - b);
}

export function isWssReportConfigured(settings = {}) {
  return normalizeBooleanSetting(settings?.wss_report_enabled) === 'true';
}

export function getWssReportScheduleState(settings = {}, now = Date.now()) {
  if (!isWssReportConfigured(settings)) {
    return {
      configured: false,
      active: false,
      mode: 'disabled',
      reason: 'wss_disabled'
    };
  }

  return {
    configured: true,
    active: true,
    mode: 'active',
    reason: 'wss_active'
  };
}

export function isWssReportEnabled(settings = {}, now = Date.now()) {
  return getWssReportScheduleState(settings, now).active;
}

export async function migrateSettings(db) {
  return readGroupedSettings(db, defaults);
}

export function ensureSettingsStorage(db) {
  return ensureGroupedSettings(db, defaults);
}

export async function loadSettingsScope(db, scope, options = {}) {
  const groups = SETTINGS_SCOPES[scope];
  if (!groups) throw new AppError('Unknown settings scope', 500);
  const forceRefresh = options === true || Boolean(options?.forceRefresh);
  const cached = scopedResults.get(scope);
  if (!forceRefresh && cached?.db === db && cached.expiresAt > Date.now()) return cached.value;
  try {
    const raw = await readGroupedSettings(db, defaults, { groups, forceRefresh });
    const normalized = normalizeStoredSite({ ...defaults, ...raw });
    normalized.display_mode = normalizeDisplayMode(normalized.display_mode, defaults.display_mode);
    normalized.preferred_theme = normalizePreferredTheme(normalized.preferred_theme);
    normalized.default_language = normalizeDefaultLanguage(normalized.default_language);
    if (groups.includes('settings.security') && !isValidJwtSecret(normalized.jwt_secret)) {
      normalized.jwt_secret = await ensureGroupedJwtSecret(db, generateRandomSecret(32));
    }
    const result = {};
    copyFields(result, normalized, groups.flatMap(group => SETTINGS_GROUPS[group]));
    scopedResults.set(scope, { db, value: result, expiresAt: Date.now() + SITE_SETTINGS_CACHE_TTL_MS });
    if (!lastKnownScoped.has(db)) lastKnownScoped.set(db, new Map());
    lastKnownScoped.get(db).set(scope, result);
    return result;
  } catch (error) {
    const previous = lastKnownScoped.get(db)?.get(scope);
    logError('settings', 'settings.scope.load_failed', 'Functional settings read failed', error, { scope, fallback: !!previous }, previous ? 'warn' : 'error');
    if (previous) return previous;
    throw new AppError('Site settings unavailable', 503);
  }
}

export async function loadSiteSettings(db, options = {}) {
  const forceRefresh = options === true || Boolean(options && options.forceRefresh);
  const now = Date.now();
  if (!forceRefresh && cachedSiteSettingsDb === db && cachedSiteSettings && now < siteSettingsCacheExpiry) {
    debug('Settings缓存命中');
    return cachedSiteSettings;
  }
  debug('Settings缓存更新');

  const result = { ...defaults };
  let siteOptions = null;

  try {
    siteOptions = await readGroupedSettings(db, defaults, { forceRefresh });
    copyFields(result, siteOptions, SITE_FIELDS);
    if (!isValidJwtSecret(result.jwt_secret)) {
      result.jwt_secret = await ensureGroupedJwtSecret(db, generateRandomSecret(32));
    }
    normalizeStoredSite(result);
  } catch (e) {
    // Authentication policy must never fall back to the public defaults during an outage.
    const previous = db && lastKnownSiteSettings.get(db);
    logError('settings', 'settings.load.failed', previous ? 'Settings read failed; using last known policy' : 'Settings unavailable; protected access remains closed',
      e, { fallback: !!previous }, previous ? 'warn' : 'error');
    if (previous) return previous;
    throw new AppError('Site settings unavailable', 503);
  }

  cachedSiteSettings = result;
  cachedSiteSettingsDb = db;
  if (db) lastKnownSiteSettings.set(db, result);
  siteSettingsCacheExpiry = now + SITE_SETTINGS_CACHE_TTL_MS;
  return result;
}

export function clearSiteSettingsCache() {
  cachedSiteSettings = null;
  cachedSiteSettingsDb = null;
  siteSettingsCacheExpiry = 0;
  scopedResults.clear();
}

export async function loadAppearanceOptions(db) {
  const now = Date.now();
  if (cachedAppearanceDb === db && cachedAppearanceOptions && now < appearanceOptionsCacheExpiry) {
    debug('Appearance缓存命中');
    return cachedAppearanceOptions;
  }
  debug('Appearance缓存更新');

  const result = {};
  copyFields(result, defaults, APPEARANCE_FIELDS);
  let appearanceOptions = null;

  try {
    appearanceOptions = await readGroupedSettings(db, defaults, { groups: SETTINGS_SCOPES.appearance });
    copyFields(result, appearanceOptions, APPEARANCE_FIELDS);
    result.display_mode = normalizeDisplayMode(result.display_mode, defaults.display_mode);
    result.preferred_theme = normalizePreferredTheme(result.preferred_theme);
    result.default_language = normalizeDefaultLanguage(result.default_language);
  } catch (e) {
    logError('settings', 'appearance.load.failed', 'Appearance settings read failed', e);
  }

  cachedAppearanceOptions = result;
  cachedAppearanceDb = db;
  appearanceOptionsCacheExpiry = now + SITE_SETTINGS_CACHE_TTL_MS;
  return result;
}

export function clearAppearanceSettingsCache() {
  cachedAppearanceOptions = null;
  cachedAppearanceDb = null;
  appearanceOptionsCacheExpiry = 0;
}

export function isValidThemeOptions(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function saveThemeOptions(db, themeOptions) {
  if (!isValidThemeOptions(themeOptions)) throw new AppError('Invalid theme options', 400);
  await saveSettings(db, { theme_options: themeOptions });
  return themeOptions;
}

export async function loadSettings(db) {
  const [siteSettings, appearanceOptions] = await Promise.all([
    loadSiteSettings(db),
    loadAppearanceOptions(db)
  ]);
  return { ...defaults, ...siteSettings, ...appearanceOptions };
}

function normalizeStoredSite(siteOptions) {
  siteOptions.tg_notify = normalizeTgNotify(siteOptions.tg_notify);
  siteOptions.expire_reminder = normalizeExpireReminder(siteOptions.expire_reminder);
  siteOptions.long_history_points = normalizeLongHistoryPoints(siteOptions.long_history_points);
  siteOptions.resource_alert_rules = normalizeResourceAlertRules(siteOptions.resource_alert_rules);
  siteOptions.show_three_net_details = normalizeBooleanSetting(siteOptions.show_three_net_details, defaults.show_three_net_details);
  siteOptions.wss_report_enabled = normalizeBooleanSetting(siteOptions.wss_report_enabled, defaults.wss_report_enabled);
  siteOptions.frontend_ws_timeout_minutes = normalizeFrontendWsTimeoutMinutes(siteOptions.frontend_ws_timeout_minutes);
  siteOptions.notification_webhook_enabled = normalizeBooleanSetting(siteOptions.notification_webhook_enabled);
  siteOptions.notification_webhook_method = normalizeNotificationWebhookMethod(siteOptions.notification_webhook_method);
  siteOptions.notification_webhook_format = normalizeNotificationWebhookFormat(siteOptions.notification_webhook_format);
  siteOptions.notification_webhook_headers = normalizeNotificationWebhookHeaders(siteOptions.notification_webhook_headers);
  siteOptions.notification_webhook_body = normalizeNotificationWebhookBody(siteOptions.notification_webhook_body);
  siteOptions.notification_template = normalizeNotificationTemplate(siteOptions.notification_template);
  siteOptions.notification_timezone = normalizeNotificationTimezone(siteOptions.notification_timezone);
  siteOptions.notification_language = normalizeNotificationLanguage(siteOptions.notification_language);
  siteOptions.expire_notification_time = normalizeExpireNotificationTime(siteOptions.expire_notification_time);
  siteOptions.traffic_alert_threshold = normalizeTrafficAlertThreshold(siteOptions.traffic_alert_threshold);
  siteOptions.auto_register_enabled = normalizeBooleanSetting(siteOptions.auto_register_enabled);
  siteOptions.auto_register_default_group = String(siteOptions.auto_register_default_group || 'Default').trim().slice(0, 50) || 'Default';

  return siteOptions;
}

// The public/admin API stays flat. Only the persistence layout is grouped.
export async function saveSettings(db, updates) {
  const groups = [...new Set(Object.keys(updates).map(field => FIELD_SETTINGS_GROUP[field]).filter(Boolean))];
  const existing = await readGroupedSettings(db, defaults, { groups });
  const siteOptions = {};
  const merged = { ...defaults, ...existing, ...updates };
  copyFields(siteOptions, merged, SITE_FIELDS);
  normalizeStoredSite(siteOptions);
  const patch = {};
  for (const field of SITE_FIELDS) if (updates[field] !== undefined) patch[field] = siteOptions[field];
  for (const field of APPEARANCE_FIELDS) if (updates[field] !== undefined) patch[field] = updates[field];
  if (patch.display_mode !== undefined) patch.display_mode = normalizeDisplayMode(patch.display_mode, defaults.display_mode);
  if (patch.preferred_theme !== undefined) patch.preferred_theme = normalizePreferredTheme(patch.preferred_theme);
  if (patch.default_language !== undefined) patch.default_language = normalizeDefaultLanguage(patch.default_language);
  if (patch.theme_options !== undefined && !isValidThemeOptions(patch.theme_options)) throw new AppError('Invalid theme options', 400);
  const changed = await saveGroupedSettings(db, patch, defaults);
  for (const [scope, owned] of Object.entries(SETTINGS_SCOPES)) {
    if (!owned.some(group => changed.includes(group))) continue;
    if (scopedResults.get(scope)?.db === db) scopedResults.delete(scope);
    lastKnownScoped.get(db)?.delete(scope);
  }
  if (Object.keys(patch).some(field => SITE_FIELDS.includes(field))) {
    lastKnownSiteSettings.delete(db);
    clearSiteSettingsCache();
  }
  clearAppearanceSettingsCache();
  return { ...siteOptions, ...Object.fromEntries(APPEARANCE_FIELDS.filter(field => merged[field] !== undefined).map(field => [field, merged[field]])), ...patch };
}

export async function saveSiteOptions(db, updates) {
  const patch = Object.fromEntries(SITE_FIELDS.filter(field => updates[field] !== undefined).map(field => [field, updates[field]]));
  return saveSettings(db, patch);
}

export async function getSettingByKey(db, key, returnBoolean = false) {
  const settings = await loadSiteSettings(db);
  if(returnBoolean){
    const value = String(settings[key] ?? '').trim().toLowerCase();
    if(['true', '1', 'yes', 'on'].includes(value)) return true;
    if(['false', '0', 'no', 'off', ''].includes(value)) return false;
  }
  return settings[key];
}

let isDebugEnabled = false;

export function setDebug(debug) {
  isDebugEnabled = debug === 1 || debug === '1' || debug === true;
}

export function debug(...args) {
  const emit = () => logEvent('system', 'diagnostic', String(args[0] || ''), args.length > 1 ? { details: args.slice(1) } : {}, 'debug');
  if (hasLogContext()) emit();
  else if (isDebugEnabled) withLogContext({}, emit, { DEBUG: true });
}
