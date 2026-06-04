# 数据完整性 invariant(validateHub / repairHub)设计文档

承接 [01-init-basic-func/design.md](../01-init-basic-func/design.md)(CRDT oplog 为真相源、字段级 LWW)、[03-snapshot-restore/design.md](../03-snapshot-restore/design.md)(merge/reset 回放 oplog)、[05-json-record-storage/design.md](../05-json-record-storage/design.md)(记录单元格按 property id 存 JSON)。本文记录在 **core 层补一套最终一致的逻辑完整性约束**:集中式 `validateHub()` / `repairHub()` + 删除操作内置级联,新增 `mh doctor` / `mh repair` 一对命令。

## 1. 背景与问题

schema(`src/core/schema.ts`)**只保证主键**,`database_id` / `parent_id` / `site_id` / `doc_id` 以及记录 JSON 的 property key 全是**弱引用**——无任何 FK / UNIQUE。WebUI 靠前端状态规避坏数据,但 **API / CLI / sync / restore** 仍可写入:

- 同库重复 property name、重复 site name、跨节点并发上传产生的重复 `(site_id, path)` 文件行;
- 父/库被删后残留的孤儿 document / record / property / cell / block / file;
- 删除仅软删(`__deleted=1`),改动前**全代码库只有 `deleteSite` 做级联**,其余删除全部留孤儿。

且在 CRDT / 乱序 sync 下,这些坏数据会被同步放大。

## 2. 为什么不加 SQLite FK / UNIQUE(关键判断)

本系统是 **per-field LWW oplog CRDT**(`crdt.ts`):

- **乱序写入**:单元格写入(`col` = property id)可先于 `database_id` 到达,`materialize` 用 `ensureRow` 先建 stub 行(`crdt.ts` 注释明确)。FK 会拒绝这种合法写入。
- **前向引用**:relation 值允许指向尚未创建的 record id(`resolveRelation` 逃生阀)。
- **并发同名**:两节点并发建同名 site/db,oplog 两条都要存活才能收敛,UNIQUE 会让 `ingest` 失败。
- **幂等回放**:snapshot restore 靠 `INSERT OR IGNORE` 幂等重放整条 oplog,硬约束会在回放中途报错。
- **软删除**:行物理上永远存在,SQL FK 无法表达「指向一个未 tombstone 的行」。

⇒ schema 保持弱约束,完整性改在 core 层做**最终一致**的逻辑 invariant。

## 3. 两条贯穿设计的铁律

### 3.1 修复只针对 tombstone,容忍 absence

引用目标「查不到」在乱序 sync 下不可区分两种情况:**已删**(oplog 里有 `__deleted=1`)vs **尚未到达**(创建 change 还在路上,合法前向引用)。

- 仅当目标存在且 `__deleted=1` 时才判定引用断裂并修复;
- 单纯缺失一律**不动**——读路径的 `__deleted=0` 过滤已优雅隐藏,等创建 change 到了自然就好。

若违反这条(看到「不存在」就清引用),会把还在途中的合法前向引用永久改坏,并经 `emit` 放大同步出去。

### 3.2 修复是收敛态的确定性、幂等函数

每个节点 sync 后**独立**跑修复,必须保证:

- 修复是**已收敛 materialized 状态**的纯函数:同输入在任何节点产出相同修复;
- winner 用全序 `(created_hlc, id)`(`created_hlc` 缺失退化为按 `id`);
- **不动点**:repair 后再 validate 必为空、再 repair 必 0 op(防发散/抖动);
- 所有修复经 `emit()` 走 oplog,保证可复制收敛。

## 4. validateHub / repairHub

### 4.1 问题分类

| category | 含义 | 处理 |
|----------|------|------|
| `broken_ref` | 非空引用指向**已 tombstone** 的目标 | 自动:派生侧 tombstone,或置空 fk |
| `orphan_cell` | 记录 JSON 残留**已删属性**的单元格 | 自动:`json_remove` |
| `dup_path` | 同 site 同 path 的冗余 live 文件行 | 自动:保留读 winner,tombstone loser |
| `parent_cycle` | 文档 `parent_id` 成环 | 自动:在 `(created_hlc,id)` 最大成员处断开 |
| `dup_name` | 同库重名 database / property | **仅报告** |
| `bad_config` | 非法 type / relation 无 database / select 无 options | **仅报告** |

弱引用修复矩阵(`broken_ref`):

| 源 | fk | 目标 | tombstone 后 |
|----|----|----|----|
| properties | database_id | databases | tombstone 属性 |
| records | database_id | databases | tombstone 记录 |
| documents | database_id | databases | **detach**(置空,文档存活) |
| documents | parent_id | documents | **unparent**(置空,子文档存活) |
| doc_blocks | doc_id | documents | tombstone block |
| site_files | site_id | sites | tombstone 文件 |

### 4.2 绝不 hard-delete 用户内容

`repairHub` 只对**派生行**(孤儿 cell/block)和**路由冗余**(同 path 文件)做删除;**用户内容**(database/document/record/site)重名只报告,不自动删/改名——避免静默丢数据,以及与他节点正在编辑的内容相争。

- `dup_path` winner 取 `created_hlc` 最早者,与 `getFileForServe` / `fileIdFor` 的 `ORDER BY created_hlc LIMIT 1` 读取语义一致。
- site name 重名**不自动去重**(删一个 site 会连带其文件,过于破坏);`getSiteByName` 的「最近创建胜」已优雅处理路由,故归入仅报告。

## 5. 两层协作:写时级联 + 事后兜底

- **写时级联(主路径)**:`deleteDatabase` / `removeProperty` / `deleteDocument` 在删除时由删除节点一次性 emit 级联 tombstone(对齐既有 `deleteSite`)。确定性最强。
- **事后兜底**:仍需 `repairHub`,因为存在竞态——A 删 database 时只 emit 了当时子行的 tombstone,B 同时往该库新建 record,sync 后该 record 成孤儿。`repairHub` 凭 **database 的 tombstone**(符合铁律 3.1)清理它。

二者对每种引用的处理**一致**(如 documents 删库都 detach、删父都 unparent),故无论级联跑没跑、还是 repair 兜底,结果相同。

## 6. 触发时机

- `restoreSnapshot`(merge + reset)重建索引后自动跑一次 `repairHub`。
- `mh doctor`(只读)/ `mh repair`(`--dry-run` 走 validate)手动触发。
- **不**在每次 `/sync` 后自动跑:全量扫描偏重、且有修复 op 抖动风险;留给手动 + restore。

## 7. 取舍

- **range/强唯一留到未来**:重名当前只报告;升级为写时强校验是后续 P0(见 [gaps-and-priorities.md](../../system-design/gaps-and-priorities.md))。
- **document title 重名不检测**:过于噪声且不影响解析(文档按 id 解析),只报告 database/property 重名(影响 name 解析)。
- **修复用新 HLC**:`emit` 给每条修复新本地 HLC;同值修复在各节点收敛(LWW 取其一,值相同),不破坏一致性。
- **置空语义**:`emit(...,null)` 把列置 SQL null;`emit(...,undefined)` 才 `json_remove` 删 JSON key——孤儿单元格清理必须用后者,否则 key 残留破坏不动点。
