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
- `search_hlc`: FTS 已索引到的 oplog 水位。
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
}
```

每条 change 表达一个 register assignment。register identity 是:

```text
(dataset, row_id, col)
```

物化时同一 register 中 HLC 最大的 change 胜出。

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

- 读记录时把 property id 映射回 property name。
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
documents(id, title, body, database_id, parent_id, created_hlc, __deleted)
```

当前 `body` 是缓存列,不是文档正文的权威来源。对于 block-managed 文档,正文由 `doc_blocks` 重算。

删除文档会**级联**:`deleteDocument` 软删自身后,软删其 `doc_blocks`(派生正文)、并把直接子文档 unparent(置空 `parent_id`,作为顶层文档保留)。改 `parent_id` 时 core 做防环校验;sync 仍可能合出环,由 `repairHub` 兜底打断(见「完整性约束」)。

## doc_blocks

文档正文的权威数据:

```text
doc_blocks(id, doc_id, text, order_key, __deleted)
```

语义:

- 每个 block 有独立 CRDT register。
- `order_key` 使用 fractional index。
- 展示时按 `ORDER BY order_key, id` 排序。
- 正文序列化时用空行连接 blocks。
- WebUI 的文档编辑器会在前端把 Markdown 解析成更丰富的逻辑块树（例如列表项 `children`、代码块 `lang`、有序列表 `start` 起始号）,但这些字段不入库。保存仍写完整 Markdown body,再由 core 按段落/fenced code 重建或 reconcile `doc_blocks`；有序列表起始号通过 Markdown 序号本身往返。

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

当前索引重建策略是全量重建,不是增量更新。
