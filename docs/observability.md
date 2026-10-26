# 日志格式与排障

Worker、Durable Object、HTTP/WSS 上报、定时任务和通知使用同一套结构化日志。每次 `console` 调用只传入一个包含 `message` 的 JSON 对象：主列表可读摘要，展开后按字段过滤。Cloudflare 对结构化日志的说明见 [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#logging-structured-json-objects)。

## 读一条日志

```json
{
  "source": "cfsm",
  "schemaVersion": 1,
  "component": "storage",
  "event": "metrics.commit.failed",
  "level": "error",
  "message": "[storage] Metrics commit failed; Agent must retry | node=node-a report=r-17 status=503 18ms attempt=2",
  "runtime": "durable-object",
  "trigger": "fetch",
  "transport": "http",
  "requestId": "example-request-id",
  "serverId": "node-a",
  "reportId": "r-17",
  "attempt": 2,
  "status": 503,
  "persisted": false,
  "durationMs": 18,
  "error": {
    "name": "Error",
    "message": "database or disk is full: SQLITE_FULL"
  }
}
```

`event` 是稳定事件名，`message` 用于浏览，`component` 区分模块。`runtime` 区分 Worker 和 DO；`durationMs` 为经过的墙钟时间，包含网络及存储等待，不等于 CPU 时间。异常包含名称、消息、错误码、有限长度的堆栈和原因链；预期的客户端 `AppError` 拒绝只记 warning，不输出堆栈。

Worker 的普通 HTTP 响应携带 `X-Request-ID`，允许的跨域前端也可以读取该响应头。内部 DO 请求和每次提交重试沿用此 ID；不把完整 URL、查询参数或整个请求头写入应用日志。上下文通过异步局部存储隔离，避免并发请求串用节点、请求 ID 或日志级别。

WSS 使用 `connectionId` 关联同一连接的握手、鉴权、上报和断开。每次消息回调另有自己的 `requestId`，而 `connectionId` 跨休眠回调保留；前端使用现有持久会话 ID，Agent 使用小型连接附件。升级响应 `101` 保持原 WebSocket 对象，不重新包装响应。

## 默认日志量与配置

默认 `info`：记录连接、鉴权成功、模式切换、通知结果、完成的小时维护和指标汇总。普通成功 HTTP 请求不重复记录应用访问日志，依赖平台 Invocation 日志；普通成功报告不逐条打印。慢操作、拒绝、降级、重试和失败按对应级别记录。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` |
| `LOG_SLOW_MS` | `1000` | 成功请求或指标提交超过该毫秒数时输出 warning；有效范围 1–60000 |
| `DEBUG` | 未启用 | 没有有效 `LOG_LEVEL` 时，`1`、`"1"`、`true` 启用 debug；保留既有 DEBUG 兼容行为 |

显式 `LOG_LEVEL` 优先。例如 `LOG_LEVEL=warn` 配合 `DEBUG=1` 仍只输出 warning/error。若只想打开详细日志，优先使用 `LOG_LEVEL=debug`。可通过 Cloudflare 环境配置或项目部署变量设置，排障后恢复 `info`。本次没有修改平台 `head_sampling_rate`。

`debug` 会显示每次 `metrics.committed`、成功 HTTP 请求以及缓存等诊断信息。不再每个请求打印 `DEBUG mode`，也不再为一次成功 WSS 报告同时打印“存储成功”和“报告成功”两条日志。

### 指标分钟汇总

DO 在内存中汇总报告，在后续上报跨越分钟边界时输出 `metrics.summary`；已有维护 Alarm 或 Agent 断开时也会刷新尚未输出的汇总。没有增加定时器、Alarm 或存储写入，因此不会为日志阻止 DO 休眠。

摘要示例：

```text
[storage] Metrics committed | reports=300 samples=600 nodes=5 duplicates=10
```

字段包括 `windowStart/windowEnd`、`reportCount`、`sampleCount`、`duplicateCount`、`serverCount`、`httpReports/wssReports`、`avgDurationMs/maxDurationMs`。报告数和样本数包含已经确认的重复报告，重复次数单独展示；不是唯一样本数，也不是 Cloudflare 计费请求数。

汇总跨多个请求，不附带某一条报告的节点、请求或连接 ID。唯一节点集合最多保留 1000 个，超过时设置 `serverCountTruncated=true`，摘要显示 `nodes>=1000`。汇总是进程内尽力记录；DO 回收或重启会丢弃尚未输出的日志计数，不影响已持久化指标，也不应据此做计费或审计统计。业务失败不等待汇总，立即记录。

## 常见事件

| 事件 | 含义与重点字段 |
| --- | --- |
| `metrics.summary` | 已确认报告的分钟汇总 |
| `metrics.committed` | debug 下的单次提交，包含 `serverId/reportId/duplicate/durationMs` |
| `metrics.commit.failed` | 指标提交失败，查看 `error`、`persisted`、`status`、`attempt` |
| `metrics.maintenance.failed` | 指标已经提交，但维护调度失败；重试仍安全 |
| `metrics.commit.retry` | Worker 尚未收到持久化确认，包含 `attempt/nextAttempt/retryAfterMs` |
| `metrics.commit.recovered` | 重试后提交成功，包含 `attempts/persisted` |
| `metrics.commit.slow` | 指标提交已确认但耗时较长 |
| `http.request.rejected/failed/slow` | 客户端拒绝、服务端异常、成功但缓慢的 HTTP 请求 |
| `agent.connect/auth_ok/disconnect` | Agent 连接生命周期，按 `connectionId/serverId` 关联 |
| `frontend.connect/subscribe/disconnect` | 访客连接、订阅范围与离线，包含 `scope`、订阅者数、关闭码 |
| `mode.hint` | `REALTIME` / `IDLE_BATCH` 切换；最后一个访客离开时订阅者数为 0 |
| `maintenance.completed/failed` | 维护状态、待继续清理的标记、下次 Alarm 时间 |
| `settings.load.failed` | 设置读取失败，`fallback=true` 表示继续使用可信缓存策略 |
| `notification.sent/failed` | 通知结果，包含渠道、事件类型、节点数量、耗时；不记录通知正文 |
| `cron.completed/failed` | 巡检结果，包含 cron、计划时间、耗时、告警/错误计数 |

每分钟正常巡检只在 debug 记录完成事件；小时巡检在 info 记录。任务内部已经捕获的错误会使最终 `outcome` 标为 `partial_failure`，仅有 warning 时为 `degraded`，避免把“没有抛异常”误写成完全成功。任务向外抛错时仍保持原有失败/重试语义。

## 检索步骤

1. 查看失败请求的 `X-Request-ID`，在 Cloudflare Workers → Observability 中以 `source=cfsm` 和该 `requestId` 过滤，串起 Worker、DO 和重试。
2. 查某个节点时用 `serverId`；查某份报告时结合 `reportId`。同一个报告可能重试，不要只按日志条数判断写入次数。
3. 排查 WSS 重连时按 `connectionId` 查看连接、鉴权和关闭事件，再用 `code/reason` 判断是否正常结束。
4. 排查慢写入时筛选 `metrics.commit.slow`，比较 `durationMs` 与 `metrics.summary` 的最大/平均耗时。

本地或实时 Tail：

```bash
npm run dev
npx wrangler tail --format json
```

应用日志对敏感键、请求/响应正文、指标样本、完整头集合、凭证 URL、Bearer 和常见 JWT 做屏蔽；限制嵌套、集合和堆栈长度，超大日志退化为保留关键定位字段的记录并设置 `truncated=true`，单条上限 12 KiB。日志序列化或输出失败不会影响业务响应或 Agent ACK。

这些规则针对应用 `console` 日志。Cloudflare 平台自己的 Invocation 日志和采样设置独立，平台仍可能记录请求 URL；应用减少日志不等于同比减少平台日志。旧的 `source=cfsm.wss` 查询应改为 `source=cfsm`；WSS helper 仍保留 `category/action` 字段。
