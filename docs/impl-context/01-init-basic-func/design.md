# Metahub 设计文档

## 1. 背景与目标

Metahub 是一个**给 AI 用的本地知识库 CLI**。核心诉求：

- 在用户目录 `~/.metahub/` 下，用一个 SQLite 数据库 + 一个 `cache/` 目录承载数据。
- 提供 notion 风格的数据：**类型化数据库（表 + 类型化列 + 行记录）** 与 **markdown 文档**。
- 主要消费方是 AI：CLI 子命令默认输出 **JSON**；同时兼顾人类直接阅读/编辑。
- 既能单机离线使用，也能通过简单的 C-S 服务端在多机之间同步，采用 **CRDT 最终一致**。

交付形态：库 + CLI + 独立二进制三合一（基于 Bun）。

## 2. 整体架构

```
            ┌──────────────────────────────┐
   AI / 人  │            CLI (citty)        │  JSON / 表格(TTY 自适应)
  ────────▶ │  init db prop record doc      │
            │  edit search sync --server    │
            └───────────────┬──────────────┘
                            │ 复用同一套 core
            ┌───────────────▼──────────────┐
            │             core              │
            │  域逻辑: databases/properties │
            │          records/documents    │
            │  search / cache               │
            │  ┌─────────────────────────┐  │
            │  │ CRDT: hlc + oplog + 物化 │  │  ← 所有写入都走这里
            │  └─────────────────────────┘  │
            │  sync: protocol/server/client │
            └───────────────┬──────────────┘
                            │ bun:sqlite
                    ~/.metahub/metahub.db + cache/
```

- **所有写入**（建库、加列、改记录单元格、改文档正文、删除）都被表达为 CRDT 字段赋值，先进 oplog，再物化到域表。
- **域表**是 oplog 的物化视图，仅用于快速查询。
- **同步**只交换 oplog 中的变更消息，合并幂等、可交换、最终一致。

## 3. 数据存储布局

```
~/.metahub/
  metahub.db   # SQLite：域表 + CRDT oplog + 元数据
  cache/       # 内容寻址 blob（附件），文件名 = sha256
```

可用环境变量 `METAHUB_HOME` 覆盖根目录（便于多实例 / 测试 / 服务端独立数据）。

**为什么文档正文进 SQLite、二进制进 cache：** markdown 正文是小文本，需进全文检索、且要作为 CRDT 字段随 oplog 同步，存库最顺；大二进制（图片/PDF）不应塞进同步消息，以 sha256 内容寻址落在 `cache/`，库里只存引用。

## 4. 数据模型

四个一级实体：

| 实体 | 含义 | 关键字段 |
|------|------|----------|
| database | 一张 notion 表（集合） | name, icon |
| property | 表的一列（类型化） | database_id, name, type, config, position |
| record | 表的一行 | database_id + 各列单元格（EAV） |
| document | 一篇 markdown 文档 | title, body, database_id?, parent_id? |

**记录单元格用 EAV 模型**（`record_values(record_id, property_id, value)`），每个单元格是一个独立的 CRDT register，便于按字段合并。

**属性类型（v1）**：`text · number · checkbox · select · multi_select · date · relation · url`
- `select / multi_select`：`config.options: string[]`，写入时校验取值。
- `relation`：`config.database` 指向目标库 id，值为目标 record id 数组。
- 写入按类型校验 / 规范化（如 checkbox 接受 true/"true"/1）。

文档与数据库是两个并列概念，匹配「文档和数据表」的原始诉求。文档可选归属某个 database / 父文档，形成层级。

## 5. CRDT 同步设计（核心）

采用经典「CRDTs for Mortals」模式：**Hybrid Logical Clock (HLC) + 按字段的 Last-Write-Wins oplog**。这是可交换、幂等、最终一致的 CRDT，且服务端实现极简。

### 5.1 Hybrid Logical Clock

字符串形式 `<millis:15位补零>-<counter:4位hex>-<nodeId>`，定宽数值段保证**字典序 == 因果/全序**。

- 本地每次写入用 `nextHlc` 取一个严格递增的新时间戳。
- 收到远端消息用 `observeHlc` 把本地时钟推进到不小于对端，吸收时钟漂移。
- nodeId 是每台机器一个稳定随机串（存在 `meta` 表），用于打破并发平局、保证全序唯一。

### 5.2 oplog 与物化

- 每个写入产生一条「字段赋值消息」`Change { hlc, node_id, dataset, row_id, col, value }`，`value` 为 JSON 编码（或 null）。
- 应用一条消息（`applyChange`）：
  1. `INSERT OR IGNORE` 进 `crdt_changes`（**幂等**，重复消息无副作用）。
  2. 重新计算该 `(dataset,row_id,col)` 寄存器在整段 oplog 中的 `MAX(hlc)`。
  3. 若本条就是最大者，则物化到域表；否则忽略（已有更新的写覆盖）。
- 因为胜者总是「全 oplog 的 max HLC」，所以**应用顺序无关**：乱序、重放都收敛到同一结果。

### 5.3 删除

软删除：把 `__deleted` 当作一个普通 CRDT 字段写成 `1`（**墓碑**），随 oplog 传播。查询一律过滤 `__deleted = 0`。

### 5.4 列允许名单（安全）

物化时 `col` 会拼进 SQL（域表列名），且消息可能来自不可信的同步对端，因此 `crdt.ts` 用 `DOMAIN` 白名单校验每个 (dataset, col)；记录单元格的 `col` 是 property id，落到参数化的 `record_values`，不拼 SQL。未知 dataset/列直接忽略（前向兼容）。

### 5.5 复制：rowid 游标

同步差异不按 HLC `since`，而按 **SQLite rowid 游标**：`crdt_changes` 的隐式 rowid 按插入顺序单调递增，按 rowid 拉取**永不漏掉**任何一条变更（即使时钟漂移、消息乱序到达）。每个 peer 记录两个游标：

- `pull_cursor`：从该 peer 已拉到的服务端高水位。
- `push_cursor`：已推送给该 peer 的本地高水位。

### 5.6 C-S 协议（简单实现）

服务端本身就是「另一个 metahub 节点」（有自己的 `~/.metahub`）。单一端点：

```
POST /sync
  req:  { node_id, since,  changes[] }   # since = 客户端上次拿到的服务端游标
  resp: { node_id, changes[], cursor }   # changes = 游标之后的服务端变更
GET  /health -> { ok, node }
```

客户端 `syncWithPeer` 一轮：推本地新变更 → 收服务端新变更并 `ingest` → 更新两个游标。星型拓扑下多机即可最终一致。

> 取舍：客户端可能把「刚从服务端拉来的变更」在下一轮又推回服务端，服务端 `INSERT OR IGNORE` 去重，仅是少量冗余带宽，不影响正确性。Merkle-tree 差异、按 node 过滤回推等是后续优化点。

> 文档正文是「整文档 LWW」：两机并发改同一篇，HLC 较新者整体胜出（非段落级合并）。若将来要字符级无损合并，需引入文本序列 CRDT（如 Yjs/Automerge），正文将不再是纯字符串。

## 6. 标识符方案

每个实体 id = `slug(名字) + "-" + 随机后缀`，例如 `tasks-3djsno`、`status-1wg05k`、`write-design-doc-erd0w6`。

- 随机后缀（6 位 base36）保证**多机离线创建也几乎不撞** → CRDT 同步安全；同时 id 可读。
- id 稳定、不可改；oplog / 关系外键 / CLI 全部用它。
- slug 取自名字并 ASCII 化；名字非英文（如中文 record 标题）时 base 回退为类型 / 所属库前缀（record → `<dbslug>`、doc → `doc`），仍是纯英文 + 随机后缀。
- 放弃了「可读 key + 隐藏 uid」的双 id 方案——双 id 的可读 key 仍可能歧义；单 id（名字+随机）更简单且无歧义。

## 7. 人机交互

同一套命令同时服务 AI 与人：

- **输入**：`--body` / `--data` / `--config` 支持 `@file`（读文件）、`@-`（读 stdin）、或直接字面值。
- **输出（按受众自动切换）**：stdout 是 TTY（人）→ 记录渲染 ASCII 表格、文档渲染 markdown 正文；被管道 / 子进程调用（AI）→ 紧凑 JSON。`--json` / `--pretty` 可强制。错误统一 `{"error": "..."}` + 退出码 1。
- **编辑**：`mh edit <id>` 打开 `$EDITOR`——文档开 markdown 正文，记录开 `字段名: JSON值` 表单，存盘解析后转 CRDT 更新（记录为部分更新，只改动过的字段）。v1 不做 Obsidian 仓库式文件夹双向同步。

## 8. 全文检索

- 优先用 SQLite **FTS5**：`search_fts` 虚拟表索引文档（title/body）与记录文本单元格；按 oplog 的 `MAX(hlc)` 做**惰性增量重建**（只在数据变化后重建）。
- FTS5 不可用、或 FTS 命中为空（CJK 分词常漏）时**降级 LIKE 子串匹配**，对中文与精确短语更稳。

## 9. 运行时与分发

- 运行时依赖 **Bun**：`bun:sqlite`、`Bun.serve`、`Bun.file`、`Bun.CryptoHasher`。
- 分发三态：npm 库（Bun 环境）、全局 CLI（`metahub` / `mh`，shebang `#!/usr/bin/env bun`）、独立二进制（`bun build --compile` 内嵌 Bun，免运行时，跨 5 平台）。
