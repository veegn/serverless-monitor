import { DatabaseService } from './DatabaseService.js';
import { DEFAULT_LONG_HISTORY_POINTS } from '../utils/settings.js';

export { DatabaseService };

export function clearDashboardLatencyHistoryCache() {
  DatabaseService.clearDashboardLatencyHistoryCache();
}

export async function initDatabase(db) {
  return new DatabaseService(db).init();
}

export async function clearHistory(db) {
  return new DatabaseService(db).clearHistory();
}

export async function weeklyCleanup(db) {
  return new DatabaseService(db).weeklyCleanup();
}

export function buildHistoryInsertStatement(db, serverId, historyPartitionId, metrics = {}, regionCode = '', timestamp = null, agentVersion = '') {
  return new DatabaseService(db).buildHistoryInsertStatement(serverId, historyPartitionId, metrics, regionCode, timestamp, agentVersion);
}

export async function saveMetricsHistory(db, serverId, historyPartitionId, metrics, regionCode = '', timestamp = null, agentVersion = '') {
  return new DatabaseService(db).saveMetricsHistory(serverId, historyPartitionId, metrics, regionCode, timestamp, agentVersion);
}

export async function saveMetricsHistoryBatch(db, serverId, historyPartitionId, samples = [], regionCode = '', agentVersion = '', baselineMetrics = null) {
  return new DatabaseService(db).saveMetricsHistoryBatch(serverId, historyPartitionId, samples, regionCode, agentVersion, baselineMetrics);
}

export async function getLatestMetrics(db, serverId, server = null) {
  return new DatabaseService(db).getLatestMetrics(serverId, server);
}

export async function getLatestMetricsForAllServers(db) {
  return new DatabaseService(db).getLatestMetricsForAllServers();
}

export async function getLatestTimestampsForAllServers(db) {
  return new DatabaseService(db).getLatestTimestampsForAllServers();
}

export async function getMetricsHistory(
  db,
  serverId,
  hours,
  columns,
  server = null,
  longHistoryPoints = DEFAULT_LONG_HISTORY_POINTS
) {
  return new DatabaseService(db).getMetricsHistory(serverId, hours, columns, server, longHistoryPoints);
}

export async function getDashboardLatencyHistory(db, servers, options = {}) {
  return new DatabaseService(db).getDashboardLatencyHistory(servers, options);
}
