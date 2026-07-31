# metahub

**给你的 AI 一个本地知识库。**

[English](./README.md) · 简体中文

metahub 是基于 Bun + SQLite 的本地优先知识库 CLI，给 AI agent 一份持久、可同步的工作记忆：用 notion 风格的**类型化数据表**装结构化数据，用 **markdown 文档**装长文本知识，再配一套像 `Read / Edit / Write` 的编辑接口。数据全部存在你本机的 `~/.metahub/`，单机离线可用，多机之间保持一致。

> 运行时依赖 [Bun](https://bun.sh)。用 `bunx`、全局安装后的 `mh`，或下载独立二进制都行。

## 为什么用它

- **为 AI 读写而设计** —— `doc read` 先返回正文 + 版本号，`doc edit --old/--new` 做锚定查找替换、只传增量；引用一律支持 id 前缀 / 名字，不必粘完整 id。
- **结构化 + 非结构化一处管** —— 类型化数据表（行 / 列，8 种属性类型）放任务、流水、联系人；markdown 文档放设计稿、笔记。
- **本地优先、可同步** —— 数据在你自己的磁盘上，离线可用；多台机器干净合并，改不同段落互不覆盖。
- **自带 GUI 与 API** —— `mh --server` 一条命令起浏览器 WebUI（浏览 / 行内编辑 / 全文搜索）+ `/api/*` REST 接口 + 自动生成的 OpenAPI 文档。

<!-- TODO 截图：docs/assets/webui.png（WebUI）、docs/assets/desktop.png（桌面端） -->
> 想看界面？装上[桌面 App](#获取--安装)，或运行 `mh --server` 后打开 `http://localhost:7777/`。

## 快速开始

```bash
bunx @tensorix/metahub init                       # 创建 ~/.metahub
mh db create "Tasks"                              # 建一张表 → 返回 id，如 db_tasks-k3f9c1
mh use tasks                                      # 设为「当前库」，之后 record/prop 免带库参数
mh prop add Title  --type text
mh prop add Status --type select --options "todo,doing,done"
mh record create --data '{"Title":"写设计稿","Status":"todo"}'
mh doc create --title "架构说明" --body @arch.md  # @file / @- / 直接字符串
mh search "架构"                                   # 全文检索文档 + 记录
```

引用不必粘完整 id：凡接受 id 的地方都接受**完整 id / 唯一前缀 / 名字**，歧义时报错列候选。

**给 AI 用的非交互增量编辑**（对标 `Read / Edit / Write`）：

```bash
mh doc read <ref>                                 # 读正文 + version（改前先读）
mh doc edit <ref> --old "旧文本" --new "新文本"   # 锚定查找替换，只传增量
mh doc append <ref> --body "追加段落"             # 也有 prepend
```

输出按受众自动切换：终端（人）显示表格 / markdown，被管道或子进程调用（AI）输出 **JSON**；`--json` / `--pretty` 可强制。

## 获取 / 安装

| 形态 | 安装 | 适合 |
| --- | --- | --- |
| **桌面 App**（GUI） | `brew install --cask tensorix/tap/metahub-app` | 想要图形界面、像 notion 那样用 |
| **CLI** | `brew install tensorix/tap/metahub-cli`，或 `npm i -g @tensorix/metahub`，或免安装 `bunx @tensorix/metahub <cmd>` | AI agent / 命令行 |
| **库**（Bun） | `bun add @tensorix/metahub` | 在自己的 Bun 程序里直接调用 |
| **独立二进制** | 下载对应平台文件，`chmod +x` 后直接运行 | 无运行时环境 |

```ts
// 作为库使用：所有 core 能力从包根导出
import { openMetahub, createDatabase, createRecord, search } from "@tensorix/metahub";
```

支持平台：`darwin-arm64` / `darwin-x64` / `linux-x64` / `linux-arm64` / `windows-x64` / `windows-arm64`。库 API 详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 多机同步

在一台机器起服务端，另一台与它同步。文档按段落级合并，所以并发改同一篇文档的不同部分能干净合并。

```bash
# A 机：启动同步服务端（它本身也是一个 metahub 节点）
mh --server --port 7777

# B 机：与服务端推 / 拉一轮
mh sync http://a-host:7777
```

配对一次（`mh config device code` / `mh config device add`）后即可后台**周期性自动双向同步**，不必每次手敲 `mh sync`。`mh status` 只凭本地状态就能回答「我的数据存在哪几处、每处有多新」，因此离线也答得出。同一条 `sync` 命令也能在「单个文档 / 数据表」与本地文件之间导入导出（文档 ↔ markdown、数据表 ↔ CSV）。原理详见[系统设计文档](./docs/system-design/)。

## WebUI、API 与 Agent 站点

`mh --server` 在根路径 `/` 内置浏览器 **WebUI**（浏览 / 行内编辑数据表、**CodeMirror 6** 所见即所得 Markdown 编辑器——斜杠菜单、文档表格、媒体嵌入、`[[…]]` 文档内链、代码块一键格式化、源码/块模式切换、查找、TOC、全文搜索、管理 agent 站点）。同一服务端还暴露：

- `/api/*` —— REST 接口，读写本库的数据表与文档。
- `/docs` —— 自动生成的 OpenAPI 文档。
- `/sites/<name>/` —— `mh site upload` 托管 agent 生成的 HTML/CSS/JS；页面同源调用 `/api/*` 即可读本库数据（一个本地 mini-Supabase）。
- `/sites/<name>/api/*` —— **公开**站点的访客数据面：匿名访客只拿到你用 `mh site grant` 明确开出的「表 × 操作」权限（`read`/`create`/`update`，**没有 delete**），可再加密码或 Turnstile。
- `/share/<slug>` —— `mh share` 把文档/数据库/站点发布成公开链接（view = 只读 SSR，edit = 接受 guest 写入；可加密码 + 过期），经 server、S3 桶，或你自己 Cloudflare 边缘上的常在线房间。

**设备离线时也想让别人访问**是可选能力，且完全跑在**你自己的** Cloudflare 账号里：`mh edge deploy`（用 Cloudflare 登录，或粘贴 API token）部署一个 Worker、两个命名空间——**写信箱**收下访客的密文投稿，你的设备下次同步时再解密入库；**房间**（Durable Object）让分享出去的站点在你所有设备都休眠时依然实时可用。metahub 自己不运营任何后端：边缘上要么只有密文信封，要么只有你明确分享出去的那一小块分区。

每个请求由单 token 守护（持久化在 `~/.metahub`）。服务端默认只绑 `127.0.0.1`；`--host 0.0.0.0` 才对外，此时凭据以明文 Bearer 传输，请置于可信网络或前置 TLS。细节见[系统设计文档](./docs/system-design/)。

## 命令参考

<details>
<summary>展开完整命令表</summary>

| 命令 | 说明 |
| --- | --- |
| `mh init` | 创建 `~/.metahub`（`--claude` / `--codex` 改为把本指南装成 Claude Code `/mh` / Codex `$mh` skill） |
| `mh db create\|list\|get\|delete` | 管理数据库（表） |
| `mh use [<db>] [--clear]` | 设置/显示「当前库」（record/prop 默认作用于它） |
| `mh get <ref>` | 通用查找：按 id/前缀/名字解析，自动判别类型 |
| `mh prop add\|list\|update\|remove` | 管理属性（列）；`add` 用 `--db` 指定库（默认当前库） |
| `mh record create\|list\|get\|update\|delete` | 管理记录（行） |
| `mh doc create\|list\|get\|update\|delete` | 管理 markdown 文档 |
| `mh doc read <id>` | 读正文 + version token（AI 改前先读） |
| `mh doc edit <id> --old --new` | 锚定查找替换（`--replace-all` / `--if-match`）；`--edits '<json 数组>'` 一次原子应用 N 对 |
| `mh doc append\|prepend <id> --body` | 在文档首/尾追加块 |
| `mh doc history <id>` / `mh doc revert <id> --to <version>` | 列出文档修订历史 / 恢复到某版本（回滚是一次新的正向修订；`doc get --at <version>` 预览；revert 可复活已删文档） |
| `mh record history <id> [--field <名>]` / `mh record revert <id> --to <version>` | 记录修改历史（逐修订字段 diff，或单字段值变迁）/ 恢复历史值（可复活已删记录） |
| `mh prop history <id>` / `mh prop revert <id> --to <version>` | 列定义历史 / schema 回滚：同时恢复列定义**和**被改类型/删列清掉的单元格，之后的用户编辑保留 |
| `mh db activity [<id>] [--limit N]` | 表级活动流：全表记录修订按时间倒序聚合，每条带字段级「旧值 → 新值」与记录标题快照（已删记录显示删除时的标题） |
| `mh edit <id>` | 在 `$EDITOR` 中交互式编辑文档/记录（给人用） |
| `mh search <query>` | 全文检索（文档 + 记录） |
| `mh doctor` | 只读体检：列出逻辑完整性问题（孤儿引用/单元格、重复路径、文档环、重名等）+ oplog/磁盘统计 |
| `mh repair [--dry-run]` | 确定性、幂等修复可自动修的问题（改动随 oplog 复制）；`--dry-run` 仅预览（等价 doctor） |
| `mh compact [--keep <天数>] [--dry-run]` | 清理保留窗口（默认 90 天）之外的 oplog 历史 + 回收无引用 blob + VACUUM。纯本地操作；当前数据不变，窗口外历史坍缩为基线（无法再回滚到更早版本） |
| `mh site create\|scaffold\|put\|upload\|list\|files\|rm\|delete` | 托管 agent 生成的静态站点（HTML/CSS/JS），由 `--server` 在 `/sites/<name>/` serve 出去。`scaffold` 写一份起步页；`upload <目录>` 镜像整个目录（首次加 `--create`，`--prune` 连带删除本地已不存在的文件） |
| `mh site access <site> [public\|private]` | 查看 / 修改「谁可以访问这个站点」。public = 免 token；private 的响应与「不存在」完全一致。`--show-links` 才打印能力 URL（链接本身即密钥） |
| `mh site grant <site> <db>:<ops>` / `mh site grants <site>` | 给公开站点的 `api/` 开匿名数据授权（`read,create,update`，无 delete），可用 `--password` / `--turnstile` 加门；`--revoke <db>` / `--clear` 收回 |
| `mh share create\|list\|servers\|link\|renew\|revoke` | 把文档/数据库/站点发布成公开链接（`/share/<slug>`）：server SSR、S3 导出，或 `--room` 上你自己的边缘；view/edit 权限、可选密码 + 过期、可选 `--grant <db>:<ops>` 数据面 |
| `mh edge deploy\|status\|pull\|rotate\|connect` | 你自己的 Cloudflare Worker + D1（+ Durable Object）：部署（用 Cloudflare 登录或 API token）、查健康、手动拉一轮写信箱、轮换收件密钥、把第二台设备接到既有 edge |
| `mh blob add <file>` / `mh blob get <hash>` | 把本地文件存成内容寻址 `/blob/<hash>` URL（嵌入文档）/ 取回字节（本地 cache → peer → 桶） |
| `mh cache [status\|clear\|gc\|full-device\|redundancy\|pin\|unpin]` | 查看/管理本地 blob 缓存；指定「全量设备」（durable 锚）使图片可安全清理 |
| `mh token [show\|refresh]` | 查看 / 轮换持久化的服务器鉴权 token（存于 `~/.metahub`，默认 30 天到期轮换） |
| `mh completion <bash\|zsh\|fish>` | 打印补全脚本：`eval "$(mh completion zsh)"` |
| `mh sync` | 立即同步：对每一台已配置的设备与每一个桶各跑一轮 |
| `mh sync <url>` | 与指定服务端同步一轮（CRDT 推/拉）；`/sync` 受保护时按已存凭据直连，否则在交互终端提示输入 token 并记住（`--token` 非交互） |
| `mh sync <src> <dst>` | 单个文档/数据表与文件互导：文档↔markdown、数据表↔CSV；方向按参数判别（哪侧是库内实体） |
| `mh status` | 数据在哪几处、每处有多新、当前最要紧的问题是什么、该怎么办。纯本地派生，离线可答 |
| `mh config` | 交互向导，覆盖下面全部（`server` / `device` / `backup` / `edge`）。日常**工具**留在顶层，凡改**长期状态**的都收在 `config` 下 |
| `mh config server --port … --host … --sync-interval …` | 持久化服务器设置到 `~/.metahub`（启动时 CLI flag 仍优先） |
| `mh config device code\|add\|list\|revoke` | 用一次性码配对设备、查看设备名册（怎么加入的、最后活跃、能否吊销；`--refresh` 追加桶在场性）、断开某台设备 |
| `mh config backup connect\|list\|rotate\|recovery\|anchors` | 挂云端桶（S3/R2）做离线 store-and-forward——直填凭据、`--enroll` 码/二维码，或 `--provision-r2` 先替你建桶。`rotate` 丢设备后换钥换短语；`recovery` 打印可手抄的恢复码卡；`anchors` 设 blob 冗余判定 |
| `mh --server [--port] [--host] [--debug] [--token] [--sync-interval] [--no-auto-sync]` | 启动服务端：`/sync`（主 token 或配对凭据）+ 根路径 WebUI + `/api/*` REST + `/docs`（OpenAPI）+ 静态站点 `/sites/<name>/` + token 交换 `/auth/token` + 配对 `/api/pair`；内置定时器自动同步已配对 peer |

</details>

## 文档

- [系统设计](./docs/system-design/) —— 架构、数据模型、能力清单、使用流程。
- [贡献指南](./CONTRIBUTING.md) —— 本地开发、构建、发布、目录结构、库 API。
- [桌面 App](./apps/desktop/README.md) —— Electron 壳 + Bun sidecar。

## 许可证

[AGPL-3.0-only](./LICENSE)。
