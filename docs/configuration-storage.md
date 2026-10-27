# 配置存储与服务器字段清理

全局设置按后台功能分别保存在 D1 `settings` 表的多行 JSON 中。服务器主表、Ping 配置、通知配置、通知运行状态也分别存储。管理端、主题和 Agent 继续使用原有扁平字段；无需修改调用协议。

## 全局设置

| settings.key | 功能 | 字段 |
| --- | --- | --- |
| `settings.site` | 站点基本信息 | `site_title`、`is_public`、`default_language` |
| `settings.appearance` | 外观与资源来源 | `custom_bg`、`custom_bg_mobile`、`favicon`、`custom_head`、`custom_script`、`csp_static`、`csp_api`、`display_mode`、`preferred_theme` |
| `settings.monitoring` | 监控展示与上报 | `show_price`、`show_expire`、`show_tf`、`show_three_net_details`、`wss_report_enabled`、`frontend_ws_timeout_minutes`、`long_history_points` |
| `settings.security` | 访问安全 | `turnstile_enabled`、`turnstile_login_enabled`、`turnstile_site_key`、`turnstile_secret_key`、`jwt_secret` |
| `settings.account` | 管理账号 | `username`、`password`（密码哈希） |
| `settings.registration` | 自动注册 | `auto_register_enabled`、`auto_register_default_group`、`auto_register_token`、`auto_register_token_expires` |
| `settings.probes` | 全局 Ping 节点 | `custom_ct/cu/cm/bd`、`node_1` 至 `node_4`，及对应的八个 `*_name` |
| `settings.notifications` | 通知渠道与消息 | `tg_bot_token`、`tg_chat_id`、`notification_timezone`、`notification_language`、`notification_template`、`notification_webhook_enabled/url/method/format/headers/body` |
| `settings.alerts` | 告警规则 | `tg_notify`、`expire_reminder`、`expire_notification_time`、`resource_alert_rules`、`traffic_alert_threshold` |
| `settings.cloudflare` | Cloudflare 用量查询 | `cloudflare_account_id`、`cloudflare_token` |
| `settings.theme` | 第三方主题 | `theme_url`、`theme_options` |

字段归属以 `src/utils/settingFields.js` 为准。每个字段只归属一个分组。`APPEARANCE_FIELDS`、`SITE_FIELDS` 仍是接口兼容分类，不再对应两条大 JSON。

保存时只合并本次传入的字段，只更新其所属分组；同组内未提供的字段继续保留。一次请求涉及多个分组时，使用同一个 D1 batch 事务。JSON 对象、数组、布尔值、数字和显式 `null` 在迁移与存储层保持类型；业务加载时继续执行既有规范化。`theme_options` 按完整对象替换，其内部的 `null` 不会被 JSON merge-patch 当作删除操作。

读取按用途选择功能分组，使用有界 SELECT、逐组 120 秒内存缓存及并发读取任务。保存后仅失效发生变更的原始分组缓存。每组通过同一条条件更新维护 `updated_at` 与 `revision`；值未变化时不递增版本、不更新时间。相比原来两行 JSON，冷读会读取更多配置行；更改一个设置只需写对应分组，不再重写两份完整配置。重复保存相同 JSON 字段值时不更新该行。

`alert_state`、`resource_alert_state` 不再存储于 `settings`，其内容在独立迁移事务中原样迁入 `notification_runtime_state`，成功后才删除原 key。运行状态继续采用两条聚合记录，保持一次聚合变更通常写一行业务记录，避免逐节点拆分后扩大写行数。分组读取损坏、版本不兼容或不完整时不会用公开站点默认值替代访问策略。

## 服务器配置

| 表或视图 | 用途 | 字段 |
| --- | --- | --- |
| `servers` | 服务器基础信息、计费和 Agent 参数 | 下表列出的 28 个字段 |
| `server_ping_settings` | 逐服务器 Ping 配置 | `server_id`、`ping_mode`、`custom_ct`、`custom_cu`、`custom_cm`、`custom_bd`、`node_1` 至 `node_4`、`updated_at`、`revision` |
| `server_notification_settings` | 逐服务器通知配置 | `server_id`、`offline_notify_disabled`、`traffic_alert_percent`、`updated_at`、`revision` |
| `server_notification_state` | 流量告警的去重与账期状态 | `server_id`、`traffic_used_bytes`、`traffic_threshold`、`traffic_limit_gb`、`claim_token`、`claim_until`、`revision` |
| `notification_runtime_state` | 全局离线/资源告警运行状态 | `key`、`value`（JSON 对象）、`updated_at`、`revision` |
| `schema_migrations` | 分组件的有序迁移记录 | `component`、`version`、`name`、`applied_at` |
| `server_details`（视图） | 为已有调用方组合上述数据 | `servers.*` 加三张独立表的字段 |

三张服务器子表均以 `server_id` 为主键，外键引用 `servers.id`，使用 `ON DELETE CASCADE` 和 `WITHOUT ROWID`。子记录按需创建：缺行表示默认配置或无告警状态，不再通过触发器为每台服务器创建三个空行。

新增、编辑和导入仍使用一个事务。SQL 使用空值安全的差异条件，只有值发生变化的表才写入；恢复全部默认值时直接删除相应子记录。`updated_at`、`revision` 分别记录所在配置表的真实变更，修改通知覆盖项不会额外更新服务器主表。主表只改名、排序或 Agent 参数时也不会重写 Ping、通知记录。

Ping 地址列统一为 `NULL` 表示继承、`"0"` 表示禁用、其他文本表示覆盖地址；旧空串在迁移时转成 `NULL`。通知阈值 `NULL` 表示继承全局值，`0` 表示关闭，数据库限制其余值为 `0–100` 整数。布尔列存储为 INTEGER `0/1`，视图和查询投影继续返回原有字符串格式。

采集/上报间隔、Ping 和连接模式、流量校正、主键及时间元数据均有数据库约束。新表采用 CHECK/NOT NULL；保留原有父表时，通过验证触发器补齐 SQLite 无法直接追加的列约束，避免重建父表触发外键级联删除。

流量状态改为具名数值列。兼容视图仅在需要时合成旧 `{u,th,lim}` JSON；原始配置导出/导入格式仍支持该字段。发送前通过条件 UPSERT 获取两分钟租约，只有持有正确 token 的发送者能确认成功。失败会释放租约，进程中断可在超时后接管；已发送状态还能阻止缓存陈旧的请求重发。低于阈值时，启用流量告警的 Agent 在首次需要状态时按需读取并缓存，保证冷启动也能识别账期回落。

租约抑制并发重复，交付仍允许重试：外部渠道已接收而成功状态未能提交的故障窗口中，后续重试仍可能再次送达。首次通知通常需要抢占、确认两次状态写入，只在实际触发告警时发生。

全局通知渠道保存在 `settings.notifications`，全局告警规则保存在 `settings.alerts`；逐服务器表只保存原来已有的覆盖项。

## servers 字段核对

| 保留字段 | 实际用途 |
| --- | --- |
| `id`、`name`、`server_group`、`region`、`tags`、`note` | 节点标识、展示、分组和管理备注 |
| `price`、`billing_cycle`、`auto_renewal`、`currency`、`expire_date` | 费用展示、续费日期计算与到期提醒 |
| `traffic_limit`、`traffic_calc_type` | 流量展示、用量计算与流量告警 |
| `interface`、`reset_day`、`collect_interval`、`report_interval`、`wss_report_interval`、`connection_mode` | Agent 配置下发及上报模式 |
| `auto_update` | 管理端记忆探针自动更新选项并生成安装命令；不是实时配置下发项 |
| `rx_correction`、`tx_correction` | 一次性流量校正，探针确认后清空 |
| `is_hidden`、`sort_order` | 可见性控制和前台排序 |
| `secret` | 逐节点 Agent 认证及配置备份还原 |
| `created_at` | 创建/导入元数据；视图提供旧 `timestamp` 别名，不用于在线判断 |
| `updated_at`、`revision` | 主表配置最后变更时间及版本，均只在实际修改时更新 |

删除与清理：

- `history_partition_id`：仅服务于旧 D1 历史分区；DO 历史按服务器 ID 存取，已无业务用途。同时移除分区分配、冲突修复、索引和最多 900 个节点的旧限制。
- 旧实时指标列，如 `cpu`、`ram_*`、`disk_*`、`load_avg`、`uptime`、`last_updated`、OS / IP / GPU / Ping / 丢包等：数据来源已是 DO 最新报告与历史，D1 副本不再维护。
- 旧流量运行快照列，如 `net_rx`、`net_tx`、`monthly_rx/tx`、`net_rx/tx_monthly`、`last_rx/tx`、`reset_month`、`traffic_snapshots`、`bandwidth`：均由 Agent 上报与 DO 存储负责；不删除仍有效的流量配置和校正项。

完整删除清单为 `src/database/migrations/legacyServers.js` 中的 `OBSOLETE_SERVER_COLUMNS`。仅删除确认废弃的字段；未知自定义列保留。Ping、通知设置和告警状态是迁出，并非丢弃。DO 中的指标与历史保持原状。

## 自动迁移与兼容

1. `schema_migrations` 记录每个组件已完成阶段。服务器版本为 3，全局设置版本为 2，通知运行状态版本为 1。原 `schema.servers`、`settings.schema` 标记同步保留。
2. 服务器迁移依次记录“旧配置分表兼容”“稀疏配置、类型约束及时间字段”“查询索引”三个阶段。每阶段是独立事务；失败回滚当前阶段，已提交阶段继续保留，重试从未完成阶段恢复。保留未知自定义列和仍有效的原有索引，不删除重建父表。
3. 全局设置按“已有功能分组 → 原所属 JSON → 旧单字段 key → 默认值”取值；保留密码哈希和 JWT 密钥。配置复制、旧 key 清理、约束和元数据更新有事务保障。通知运行状态独立迁移，损坏状态不会被静默丢弃。
4. 首次访问仍保留旧版自动升级兼容路径，也可通过后台数据库升级操作主动迁移。已完成迁移的冷实例只读取版本记录，同一实例复用初始化任务；常规请求不会反复执行 DDL。遇到更高版本结构会拒绝写入。
5. 后台导出仍为扁平数组，旧文件中的 `timestamp`、`traffic_alert_state` 可继续导入；新导出同时提供 `created_at` 和兼容 `timestamp` 别名，旧 `history_partition_id` 被忽略。
6. 代码回退需要同时考虑数据库结构。旧版本无法向已删除的列写入，不能长期混用新旧写入逻辑。

## 按用途查询与索引

- 前台服务器列表/详情：读取基础字段和 Ping 配置，不读取认证密钥、通知配置与通知状态。
- 后台列表：读取基础字段、Ping 和通知配置；完整导出才使用 `server_details` 读取全部配置及兼容状态。
- Agent：读取认证、下发和流量告警所需配置；有流量告警需求时才按需读取运行状态。
- 历史权限检查、资源告警、到期提醒：直接读取主表所需字段；离线检测只额外关联通知开关。
- `servers(name)` 服务自动发现查重，`servers(sort_order,id)` 服务稳定排序和最大排序值查询。子表主键已支持关联，不重复建索引。

全局设置通过 `SETTINGS_SCOPES` 按访问控制、前台、Agent、通知和监控等用途加载。普通请求不再因为只需要上报配置就读取账号和 Cloudflare 凭据分组。

迁移存在一次性 D1 读写；索引维护也计入写行。此变更不新增 Cloudflare 绑定、不迁移 DO，不增加指标上报的 DO 写行。

## 本地 workerd / D1 计量

`configuration-runtime.test.js` 使用真实 D1 API 的 `meta.rows_read/rows_written`，2026-10-27 的单节点测试结果：

| 操作 | 行计量 |
| --- | --- |
| 新增完全默认的节点 | 4 写行，包含主表及主键、名称、排序索引；三个子表均无空行 |
| 完整表单只修改通知开关 | 1 写行 |
| 重复保存完全相同的表单 | 0 写行 |
| 恢复默认通知配置 | 1 写行，删除覆盖记录 |
| 同一节点具备三张子表记录时，完整详情读取 | 4 读行 |
| 相同数据下，前台读取 / 权限检查 | 2 / 1 读行 |

这些是固定测试数据的计量，实际查询范围、命中缓存、索引和记录分布会改变结果。

事务与约束依据：[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)、[D1 外键](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)。[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)规定 batch 按一次调用计入每次 Worker 执行的查询限制，每条语句仍需遵守绑定数量等限制。

## 验证

`configuration-optimization.test.js` 覆盖条件写入、稀疏默认值、约束、按用途查询、索引、迁移恢复、并发迁移、状态隔离、账期回落和通知租约；`configuration-runtime.test.js` 校验真实 D1 行计量及租约。`settings-storage.test.js` 覆盖字段归属、旧 JSON/旧单 key 迁移、类型保留、并发合并、失败回滚、缓存和 JWT 稳定性。`server-schema.test.js` 覆盖旧列删除、数据迁出、稀疏默认值、级联删除、跨表回滚、缓存隔离、导入导出、告警状态和超过 900 个节点的注册。`runtime.test.js` 在本地真实 workerd / D1 上验证迁移与分组写入，以及原有 HTTP/WSS 上报与访问控制。
