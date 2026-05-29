# 当前使用流程

本文只描述当前代码已经支持的用户体验,不描述理想最终形态。

## 记账数据当前流程

当前没有 `ledger` 专用命令,需要用通用数据表手动搭建。

### 1. 建表

```bash
mh init
mh db create "Transactions"
mh prop add <dbId> date --type date
mh prop add <dbId> amount --type number
mh prop add <dbId> category --type select --options food,transport,shopping,other
mh prop add <dbId> account --type text
mh prop add <dbId> note --type text
```

### 2. 写入一笔流水

```bash
mh record create <dbId> --data '{
  "date": "2026-05-29",
  "amount": -38.5,
  "category": "food",
  "account": "alipay",
  "note": "coffee"
}'
```

### 3. 查询流水

当前可做:

```bash
mh record list <dbId> --filter '{"category":"food"}' --sort date --desc --limit 20
mh record get <recordId>
mh record update <recordId> --data '{"category":"transport"}'
mh search "coffee"
```

### 当前体验结论

已可完成:

- 手动建记账表。
- 单条写入。
- 按分类等值过滤。
- 按日期字段排序。
- 通过全文搜索找备注。

还不能完成:

- 按月份范围查询。
- 按分类汇总支出。
- CSV/JSONL 批量导入。
- 自动去重。
- 低置信度 review。
- merchant/category 规则。

所以当前记账体验是“通用表 MVP”,不是完整记账 Agent 体验。

## IM 历史消息当前流程

当前没有 `chat` 专用命令,需要用通用数据表手动搭建。

### 1. 建 messages 表

```bash
mh db create "Messages"
mh prop add <dbId> conversation --type text
mh prop add <dbId> sender --type text
mh prop add <dbId> sent_at --type date
mh prop add <dbId> text --type text
mh prop add <dbId> source --type text
mh prop add <dbId> message_id --type text
```

### 2. 写入消息

```bash
mh record create <dbId> --data '{
  "conversation": "alice",
  "sender": "Alice",
  "sent_at": "2026-05-29T10:00:00Z",
  "text": "发票发你了",
  "source": "wechat",
  "message_id": "wechat_001"
}'
```

### 3. 查询消息

当前可做:

```bash
mh record list <dbId> --filter '{"conversation":"alice"}' --sort sent_at --desc --limit 50
mh search "发票"
```

### 当前体验结论

已可完成:

- 手动建消息表。
- 单条写入消息。
- 按 conversation 等值过滤。
- 按 sent_at 排序取最近消息。
- 全文搜索消息文本。

还不能完成:

- 批量导入平台导出文件。
- message_id 去重或 upsert。
- 时间范围查询。
- 搜索后查看前后上下文。
- 按 conversation title/member 做关系查询。
- cursor pagination。

所以当前 IM 体验适合 demo 和小规模手动写入,还不适合真实历史消息归档。

## 文档当前流程

文档能力相对完整。

### 1. 创建和读取

```bash
mh doc create --title "架构说明" --body @arch.md
mh doc list
mh doc get <docId>
mh search "架构"
```

### 2. AI 增量编辑

```bash
mh doc read <docId>
mh doc edit <docId> --old "旧文本" --new "新文本"
mh doc append <docId> --body "追加段落"
```

### 3. 人类编辑

```bash
mh edit <docId>
mh edit <docId> --vscode
```

### 当前体验结论

已可完成:

- Markdown 文档 CRUD。
- AI read-before-edit。
- 锚定替换。
- append/prepend。
- 人类编辑器编辑。
- block-level CRDT 合并不同段落编辑。

还不能完成:

- 根据 block id 或行号精确编辑。
- 返回具体 changed block。
- 富附件引用和 blob 同步。

## 快照和同步当前流程

### 快照

```bash
mh snapshot backup.mhpack
mh restore backup.mhpack
mh restore backup.mhpack --reset --force
```

### 同步

```bash
mh --server --port 7777
mh sync http://host:7777
```

当前体验结论:

- 可用于备份、迁移和简单多节点同步。
- 命令形态偏工程化。
- 对普通用户还缺少状态解释、冲突说明和同步历史。

