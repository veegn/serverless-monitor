import { debug, migrateSettings } from '../utils/settings.js';
import { ensureServerSchema } from './ServerRepository.js';
import { ensureNotificationStateSchema } from './NotificationStateRepository.js';


export async function updateDatabase(db) {
  debug('开始执行数据库更新...');
  const results = [];
  
  try {
    await migrateSettings(db);
    results.push({ name: '设置按功能分组', success: true });
    const serversCols = await addServerColumns(db);
    results.push({ name: 'servers 表列更新', ...serversCols });
    await ensureNotificationStateSchema(db);
    results.push({ name: '通知运行状态独立存储', success: true });
    
    const cleanupServers = await cleanupServerExtraColumns(db);
    results.push({ name: 'servers 表多余字段清理', ...cleanupServers });
    
    // D1 存储 metrics 相关实现已完全移除，清理弃用的 metrics_history 与 metrics_history_old 表
    await db.prepare(`DROP TABLE IF EXISTS metrics_history`).run().catch(() => {});
    await db.prepare(`DROP TABLE IF EXISTS metrics_history_old`).run().catch(() => {});
    results.push({ name: '弃用 D1 metrics_history 表清理', success: true });
    
    const staleCleanup = await cleanupStaleSettings(db);
    results.push({ name: '废弃 settings key 清理', ...staleCleanup });
    
    const dropAggregated = await dropMetricsAggregatedTable(db);
    results.push({ name: '删除弃用的 metrics_aggregated 表', ...dropAggregated });
    
    // 删除弃用的 notification_deliveries 表
    await db.prepare(`DROP TABLE IF EXISTS notification_deliveries`).run();
    
    debug('✅ 数据库更新完成');
    
    return {
      success: true,
      message: 'databaseUpgradeSuccess',
      results
    };
  } catch (e) {
    debug('❌ 数据库更新失败:', e);
    return {
      success: false,
      message: 'databaseUpgradeFailed',
      error: e.message,
      results
    };
  }
}

export async function addServerColumns(db) {
  return ensureServerSchema(db);
}

async function cleanupServerExtraColumns(db) {
  const result = await ensureServerSchema(db);
  return { ...result, cleaned: result.removedColumns.length };
}

export async function addHistoryColumns(db) {
  // D1 存储 metrics 相关实现已完全移除，不再向 D1 增加历史指标列
  return { success: true, added: 0 };
}

async function dropMetricsAggregatedTable(db) {
  debug('开始删除弃用的 metrics_aggregated 表...');
  try {
    const { results: tables } = await db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='metrics_aggregated'`
    ).all();
    
    if (tables.length === 0) {
      return { success: true, dropped: 0, message: '无需删除（表不存在）' };
    }
    
    await db.prepare(`DROP TABLE metrics_aggregated`).run();
    debug('✅ 已删除 metrics_aggregated 表');
    return { success: true, dropped: 1, message: '已删除 metrics_aggregated 表' };
  } catch (e) {
    debug('删除 metrics_aggregated 表失败:', e);
    return { success: false, error: e.message };
  }
}

export async function cleanupStaleSettings(db) {
  debug('开始清理废弃的 settings key...');
  await migrateSettings(db);
  try {
    const stalePrefixes = ['last_write_%'];
    const staleExact = [
      'theme',
      'custom_css',
      'auto_reset_traffic',
      'last_aggregated_to_120',
      'last_aggregated_to_240',
      'last_aggregated_to_480',
      'last_aggregated_to_960',
      'last_aggregated_to_1920',
      'site_title',
      'admin_title',
      'custom_head',
      'custom_script',
      'custom_bg',
      'favicon',
      'is_public',
      'show_price',
      'show_expire',
      'show_tf',
      'show_time',
      'show_long_history',
      'tg_notify',
      'tg_bot_token',
      'tg_chat_id',
      'last_aggregated_to',
      'history_id_optimized',
      'last_cleanup',
      'expire_reminder',
      'traffic_report_last_daily',
      'traffic_report_last_weekly',
      'traffic_report_last_monthly'
    ];
    const staleKeysWhere = stalePrefixes.map(() => `key LIKE ?`).concat(staleExact.map(() => `key = ?`)).join(' OR ');
    const staleBindings = [...stalePrefixes, ...staleExact];
    const { meta: cleanupResult } = await db.prepare(
      `DELETE FROM settings WHERE ${staleKeysWhere}`
    ).bind(...staleBindings).run();
    if (cleanupResult.changes > 0) {
      debug(`已清理 ${cleanupResult.changes} 个废弃的 settings key`);
    }
    return { success: true, cleaned: cleanupResult.changes };
  } catch (e) {
    debug('清理废弃 settings key 失败:', e);
    return { success: false, error: e.message };
  }
}
