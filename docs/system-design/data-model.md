# 当前数据模型

## SQLite 表

当前核心 schema 包含:

```text
meta
crdt_changes
peers
peer_grants
pairing_codes
databases
properties
records
documents
doc_blocks
sites
site_files
search_fts
```

`search_fts` 是 best-effort FTS5 虚拟表,如果当前 SQLite 不支持 FTS5,搜索会降级到 LIKE。

## meta

`meta(key, value)` 存系统级元数据:

- `node_id`: 当前节点稳定 id。
- `hlc`: 当前节点最后一次 Hybrid Logical Clock。
- `search_seq`: 搜索索引(`search_fts`)已处理到的 `crdt_changes.rowid` 增量游标;`search_index_version`: 索引逻辑版本号(规则变更时 bump → 触发全量重建)。两者取代旧的 `search_hlc`(见 [14-incremental-search-index](../impl-context/14-incremental-search-index/design.md))。
- `current_db`: 「当前数据库」指针(本机 UI 上下文,不进 oplog、不随 sync)。读取时惰性校验所指库是否仍存在,失效则自动清除(见 `src/core/context.ts`)。
- `auth_token` / `auth_token_exp` / `auth_token_prev` / `auth_token_prev_exp`: 持久化的服务器鉴权 token、其过期时刻(epoch ms)、上一代 token 及其可被交换的截止时刻(本机服务器密钥,不进 oplog、不随 sync;见 `src/core/sync/token.ts`、[10-persistent-token](../impl-context/10-persistent-token/design.md))。
- `cfg_host` / `cfg_port` / `cfg_sync_interval` / `cfg_auto_sync`: `mh config` 持久化的服务器级设置(绑定地址、端口、自动同步间隔 ms、自动同步开关),`--server` 启动时作默认值(CLI flag 覆盖);本机配置,不进 oplog、不随 sync(见 `src/core/config.ts`、[11-device-pairing-sync](../impl-context/11-device-pairing-sync/design.md))。

## ID 与引用

新建实体的 id 带**类型前缀**: `<kind>_<slug>-<rand>`(`src/core/ids.ts` 的 `newId`/`idKind`):

```text
db_tasks-a3f9   prop_status-x7p2   rec_fix-login-bug-k2p9   doc_design-9fk3   blk_intro-m4x8
site_blog-7q2k   sf_index-html-9fk3
```

- 前缀↔dataset: `db`/`prop`/`rec`/`doc`/`blk`/`site`/`sf` 对应 `databases`/`properties`/`records`/`documents`/`doc_blocks`/`sites`/`site_files`。
- `slugify` 只产出 `[a-z0-9-]`、`randomSuffix` 只产出 base36——两者都不含 `_`,故 id 中首个 `_` 必是类型分隔符,`idKind` 据此恢复类型;**旧的无前缀 id(无 `_`)读作 null,与新 id 共存**,无需迁移。
- 前缀只是把类型显式带到人/AI/日志眼前;`crdt_changes.row_id`、`records.data` 的 JSON key、`crdt_changes.col` 对 id 不透明,加前缀对 oplog/sync/快照/搜索零影响。

引用解析层(`src/core/resolve.ts`,纯只读)把存储 id 与用户输入的「引用」分离。`resolveRef` / `resolveEntity` / `resolveCandidates` 按以下规则解析:

- **kind 范围**: 命令显式 `kind` 优先;否则按 ref 的类型前缀分派;否则跨 `db/prop/rec/doc`(blk 不参与公共解析)。
- **匹配**: 精确 id(永远可用,跨库亦可) → id 前缀(对 `ref` 原样及 `<kind>_<ref>`,主键范围扫描 `id >= p AND id < p||'{'`,不用 LIKE 以避开 `_` 通配符) → 名字/标题(db.name / doc.title / prop.name 大小写不敏感)。
- **record 名字**: record 无名字列;当解析**限定到某库**(`databaseId` 给定,即 relation 与补全)时,按该库**首个 text 属性的值**(de-facto 标题)匹配。未 scope 的 record 解析仍只按 id/slug 前缀。
- **歧义**: 命中多个则报错并列出候选(git 短 SHA 风格);0 个报 `no such <kind>`。

## crdt_changes

`crdt_changes` 是当前系统的真相源:

```ts
interface Change {
  hlc: string;
  node_id: string;
  dataset: string;
  row_id: string;
  col: string;
  value: string | null;
  txn?: string | null; // 修订分组 id:同一次逻辑变更(一次保存/一次 API 调用)的 changes 共享
}
```

每条 change 表达一个 register assignment。register identity 是:

```text
(dataset, row_id, col)
```

物化时同一 register 中 HLC 最大的 change 胜出。

**oplog 即历史**:表是 append-only(`INSERT OR IGNORE`,旧版本永不覆盖),任意时点 T 的状态 = 每个 register 取 `hlc ≤ T` 的最大值,据此 `src/core/history.ts` 提供修订列表/时点重建/回滚(回滚是正向写入,见 [15-history-rollback-compaction](../impl-context/15-history-rollback-compaction/design.md))。

`txn` 由 `withChangeGroup`/`grouped()`(`crdt.ts`)在公开变更函数边界盖戳,**随 sync 复制**(各端历史聚簇一致);label 前缀 `repair:`/`revert:` 用于推导修订 kind(user/repair/revert)。存量行/旧 peer 的 change 为 NULL,历史聚簇退回 (node_id + 1.5s 间隙) 启发式。存量库经 `migrateOplog`(db.ts)补列。

索引:`idx_changes_hlc(hlc)`;局部索引 `idx_changes_docref(value) WHERE dataset='doc_blocks' AND col='doc_id'` 服务历史的按文档找块(局部是为了不给携带大 value 的 site_files 行建索引)。

**压缩**(`mh compact`,`src/core/compact.ts`):保留窗口(默认 90 天)外每 register 只留"截止点胜者",删除被取代的输家;墓碑胜者必存活、`MAX(rowid)` 行受保护(防 SQLite rowid 复用使 peer 游标跳过新变更)、纯本地不复制。头部物化状态压缩前后逐字节不变;窗口外历史坍缩为基线,配套 blob GC + VACUUM。

## databases

数据库表示一张 Notion-like 表:

```text
databases(id, name, icon, created_hlc, __deleted)
```

当前支持 create/list/get/delete。删除是软删除,写入 `__deleted = 1`。**删除会级联**(删除节点在删除时一次性 emit):其下 properties / records 跟随软删,documents 改为 detach(置空 `database_id`,内容作为独立文档保留)。见下文「完整性约束」。

## properties

属性表示表的一列:

```text
properties(id, database_id, name, type, config, position, __deleted)
```

当前支持类型:

- `text`
- `number`
- `checkbox`
- `select`
- `multi_select`
- `date`
- `relation`
- `url`

当前类型语义:

- `select` 和 `multi_select` 要求 `config.options`。
- `relation` 要求 `config.database`。
- `date` 当前按 string 校验,没有统一规范化。
- `url` 当前按 string 校验,没有 URL 格式校验。
- `relation` 当前存目标 record id 数组,没有反向链接和完整性校验。写入时,relation 值会在**目标库范围内**经引用解析(id/前缀/名字),数组逐个解析;歧义或匹配不到则报错,完整 `rec_` id 直通(前向引用逃生阀)。

## records

记录表示表的一行:

```text
records(id, database_id, created_hlc, order_key, data, __deleted)
```

当前记录字段存储在 `data` JSON 中:

```json
{
  "<property_id>": "<value>"
}
```

设计原因:

- 属性重命名不需要重写记录数据。
- 物化层是一行一条记录,读单条记录不需要 EAV N+1 查询。
- 字段级 CRDT register 仍然保留在 oplog 中。

当前行为:

- 读记录时同时给出两套键:`values` 把 property id 映射回 property name(对人/CLI 友好,但**重名属性时有损**——同名只留一份),`cells` 按 property id 原样给出(无损,WebUI 的读写路径)。
- 写入的 data key 接受属性名或属性 id;名字命中**多个**重名属性时报 `ambiguous`(要求改用属性 id),不做静默 last-wins。重名本身合法(离线并发可产生),`prop add`/改名造成重名时 CLI 仅 stderr warning。
- `duplicateDatabase` 复制记录按**旧→新属性 id 映射**搬单元格(不走 name-keyed,重名列也能无损复制)。
- 删除属性时会**清理孤儿单元格**:`removeProperty` 软删属性的同时,把各记录 JSON 中该属性 key 删掉(`emit(undefined)` 物化为 `json_remove`);若属性 tombstone 经 sync 单独到达,`repairHub` 也会兜底清理(见「完整性约束」)。
- `null` 是合法单元格值。
- CLI 目前没有单独的 unset 命令来删除 JSON key。

## 记录索引

当前实现有按需表达式索引:

```sql
CREATE INDEX IF NOT EXISTS idx_rec_<db>_<prop>
ON records (data ->> '<propid>', created_hlc)
WHERE database_id = '<db>' AND __deleted = 0;
```

触发方式:

- relation 属性创建时会 eager index。
- 大表上首次按某字段 filter/sort 时会 maybe auto-index。

当前限制:

- scalar 等值查询能利用索引。
- array/object/null 查询走 JS 过滤。
- relation 和 multi_select 当前是数组语义,表达式索引与 contains 查询体验尚未对齐。

## documents

文档表示一篇 Markdown 文档:

```text
documents(id, title, body, database_id, parent_id, created_hlc, order_key, __deleted)
```

当前 `body` 是缓存列,不是文档正文的权威来源。对于 block-managed 文档,正文由 `doc_blocks` 重算。

`order_key` 与 records 同为 fractional index,但**作用域按 `parent_id` 分组**(同一父级下的兄弟,`NULL` = 顶层):展示时 `listDocuments` 按 `ORDER BY order_key IS NULL, order_key, created_hlc, id` 排,`NULL` 兜底回落到创建时间,故旧库未回填前顺序不变。`createDocument` 追加到同级末尾;`moveDocument(before|after|into)` 是**唯一**的放置入口——因为 reparent 必然进入新的兄弟作用域,父级与顺序由内部 `placeInSiblings` 一处保持一致。迁移 `migrateDocuments` 幂等回填(按现有 `created_hlc` 顺序),首次拖拽后才真正落键。

删除文档会**级联**:`deleteDocument` 软删自身后,软删其 `doc_blocks`(派生正文)、并把直接子文档 unparent(置空 `parent_id`,作为顶层文档保留)。改 `parent_id`/排序时 core 做防环校验;sync 仍可能合出环,由 `repairHub` 兜底打断(见「完整性约束」)。

## doc_blocks

文档正文的权威数据:

```text
doc_blocks(id, doc_id, text, order_key, blank_after, __deleted)
```

语义:

- 每个 block 有独立 CRDT register。
- `order_key` 使用 fractional index。
- 展示时按 `ORDER BY order_key, id` 排序。
- 正文序列化时块间用单个空行连接。
- `blank_after`(默认 0)记录该块后面**额外**的空行数(超出标准单空行分隔的部分;最后一块则是末尾留白行数)。这让用户刻意留下的竖向间距(段落之间、文末)在 save/reload 后存活,而**不必**把空行表示成零内容的块——零内容块会让基于文本相等的 reconcile 抖动。空行不是独立块,而是相邻块上的间距属性,故并发改间距按块 LWW 干净合并。见 [04-block-level-doc-crdt](../impl-context/04-block-level-doc-crdt/design.md) §2.7。
- WebUI 的文档编辑器会在前端把 Markdown 解析成更丰富的逻辑块树（例如列表项 `children`、代码块 `lang`、有序列表 `start` 起始号）,但这些字段不入库。保存仍写完整 Markdown body,再由 core 按段落/fenced code 重建或 reconcile `doc_blocks`；有序列表起始号通过 Markdown 序号本身往返；空行游程通过 body 里的空行往返(WebUI 把文末/段间空段落映射为空行,core 用 `blank_after` 持久化)。

## peers / peer_grants / pairing_codes

多设备同步的本机表(都不进 oplog、不随 sync;见 [11-device-pairing-sync](../impl-context/11-device-pairing-sync/design.md)):

```text
peers(url PK, pull_cursor, push_cursor, token, label, node_id, enabled, last_sync_at, last_status, last_error)
peer_grants(token PK, peer_url, node_id, created_at)
pairing_codes(code PK, exp, used, created_at)
```

- `peers`(出站):我会同步去的对端。`pull_cursor`/`push_cursor` 是基于 rowid 的复制游标;`token` 是对端配对时签发给我、我出站 `/sync` 时出示的凭据;`enabled` 决定是否进自动同步定时器;`last_*` 为状态。老库经 `migratePeers` 幂等补列。
- `peer_grants`(入站):我签发、并在 `/sync` 上接受的长期 bearer 凭据(`acceptsSyncToken` = 主 token 或命中此表)。`peer_url` 记签发对象,`removePeer` 据此连带吊销;单向配对产生的 `peer_url` 为 null,需 `grant revoke`。**目前无过期**。
- `pairing_codes`:一次性配对码(随机 12 位 base36,默认 10min)。兑换是单条原子 `UPDATE ... WHERE used=0 AND 未过期`(防 TOCTOU 双兑换);生成时清理过期/已用码。

## sites

站点表示一个命名的静态文件桶(由 `mh --server` 在 `/sites/<name>/` serve,见 [08-agent-sites](../impl-context/08-agent-sites/design.md)):

```text
sites(id, name, title, created_hlc, __deleted)
```

- `name` 是 URL slug,`getSiteByName` 取最近创建的未删除站点(同名跨节点合并时按 `created_hlc` 取新)。
- create/list/get/delete(软删),delete 级联软删其下 `site_files`。

## site_files

站点内的单个文件:

```text
site_files(id, site_id, path, content_type, encoding, content, created_hlc, __deleted)
```

- `(site_id, path)` 映射到稳定 id:重复上传同一路径复用该 id,「改文件」是同一 CRDT register 合并而非新行。
- `encoding ∈ {utf8, base64, blob}`:文本(html/css/js/...)存 `utf8`、小二进制存 `base64`(均内联、随 oplog 同步);大于阈值的二进制经 `cache.ts` 的 `putBlob` 内容寻址,`encoding=blob`、`content=<sha256 hash>`。
- **blob 取舍**:blob 字节存 `cache/`,目前不随 oplog 复制(`site_files` 清单照常同步),故跨机时大二进制需另行传输;主用例为文本时可接受。

## 完整性约束(invariant)

schema **刻意只保留主键,不加 FK / UNIQUE**:per-field LWW oplog 需要前向引用(单元格写入可先于父行到达)、并发同名创建都要存活才能收敛、回放必须幂等——这些都会被 SQL 硬约束破坏。因此跨实体引用(`database_id` / `parent_id` / `site_id` / `doc_id`、记录 JSON 的 property key)都是**弱引用**,完整性改在 core 层做**最终一致**的逻辑约束(`src/core/integrity.ts`,见 [13-data-integrity](../impl-context/13-data-integrity/design.md))。

两条贯穿设计的硬性原则:

1. **修复只针对 tombstone,容忍 absence。** 引用目标「查不到」在乱序 sync 下既可能是已删(`__deleted=1`),也可能是尚未到达的前向引用;只有目标存在且 `__deleted=1` 才判定断裂并修复,单纯缺失一律不动(读路径的 `__deleted=0` 过滤已优雅隐藏)。
2. **修复是收敛态的确定性、幂等函数。** winner 用全序 `(created_hlc, id)`;`repairHub` 循环到不动点;所有修复经 `emit()` 复制,故各节点独立修复后既收敛又有效。

两个入口:

- `validateHub(db)`:只读体检,归类问题(`broken_ref` / `orphan_cell` / `dup_path` / `parent_cycle` 可自动修;`dup_name` / `bad_config` 仅报告)。
- `repairHub(db)`:确定性修复可自动修的类别;**绝不 hard-delete 用户内容**——重复 database/property 名只报告,只删派生行(孤儿 cell/block)和路由冗余(同 site 同 path 文件,winner 取 `created_hlc` 最早者,与 `getFileForServe`/`fileIdFor` 读取一致)。

两层协作:删除操作内置**写时级联**(databases/properties/documents,删除节点一次性 emit,是主路径);`repairHub` 是**事后兜底**,处理 sync 引入的坏数据(典型竞态:A 删库时 B 并发往该库建记录)。`repairHub` 在 `restoreSnapshot`(merge + reset)后自动跑一次,并由 `mh doctor` / `mh repair` 手动触发;**不**在每次 sync 后自动跑(避免重扫描与抖动)。

`emit` 置空语义(关键):`emit(...,null)` → JSON `"null"`(把列/单元格置为 null 值);`emit(...,undefined)` → SQL NULL → 物化为 `json_remove`(真正删 key)。孤儿单元格清理必须用 `undefined`,否则 key 残留破坏不动点。

## search_fts

搜索索引:

```text
search_fts(kind, id, database_id, title, body)
```

索引内容:

- document: title + body。
- record: 文本类属性值 group concat 后作为 body。

索引维护为**增量**:搜索前按 `meta.search_seq`(`crdt_changes.rowid` 游标)读取游标之后的新变更,归并出受影响的文档/记录,只删除并重写这些对象的 FTS 行。全量重建仅作兜底:首次建索引、`search_index_version` 升级、快照 reset、或手动修复(`rebuildSearchIndex`)。删库/删属性经级联产生的 `__deleted` 变更也会经增量路由自动从索引移除。详见 [14-incremental-search-index](../impl-context/14-incremental-search-index/design.md)。
