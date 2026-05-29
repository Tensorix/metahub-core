# 目标差距与用户体验优先级

本文按用户体验整理优先级。当前阶段暂不讨论同步安全性和并发写锁。

## 产品目标

Metahub 的目标不是只做一个 SQLite 包装 CLI,而是为 AI Agent 和人类用户提供一套通用本地数据与文档操作层:

- 简单数据需求可以快速建表和查询。
- 复杂但常见的数据需求,例如记账和 IM 历史消息,可以通过通用表结构和通用查询能力覆盖。
- AI 可以稳定读 schema、写数据、查数据、修正文档。
- 人类可以用直观命令和编辑器完成相同数据的查看和修正。

## 已改善: ID 引用体验

原硬伤「每次都要粘贴完整 id、id 不带类型(`test-abc` 分不清 db/rec/doc)、record 操作重复带库 id」已通过友好 ID 特性解决(见 [data-model.md](./data-model.md) 的「ID 与引用」、`docs/impl-context/06-friendly-ids/design.md`):

- 类型前缀 id(`<kind>_…`)使 id 自解释。
- 引用解析层支持完整 id / 唯一前缀 / 名字。
- `mh use <db>` 提供当前库上下文;relation 值也按引用解析。
- 歧义报错列候选(git 风格),不静默误选。
- `mh completion` 提供 Tab 补全。

## P0: 当前体验硬伤

### 属性名唯一性

当前同一 database 下可以创建重复属性名。引用解析遇到重名时已会**报错列候选**(不再静默误选),但仍缺少硬约束。

建议:

- 默认禁止同库重复属性名。
- 或者继续依赖解析层的歧义报错 + 要求使用 property id / 更长前缀。

### 友好参数错误

当前非法 `--limit` 可能冒出 SQLite `datatype mismatch`。JSON parse、未知字段、类型错误也需要更稳定的错误结构。

建议:

- CLI 层先校验 number 参数。
- 错误返回稳定 code,例如 `INVALID_LIMIT`、`UNKNOWN_PROPERTY`、`TYPE_MISMATCH`。

### 明确 unset 语义

当前 CLI 可以写 `null`,但不能表达删除单元格 key。

建议:

```bash
mh record unset <recordId> <field>
```

或:

```bash
mh record update <recordId> --unset fieldA,fieldB
```

### 当前状态文档持续维护

旧文档中仍有 EAV、整文档 LWW、`record_values` 等过期描述。后续应以本目录作为当前事实入口。

## P1: 通用表查询体验

这是记账和 IM 两个目标场景的共同基础。

### 查询 DSL

当前只有 `{field:value}` 等值过滤。

建议新增:

```json
{
  "date": { "between": ["2026-05-01", "2026-05-31"] },
  "amount": { "lt": 0 },
  "category": { "in": ["food", "transport"] },
  "tags": { "contains": "invoice" },
  "text": { "contains": "发票" }
}
```

### multi_select / relation contains

当前数组字段按 JSON 完全相等比较,不符合 Notion-like 使用预期。

建议:

- multi_select 支持 contains/contains-all/contains-any。
- relation 支持 contains record id。

### 稳定分页

IM 场景不能只依赖 `--limit 50`。

建议:

- 支持 cursor。
- cursor 至少包含 sort field + record id tie-break。

### 日期规范化

当前 date 是 string。

建议:

- 写入时规范化为 ISO。
- query DSL 对 date range 做明确比较。

## P2: 记账体验

### 内置模板

未实现:

```bash
mh template use bookkeeping --name personal-ledger
```

建议 transactions 表至少包含:

- date
- amount
- currency
- account
- category
- counterparty
- note
- source
- source_id
- raw_text
- tags
- confidence

### 聚合查询

记账必须支持:

```bash
mh record query transactions --where '{...}' --sum amount --group-by category
```

或领域命令:

```bash
mh ledger summary --month 2026-05
```

### 导入和去重

未实现:

- CSV 导入。
- JSONL 导入。
- source_id 去重。
- upsert。

## P3: IM 历史消息体验

### 内置模板

未实现:

```bash
mh template use chat-log --name im-history
```

建议至少包含:

- conversations 表。
- messages 表。
- messages.conversation 关联 conversations。
- message_id/source 去重字段。

### 批量导入

未实现:

```bash
mh record bulk-create messages --jsonl @messages.jsonl
```

### 搜索后回上下文

IM 搜索结果需要支持:

```bash
mh chat around <messageId> --before 20 --after 20
```

通用表层可以先支持:

- 按 conversation + sent_at 查询前后消息。
- 搜索结果返回 message id、conversation、sender、sent_at、snippet。

## P4: AI Agent 操作体验

### Schema introspection

当前 Agent 要通过多个命令拼 schema。

建议:

```bash
mh db describe <dbId>
```

返回:

- database 信息。
- properties。
- 类型配置。
- 示例 create payload。
- 可用 query operators。

### 稳定 JSON envelope

建议所有机器输出统一成:

```json
{
  "ok": true,
  "data": {},
  "meta": {}
}
```

错误:

```json
{
  "ok": false,
  "error": {
    "code": "UNKNOWN_PROPERTY",
    "message": "unknown property: foo"
  }
}
```

### 批量操作

Agent 导入 IM 和账单时需要批量写:

- bulk-create。
- bulk-update。
- upsert by unique key。

## P5: 人类表格体验

建议:

- `record list --columns date,amount,category,note`。
- CJK 宽度正确的表格输出。
- 复杂字段可折叠显示。
- CSV/JSONL export。
- `prop rename`、`prop reorder` 等直观命令。

