# metahub

给 AI 用的本地知识库 CLI：在 `~/.metahub/` 下用 SQLite 管理 notion 风格的**类型化数据库（表 + 行）**和 **markdown 文档**，单机可用，也能通过简单的 C-S 服务端在多机之间用 **CRDT 最终一致**同步。库 + CLI + 独立二进制三合一。

> 运行时依赖 **Bun**（使用 `bun:sqlite` / `Bun.serve`）。用 `bunx`、全局安装后的 `metahub`，或下载独立二进制。

## 数据存储

```text
~/.metahub/
  metahub.db   # SQLite：数据库/属性/记录/文档 + CRDT oplog
  cache/       # 内容寻址 blob（附件）
```

可用 `METAHUB_HOME` 环境变量覆盖目录（便于多实例 / 测试）。

## 快速开始

```bash
bunx @tensorix/metahub init                      # 创建 ~/.metahub
mh db create "Tasks"                             # 建一张表 -> 返回 id 如 tasks-k3f9c1
mh prop add tasks-k3f9c1 Title  --type text
mh prop add tasks-k3f9c1 Status --type select --options "todo,doing,done"
mh record create tasks-k3f9c1 --data '{"Title":"写设计稿","Status":"todo"}'
mh record update <recordId> --data '{"Status":"doing"}'
mh doc create --title "架构说明" --body @arch.md  # @file / @- / 直接字符串
mh search "架构"
mh edit <id>                                     # 在 $EDITOR 里改文档正文 / 记录字段
```

输出按受众自动切换：终端（人）显示表格 / markdown，被管道或子进程调用（AI）输出 **JSON**；`--json` / `--pretty` 可强制。

### ID

每个实体 id = `名字slug-随机后缀`（如 `tasks-k3f9c1`），可读且多机离线创建也几乎不撞。

### 属性类型

`text · number · checkbox · select · multi_select · date · relation · url`
（select/multi_select 用 `--options a,b,c`；relation 用 `--target <databaseId>`）

## 多机同步（CRDT）

每次写入都进 oplog（Hybrid Logical Clock + 按字段 Last-Write-Wins），合并可交换、幂等、最终一致。

```bash
# A 机：启动同步服务端（服务端也是一个 metahub 节点）
mh --server --port 7777

# B 机：与服务端推/拉一轮
mh sync http://a-host:7777
```

## 三种用法

```bash
# 1) 作为库（Bun）
import { openMetahub, createDatabase, createRecord, search } from "@tensorix/metahub";

# 2) 作为 CLI
npm i -g @tensorix/metahub   # 然后用 metahub / mh
bunx @tensorix/metahub <cmd> # 免安装

# 3) 独立二进制（免运行时）
chmod +x metahub-darwin-arm64 && ./metahub-darwin-arm64 init
```

支持平台：`darwin-arm64` / `darwin-x64` / `linux-x64` / `linux-arm64` / `windows-x64`。

## 命令

| 命令 | 说明 |
|------|------|
| `mh init` | 创建 `~/.metahub` |
| `mh db create\|list\|get\|delete` | 管理数据库（表） |
| `mh prop add\|list\|update\|remove` | 管理属性（列） |
| `mh record create\|list\|get\|update\|delete` | 管理记录（行） |
| `mh doc create\|list\|get\|update\|delete` | 管理 markdown 文档 |
| `mh edit <id>` | 在 `$EDITOR` 中编辑文档/记录 |
| `mh search <query>` | 全文检索（文档 + 记录） |
| `mh sync <url>` | 与服务端同步一轮 |
| `mh --server [--port]` | 启动同步服务端 |

## 开发

```bash
bun install
bun run dev init                  # 热重载运行 CLI
bun test                          # 跑测试（含 CRDT 收敛测试）
bun run build                     # 产出 dist/（库 + CLI + 类型声明）
bun run build:binaries            # 产出 binaries/ 五平台二进制
```

## 目录结构

```text
src/
  core/        # 业务逻辑（库和 CLI 共享）
    sync/      # CRDT 同步协议 + 服务端 + 客户端
  cli/         # citty 子命令
  index.ts     # 库入口
scripts/       # 构建脚本
```
