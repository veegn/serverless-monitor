/**
 * 缓存管理模块
 * 集中管理所有内存缓存，包括：
 * - 服务器列表缓存
 * - 服务器详情（复用服务器列表缓存）
 * - 最新指标缓存
 * - 历史指标缓存
 * - 站点设置缓存
 */

import { clearAppearanceSettingsCache, clearSiteSettingsCache, debug } from './settings.js';
import { historySampling } from './historyPolicy.js';
import { ensureServerSchema, serverQuery } from '../database/ServerRepository.js';

const SERVERS_LIST_TTL = 120 * 1000;
const serversListCaches = new Map();

const metricsHistoryCache = new Map();

const serverDetailCache = new Map();

export function getCacheDuration(hours, points = null) {
  return Math.max(10_000, Math.min(20 * 60_000, historySampling(hours, points).intervalMs));
}

function filterServersByHidden(servers, includeHidden) {
  if (!servers || servers.length === 0) return [];
  if (includeHidden) {
    return [...servers];
  }
  return servers.filter(s => s.is_hidden !== 1 && s.is_hidden !== '1');
}

export async function getAllServers(db, includeHidden = true, { scope = 'full' } = {}) {
  const now = Date.now();
  const serversListCache = serversListCaches.get(scope);
  
  if (serversListCache?.db === db && now - serversListCache.time < SERVERS_LIST_TTL) {
    debug('服务器列表缓存命中');
    return filterServersByHidden(serversListCache.data, includeHidden);
  }

  try {
    await ensureServerSchema(db);
    const { results } = await db.prepare(serverQuery(scope)).all();
    serversListCaches.set(scope, { db, data: results, time: now });
    debug('服务器列表缓存更新');
    return filterServersByHidden(results, includeHidden);
  } catch (e) {
    debug('获取服务器列表失败:', e);
    if (serversListCache?.db !== db) throw e;
    return filterServersByHidden(serversListCache.data, includeHidden);
  }
}

export function clearServersListCache() {
  serversListCaches.clear();
  serverDetailCache.clear();
}

export function clearServerDetailCache() {
  serverDetailCache.clear();
}

// 按 id 就地打补丁更新已缓存的服务器详情字段（不创建条目、不清全表）
// 用于运行时状态列（如 traffic_alert_state）写回后刷新缓存，避免 TTL 内读到旧值重复触发。
export function patchServerDetailCache(id, fields) {
  for (const entry of serverDetailCache.values()) {
    if (entry.id === id && ['agent', 'full'].includes(entry.scope) && entry.data) Object.assign(entry.data, fields);
  }
}

export async function getServerDetail(db, id, includeHidden = false, { scope = 'full' } = {}) {
  const now = Date.now();
  const key = `${scope}:${id}`;
  const entry = serverDetailCache.get(key);
  const cached = entry?.db === db ? entry : null;
  
  if (cached) {
    if (now - cached.time < SERVERS_LIST_TTL) {
      debug('服务器详情缓存命中');
      const server = cached.data;
      
      if (!server) {
        return null;
      }
      
      if (!includeHidden && (server.is_hidden === 1 || server.is_hidden === '1')) {
        return null;
      }
      
      return { ...server };
    }
    
    serverDetailCache.delete(key);
  }
  
  let server;
  let degraded = false;
  try {
    await ensureServerSchema(db);
    server = await db.prepare(serverQuery(scope, true)).bind(id).first();
  } catch (e) {
    // 与 getAllServers 一致：D1 异常时回退上一次已知结果，不把基础设施抖动放大成业务失败。
    if (!cached) throw e;
    debug('服务器详情查询失败，回退缓存值:', e);
    server = cached.data;
    degraded = true;
  }

  if (!degraded) {
    serverDetailCache.set(key, { db, id, scope, data: server, time: now });
    debug('服务器详情缓存更新');
  }
  
  if (!server) {
    return null;
  }
  
  if (!includeHidden && (server.is_hidden === 1 || server.is_hidden === '1')) {
    return null;
  }
  
  return { ...server };
}

export async function checkServerExists(db, id) {
  const server = await getServerDetail(db, id, true);
  return !!server;
}

function getCacheKey(serverId, hours, columns, samplePoints = null) {
  const sortedColumns = columns.split(',').sort().join(',');
  const sampleSuffix = samplePoints ? `:points=${samplePoints}` : '';
  return `${serverId}:${hours}:${sortedColumns}${sampleSuffix}`;
}

export function getMetricsHistoryCache(serverId, hours, columns, samplePoints = null) {
  const key = getCacheKey(serverId, hours, columns, samplePoints);
  const entry = metricsHistoryCache.get(key);
  if (entry && Date.now() >= entry.expiresAt) {
    metricsHistoryCache.delete(key);
    return null;
  }
  return entry;
}

export function setMetricsHistoryCache(serverId, hours, columns, data, samplePoints = null) {
  const key = getCacheKey(serverId, hours, columns, samplePoints);
  const now = Date.now();
  for (const [cachedKey, entry] of metricsHistoryCache) {
    if (entry.expiresAt <= now) metricsHistoryCache.delete(cachedKey);
  }
  metricsHistoryCache.delete(key);
  metricsHistoryCache.set(key, { data, timestamp: now, expiresAt: now + getCacheDuration(hours, samplePoints) });
  while (metricsHistoryCache.size > 512) metricsHistoryCache.delete(metricsHistoryCache.keys().next().value);
}

export function clearMetricsHistoryCache(serverId) {
  for (const key of metricsHistoryCache.keys()) {
    if (key.startsWith(`${serverId}:`)) {
      metricsHistoryCache.delete(key);
    }
  }
}

export function clearAllCaches() {
  clearServersListCache();
  metricsHistoryCache.clear();
  clearSiteSettingsCache();
  clearAppearanceSettingsCache();
}
