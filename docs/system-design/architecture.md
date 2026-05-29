# 当前架构

## 总体结构

```text
AI Agent / Human
        |
        v
CLI (src/cli)
  - citty command tree
  - JSON / human-readable output
  - editor integration
        |
        v
Core API (src/core)
  - databases / properties / records
  - documents / blocks
  - search
  - snapshot / restore
  - sync client/server
        |
        v
SQLite + cache
  ~/.metahub/metahub.db
  ~/.metahub/cache/
```

当前实现把 CLI 和库能力共享在 `src/core` 中。CLI 只负责参数解析、输入解析、输出渲染和命令接线;业务写入都通过 core 完成。

## 运行时和分发

已实现:

- 运行时基于 Bun。
- SQLite 使用 `bun:sqlite`。
- HTTP 同步服务使用 `Bun.serve()`。
- 构建脚本输出库入口 `dist/index.js` 和 CLI `dist/cli.js`。
- `package.json` 暴露 `metahub` 和 `mh` 两个 bin。
- 支持通过 `bun build --compile` 生成独立二进制。

## 本地目录

```text
~/.metahub/
  metahub.db
  cache/
```

可通过 `METAHUB_HOME` 覆盖根目录,测试和多实例运行依赖这个能力。

## 写入路径

所有领域写入都走 CRDT oplog:

1. 领域函数调用 `emit(db, dataset, rowId, col, value)`。
2. `emit` 生成 Hybrid Logical Clock 时间戳。
3. 写入 `crdt_changes`。
4. `applyChange` 判断当前 change 是否为该 register 的最大 HLC。
5. 如果胜出,物化到领域表。

当前 register 由 `(dataset, row_id, col)` 定义。记录单元格也是 register,其中 `col` 是 property id。

## 读取路径

读取直接走物化表:

- 数据库和属性直接查 `databases`、`properties`。
- 记录从 `records.data` JSON 中读取 property id 到 value 的映射,再映射回属性名。
- 文档读取 `documents.body`,该字段是从 `doc_blocks` 重算出来的缓存。
- 搜索读取 `search_fts`,不可用或无命中时降级 LIKE。

## 查询路径

当前记录查询由 `listRecords` 编译为 SQL:

- `filter` 支持 `{field: value}` 等值过滤。
- scalar 值下推到 SQL。
- array/object/null 值在 JS 层过滤。
- `sort` 支持单字段排序,默认 `created_hlc`。
- `limit` 在没有 JS 过滤时下推到 SQL。

当前没有正式查询 DSL,也没有范围查询、contains、聚合和 cursor pagination。

## 文档架构

文档正文采用 block-level CRDT:

- `doc_blocks` 是权威数据。
- `documents.body` 是物化缓存。
- Markdown 按段落切块,fenced code block 保持为一个块。
- `doc edit --old --new` 优先在单块内做锚定替换。
- 跨块或引入块分隔时走整篇 reconcile。

这让不同段落的并发编辑可以合并,比整篇 LWW 更适合 AI 增量编辑。

## 搜索架构

搜索模块当前实现:

- 优先使用 SQLite FTS5。
- 使用 `meta.search_hlc` 记录已索引水位。
- 只要 oplog 最大 HLC 变化,会清空并重建 `search_fts`。
- FTS 无命中或不可用时使用 LIKE 子串搜索。

当前搜索是全文搜索 MVP,不是面向 IM 上下文检索的完整体验。

## 同步架构

同步是简单 C-S 模式:

- 服务端也是一个 Metahub 节点。
- `POST /sync` 接收客户端 changes,服务端 ingest 后返回服务端游标之后的 changes。
- 客户端用 `peers` 表记录 `pull_cursor` 和 `push_cursor`。
- 游标基于 SQLite `rowid`,避免 HLC 时钟漂移导致漏同步。

当前同步是最终一致的基础实现,还没有面向大量 oplog 的分页、压缩或差异优化。

## 快照架构

快照包是 gzip JSON:

- `changes`: 全量 CRDT oplog。
- `meta`: `node_id` 和 `hlc`。
- `peers`: 同步游标。
- `blobs`: cache 文件的 base64 内容。

恢复有两种模式:

- merge: 将包内 oplog ingest 到当前库。
- reset: 先保存安全快照,再清空领域表和 oplog,重放包内 changes。

## 当前暂缓边界

以下问题存在,但当前用户体验复盘中暂不作为优先级核心:

- 同进程或多进程并发写入的 SQLite lock 体验。
- 同步服务和快照导入的安全边界。

