# 当前架构

## 总体结构

```text
AI Agent / Human
        |
        +----------------------------+
        v                            v
CLI (src/cli)              桌面端 (apps/desktop)
  - citty command tree       - Electron 外壳
  - JSON / human-readable      + Bun 边车跑 startServer()
  - editor integration         - 窗口加载内嵌 WebUI
        |                            |
        v                            v
Core API (src/core)
  - databases / properties / records
  - documents / blocks
  - resolve (引用解析) / context (当前库)
  - integrity (完整性校验/修复 validateHub/repairHub)
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
- 桌面端 `apps/desktop`(Electron + Bun 边车):外壳是 Electron(自带 Node 运行时),core/server 跑在 spawn 出的 Bun 边车里(因 core 依赖 `bun:sqlite` 等 Bun 专有 API,无法在 Electron 主进程直接运行),窗口加载边车在回环临时端口提供的内嵌 WebUI。还含「快速笔记」小窗(全局快捷键/托盘唤起、mac 半透明、可置顶):复用同一份 WebUI 的 `#quick` 路由 + 块编辑器,笔记是挂在通用 `parent_id` 下的普通文档,**core 不含 quicknote 概念**。详见 [impl-context/12-desktop-app](../impl-context/12-desktop-app/design.md)。

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
- WebUI 文档编辑器有自己的前端逻辑块树（支持嵌套列表与代码语言名）,但保存仍只是完整 Markdown body；服务端不认识前端 `children/lang` 结构,仍按上述 core block 规则 reconcile。

这让不同段落的并发编辑可以合并,比整篇 LWW 更适合 AI 增量编辑。

## 搜索架构

搜索模块当前实现:

- 优先使用 SQLite FTS5。
- 用 `meta.search_seq`(`crdt_changes.rowid` 游标)+ `meta.search_index_version` 记录索引进度与版本。
- 搜索前**增量**维护:只读取游标之后的 oplog 变更,归并受影响对象,重写其 `search_fts` 行;首次建索引 / 版本升级 / 快照 reset / 手动修复时才全量重建。整个增量更新与游标推进在同一事务内,保证不漏索引。
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

`Bun.serve()` 的 fetch handler 用精确路径匹配分发,路由表 `src/core/sync/routes.ts` 是单一来源——`syncRoutes`(`/sync`、`/health`)、`webuiRoutes`(`/api/*`)与 `sitesRoutes`(`/api/sites`、`/api/site/files` 只读)合并后,既被 fetch handler 命中,也被 `openapi.ts` 遍历生成 OpenAPI(`/docs`、`/docs.json`),无 codegen。静态站点用一个 `startsWith("/sites/")` **前缀分支**(精确匹配做不到任意路径)单独处理。

- **REST API**(`src/core/sync/webui-routes.ts`):一组只读 + 写入路由,**复用与 CLI 同一套 core 函数**(`listDatabases`/`updateDatabase`/`listRecords`/`createRecord`/`updateProperty`/`updateDocument`/`search` 等),因此写操作同样经 `emit()` 进 CRDT oplog、随 sync 复制。id 用 query 参数携带(`?db=`/`?id=`),以保持精确路径匹配与 OpenAPI 生成不变;`Route.method` 扩展出 `PATCH`/`DELETE`(含 `PATCH/DELETE /api/database`、`PATCH/DELETE /api/property`)。handler 统一包一层 try/catch,异常转 `{error}` 400。
- **浏览器 WebUI**(`src/webui/`,Preact):根路径 `/` 返回内联 HTML 外壳,`/webui.js` 返回应用 bundle。服务模块 `src/core/sync/webui.ts` 经 `server.ts` 的 `await import("./webui.ts")` **懒加载**,优先读打包产物 `dist/webui.js`,开发态(从源码运行、无 dist)即时 `Bun.build` 兜底并缓存。v2 为 Notion-like 模块化应用(`app.tsx` 为唯一构建入口,拆 `api/icons/ui/blocks/markdown/sidebar/table/editor`):块级所见即所得文档编辑(前端逻辑块树支持嵌套列表、列表内段落/引用/代码块、代码语言名与 Markdown 快捷转换；保存为 body 走 `reconcileBody`,无需 block 级 API)、Notion-like 表格、文档树侧栏(拖拽改嵌套)、移动端适配。见 [07-webui](../impl-context/07-webui/implementation.md)。
- **CLI 性能隔离**:WebUI 与 Preact 单独打包为 `dist/webui.js`,**不进入 `cli.js` 的启动 import 图**;懒加载使其仅在浏览器首次访问 `/` 时载入,普通 `mh <命令>` 启动不受影响。
- **静态站点托管**(`src/core/sync/sites-serve.ts`,经 `server.ts` 懒加载):`GET /sites/<name>/<path...>` 按名字 resolve 站点、查 `site_files`(默认 `index.html`),返回字节 + MIME;站点经 `mh site` CLI 发布,文件经 `emit()` 进 CRDT(见 [08-agent-sites](../impl-context/08-agent-sites/design.md))。
- **鉴权**(`src/core/sync/auth.ts`、`src/core/sync/token.ts`):fetch handler 顶部一处 token 门禁,`--debug` 跳过;`/sync`、`/health`、`/auth/token` 豁免(前两者保持 peer 复制免 token,后者让持过期 token 者仍能换新),其余请求需经 `Authorization: Bearer`/Cookie `mh_token`/`?token=` 携带 token。**token 默认持久化在 `~/.metahub` 的 `meta` 表**(非 `--token`/`METAHUB_TOKEN` 静态覆盖时),带 TTL(默认 30 天,env `METAHUB_TOKEN_TTL`),到期或 `mh token refresh` 时**惰性轮换**(以 DB 为单一来源、每请求读,故另一进程刷新立即生效);轮换后旧 token 在宽限期内(默认 7 天,env `METAHUB_TOKEN_GRACE`)仍可经 `GET /auth/token` 换到新 token,实现浏览器**无感续期**。浏览器导航无 token 返回解锁页(存 `localStorage`+cookie,并先尝试 `/auth/token` 静默续期),其后 HTML 响应经 `withShim` 注入 fetch 套壳自动带 `Bearer`、并在 401 时自动换取并重试一次。见 [10-persistent-token](../impl-context/10-persistent-token/design.md)。

## 快照架构

快照包是 gzip JSON:

- `changes`: 全量 CRDT oplog。
- `meta`: `node_id` 和 `hlc`。
- `peers`: 同步游标。
- `blobs`: cache 文件的 base64 内容。

恢复有两种模式:

- merge: 将包内 oplog ingest 到当前库。
- reset: 先保存安全快照,再清空领域表和 oplog,重放包内 changes。

两种模式在重建索引后都会跑一次 `repairHub`,把合入数据可能破坏的不变量确定性修好(见下「完整性架构」)。

## 完整性架构

schema 刻意只有主键、无 FK/UNIQUE(per-field LWW oplog 需要前向引用、并发同名存活、幂等回放),完整性改在 core 层做最终一致约束(`src/core/integrity.ts`,见 [13-data-integrity](../impl-context/13-data-integrity/design.md)):

- `validateHub(db)` 只读体检,`repairHub(db)` 确定性、幂等修复(循环到不动点,改动经 `emit()` 进 oplog 随 sync 复制)。
- **两条铁律**:① 修复只针对 tombstone(`__deleted=1`),容忍 absence(可能是尚未到达的前向引用);② 修复是收敛态的纯函数,winner 用全序 `(created_hlc, id)`,故各节点独立修复后既收敛又有效。
- **两层协作**:删除操作(`deleteDatabase`/`removeProperty`/`deleteDocument`)内置写时级联,删除节点一次性 emit,是主路径;`repairHub` 作为事后兜底,处理 sync 引入的坏数据(典型竞态:A 删库时 B 并发往该库建记录)。
- **触发时机**:`restoreSnapshot`(merge+reset)后自动跑;`mh doctor`/`mh repair` 手动触发;**不**在每次 `/sync` 后自动跑(避免重扫描与修复 op 抖动)。

## 当前暂缓边界

以下问题存在,但当前用户体验复盘中暂不作为优先级核心:

- 同进程或多进程并发写入的 SQLite lock 体验。
- 同步服务和快照导入的安全边界。
