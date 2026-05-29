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
mh db create "Tasks"                             # 建一张表 -> 返回 id 如 db_tasks-k3f9c1
mh use tasks                                     # 设为「当前库」,之后 record/prop 免带库参数
mh prop add Title  --type text                   # 作用于当前库
mh prop add Status --type select --options "todo,doing,done"
mh record create --data '{"Title":"写设计稿","Status":"todo"}'
mh record update fix-login --data '{"Status":"doing"}'   # 用唯一前缀/名字,不必粘完整 id
mh doc create --title "架构说明" --body @arch.md  # @file / @- / 直接字符串
mh search "架构"
mh get tasks                                     # 通用查找:按 id/前缀/名字,自动判类型
mh edit <ref>                                    # 在 $EDITOR 里改文档正文 / 记录字段(给人用)

# 给 AI 用的非交互增量编辑(对标 Read / Edit / Write):
mh doc read <ref>                                # 读正文 + version(改前先读)
mh doc edit <ref> --old "旧文本" --new "新文本"  # 锚定查找替换,只传增量
mh doc append <ref> --body "追加段落"            # 也有 prepend
```

输出按受众自动切换：终端（人）显示表格 / markdown，被管道或子进程调用（AI）输出 **JSON**；`--json` / `--pretty` 可强制。

### ID 与引用

每个实体 id = `类型_名字slug-随机后缀`（如 `db_tasks-k3f9c1`、`rec_fix-login-bug-7j02an`）。类型前缀让 id 自解释（一眼区分 db/rec/doc/prop），随机后缀保证多机离线创建几乎不撞。

凡接受 id 的地方（`get`/`update`/`delete`/`--db`/`--parent`/`--target` 等）都接受**引用**，按以下顺序解析，省去粘贴完整 id：

- **完整 id**（永远可用，跨库亦可）
- **唯一前缀**（git 短 SHA 风格，`rec_fix-log` 或裸 slug `fix-log`）
- **名字/标题**（db 名、doc 标题、prop 名，大小写不敏感）

歧义时报错并列出候选；用 `mh use <db>` 设当前库后，record/prop 的引用与列举自动限定在该库内。Tab 补全见 `mh completion`。

### 属性类型

`text · number · checkbox · select · multi_select · date · relation · url`
（select/multi_select 用 `--options a,b,c`；relation 用 `--target <db引用>`）

relation 字段的**值**也接受引用：`--data '{"assignee":"Alice Chen"}'` 会在目标库里按名字/前缀解析成记录 id（数组逐个解析）；歧义或找不到会报错，完整 `rec_…` id 始终直通。

## 多机同步（CRDT）

每次写入都进 oplog（Hybrid Logical Clock + 按字段 Last-Write-Wins），合并可交换、幂等、最终一致。

文档正文按**块（block）**切分(段落级,fenced code 整块),每块是独立 register、用分数索引(fractional index)排序。所以两台机器改同一篇文档的**不同段落**能干净合并、互不覆盖；`mh doc edit` 的锚定替换通常只改命中那一块。`documents.body` 是由块重算的物化缓存。

```bash
# A 机：启动同步服务端（服务端也是一个 metahub 节点）
mh --server --port 7777

# B 机：与服务端推/拉一轮
mh sync http://a-host:7777
```

服务端在根路径 `/` 还内置一个**浏览器 WebUI**（Preact）：左侧列出数据库与文档，可浏览/行内编辑数据表、读写 markdown 文档（带预览）、全文搜索；编辑走与 CLI 同一套 core 写入路径，进 CRDT oplog 后随 `mh sync` 复制。同时暴露一组 `/api/*` REST 接口与自动生成的 OpenAPI 文档（`/docs`）。WebUI 资源（含 Preact）单独打包为 `dist/webui.js`，仅在浏览器首次访问 `/` 时懒加载，**不进入 CLI 启动路径，对命令行性能零影响**。设计见 [docs/impl-context/07-webui/design.md](docs/impl-context/07-webui/design.md)。

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
| `mh use [<db>] [--clear]` | 设置/显示「当前库」（record/prop 默认作用于它） |
| `mh get <ref>` | 通用查找：按 id/前缀/名字解析，自动判别类型 |
| `mh prop add\|list\|update\|remove` | 管理属性（列）；`add` 用 `--db` 指定库（默认当前库） |
| `mh record create\|list\|get\|update\|delete` | 管理记录（行） |
| `mh doc create\|list\|get\|update\|delete` | 管理 markdown 文档 |
| `mh doc read <id>` | 读正文 + version token（AI 改前先读） |
| `mh doc edit <id> --old --new` | 锚定查找替换（`--replace-all` / `--if-match`） |
| `mh doc append\|prepend <id> --body` | 在文档首/尾追加块 |
| `mh edit <id>` | 在 `$EDITOR` 中交互式编辑文档/记录（给人用） |
| `mh search <query>` | 全文检索（文档 + 记录） |
| `mh completion <bash\|zsh\|fish>` | 打印补全脚本：`eval "$(mh completion zsh)"` |
| `mh sync <url>` | 与服务端同步一轮 |
| `mh --server [--port]` | 启动同步服务端：`/sync` + 根路径 WebUI + `/api/*` REST + `/docs`（OpenAPI） |

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
    sync/      # CRDT 同步协议 + 服务端 + 客户端 + WebUI/REST 路由（routes/webui-routes/openapi/webui）
  cli/         # citty 子命令
  webui/       # 浏览器 WebUI（Preact，独立打包为 dist/webui.js）
  index.ts     # 库入口
scripts/       # 构建脚本（含 webui 打包入口）
```
