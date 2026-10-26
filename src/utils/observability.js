import { AsyncLocalStorage } from 'node:async_hooks';

export const LogLevel = Object.freeze({ DEBUG: 'debug', INFO: 'info', WARN: 'warn', ERROR: 'error' });
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const contexts = new AsyncLocalStorage();
const MAX_LOG_BYTES = 12 * 1024;
const REDACTED = '[redacted]';
const SECRET_KEY = /secret|password|passwd|token|authorization|cookie|api.?key|private.?key|webhook.?url/i;
const BODY_KEY = /^(?:body|requestBody|responseBody|payload|metrics|samples|settings|headers)$/i;
const CORE_FIELDS = ['runtime', 'trigger', 'requestId', 'rayId', 'connectionId', 'serverId', 'reportId',
  'transport', 'method', 'path', 'status', 'durationMs', 'attempt', 'task', 'cron'];
const PRIORITY_FIELDS = [...CORE_FIELDS, 'error'];
const PRIORITY_SET = new Set(PRIORITY_FIELDS);

function minimumLevel(env) {
  const configured = String(env?.LOG_LEVEL || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LEVELS, configured)) return configured;
  return env?.DEBUG === true || env?.DEBUG === 1 || env?.DEBUG === '1' ? 'debug' : 'info';
}

export function withLogContext(fields, callback, env) {
  const parent = contexts.getStore();
  return contexts.run({ fields: { ...parent?.fields, ...fields },
    minimum: env ? minimumLevel(env) : parent?.minimum || 'info',
    slowMs: env ? Math.max(1, Math.min(60_000, Number(env.LOG_SLOW_MS) || 1000)) : parent?.slowMs || 1000,
    counts: { warnings: 0, errors: 0 }, parent,
    response: parent?.response || { logged: false } }, callback);
}

export function setLogContext(fields) {
  const context = contexts.getStore();
  if (context) Object.assign(context.fields, fields);
}

export function getLogContext() { return { ...contexts.getStore()?.fields }; }
export function getLogCounts() { return { ...(contexts.getStore()?.counts || { warnings: 0, errors: 0 }) }; }
export function hasLogContext() { return !!contexts.getStore(); }
export function getSlowThresholdMs() { return contexts.getStore()?.slowMs || 1000; }
export function markResponseLogged() { if (contexts.getStore()) contexts.getStore().response.logged = true; }
export function wasResponseLogged() { return contexts.getStore()?.response.logged === true; }
export function isLogEnabled(level = 'info') { return LEVELS[level] >= LEVELS[contexts.getStore()?.minimum || 'info']; }

function validId(value) { return typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,100}$/.test(value) ? value : null; }
export function requestLogContext(request, runtime = 'worker') {
  const rayId = validId(request.headers.get('cf-ray'));
  const forwardedId = runtime === 'durable-object' && validId(request.headers.get('X-CFSM-Request-ID'));
  const attempt = Number(request.headers.get('X-CFSM-Attempt'));
  return { runtime, trigger: 'fetch', requestId: forwardedId || rayId || crypto.randomUUID(),
    transport: request.headers.get('Upgrade')?.toLowerCase() === 'websocket' ? 'wss' : 'http',
    ...(rayId ? { rayId } : {}), method: request.method, path: new URL(request.url).pathname,
    ...(runtime === 'durable-object' && attempt >= 1 && attempt <= 3 ? { attempt } : {}) };
}

export function correlationHeaders(extra = {}) {
  const requestId = getLogContext().requestId;
  return { ...extra, ...(requestId ? { 'X-CFSM-Request-ID': requestId } : {}) };
}

function cleanText(value, limit = 1000, multiline = false) {
  return String(value)
    .replace(/https?:\/\/[^\s<>"']+/gi, raw => {
      try { const url = new URL(raw); return `${url.protocol}//${url.host}${url.pathname === '/' ? '/' : '/[redacted]'}${url.search ? '?[redacted]' : ''}`; }
      catch { return '[redacted-url]'; }
    })
    .replace(/\bBearer\s+[^\s,;"']+/gi, `Bearer ${REDACTED}`)
    .replace(/\beyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, REDACTED)
    .replace(/(["']?(?:[\w-]*(?:secret|password|passwd|token|api[_-]?key|authorization|cookie))["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, `$1${REDACTED}`)
    .replace(multiline ? /[\u0000-\u0008\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .slice(0, limit);
}

function safeValue(value, key = '', depth = 0, seen = new WeakSet(), budget = { remaining: 300 }) {
  if (--budget.remaining < 0) return '[truncated]';
  if (SECRET_KEY.test(key) || BODY_KEY.test(key)) return REDACTED;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return cleanText(value, key === 'stack' ? 2500 : 1000, key === 'stack');
  if (value instanceof Error) return errorDetails(value, depth, seen);
  if (typeof value !== 'object') return cleanText(value);
  if (seen.has(value)) return '[circular]';
  if (depth >= 4) return '[truncated]';
  seen.add(value);
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : 'Invalid Date';
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return `[binary: ${value.byteLength} bytes]`;
  if (Array.isArray(value)) return value.slice(0, 20).map(item => safeValue(item, '', depth + 1, seen, budget));
  const result = {};
  const keys = [...PRIORITY_FIELDS.filter(field => Object.prototype.hasOwnProperty.call(value, field)),
    ...Object.keys(value).filter(field => !PRIORITY_SET.has(field))].slice(0, 40);
  for (const field of keys) {
    if (budget.remaining <= 0) { result._truncated = true; break; }
    if (field === '__proto__' || field === 'constructor') continue;
    try { const item = safeValue(value[field], field, depth + 1, seen, budget); if (item !== undefined) result[field] = item; }
    catch { result[field] = '[unavailable]'; }
  }
  return result;
}

function errorDetails(error, depth = 0, seen = new WeakSet()) {
  if (error === null || error === undefined) return undefined;
  if (typeof error !== 'object') return { name: 'Error', message: cleanText(error) };
  if (seen.has(error)) return { message: '[circular]' };
  seen.add(error);
  const result = { name: cleanText(error.name || 'Error', 100), message: cleanText(error.message || String(error)) };
  if (error.code !== undefined) result.code = safeValue(error.code, 'code', 0, seen);
  if (error.stack) result.stack = cleanText(String(error.stack).split('\n').slice(0, 7).join('\n'), 2500, true);
  if (error.cause && depth < 2) result.cause = errorDetails(error.cause, depth + 1, seen);
  return result;
}

function readableMessage(component, message, fields) {
  const labels = [];
  if (typeof fields.serverId === 'string') labels.push(`node=${fields.serverId.slice(0, 40)}`);
  if (typeof fields.reportId === 'string') labels.push(`report=${fields.reportId.slice(0, 32)}`);
  if (!fields.serverId && typeof fields.connectionId === 'string') labels.push(`connection=${fields.connectionId.slice(0, 12)}`);
  if (fields.status !== undefined && !message.includes(`→ ${fields.status}`)) labels.push(`status=${fields.status}`);
  if (fields.durationMs !== undefined && !message.includes(`${fields.durationMs}ms`)) labels.push(`${fields.durationMs}ms`);
  if (fields.attempt !== undefined) labels.push(`attempt=${fields.attempt}`);
  if (fields.scope !== undefined) labels.push(`scope=${String(fields.scope).slice(0, 40)}`);
  if (fields.subscribers !== undefined) labels.push(`subscribers=${fields.subscribers}`);
  if (typeof fields.agentVersion === 'string' && fields.agentVersion) labels.push(`v=${fields.agentVersion.slice(0, 24)}`);
  if (component === 'http' && fields.method && fields.path && !message.includes(fields.path)) labels.push(`${fields.method} ${fields.path}`);
  return cleanText(`[${component}] ${message}${labels.length ? ` | ${labels.join(' ')}` : ''}`, 1000);
}

// One JSON object, including a readable message, lets Workers Logs index each field.
// Logging must never change report ACKs or throw while handling another failure.
export function logEvent(component, event, message, metadata = {}, level = 'info') {
  level = String(level).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(LogLevel, String(level).toUpperCase())) level = 'info';
  if (!isLogEnabled(level)) return false;
  try {
    component = cleanText(component, 64); event = cleanText(event, 100);
    const contextFields = getLogContext();
    const fields = { ...safeValue(contextFields), ...safeValue(metadata) };
    // Explicit undefined clears inherited attribution for aggregate events.
    for (const key of Object.keys(contextFields)) {
      const descriptor = metadata && Object.getOwnPropertyDescriptor(metadata, key);
      if (descriptor && 'value' in descriptor && descriptor.value === undefined) delete fields[key];
    }
    let entry = { ...fields, source: 'cfsm', schemaVersion: 1, component, event, level,
      message: readableMessage(component, cleanText(message, 700), fields), timestamp: new Date().toISOString() };
    if (new TextEncoder().encode(JSON.stringify(entry)).byteLength > MAX_LOG_BYTES) {
      entry = { source: entry.source, schemaVersion: entry.schemaVersion, component, event, level,
        message: cleanText(entry.message, 600), timestamp: entry.timestamp, truncated: true,
        ...Object.fromEntries(CORE_FIELDS.filter(key => entry[key] !== undefined).map(key => [key,
          typeof entry[key] === 'number' || typeof entry[key] === 'boolean' ? entry[key] : cleanText(entry[key], 96)])),
        ...(entry.error ? { error: { name: cleanText(entry.error.name || 'Error', 100), message: cleanText(entry.error.message || '', 512),
          ...(entry.error.code !== undefined ? { code: typeof entry.error.code === 'number' ? entry.error.code : cleanText(entry.error.code, 128) } : {}) } } : {}) };
    }
    console[level](entry);
    for (let context = contexts.getStore(); context; context = context.parent) {
      if (level === 'warn') context.counts.warnings++;
      if (level === 'error') context.counts.errors++;
    }
    return true;
  } catch { return false; }
}

export function logError(component, event, message, error, metadata = {}, level = 'error') {
  level = String(level).toLowerCase();
  if (!isLogEnabled(level)) return false;
  try {
    const details = errorDetails(error);
    if (level === 'warn' && error?.name === 'AppError' && error.code < 500) delete details.stack;
    return logEvent(component, event, message, { ...metadata, error: details }, level);
  } catch { return logEvent(component, event, message, { ...metadata, error: { message: 'Error details unavailable' } }, level); }
}

// Keep the existing helper API for callers while using the common schema.
export function logWssEvent(category, action, message, metadata = {}, level = 'info') {
  return logEvent(category.toLowerCase(), `${category.toLowerCase()}.${action.toLowerCase()}`,
    message, { transport: 'wss', category, action, ...metadata }, level);
}
export function logAgentConnect(metadata = {}) {
  logWssEvent('Agent', 'CONNECT', 'Agent WebSocket connected; awaiting authentication', metadata);
}
export function logAgentAuth(metadata = {}, success = true, reason = '') {
  logWssEvent('Agent', success ? 'AUTH_OK' : 'AUTH_FAIL', success ? 'Agent authenticated' : 'Agent authentication rejected',
    { ...metadata, ...(reason ? { reason } : {}), outcome: success ? 'success' : 'rejected' }, success ? 'info' : 'warn');
}
export function logAgentReport(metadata = {}) {
  logWssEvent('Agent', 'REPORT', 'Agent report committed', metadata, 'debug');
}
export function logModeTransition(metadata = {}) {
  const targetMode = metadata.isFrontendActive ? 'REALTIME' : 'IDLE_BATCH';
  logWssEvent('Mode', 'HINT', `Reporting mode changed to ${targetMode}`, { ...metadata, targetMode });
}
export function logFrontendConnect(metadata = {}) { logWssEvent('Frontend', 'CONNECT', 'Frontend WebSocket connected', metadata); }
export function logFrontendSubscribe(metadata = {}) { logWssEvent('Frontend', 'SUBSCRIBE', 'Frontend subscription updated', metadata); }
export function logFrontendDisconnect(metadata = {}) {
  logWssEvent('Frontend', 'DISCONNECT', 'Frontend WebSocket disconnected', metadata,
    metadata.code && ![1000, 1001].includes(metadata.code) ? 'warn' : 'info');
}
export function logMetricsPersist(metadata = {}, success = true, error = null) {
  if (!success) return logError('storage', 'metrics.commit.failed', 'Metrics commit failed; Agent must retry', error, { ...metadata, persisted: false });
  return logEvent('storage', 'metrics.committed', 'Metrics committed', { ...metadata, persisted: true }, 'debug');
}

// Counters only: no timers or storage writes, so WebSocket hibernation still works.
export class ReportLogSummary {
  constructor() { this.window = null; }
  record({ serverIds, sampleCount, duplicate = false, durationMs = 0, transport = 'http', now = Date.now() }) {
    const bucket = Math.floor(now / 60_000) * 60_000;
    if (this.window && this.window.start !== bucket) this.flush();
    const window = this.window ||= { start: bucket, end: now, reports: 0, samples: 0, duplicates: 0,
      nodes: new Set(), nodesTruncated: false, duration: 0, maxDuration: 0, http: 0, wss: 0 };
    window.end = now; window.reports++; window.samples += sampleCount; window.duplicates += Number(duplicate);
    window.duration += durationMs; window.maxDuration = Math.max(window.maxDuration, durationMs);
    window[transport === 'wss' ? 'wss' : 'http']++;
    for (const serverId of serverIds) {
      if (window.nodes.size < 1000 || window.nodes.has(serverId)) window.nodes.add(serverId);
      else window.nodesTruncated = true;
    }
  }
  flush() {
    const window = this.window;
    if (!window) return;
    this.window = null;
    logEvent('storage', 'metrics.summary',
      `Metrics committed | reports=${window.reports} samples=${window.samples} nodes${window.nodesTruncated ? '>=' : '='}${window.nodes.size} duplicates=${window.duplicates}`,
      { requestId: undefined, rayId: undefined, method: undefined, path: undefined, serverId: undefined, reportId: undefined,
        connectionId: undefined, transport: undefined, attempt: undefined, role: undefined, scope: undefined,
        windowStart: new Date(window.start).toISOString(), windowEnd: new Date(window.end).toISOString(),
        reportCount: window.reports, sampleCount: window.samples, duplicateCount: window.duplicates,
        serverCount: window.nodes.size, serverCountTruncated: window.nodesTruncated,
        httpReports: window.http, wssReports: window.wss, persisted: true,
        avgDurationMs: Math.round(window.duration / window.reports), maxDurationMs: window.maxDuration });
  }
}
