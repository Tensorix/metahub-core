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
  - resolve (引用解析) / context (当前库)
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

新建实体的 `row_id` 带类型前缀(`<kind>_<slug>-<rand>`,见 `src/core/ids.ts`),对 oplog/物化/同步完全不透明;旧的无前缀 id 与之共存。

## 引用解析路径

CLI 在调用 core 写/读函数前,先把用户输入的「引用」解析成确切 id:

1. CLI 命令拿到 id 参数(可能是完整 id、唯一前缀、名字/标题)。
2. 调 `resolveRef`(`src/core/resolve.ts`,纯只读)在指定 kind/库范围内解析,歧义或找不到则抛错(经 `guard` 转成 `{error}` 输出)。
3. 用解析出的精确 id 调 core 的 `getX`/`updateX`/`deleteX`——**core API 仍只接受精确 id**,解析便利只在 CLI 边界。
4. `database` 参数缺省时回退到 `meta.current_db`(`src/core/context.ts`,本机上下文);relation 值在写入(`coerce`)时于目标库内解析。

这样保持了 core API 的精确可预测,同时把「不必粘贴完整 id」的体验集中在解析层。

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

## HTTP 路由与 WebUI

`Bun.serve()` 的 fetch handler 用精确路径匹配分发,路由表 `src/core/sync/routes.ts` 是单一来源——`syncRoutes`(`/sync`、`/health`)与 `webuiRoutes`(`/api/*`)合并后,既被 fetch handler 命中,也被 `openapi.ts` 遍历生成 OpenAPI(`/docs`、`/docs.json`),无 codegen。

- **REST API**(`src/core/sync/webui-routes.ts`):一组只读 + 轻量写入路由,**复用与 CLI 同一套 core 函数**(`listDatabases`/`listRecords`/`createRecord`/`updateDocument`/`search` 等),因此写操作同样经 `emit()` 进 CRDT oplog、随 sync 复制。id 用 query 参数携带(`?db=`/`?id=`),以保持精确路径匹配与 OpenAPI 生成不变;`Route.method` 扩展出 `PATCH`/`DELETE`。handler 统一包一层 try/catch,异常转 `{error}` 400。
- **浏览器 WebUI**(`src/webui/app.tsx`,Preact):根路径 `/` 返回内联 HTML 外壳,`/webui.js` 返回应用 bundle。服务模块 `src/core/sync/webui.ts` 经 `server.ts` 的 `await import("./webui.ts")` **懒加载**,优先读打包产物 `dist/webui.js`,开发态(从源码运行、无 dist)即时 `Bun.build` 兜底并缓存。
- **CLI 性能隔离**:WebUI 与 Preact 单独打包为 `dist/webui.js`,**不进入 `cli.js` 的启动 import 图**;懒加载使其仅在浏览器首次访问 `/` 时载入,普通 `mh <命令>` 启动不受影响。

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

