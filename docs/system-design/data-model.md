# 当前数据模型

## SQLite 表

当前核心 schema 包含:

```text
meta
crdt_changes
peers
databases
properties
records
documents
doc_blocks
search_fts
```

`search_fts` 是 best-effort FTS5 虚拟表,如果当前 SQLite 不支持 FTS5,搜索会降级到 LIKE。

## meta

`meta(key, value)` 存系统级元数据:

- `node_id`: 当前节点稳定 id。
- `hlc`: 当前节点最后一次 Hybrid Logical Clock。
- `search_hlc`: FTS 已索引到的 oplog 水位。

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

当前支持 create/list/get/delete。删除是软删除,写入 `__deleted = 1`。

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
- `relation` 当前存目标 record id 数组,没有反向链接和完整性校验。

## records

记录表示表的一行:

```text
records(id, database_id, created_hlc, data, __deleted)
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
- 删除属性后,旧记录 JSON 中对应 key 会被读取层跳过。
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

## search_fts

搜索索引:

```text
search_fts(kind, id, database_id, title, body)
```

索引内容:

- document: title + body。
- record: 文本类属性值 group concat 后作为 body。

当前索引重建策略是全量重建,不是增量更新。

