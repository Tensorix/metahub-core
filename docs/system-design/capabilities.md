# 当前功能能力

## 初始化

已实现:

```bash
mh init
```

效果:

- 创建 `METAHUB_HOME` 或 `~/.metahub`。
- 创建 SQLite schema。
- 创建 cache 目录。
- 初始化或读取 node id。

## 数据库和属性

已实现:

```bash
mh db create <name> [--icon]
mh db list
mh db get <id>
mh db delete <id>

mh prop add <db> <name> --type <type> [--options a,b] [--target <db>] [--config JSON] [--position N]
mh prop list <db>
mh prop update <id> [--name] [--options] [--target] [--config] [--position]
mh prop remove <id>
```

当前体验:

- 可以手动创建 Notion-like 表结构。
- 属性支持类型和基本配置校验。
- 属性名当前没有唯一性约束,同名属性会造成 CLI 输入歧义。

## 记录

已实现:

```bash
mh record create <db> --data '{"field":"value"}'
mh record list <db> [--filter '{"field":"value"}'] [--sort field] [--desc] [--limit N]
mh record get <recordId>
mh record update <recordId> --data '{"field":"value"}'
mh record delete <recordId>
```

当前查询能力:

- 支持按字段等值过滤。
- 支持单字段排序。
- 支持 limit。
- 支持属性名或属性 id 作为 data key。
- 支持 select/multi_select 的 options 校验。

当前未实现:

- range 查询,例如 date between、amount gt/lt。
- contains 查询,例如 tag contains、relation contains、text contains。
- 多条件逻辑 DSL,例如 AND/OR。
- 聚合,例如 sum amount、group by category。
- cursor pagination。
- bulk create/import。
- 去重键或 upsert。

## 文档

已实现:

```bash
mh doc create --title <title> [--body @file]
mh doc list [--db <db>]
mh doc get <docId>
mh doc update <docId> [--title] [--body]
mh doc delete <docId>
```

AI 增量编辑:

```bash
mh doc read <docId>
mh doc edit <docId> --old "old text" --new "new text" [--replace-all] [--if-match <version>]
mh doc append <docId> --body "markdown"
mh doc prepend <docId> --body "markdown"
```

当前体验:

- `doc read` 返回正文和 version token。
- `doc edit` 要求 old text 精确匹配,适合 AI read-before-edit。
- 文档正文按 block 存储,不同 block 的并发编辑可以保留。

## 人类编辑器

已实现:

```bash
mh edit <docId>
mh edit <recordId>
mh edit <id> --vscode
mh edit <id> --editor zed
```

当前体验:

- 文档用 Markdown 临时文件编辑。
- 记录用 `Field: JSONValue` 表单编辑。
- GUI 编辑器已内置 wait 参数映射。

当前限制:

- record 表单不适合复杂多行值。
- raw editor command 使用简单空格拆分。

## 搜索

已实现:

```bash
mh search <query> [--limit N]
```

当前能力:

- 搜索文档 title/body。
- 搜索记录中的文本类字段。
- FTS5 优先,LIKE 兜底。

当前未实现:

- 限定 database。
- 限定 document/record 类型。
- 返回 record 命中字段。
- IM 消息 around context。
- 语义检索。

## 快照和恢复

已实现:

```bash
mh snapshot <out.mhpack>
mh restore <file.mhpack>
mh restore <file.mhpack> --reset --force
```

当前能力:

- 快照包含 oplog、meta、peers 和 cache blobs。
- 默认 restore 是 merge。
- reset 前会保存安全快照。

## 同步

已实现:

```bash
mh --server --port 7777
mh sync http://host:7777
```

当前能力:

- 一轮 push/pull。
- 基于 rowid cursor 防止 HLC 漂移漏同步。
- 通过 CRDT oplog 最终一致。

当前未实现:

- 大批量分页同步。
- 冲突解释或用户可见 diff。
- blob 按需同步协议。

## 输出模式

当前输出规则:

- stdout 是 TTY 时偏人类可读。
- 非 TTY 时输出紧凑 JSON。
- `--json` 强制 JSON。
- `--pretty` 强制人类输出。

当前限制:

- `--json`/`--pretty` 是通过扫描 `process.argv` 实现,不是正式 root command schema。
- JSON envelope 尚未统一成稳定的 `{ok,data,error}` 结构。

