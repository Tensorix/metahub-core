# 阶段性设计记录

本目录保留各阶段的方案、取舍和当时验证结果。**当前事实入口是 [system-design](../system-design/README.md)**；不要直接把旧文中的「未实现」、版本号、测试数量或运行截图当成当前状态。2026-10-24 的代码对照结果见 [复核记录](../system-design/review-2026-10-24.md)。

## 阅读关系

| 阶段记录 | 当前应如何理解 |
| --- | --- |
| 01-init-basic-func、05-json-record-storage | EAV 是早期方案；当前记录在 `records.data` JSON，单元格仍按属性 ID 独立 CRDT |
| 02-edit-editor-selection、07-webui | CLI 外部编辑器仍有价值；早期 contenteditable 块树已由 CM6 文本模型取代 |
| 03-snapshot-restore | 包格式与 merge/reset 的背景；快照只包含列出的数据，不等于备份全部本机凭据/发布状态 |
| 04-block-level-doc-crdt | 正文 block 权威仍有效，当前含 `blank_after` 与读边界 Markdown 修复 |
| 06-friendly-ids | 类型前缀与引用解析仍有效；core 精确 ID 与 CLI 友好引用区分见当前数据模型 |
| 08-agent-sites、23-sites-experience、24-sites-ux-refresh | 站点能力演进；受众优先仍适用于站点，不能套用到当前文档/数据库分享弹窗 |
| 09-file-sync | 单实体 Markdown/CSV 互导已实现；CSV 逐行提交及已确认缺陷见当前复核记录 |
| 10-persistent-token、11-device-pairing-sync | token 与 HTTP 配对的背景；配对凭据仍无自动过期，撤销与设备名册另见当前架构 |
| 12-desktop-app、30-mini-windows-and-file-editor | 小窗/文件编辑器仍保留；新增文档独立窗与关闭保存协议见 [document-windows](../system-design/document-windows.md) |
| 13-data-integrity | tombstone-only、确定性修复仍是约束；业务引用无 FK 不等于协议日志无 UNIQUE |
| 14-incremental-search-index、15-history-rollback-compaction | 增量搜索与窗口压缩仍有效；复制/搜索游标使用显式 AUTOINCREMENT seq，不能仅依靠保留 MAX(rowid) |
| 16-pwa-offline、18-no-origin-shell、19-client-topology | 浏览器完整副本与无源站拓扑；附件缓存/spool 已实现，旧的离线附件缺口已过时 |
| 17-s3-storage-sync、20-storage-sync-efficiency | 桶传输、发布者、退避与增量快照背景；v1 不做分享不是当前限制；短链接查看器是独立服务 |
| 21-enroll-code-onboarding | 设备接入码与扫码；描述符、密钥输入、恢复能力边界见当前架构 |
| 22-blob-sync | 文首早期待办不能覆盖后文 §6 的离线附件实现；当前缓存还用 anchored/pin，不能只按 pending 判可清 |
| 25-trust-and-settings | 数据地图、设备名册与设置页背景；页面数量和导航以 `settings/nav.ts` 为准 |
| 26-doc-internal-links、27-relation-and-doc-properties | 内链与引用列仍有效；WebUI 引用筛选已实现，服务端 contains DSL 仍未做 |
| 28-live-change-feed、29-audit-log | SSE 与 txn 审计仍有效；保存生命周期增加 revision/epoch 与过期响应保护 |
| 31-concurrent-writers | 多进程 IMMEDIATE 写事务、busy/clock_skew 契约；不是实时字符级协同 |
| 31-table-views | 已落地；当前入口为 [table-views](../system-design/table-views.md)，meta 是按顶层键合并 |

两个 `31-*` 是已有独立目录，引用时必须带完整名字，本次不重编号以免破坏既有链接。

## 维护规则

修改现行行为时更新 `system-design` 对应专题；阶段记录只追加有日期的修订或链接，不静默改写过去的决策与验证结论。已经失效的实现假设需在当前文档明确指出；未解决缺陷记入复核/差距清单，不记录成已批准设计。
