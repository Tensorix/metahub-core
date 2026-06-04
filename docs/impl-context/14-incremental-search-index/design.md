# 搜索索引增量维护(rowid 游标)设计文档

承接 [01-init-basic-func/design.md](../01-init-basic-func/design.md)(FTS5 `search_fts`、按 `MAX(hlc)` 惰性重建)、[13-data-integrity/design.md](../13-data-integrity/design.md)(删除写时级联 + `repairHub`)。本文记录把搜索索引从**读时整库重建**改为 **rowid 游标驱动的增量维护**,保留 SQLite FTS、不引入外部搜索服务。

## 1. 背景与问题

原 `ensureIndex`(`src/core/search.ts`)在每次搜索前比较 `crdt_changes` 的 `MAX(hlc)` 与 `meta.search_hlc`,只要不等就 `DELETE FROM search_fts`,再把**所有**非删除文档 + **所有**含文本字段的记录全部重新写入 FTS。

问题:任何一条记录修改、任何一条同步变更,都会让下一次搜索触发**整库索引重建**。对 MVP 够用,但随着 IM 历史 / 记账记录 / 本地知识库这类长期数据增长,会变成「一次搜索 → 大量写入」,带来卡顿、写放大、不必要的 SQLite 压力。

此外旧 `MAX(hlc)` 判定还有一个**潜在 bug**:乱序 sync 下,一条 HLC 比当前全局最大值更小、却赢得自己寄存器的远程变更会更新数据,但全局 `MAX(hlc)` 不变 → `ensureIndex` 误判「已最新」→ **跳过重建 → 索引陈旧**。

## 2. 为什么这样做(关键判断)

1. **复用既有 rowid 游标原语**:`changesAfterSeq(db, seq)`(`crdt.ts`)按 `rowid` 顺序返回「游标之后的变更 + 新游标」,`peers.pull_cursor/push_cursor` 已用同一约定做复制游标(插入顺序单调、永不漏变更)。
2. **派生索引按需局部重建已有先例**:`ensurePropIndex`(`indexing.ts`)、`rebuildDeclaredIndexes`(`snapshot.ts`)。
3. **顺带修掉上面的 `MAX(hlc)` 漏索引 bug**:rowid 游标对每条插入的变更都可见,与 HLC 大小无关。

代价是逻辑复杂度上升(派生受影响集合 + 局部重写 + 游标推进 + 兜底全量),但都是有界、可测试的逻辑。

## 3. 设计

### 3.1 meta 游标 + 版本(取代 `search_hlc`)

- `search_seq`:已处理到的 `crdt_changes.rowid` 高水位游标。
- `search_index_version`:索引逻辑版本号(常量 `SEARCH_INDEX_VERSION`)。存储值与常量不符或缺失 → 强制全量重建。改 `TEXT_TYPES` / 索引字段 / FTS schema 时 bump 即自动重建,无需手工迁移。

### 3.2 全量重建作兜底

`fullRebuild` 清空 `search_fts`、重新派生所有文档与记录,末尾把 `search_seq` 设为 `MAX(crdt_changes.rowid)` 并写入当前 version。触发场景:首次建索引、version 不符、快照 reset、手动 `rebuildSearchIndex`。

### 3.3 增量:dataset → FTS 映射

`incrementalUpdate` 读 `changesAfterSeq(search_seq)`,按 dataset 归并受影响对象,只重写它们:

| dataset | 受影响 FTS | 处理 |
|---|---|---|
| documents | 该文档 | `reindexDocument(row_id)` |
| doc_blocks | 所属文档 | 查 `doc_id` → `reindexDocument` |
| records | 该记录 | `reindexRecord(row_id)` |
| properties(`type`/`__deleted`/`database_id`) | 该库全部记录 | `reindexDatabaseRecords(db_id)` |
| properties(`name`/`position`/`config`) | 无 | 跳过 |
| databases / sites / site_files | 无(不进 FTS) | 跳过 |

记录去重:若某记录所属库已在「整库重建」集合中,跳过其逐条 `reindexRecord`(由 `reindexDatabaseRecords` 覆盖)。每个 `reindex*` 都是「先按 id/database_id 删 FTS 行,再从 live 行重新派生」;tombstone 或无文本 body 的对象重新派生为空(等效移除)。

### 3.4 事务原子性

整个增量更新(删/插 FTS + 推进 `search_seq`)包在一个 `db.transaction` 内,否则崩溃后游标领先于实际索引状态会导致永久漏索引。

## 4. 与删除级联 / 完整性层的关系、收敛时机

`deleteDatabase` 写时级联(见 13),对该库每条 live 记录/属性 `emit __deleted=1`、文档 detach;`repairHub` 兜底跨设备并发产生的残留孤儿。两条路径产出的都是 `records.__deleted=1`、`properties.__deleted=1`、`doc_blocks.__deleted=1`、orphan cell `json_remove`、`documents.database_id=null` 等变更——**全部落在 3.3 已覆盖的 dataset 上**,增量索引经正常路由自动吸收,**无需为 `databases` 或 repair 特判**。

收敛时机:级联产生的逐条 `__deleted` tombstone 是普通 CRDT 变更,**随同步传给对端**,对端 `ingest` 后下次搜索即移除——发起删除方与对端都**无需手动 repair**。唯一例外是删库时删除方尚未见到、在该库并发新建的孤儿记录,靠 `mh repair` 或快照 restore(自动跑 `repairHub`)按确定性规则收敛。

## 5. 已知缺点 / 边界

1. **属性跨库迁移**:`properties.database_id` 改变时只重建当前库的记录,旧库残留陈旧贡献。极罕见,version 升级 / 手动修复可纠正。
2. **rowid 稳定性依赖**:游标依赖 `crdt_changes` rowid 不被重排。`VACUUM` 会重排隐式 rowid——但复制(peers cursor)已依赖此假设;若将来引入 VACUUM,复制与搜索都需处理(用 version bump 强制重建兜底)。
3. **大批量同步/修复后首搜**:增量扫描 `WHERE rowid > ?`(走主 rowid)代价正比于「自上次搜索以来的变更数」,而非整库规模;整库属性失效用一次 `reindexDatabaseRecords` 吸收,比逐条更省。

> 采用「读时惰性增量」而非「写时同步维护 FTS」:把索引开销留在搜索时、批量摊销多次写入,更适合写多的 IM/记账场景,也不污染同步热路径。
