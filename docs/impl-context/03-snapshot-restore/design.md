# Snapshot/Restore 数据打包与恢复 设计文档

承接 [01-init-basic-func/design.md](../01-init-basic-func/design.md)（CRDT oplog 为真相源、blob 内容寻址、FTS 懒重建）。本文记录新增 `mh snapshot` / `mh restore` 一对命令的设计：把当前 metahub 数据**打成一个可移植的包文件**，并支持从包文件**恢复**。

## 1. 背景与目标

metahub 此前没有备份/迁移能力。数据全部落在 `~/.metahub/`（或 `$METAHUB_HOME`）：SQLite 库 `metahub.db`（WAL 模式）+ 内容寻址 blob 目录 `cache/`。诉求：

- 一条命令把整个知识库打成**单个文件**（便于提交、移动、分享）。
- 一条命令把该文件恢复回来。

## 2. 设计要点

### 2.1 "完整的包" 等于什么（关键）

依赖 01 已确立的两条事实，把"备份全库"收敛成四样东西：

- **`crdt_changes` oplog 是唯一真相源。** 所有域表（`databases` / `properties` / `records` / `record_values` / `documents`）都是把 oplog 经 `applyChange`/`ingest` 回放出来的**物化视图**。因此只需导出 oplog，再用既有的 `ingest()` 回放，即可重建全部数据——无需逐表导出。
- **身份与时钟**在 `meta` 表（`node_id`、`hlc`）；同步游标在 `peers` 表。
- **blob 不在 oplog 里**——它们是 `cache/` 下以 sha256 命名的文件。完整的包必须**单独**捎带它们。
- **FTS 搜索索引会懒重建**（`src/core/search.ts` 的 `ensureIndex` 比较 `meta.search_hlc` 与 `MAX(hlc)`）。恢复时可以完全忽略 `search_fts`/`search_hlc`，下次 `mh search` 自动重建。

⇒ 包内容 = **oplog changes + meta(node_id,hlc) + peers + blobs**。

### 2.2 包格式：单文件 gzip JSON（`.mhpack`）

```jsonc
{
  "format": "metahub-snapshot",
  "version": 1,
  "createdAt": "...ISO...",
  "source":  { "node_id": "...", "hlc": "..." },
  "counts":  { "changes": N, "blobs": N },
  "meta":    { "node_id": "...", "hlc": "..." },
  "peers":   [ { "url", "pull_cursor", "push_cursor" } ],
  "changes": [ { "hlc","node_id","dataset","row_id","col","value" }, ... ],
  "blobs":   { "<sha256>": "<base64>" }
}
```

`Bun.gzipSync(JSON.stringify(...))` → 写文件。单个自包含文件即"打成一个包"。

### 2.3 两种恢复语义（flag 控制）

```
mh restore <file>            # merge（默认，安全）
mh restore <file> --reset    # replace（破坏性，需配 --force）
```

- **merge（默认）**：把包里的 oplog 用 `ingest()` 回放进现有库。**幂等**、按 HLC 最后写入者胜（LWW），不删任何东西；本地 `meta`/`peers` 不动（`ingest` 内部 `observeHlc` 已把本地时钟推过来时的 HLC，避免碰撞）。适合：新机/空库恢复、重复应用、合并两个库。
- **reset（`--reset`）**：清空并重建到与包**完全一致**，即真正的回滚。破坏性，因此**先自动存一份当前状态的安全快照**（`~/.metahub/.pre-restore-<ts>.mhpack`），且必须再加 `--force` 确认。

### 2.4 命令形态

两个顶层命令 + 显式文件路径（不做托管式 stash 栈）。简单、可脚本化，与 `--json` 配合良好。

## 3. 取舍

- **blob 以 base64 内嵌进单文件**：当前规模（本地知识库）下足够；超大 blob 场景再换流式/tar 容器（YAGNI）。
- **reset 不删旧 blob**：旧状态的孤儿 blob 留在 `cache/`（内容寻址、无害）；真正的数据（oplog）是精确一致的。
- **恢复保留身份**：reset 把 `node_id`/`hlc` 设回包里的值，契合"同机回滚"语义；不做"克隆到新身份"（未来若需要再加 `--new-node`）。
- **确认机制用 `--reset --force` 双 flag**：仓库内无交互式 prompt 工具，故不引入；缺 `--force` 时直接 `fail` 并给出提示。
- **不做按库/部分快照**：包即整库。
