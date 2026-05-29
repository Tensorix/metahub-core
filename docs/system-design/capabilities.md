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

## 引用与当前库

已实现:

```bash
mh use [<db-ref>] [--clear]     # 设置/显示「当前库」;record/prop 默认作用于它
mh get <ref>                     # 通用查找:按 id/前缀/名字解析,自动判别类型
```

当前体验:

- 凡接受 id 的参数(`get`/`update`/`delete`/`--db`/`--parent`/`--target` 及 relation 值)都接受**引用**:完整 id、唯一前缀、名字/标题。
- `mh use <db>` 后,`record`/`prop` 命令免带库参数,引用与列举自动限定在该库内。
- 引用歧义时报错并列出候选(git 短 SHA 风格),不会静默误选。
- 详见 [data-model.md](./data-model.md) 的「ID 与引用」。

## 数据库和属性

已实现:

```bash
mh db create <name> [--icon]
mh db list
mh db get <ref>
mh db delete <ref>

mh prop add <name> --type <type> [--db <db>] [--options a,b] [--target <db>] [--config JSON] [--position N]
mh prop list [<db>]
mh prop update <ref> [--name] [--options] [--target] [--config] [--position]
mh prop remove <ref>
```

当前体验:

- 可以手动创建 Notion-like 表结构。
- 属性支持类型和基本配置校验。
- `prop add` 的库用 `--db` 指定(默认当前库);`prop list` 的库可省略(默认当前库)。
- 属性名当前没有唯一性约束,同名属性会造成引用歧义,但解析时会报错列候选而非静默误选。

## 记录

已实现:

```bash
mh record create [<db>] --data '{"field":"value"}'      # db 省略时用当前库
mh record list [<db>] [--filter '{"field":"value"}'] [--sort field] [--desc] [--limit N]
mh record get <ref>
mh record update <ref> --data '{"field":"value"}'
mh record delete <ref>
```

当前查询能力:

- 支持按字段等值过滤。
- 支持单字段排序。
- 支持 limit。
- 支持属性名或属性 id 作为 data key。
- 支持 select/multi_select 的 options 校验。
- record 的 `<ref>` 支持完整 id 或唯一前缀(跨库;不按当前库 scope,以保证完整 id 始终可用)。
- relation 字段的值接受引用(在目标库内按 id/前缀/名字解析,数组逐个;完整 `rec_` id 直通)。

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
mh doc create --title <title> [--body @file] [--db <db-ref>] [--parent <doc-ref>]
mh doc list [--db <db-ref>]
mh doc get <doc-ref>
mh doc update <doc-ref> [--title] [--body]
mh doc delete <doc-ref>
```

AI 增量编辑:

```bash
mh doc read <doc-ref>
mh doc edit <doc-ref> --old "old text" --new "new text" [--replace-all] [--if-match <version>]
mh doc append <doc-ref> --body "markdown"
mh doc prepend <doc-ref> --body "markdown"
```

文档引用 `<doc-ref>` 支持完整 id、唯一前缀或标题。`--db`/`--parent` 同样接受引用;文档可独立存在(`--db` 不默认当前库)。

当前体验:

- `doc read` 返回正文和 version token。
- `doc edit` 要求 old text 精确匹配,适合 AI read-before-edit。
- 文档正文按 block 存储,不同 block 的并发编辑可以保留。

## 人类编辑器

已实现:

```bash
mh edit <ref>                 # 文档或记录引用(id/前缀/名字)
mh edit <ref> --vscode
mh edit <ref> --editor zed
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

## Shell 补全

已实现:

```bash
mh completion <bash|zsh|fish>     # 打印补全脚本: eval "$(mh completion zsh)"
mh __complete <kind|any> <prefix> # (内部)补全脚本回调,逐行返回候选 id
```

当前能力:

- 补全脚本按子命令推断要补的类型(db/rec/doc/prop),回调 `__complete` 实时查库。
- rec/prop 候选按当前库 scope;doc 列全部(可独立/跨库)。

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

