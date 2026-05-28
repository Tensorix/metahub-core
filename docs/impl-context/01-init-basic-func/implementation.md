# Metahub 实现文档

配套设计见 [design.md](./design.md)。本文是代码级实现说明。

## 1. 目录结构与职责

```
src/
  index.ts                 # 库入口：re-export core
  core/
    paths.ts               # 解析 ~/.metahub（METAHUB_HOME 覆盖）、db/cache 路径
    db.ts                  # ensureDirs / runSchema / ftsAvailable / openMetahub
    schema.ts              # SQLite DDL（CORE_SCHEMA + FTS_SCHEMA）
    ids.ts                 # randomSuffix / slugify / makeId
    node.ts                # getNodeId（meta 表，稳定 nodeId）
    hlc.ts                 # Hybrid Logical Clock：formatHlc/parseHlc/nextHlc/observeHlc
    crdt.ts                # Change 类型、emit/applyChange/ingest、物化路由、复制取数
    databases.ts           # 数据库(表) CRUD
    properties.ts          # 属性(列) CRUD + 类型/config 校验
    records.ts             # 记录(行) CRUD + 单元格类型 coerce + 名称/ID 解析
    documents.ts           # markdown 文档 CRUD
    search.ts              # FTS5 惰性重建 + 查询，LIKE 兜底
    cache.ts               # putBlob/getBlob（sha256 内容寻址）
    index.ts               # core 桶文件（barrel）
    sync/
      protocol.ts          # SyncRequest/SyncResponse、路径常量
      server.ts            # startServer（Bun.serve）
      client.ts            # syncWithPeer（push/pull + peer 游标）
  cli/
    index.ts               # 根命令：--server/--port 前置处理 + citty 子命令
    output.ts              # print（TTY 自适应）/ fail / guard / table
    input.ts               # resolveValue / resolveJson（@file/@-/字面值）
    editor.ts              # runEdit：开 $EDITOR、回写（文档 md / 记录表单）
    commands/
      init.ts db.ts prop.ts record.ts doc.ts edit.ts search.ts sync.ts
  core/crdt.test.ts        # HLC 单调性 + 两节点收敛 + 应用顺序无关
scripts/
  build.ts                 # 产出 dist/（库 + CLI + d.ts，target: bun）
  compile-binaries.ts      # 产出 binaries/ 五平台独立二进制
```

## 2. SQLite Schema（`src/core/schema.ts`）

```sql
-- 元数据：node_id、hlc（本地时钟）、search_hlc（FTS 已索引水位）
meta(key PK, value)

-- CRDT oplog：每行一个字段赋值。隐式 rowid 按插入顺序单调，用于复制游标。
crdt_changes(hlc, node_id, dataset, row_id, col, value,
             PRIMARY KEY(dataset, row_id, col, hlc))
INDEX idx_changes_hlc ON crdt_changes(hlc)

-- 每个 peer 两个 rowid 游标
peers(url PK, pull_cursor INT, push_cursor INT)

-- 域表（oplog 物化视图）
databases(id PK, name, icon, created_hlc, __deleted)
properties(id PK, database_id, name, type, config /*JSON*/, position REAL, __deleted)
  INDEX idx_properties_db
records(id PK, database_id, created_hlc, __deleted)
  INDEX idx_records_db
record_values(record_id, property_id, value /*JSON*/, PRIMARY KEY(record_id, property_id))  -- EAV 单元格
documents(id PK, title, body /*markdown*/, database_id, parent_id, created_hlc, __deleted)

-- 全文检索（best-effort，FTS5 不可用则 runSchema 静默跳过）
search_fts USING fts5(kind UNINDEXED, id UNINDEXED, database_id UNINDEXED, title, body)
```

`col` 用作列名（避免 SQLite 关键字 `column`）。`runSchema` 先建 CORE，再 `try` 建 FTS。

## 3. CRDT 引擎（`src/core/crdt.ts`）

核心数据结构：
```ts
interface Change { hlc; node_id; dataset; row_id; col; value: string | null }
```

关键函数：

| 函数 | 作用 |
|------|------|
| `emit(db, dataset, rowId, col, value)` | 本地写：取 `nextHlc` → 组 Change → `applyChange`，返回该 Change |
| `emitFields(db, dataset, rowId, fields)` | 对同一行批量写多列 |
| `applyChange(db, change) -> boolean` | `INSERT OR IGNORE` 进 oplog；若是该寄存器 `MAX(hlc)` 则物化，返回是否物化 |
| `ingest(db, changes[]) -> number` | 摄入远端变更：`observeHlc` 推进时钟 + `applyChange`，整批在一个事务里，返回实际物化条数 |
| `changesAfterSeq(db, seq) -> {changes, cursor}` | 取 rowid > seq 的变更（插入序）+ 新游标，供复制 |
| `changesSince(db, since)` | 取 hlc > since 的变更（测试/调试用） |

**物化路由 `materialize`**：
- `dataset === "records"`：`col ∈ {database_id, created_hlc, __deleted}` 写 `records` 表；否则 `col` 是 property id，写/删 `record_values`。
- 其他 dataset：查 `DOMAIN` 白名单（`databases/properties/documents` 及各自允许列），`ensureRow` 后 `UPDATE`。
- value 是 JSON：标量解码后写域表（如 `__deleted` 的 `true`→`1`、`config` 对象→JSON 串）；`record_values` 直接存 JSON 串。

## 4. 域模块 API

所有函数首参为 `Database`（依赖注入，便于测试）。写操作内部走 `emit`，读操作直接查域表且过滤 `__deleted = 0`。

- **databases.ts**：`createDatabase(db,{name,icon?})` / `getDatabase` / `listDatabases` / `deleteDatabase`
- **properties.ts**：`addProperty(db, databaseId, {name,type,config?,position?})` / `getProperty` / `listProperties` / `updateProperty` / `removeProperty`；`PROP_TYPES` 校验类型，`validateConfig` 校验 select/relation 的 config。
- **records.ts**：`createRecord(db, databaseId, data)` / `getRecord` / `listRecords(db, dbId, {filter?,limit?})` / `updateRecord`（部分更新）/ `deleteRecord`。
  - `resolveData` 允许 data 的 key 用**列名或列 id**；`coerce` 按列类型校验/规范化值；`deriveTitle` 用首个非空 text 列值生成可读 id（中文则回退库前缀）。
- **documents.ts**：`createDocument(db,{title,body?,database_id?,parent_id?})` / `getDocument` / `listDocuments({database_id?})` / `updateDocument` / `deleteDocument`。

## 5. 搜索（`src/core/search.ts`）

- `ensureIndex`：比较 `MAX(crdt_changes.hlc)` 与 `meta.search_hlc`，仅在数据变化时清空并重建 `search_fts`（文档 + 文本类记录单元格 `group_concat`）。
- `search(db, query, {limit?})`：FTS5（按 `rank`、`snippet()` 高亮）优先；无 FTS 或命中为空 → `likeSearch` 子串匹配（对 CJK/精确短语更稳）。

## 6. CLI

`src/cli/index.ts`：先从 `process.argv` 检测 `--server`（在 citty 之前处理，否则 `--port` 的值会被当成子命令名），命中则 `startServer`；否则 `runMain` 跑 citty 子命令树。

`output.ts`：
- `print(data, pretty?)`：`--json` 或非 TTY → `JSON.stringify`；TTY 且给了 `pretty` → 人类视图；否则缩进 JSON。
- `fail(msg)`：JSON `{error}` 或 stderr，`exit(1)`。
- `guard(fn)`：包裹命令 run，捕获异常转 `fail`。
- `table(rows)`：对齐 ASCII 表。

`input.ts`：`resolveValue`（`@-`→stdin、`@x`→文件、否则字面）、`resolveJson`（再 `JSON.parse`）。

### 命令清单

| 命令 | 关键参数 |
|------|----------|
| `mh init` | — |
| `mh db create <name> [--icon]` / `list` / `get <id>` / `delete <id>` | |
| `mh prop add <db> <name> --type <t> [--options a,b] [--target <db>] [--config @f] [--position]` | |
| `mh prop list <db>` / `update <id> [...]` / `remove <id>` | |
| `mh record create <db> [--data @f]` / `list <db> [--filter @f] [--limit]` / `get <id>` / `update <id> [--data]` / `delete <id>` | |
| `mh doc create --title <t> [--body @f] [--db] [--parent]` / `list [--db]` / `get <id>` / `update <id> [--title][--body]` / `delete <id>` | |
| `mh edit <id>` | 文档/记录开 `$EDITOR` |
| `mh search <query> [--limit]` | |
| `mh sync <url>` | 与服务端推/拉一轮 |
| `mh --server [--port 7777]` | 启动同步服务端 |

## 7. 同步实现

- **协议**（`sync/protocol.ts`）：`POST /sync` `{node_id, since, changes[]}` → `{node_id, changes[], cursor}`；`GET /health`。
- **服务端**（`sync/server.ts`）：`startServer({port})` 用 `Bun.serve`；收到请求先 `ingest(changes)`，再 `changesAfterSeq(since)` 回包。返回 `{server, node, port}`。
- **客户端**（`sync/client.ts`）：`syncWithPeer(db, url)` 读 peer 游标 → `changesAfterSeq(push_cursor)` 推送 → `ingest` 响应 → 写回 `{pull_cursor: resp.cursor, push_cursor: toPush.cursor}`，返回 `{pushed, pulled}`。

## 8. 构建与分发

- `scripts/build.ts`：`Bun.build` 两个入口（`src/index.ts` 库、`src/cli/index.ts` CLI），`target: "bun"`，CLI 加 `#!/usr/bin/env bun` shebang + `chmod 755`，再 `tsc -p tsconfig.build.json` 出 `.d.ts`。
- `scripts/compile-binaries.ts`：对 5 个 `bun-*` target 跑 `bun build --compile` 出 `binaries/metahub-<platform>`。
- `package.json`：`bin` 映射 `metahub`/`mh` → `dist/cli.js`；`files` 只发 `dist` + README。
- 因依赖 `bun:sqlite`/`Bun.serve`，CLI 与库均需 **Bun 运行时**（或用内嵌 Bun 的独立二进制）。

## 9. 测试与验证

- `bun test`（`src/core/crdt.test.ts`）：HLC 单调全序、两节点交换后收敛（含并发同字段、重放幂等）、应用顺序无关。
- 端到端手验：单机 CRUD + FTS 搜索；两机经 `--server` / `sync` 收敛；`mh edit` 用非交互 `$EDITOR` 回写。
- `bunx tsc --noEmit` 类型检查；`bun run build` 与 `bun build --compile` 产物可运行。

## 10. 已知取舍与扩展点

- 文档正文为整文档 LWW（非字符级合并）——可演进为 Yjs/Automerge 文本 CRDT。
- 客户端回推冗余、无 Merkle 差异——可加 node 过滤 / Merkle 树优化带宽。
- `cache/` 的 blob 目前不参与同步——可加按需拉取 / blob 同步协议。
- 关系（relation）仅存目标 id 数组，未做反向链接 / 完整性约束。
- 无视图 / 排序 / 批量导入导出（v1 范围外）。
