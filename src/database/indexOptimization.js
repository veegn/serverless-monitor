import { saveSiteOptions, debug, getSettingByKey } from '../utils/settings.js';
import { getAllServers, clearServersListCache } from '../utils/cache.js';

export const HISTORY_MAX_PARTITION_ID = 900;

// 确保servers历史记录分区优化
export async function ensureServerOptimization(db) {
  const optimized = await getSettingByKey(db, 'servers_optimized', true);
  const { results: columns = [] } = await db.prepare(`PRAGMA table_info(servers)`).all();
  const existingColumns = new Set(columns.map(column => column.name));
  let addedColumns = 0;

  if (!existingColumns.has('history_partition_id')) {
    await db.prepare(`ALTER TABLE servers ADD COLUMN history_partition_id INTEGER DEFAULT 0`).run();
    addedColumns++;
    debug('history_partition_id 字段已添加');
  }

  if (!existingColumns.has('timestamp')) {
    await db.prepare(`ALTER TABLE servers ADD COLUMN timestamp INTEGER DEFAULT 0`).run();
    addedColumns++;
    debug('timestamp 字段已添加');
  }

  if (addedColumns > 0) {
    clearServersListCache();
  }

  if (optimized && addedColumns === 0) {
    debug('服务器历史记录分区已优化');
    return { success: true, assigned: 0 };
  }

  const { results: servers = [] } = await db.prepare(`
    SELECT id, history_partition_id
    FROM servers
    ORDER BY id ASC
  `).all();
  
  if (servers.length === 0) {
    debug('没有服务器需要优化');
    await saveSiteOptions(db, { servers_optimized: 'true' });
    return { success: true, assigned: 0 };
  }

  if (servers.length > HISTORY_MAX_PARTITION_ID) {
    throw new Error(`No available history partition id; max is ${HISTORY_MAX_PARTITION_ID}`);
  }

  let updated = 0;

  for (let i = 0; i < servers.length; i++) {
    const server = servers[i];
    const partitionId = i + 1;
    if (Number(server.history_partition_id) === partitionId) {
      continue;
    }

    try {
      await db.prepare(
        `UPDATE servers SET history_partition_id = ? WHERE id = ?`
      ).bind(partitionId, server.id).run();
      updated++;
    } catch (e) {
      debug(`Failed to update server ${server.id} history_partition_id: ${e.message}`);
    }
  }

  // 清空服务器列表的缓存
  clearServersListCache();

  debug(`服务器历史记录分区优化完成，更新了 ${updated} 条记录`);
  
  // 标记为已优化
  await saveSiteOptions(db, { servers_optimized: 'true' });

  return { success: true, assigned: updated };
}

// 获取下一个可用的历史记录分区ID
export async function getNextServerHistoryPartitionId(db) {
  const servers = await getAllServers(db, true);
  const usedIds = new Set(
    servers
      .map(s => Number(s.history_partition_id))
      .filter(id => Number.isInteger(id) && id > 0 && id <= HISTORY_MAX_PARTITION_ID)
  );
  
  for (let id = 1; id <= HISTORY_MAX_PARTITION_ID; id++) {
    if (!usedIds.has(id)) return id;
  }
  debug(`No available history partition id`);
  throw new Error(`No available history partition id`);
}
