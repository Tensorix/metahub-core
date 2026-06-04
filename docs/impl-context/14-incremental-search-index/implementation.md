# 搜索索引增量维护 实现文档

配套设计见 [design.md](./design.md)。本文是代码级实现说明。承接 [01-init-basic-func/implementation.md](../01-init-basic-func/implementation.md)(`search.ts` 原全量重建)。

## 1. 改动文件

| 文件 | 改动 |
|------|------|
| `src/core/search.ts` | 主改动:`ensureIndex` 拆为 `fullRebuild` / `reindexDocument` / `reindexRecord` / `reindexDatabaseRecords` / `incrementalUpdate`;新增 `SEARCH_INDEX_VERSION` 常量、`readMeta`/`writeMeta` 助手;导出 `rebuildSearchIndex` |
| `src/core/snapshot.ts` | reset 路径清理键由 `search_hlc` 改为 `search_seq` + `search_index_version`(仍删 `search_fts`) |
| `src/core/search.test.ts` | 新增:9 例 |

复用既有原语:`changesAfterSeq(db, seq)`(`crdt.ts`,返回 `{changes, cursor}`)、`ftsAvailable`(`db.ts`)。

## 2. meta 键(取代 `search_hlc`)

- `search_seq`:已处理到的 `crdt_changes.rowid` 高水位游标(字符串存整数)。
- `search_index_version`:= 常量 `SEARCH_INDEX_VERSION`(当前 `"1"`)。存储值不符或缺失 → 全量重建。

## 3. 索引维护(`src/core/search.ts`)

### 3.1 入口 `ensureIndex`

```ts
function ensureIndex(db): boolean {
  if (!ftsAvailable(db)) return false;          // FTS5 不可用 → 调用方走 LIKE
  const version = readMeta(db, "search_index_version");
  const seq = readMeta(db, "search_seq");
  db.transaction(() => {                          // 原子:FTS 写 + 游标推进同一事务
    if (version !== SEARCH_INDEX_VERSION || seq === null) fullRebuild(db);
    else incrementalUpdate(db);
  })();
  return true;
}
export function rebuildSearchIndex(db): boolean   // 强制 fullRebuild,供维护/修复
```

### 3.2 全量兜底 `fullRebuild`

清空 `search_fts` → 重派生全部文档 + 记录 → `search_seq = MAX(crdt_changes.rowid)`(注意是 rowid 不是 hlc)→ 写 `search_index_version`。

### 3.3 增量 `incrementalUpdate`

```ts
const cursor = Number(readMeta(db,"search_seq") ?? "0");
const { changes, cursor: next } = changesAfterSeq(db, cursor);
if (changes.length === 0) return;
// 按 dataset 归并(见 design 3.3 映射表):
//   documents   -> docIds
//   doc_blocks  -> 查 doc_id -> docIds
//   records     -> recordIds
//   properties  -> col∈{type,__deleted,database_id} 时取其 database_id -> dbIds
//   其它 dataset 跳过
for (id of docIds)   reindexDocument(db, id);
for (dbId of dbIds)  reindexDatabaseRecords(db, dbId);
for (id of recordIds) if (该记录 database_id ∉ dbIds) reindexRecord(db, id);  // 去重
writeMeta(db, "search_seq", String(next));
```

### 3.4 `reindex*` 复用同一派生 SQL

每个都是「按 id/database_id 删 FTS 行 → 从 live 行重新派生插入」。记录 body 抽取统一走 `recordBodyRows(db, where, ...args)`(`where` 是固定字面量 `"r.id = ?"` / `"r.database_id = ?"` / `"1 = 1"`,非用户输入),复用原有 `json_each + properties JOIN + group_concat`,仍只取 `TEXT_TYPES` 属性。无文本 body 的记录派生为空(不插行)→ tombstone / 清空文本即等效移除。文档直接读已物化的 `documents.body`(由 `crdt.ts:recomputeDocBody` 维护)。

`ftsSearch` / `likeSearch` / `search` 主体不变。

## 4. snapshot reset

```ts
// restoreSnapshot reset 分支
db.query("DELETE FROM meta WHERE key IN ('search_seq', 'search_index_version')").run();
if (ftsAvailable(db)) db.query("DELETE FROM search_fts").run();
```

下次搜索游标缺失 → 自动全量重建。merge 路径靠 `ingest` 追加的新 rowid > 游标,增量自然吸收,无需改动。

## 5. 测试与验证

- `bun test src/core/search.test.ts`(9 例):基础文档/记录索引;增量编辑不误删其它;**乱序远程小 HLC 仍被索引(回归旧 `MAX(hlc)` 漏索引 bug)**;文档块编辑重索引文档;属性类型变更移除其文本;软删除移除记录;`search_index_version` 升级触发全量;删库级联经 `records.__deleted` 自动移除;`rebuildSearchIndex` 从头重建。
- `bun test`:全量 188 例通过。
- `bunx tsc --noEmit`:`search.ts` / `snapshot.ts` 0 新增错误(仅 `cli/index.ts` / `sites-serve.ts` 两处**预先存在**的 citty/BodyInit 报错,已用 `git stash` 在 clean HEAD 复现确认)。

> 测试注记:记录 id 由首个文本值派生且被存入 FTS `title`(沿用 01 行为),故断言「旧值消失」时,被搜词只放在 body、不放进 id slug。
