# 本地验证

使用 Node.js 22.19+（CI 使用 Node.js 22）。

```bash
npm ci
npm run test:all
npm run build:frontend
```

`npm test` 自动发现所有 `test/*.test.js`；`test:all` 还执行 Agent 配置协议脚本。

## 存储与运行时测试

- `reliability.test.js`：权限故障策略、离线/恢复通知、失败回滚、重试、隐藏节点隔离、请求体限制。
- `runtime.test.js`：通过 Miniflare/workerd 运行真实 Worker、D1、SQLite Durable Object 和 WebSocket，验证 HTTP/WSS 确认、存储失败后重试、跨进程重启、旧快照迁移与订阅权限。
- `history-query.test.js`：7 天保留、跨周查询、点数上限、分批过期清理。
- `metrics-compression.test.js`：九个时间范围、样本加权均值与峰值、字段精度、稀疏曲线、GPU、小时拆块与旧结构迁移。
- `metrics-runtime.test.js`：真实 workerd 读写行计量、跨小时提交、去重及归档/过期清理。
- `observability.test.js`：日志分级、并发上下文隔离、凭证脱敏、长度限制、分钟汇总和错误/慢请求语义。运行时测试另验证 Worker→DO 请求关联及 WSS 跨回调连接 ID。
- `latest-metrics-all.test.js` / `latest-timestamps.test.js`：最新报告、超过单次 SQL 绑定上限的批量查询、持久化心跳。
- `dashboard-latency-window.test.js`：首页 3 小时、20 个延迟窗口及空窗口保留。
- `helpers/sql-storage.js`：使用 Node 内置 SQLite 驱动验证 SQL 与事务；运行时测试另用 workerd 的真实 Storage API。

运行时测试只操作临时目录与本地资源，结束后自动清理，不连接线上数据库或部署。

```bash
node --test test/reliability.test.js test/runtime.test.js
```

## 手动开发

```bash
npm run dev
npm run dev:frontend
```

先访问 `/api/config` 初始化 D1 配置表，然后使用测试 Agent 或 `mock-sender.sh` 向本地 `/update` 上报。历史来自 DO SQLite，`generate-sql.js` 生成的旧 D1 历史数据不再作为当前面板的数据源。

升级保留现有 DO namespace；旧 `durable_history_v1:*`、最新报告快照与分钟 SQL 数据按需迁入压缩小时块。旧版本已经删除的数据不会重新生成。`npm run benchmark:metrics` 可复现本地 workerd 的载荷压缩率和行计量，详见 [采样设计](../docs/metrics-storage.md)。
