# 当前数据模型

## SQLite 表

当前核心 schema 包含:

```text
meta
crdt_changes
peers
peer_grants
pairing_codes
storage_cursors
shares
databases
properties
records
documents
doc_blocks
sites
site_files
blob_cache
blob_policy
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

表还有一个显式主键 `seq INTEGER PRIMARY KEY AUTOINCREMENT`,是**复制游标**依据(peer 的 pull/push 按 `seq` 单调推进,永不回退)。旧库经 `migrateCrdtChangesSeq`(schema-init.ts)补 `seq`。有了声明式 `seq`,过去"保护 `MAX(rowid)` 行防 rowid 复用"的做法退化为**纯防御性下限**、不再是承重逻辑。

**oplog 即历史**:表是 append-only(`INSERT OR IGNORE`,旧版本永不覆盖),任意时点 T 的状态 = 每个 register 取 `hlc ≤ T` 的最大值,据此 `src/core/history.ts` 提供修订列表/时点重建/回滚(回滚是正向写入,见 [15-history-rollback-compaction](../impl-context/15-history-rollback-compaction/design.md))。

`txn` 由 `withChangeGroup`/`grouped()`(`crdt.ts`)在公开变更函数边界盖戳,**随 sync 复制**(各端历史聚簇一致);label 前缀 `repair:`/`revert:` 用于推导修订 kind(user/repair/revert)。存量行/旧 peer 的 change 为 NULL,历史聚簇退回 (node_id + 1.5s 间隙) 启发式。存量库经 `migrateOplog`(schema-init.ts)补列。

索引:`idx_changes_hlc(hlc)`;局部索引 `idx_changes_docref(value) WHERE dataset='doc_blocks' AND col='doc_id'` 服务历史的按文档找块(局部是为了不给携带大 value 的 site_files 行建索引)。

**压缩**(`mh compact`,`src/core/compact.ts`):保留窗口(默认 90 天)外每 register 只留"截止点胜者",删除被取代的输家;墓碑胜者必存活、`MAX(rowid)` 行受保护(防 SQLite rowid 复用使 peer 游标跳过新变更)、纯本地不复制。头部物化状态压缩前后逐字节不变;窗口外历史坍缩为基线,配套 blob GC + VACUUM。

## databases

数据库表示一张 Notion-like 表:

```text
databases(id, name, icon, meta, created_hlc, __deleted)
```

当前支持 create/list/get/**duplicate**/**update**/delete。删除是软删除,写入 `__deleted = 1`。**删除会级联**(删除节点在删除时一次性 emit):其下 properties / records 跟随软删,documents 改为 detach(置空 `database_id`,内容作为独立文档保留)。见下文「完整性约束」。

`meta` 是**通用复制元数据**:一个 JSON 对象的**整对象 LWW 寄存器**(登记进 `crdt.ts` 的 `DOMAIN`:`databases` 列 = `name/icon/meta/created_hlc/__deleted`)。设计上**领域中立**——消费方自定义 key(当前唯一用例是 WebUI 侧栏的 `collapsed` 折叠标记)。`updateDatabase` 写入时校验必须是 JSON 对象或 null;`getDatabase`/`listDatabases` 经 `rowOut` 把列里的 JSON 串 `JSON.parse` 回对象。旧库经 `migrateDatabases`(schema-init.ts)加列并**从赢家 oplog 回填**(按最大 HLC 取该库 `meta` 变更的胜者,与 `applyChange` 的 LWW 规则一致),使升级后看到 peer 早已达成的状态。
> ⚠️ 整对象寄存器:两个离线设备各写**不同** key 时,各自 emit 的完整对象都缺对方 key,LWW 会静默丢一个(结构性丢更新)。当前仅 `collapsed` 一个 key 故潜伏;第二个 key 落地前应改为**按 key 分寄存器**(见 `databases.ts` 的 `TODO(meta-per-key)`)。

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
- WebUI 的文档编辑器(**CodeMirror 6**)里,文档**就是**一份 Markdown 文本;"块"是从这份文本派生的扁平展示模型(装饰/void 组件),富字段(代码块 `lang`、有序列表起始号、自由块 `indent` 等)**不入库**。保存写完整 Markdown body(`getDoc()`),再由 core 按段落/fenced code reconcile 成 `doc_blocks`;有序列表起始号通过 Markdown 序号本身往返;空行游程通过 body 里的空行往返(编辑器把文末/段间空段落映射为空行,core 用 `blank_after` 持久化)。CM6 架构、派生块模型、Markdown 往返规则、渲染结构与导航详见 [webui-editor.md](./webui-editor.md)。

## peers / peer_grants / pairing_codes

多设备同步的本机表(都不进 oplog、不随 sync;见 [11-device-pairing-sync](../impl-context/11-device-pairing-sync/design.md)):

```text
peers(url PK, kind, config, pull_cursor, push_cursor, token, label, node_id, enabled, last_sync_at, last_success_at, last_status, last_error)
peer_grants(token PK, peer_url, node_id, created_at)
pairing_codes(code PK, exp, used, created_at)
storage_cursors(peer_url, node_id, last_key)     -- S3 转发的每桶/每远端节点拉取进度
```

- `peers`(出站):我会同步去的对端。`kind`(默认 `'http'`;`'s3'` = 对象存储桶转发)选传输,`config`(JSON)持该传输的参数(桶端点/前缀等,S3 用)。`pull_cursor`/`push_cursor` 是基于 `crdt_changes.seq` 的复制游标;`token` 是对端配对时签发给我、我出站 `/sync` 时出示的凭据;`enabled` 决定是否进自动同步定时器;`last_sync_at` 是最近尝试,`last_success_at` 是最近成功(读前 freshness 只看它),`last_status/error` 为状态。老库经 `migratePeers` 幂等补列(含 `kind`/`config`)。
- `storage_cursors`(S3 store-and-forward):挂了对象存储桶(`kind='s3'`)时,按**每桶 × 每远端节点**记拉取进度 `last_key`——桶是数据盲的转发中继,各设备把变更推上去、按 key 拉下来,无需两端同时在线。见 [17-s3-storage-sync](../impl-context/17-s3-storage-sync/design.md)。
- `peer_grants`(入站):我签发、并在 `/sync` 上接受的长期 bearer 凭据(`acceptsSyncToken` = 主 token 或命中此表)。`peer_url` 记签发对象,`removePeer` 据此连带吊销;单向配对产生的 `peer_url` 为 null,需 `grant revoke`。**目前无过期**。
- `pairing_codes`:一次性配对码(随机 12 位 base36,默认 10min)。兑换是单条原子 `UPDATE ... WHERE used=0 AND 未过期`(防 TOCTOU 双兑换);生成时清理过期/已用码。

## shares

公开分享链接的本机表(**node-local、故意不进 `crdt.ts` 的 `DOMAIN`、永不随 sync**——分享是"这台设备对外发布"的本机决定;见 `src/core/shares.ts`、[17-s3-storage-sync](../impl-context/17-s3-storage-sync/design.md)):

```text
shares(slug PK, kind, target_id, permission, transport, pw_salt, pw_hash,
       expires_at, guest_node_id, served_base, created_at, s3_* …)
```

- `kind ∈ {doc, database, site}` + `target_id` 指向被分享实体;`permission ∈ {view, edit}`(`edit` 仅 `transport='server'`);`transport ∈ {server, s3}`。
- `pw_salt`/`pw_hash`:可选密码(base64 PBKDF2 verifier,server 路径);`expires_at`:过期 epoch ms(null=永不)。
- `guest_node_id`:edit 分享给 guest 写入用的合成 node id(view 为 null,guest 写入归属独立节点)。`served_base`:创建时选定的可达 base URL(链接/来源标签)。
- `s3_*` 列为遗留字段(s3 分享实际活在桶里,不在此表)。SSR 渲染见 `share-render.ts`/`share-serve.ts`(`/share/<slug>`)。

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
- `encoding ∈ {utf8, base64, blob}`:文本(html/css/js/svg/...)存 `utf8`、小号非图片二进制存 `base64`(内联、随 oplog 同步);**图片(image/* 除 svg)一律**、其余超阈值二进制经 `cache.ts` 的 `putBlob` 内容寻址,`encoding=blob`、`content=<hash>`(规范 hash = sha256 截短 32 hex;旧 64-hex 引用仍可解,寻址长度无关)。
- **blob 字节**:存节点本地 `cache/`,**不进 oplog**;`site_files` 清单(含 hash)照常同步,字节**按需**经 blob 传输层取回(`GET /blob/<hash>`:本地 cache → HTTP peer → 桶)。见 [22-blob-sync](../impl-context/22-blob-sync/design.md)。

## blob_cache / blob_policy

blob 字节层(文档插图 / 大文件)的账本与策略(见 [22-blob-sync](../impl-context/22-blob-sync/design.md))。`blob_cache` 本地;`blob_policy` 随 oplog 同步、登记进 `crdt.ts` 的 `DOMAIN`。

```text
blob_cache(hash PK, size, content_type, last_access, pinned, pending, anchored)  -- node-local,不进 DOMAIN
blob_policy(id="default", full_nodes, redundancy, __deleted)                      -- 同步,单行
```

- `blob_cache`:给内容寻址的裸文件(`cache/<hash>`)配元数据;**仅本地**,像 `peers`/`storage_cursors` 一样不入 oplog。
  - `pending`:本机**产出**、尚未确认 flush 到锚(桶/全量设备)的字节——**唯一必须保护**的。产出置 1,flush 成功(`blobMaintenance`)置 0;**取得的缓存直接置 0**。
  - `pinned`:用户「离线保留」,永不自动淘汰/清理。
  - `anchored`:该 hash 已确认在**锚**(全量设备/桶)上有副本——由按需的 presence-verify 依 `blob_policy.redundancy` 策略置位(`setAnchored`/`clearAnchored`,`blobs.ts`/`blobs-core.ts`)。
  - **可清判定**:`isClearable(hash)` = `pending===0 && anchored===1`(`blobs-core.ts`)—— **纯本地、可离线、零网络**。`pending` 是对本机**自己动作**的认知(自产、尚未确认 flush 到锚,唯一必护),永不过期;`anchored` 保证清了还能重取。**此本地模型取代了旧的同步 `blob_presence` 表**(已删):presence 缓存远端真相必然过期(假性可清)。
- `blob_policy`:工作区级策略——`full_nodes`(JSON node_id 数组,指定 1~N 台**全量设备 = durable 锚**:永不清 + pull 全量,无桶拓扑的落点);`redundancy`(`all`/`any`,`mh cache redundancy` 写)决定 presence-verify 判 `anchored` 时需要**全部/任一**全量设备在场。

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
