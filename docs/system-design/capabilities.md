# 当前功能能力

## 初始化

已实现:

```bash
mh init                 # 创建 ~/.metahub
mh init --claude        # 装 Claude Code 的 /mh skill 到 ~/.claude(不碰 ~/.metahub)
mh init --codex         # 装 Codex 的 $mh skill 到 ~/.codex(不碰 ~/.metahub)
```

效果:

- `mh init`:创建 `METAHUB_HOME` 或 `~/.metahub`、SQLite schema、cache 目录,初始化或读取 node id。
- `--claude` / `--codex`:把仓库根 `SKILL.md` 作为**个人 agent skill** 装到对应 agent 配置目录(`~/.claude/skills/mh/SKILL.md` → `/mh`;`~/.codex/skills/mh/SKILL.md` + `agents/openai.yaml` → `$mh`),幂等(内容一致则跳过),`--claude --codex` 可同装。仅写 agent 配置目录、**不创建** `~/.metahub`。见 `src/cli/agent-skill.ts`。

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
mh db duplicate <ref> [--name <名>]    # 整库复制:属性列+全部记录;自引用 relation 重映射到副本(名称默认沿用原名)
mh db activity [<ref>] [--limit N]     # 表级活动流:全表记录修订聚合,新→旧,每条带字段级"旧值 → 新值"
                                       #   与记录标题快照(已删记录显示删除时的标题而非裸 id)
mh db delete <ref>

mh prop add <name> --type <type> [--db <db>] [--options a,b] [--target <db>] [--config JSON] [--position N]
mh prop list [<db>]
mh prop update <ref> [--name] [--options] [--target] [--config] [--position]
mh prop history <ref>                  # 列定义修订历史(改名/类型/选项/删除,含级联清格计数)
mh prop revert <ref> --to <version>    # schema 回滚:恢复列定义 + 被级联清掉的单元格(用户后写保留)
mh prop remove <ref>
```

当前体验:

- 可以手动创建 Notion-like 表结构。
- 属性支持类型和基本配置校验。
- `prop add` 的库用 `--db` 指定(默认当前库);`prop list` 的库可省略(默认当前库)。
- 属性名**没有唯一性约束**(重名是合法状态——离线多端并发创建同名列经 sync 汇合天然存在,硬约束会破坏收敛)。重名的代价是 name-keyed 访问歧义,按三层处理:
  - `prop add` / `prop update --name` 造成同库重名时,操作照常成功,但向 **stderr 输出 warning**(列出冲突的属性 id;stdout 的 `--json` 不受污染)。
  - 记录读写/过滤/排序按**名字**命中多个属性时报 `ambiguous`(exit 4),错误消息指引改用属性 id;按 **id** 访问不受影响。
  - `mh doctor` 把同库重名列为 `dup_name`(仅报告,不自动改);解析引用时也会报错列候选而非静默误选。

## 记录

已实现:

```bash
mh record create [<db>] --data '{"field":"value"}'      # db 省略时用当前库
mh record list [<db>] [--filter '{"field":"value"}'] [--sort field] [--desc] [--limit N]
mh record get <ref>
mh record update <ref> --data '{"field":"value"}'
mh record history <ref> [--field <名>]   # 修订历史(逐修订字段;--field 看单元格值变迁)
mh record revert <ref> --to <version>    # 恢复历史值;对已删记录(完整 id)= 复活
mh record delete <ref>
```

当前查询能力:

- 支持按字段等值过滤。
- 支持单字段排序。
- 支持 limit。
- 支持属性名或属性 id 作为 data key;名字命中多个重名属性时报 `ambiguous`,需改用属性 id(读返回里 `values` 按名、`cells` 按属性 id,重名时以 `cells` 为准)。
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
mh doc list [--db <db-ref>]                 # 按 parent_id 缩进成树
mh doc get <doc-ref>
mh doc update <doc-ref> [--title] [--body] [--parent <doc-ref>]
mh doc duplicate <doc-ref> [--title <题>]   # 复制文档(标题+全部块,块级克隆),副本紧随原文档之后
mh doc delete <doc-ref>
```

文档层级:`--parent <doc-ref>` 把文档挂到某个父文档下,`--parent ""`(空值)移回顶层(清空 parent_id)。core 在改 parent 时做防环校验(不能挂到自身或后代下)。同级**顺序**由 `order_key`(per-parent fractional index)决定:WebUI 侧栏拖拽走 `moveDocument(before|after|into)`,一次原子更新父级与顺序;CLI 的 `--parent` 走 `updateDocument(parent_id)`,reparent 时自动落到新父级末尾(尚无单独的 CLI 重排命令)。两条路径的父级+顺序一致性都收口在 core 的 `placeInSiblings`。

AI 增量编辑:

```bash
mh doc read <doc-ref>
mh doc edit <doc-ref> --old "old text" --new "new text" [--replace-all] [--if-match <version>]
mh doc edit <doc-ref> --edits '<json array>' [--if-match <version>]   # 批量锚定改写
mh doc append <doc-ref> --body "markdown"
mh doc prepend <doc-ref> --body "markdown"
```

`--edits` 接受一组 `[{"old","new"?,"replaceAll"?}]`,在**一次** transaction 里按序折叠改写(后一对的 `old` 可命中前一对的 `new`):**先全量校验再落笔**(validate-before-write),任一对锚点缺失/歧义则整批中止、文档不变;只做一次 `--if-match` 校验、一次修订、一次版本号 bump——AI 一次 read 就能下 N 个 delta。与 `--old/--new/--replace-all` 互斥。`--edits` 与 `--old`/`--new` 均支持 `@file`/`@-`。见 `src/core/documents.ts` `editDocumentBatch`。

历史与回滚:

```bash
mh doc history <doc-ref>                            # 修订列表(新→旧,含来源设备与 kind)
mh doc get <doc-ref> --at <version>                 # 任意历史版本的标题/正文
mh doc revert <doc-ref> --to <version> [--if-match] # 恢复;对已删文档(完整 id)= 复活
```

文档引用 `<doc-ref>` 支持完整 id、唯一前缀或标题。`--db`/`--parent` 同样接受引用;文档可独立存在(`--db` 不默认当前库)。

当前体验:

- `doc read` 返回正文和 version token。
- `doc edit` 要求 old text 精确匹配,适合 AI read-before-edit。
- 文档正文按 block 存储,不同 block 的并发编辑可以保留。
- **内链是普通 Markdown**:`[[doc_xxx]]` / `[[db_xxx]]` / `[[doc_xxx|别名]]` 是行内语法的一等 token(`src/core/md/inline.ts`),agent 直接写进正文即可,往返无损。id 形状被钉死为 `newId()` 的产物(`(doc|db)_<slug>-<rand>`),所以任意 `[[普通文本]]` 仍是字面散文。见 [26-doc-internal-links](../impl-context/26-doc-internal-links/design.md)。

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

## 分享(公开能力链接)

已实现(见 [17-s3-storage-sync](../impl-context/17-s3-storage-sync/design.md) / 记忆 `share-feature-impl`;core 在 `src/core/shares.ts`,SSR 在 `src/core/sync/share-render.ts`/`share-serve.ts`):

```bash
mh share create <ref> [--kind doc|database|site] [--transport server|s3]
                      [--permission view|edit] [--password <pw>] [--expires 24h|7d]
                      [--grant <db>:<ops>] [--room]
                      [--via <peer-url|base-url>] [--bucket <url>] [--viewer <url>]
mh share list [<target>]     # 汇总:本机 + 已配对 server + 桶上的分享
mh share servers             # 可发布目标:本机 server + 已挂载对象存储桶
mh share link <slug>         # 打印某分享的可访问链接
mh share renew <slug>        # 续期(预签名 s3 链接最长 7 天)
mh share revoke <slug>       # 撤销(别名 mh share rm;可 --via 让配对 server 代撤)
```

当前能力:
- 目标可是**文档 / 数据库 / 站点**(`--kind` 省略时按类型化 id 推断)。
- 三种传输:`server`(`mh --server` 在 `/share/<slug>` 实时 SSR;权限 `view`/`edit`,**edit 仅 server**、接受 guest 节点写入)、`s3`(预签名对象存储静态导出 + 独立解密 viewer,只读,`view` only,过期上限 7 天),以及 `--room`(**站点分享专用**:把分区推进你自己 Cloudflare 账号的 Durable Object 房间,所有者设备离线时链接照样可用;需先 `mh edge deploy`)。
- 可选**密码**与**过期**;`view` 分享 SSR 只读渲染(走共享语法 + `safeUrl` 净化 URL、按 kind 渲染媒体、`[[内链]]` 渲成惰性文本)。
- `--grant <db>:<ops>`(可重复,ops ∈ `read,create,update`,**仅 server 传输**)给这条分享开一个 `/share/<slug>/api/*` 访客数据面;授权随分享行走,**撤销分享即作废授权**。
- `/share/<slug>` 在 token 门禁**之前**命中并原样返回(公开访问,不套 token shim)。
- 非法组合(如 s3 ⇒ 只读、room ⇒ 仅站点)只在 `assertShareCombo` 一处声明,CLI / WebUI / 远端代建同路径校验。

## 站点:访问与数据授权

已实现(见 [23-sites-experience](../impl-context/23-sites-experience/design.md) / [24-sites-ux-refresh](../impl-context/24-sites-ux-refresh/design.md)):

```bash
mh site create <name> [--title <t>] [--public]
mh site scaffold <dir> [--force]        # 写一份起步 index.html(带 SDK 引入与可运行示例)
mh site upload <site> <dir> [--create] [--prune]   # 上传目录(publish 为弃用别名)
mh site put <site> <path> --from <file> | --content <txt|@file|@->
mh site list [--show-links]             # 列出站点 + 计算出的访问状态
mh site access <site> [public|private] [--show-links]   # 看/改「谁可以访问」
mh site update <site> [--spa|--no-spa] [--title <t>]
mh site files <site> | mh site rm <site> <path> | mh site delete <site>

mh site grant <site> <db>:<ops>         # 匿名访客数据授权(ops: read,create,update)
mh site grant <site> <db>:create --password <pw> | --turnstile <sitekey> --turnstile-secret <s>
mh site grant <site> <db> --revoke  |  mh site grant <site> --clear
mh site grants <site>                   # 查看该站点的公开数据授权
```

当前能力:

- **访问是一根轴,托管是另一根**:`site access` 只回答"谁可以访问"(public = 免 token,private = 需要 token 且**与不存在的响应完全一致**);托管在哪(某台设备 / Edge 房间)由渠道派生,见下「站点渠道」。
- `--spa`:无扩展名的 miss 回退 `index.html`(前端路由)。
- **数据授权 `site grant`**:给**公开**站点的 `/sites/<name>/api/*` 开表×操作授权,`ops ∈ read,create,update`——**没有 delete**。按 database **id** 记录(改名不影响授权),读取一律经 default-deny 解析;"未授权"与"不存在"返回同一个 401(反枚举)。
- **写入门**:`--password` / `--turnstile` 由 Edge 写信箱与 server 实时面**共用同一个门**强制,不会一条路生效、另一条被跳过。
- `--show-links` 才打印完整能力 URL——链接本身即密钥,默认不往终端/日志里洒。

## Edge(你自己的 Cloudflare 账号)

已实现(见 [23-sites-experience §5-6](../impl-context/23-sites-experience/design.md)):

```bash
mh edge deploy [--account-id <id>] [--api-token <tok>] [--yes]   # 或「用 Cloudflare 登录」(OAuth+PKCE)
mh edge status [--json]      # Edge 健康:Worker 版本是否与本地对齐 + 各站点信箱积压/配额
mh edge pull                 # 手动跑一轮信箱拉取(自动同步约每 60s 一次)
mh edge rotate [--purge-retired]   # 轮换收件人密钥(旧密钥保留以解在途信封)
mh edge connect --endpoint <url> --token drt_...   # 接入既有 Edge(第二台设备)
# 同一组操作也有配置态别名:mh config edge deploy|connect|rotate-keys
```

当前能力:

- **一条命令、一个 Worker、两个命名空间**:`/v1/inbox/*` 写信箱(D1),`/r/<slug>/*` 分享房间(Durable Object)。部署到**用户自己的**账号,metahub 没有中间人后端。
- **写信箱**:访客把预签名的操作**封装**给所有者公钥,Edge 只存密文;所有者设备拉回解密→隔离校验→ingest→ack 删除。所有者设备离线时投稿照收,回来再落库(约 1 分钟一轮)。
- **房间**:一个站点分享的常在线服务面,含 WebSocket 实时推送(Hibernation API)。房间零出站凭据、从不外呼,`evict` 是本地物理删除、绝不产生 op。
- 所有者用独立的 `drt_` secret 认证,**不是主 token**;CF API token 只在部署那一刻使用、**从不持久化**。

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

## 历史与回滚

已实现(`src/core/history.ts`,见 [15-history-rollback-compaction](../impl-context/15-history-rollback-compaction/design.md);命令分散在文档/记录/属性各节):

- **oplog 即历史**:每次字段写入都在 append-only 的 `crdt_changes` 里,任意时点状态可重建,无额外存储。
- **修订聚簇**:同一次逻辑变更的 changes 共享 `txn` 分组 id(随 sync 复制,各端历史视图一致);`kind` 区分 `user`/`repair`/`revert` 来源。
- **回滚 = 正向写入**:revert 作为新修订落库(不删改历史),随 sync 收敛,自身可再回滚;"任何版本永远可从历史找回"。
- **复活**:对已墓碑的文档/记录/属性,revert 到存活版本即恢复(CLI 用完整 id 直通已删实体);回滚到"已删除状态"被拒绝(`invalid_input`)。
- **schema 回滚跳过策略**:`prop revert` 恢复被级联清掉的单元格时,凭共享 txn 识别级联写入,用户后来手填的值一律保留(`skipped_cells` 报告)。
- **表级活动流**:`mh db activity` / `GET /api/database/activity` 聚合全表所有记录(含已删)的修订为一条时间线,每条带字段级值 diff(`旧值 → 新值`)与记录标题快照(聚合时沿变更流维护运行状态,零额外查询);WebUI 表格「…」菜单 →「最近动态」抽屉内联展示 diff(超 3 条折叠)。
- 错误契约沿用:版本不存在 → `not_found`(exit 3),`--if-match` 失败 → `stale`(exit 5)。

当前未实现:sites/site_files 历史、revert 还原 parent_id/order_key 等元数据。

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
- restore(merge / reset)完成后自动跑一次 `repairHub`,修复合入数据可能破坏的不变量(见下「数据完整性」)。

## 数据完整性

已实现(见 [data-model.md](./data-model.md) 的「完整性约束」、[13-data-integrity](../impl-context/13-data-integrity/design.md)):

```bash
mh doctor                 # 只读体检,列出逻辑完整性问题 + oplog/磁盘统计与可压缩量
mh repair                 # 确定性修复可自动修的问题(幂等,改动随 oplog 复制)
mh repair --dry-run       # 仅报告将要修复什么,不改动(等价 doctor)
```

当前能力:

- schema 保持弱约束(只主键,无 FK/UNIQUE,契合 CRDT 前向引用/并发同名/幂等回放),完整性在 core 层做最终一致约束。
- `doctor` 归类:`broken_ref`(引用指向已删目标)、`orphan_cell`(已删属性残留单元格)、`dup_path`(同 site 同 path 冗余文件)、`parent_cycle`(文档父子环)为可自动修;`dup_name`(同库重名 database/property)、`bad_config`(非法 type/relation/select 配置)为仅报告。
- `repair` 确定性、幂等(循环到不动点),winner 用 `(created_hlc, id)` 全序;只对 tombstone 动手(容忍尚未到达的前向引用),**绝不 hard-delete 用户内容**(重名只报告)。
- 删除 database/property/document 时已内置写时级联(主路径);`repair` 兜底 sync 引入的坏数据(如 A 删库时 B 并发建记录)。

## 存储压缩

已实现(`src/core/compact.ts`,见 [15-history-rollback-compaction](../impl-context/15-history-rollback-compaction/design.md)):

```bash
mh compact [--keep <days>] [--dry-run] [--no-vacuum]   # 默认 keep 90 天;0 = 只留头部状态
```

当前能力:

- 保留窗口式 oplog 压缩:窗口内历史完整,窗口外每 register 坍缩为"截止点胜者"(头部物化状态逐字节不变);窗口外的 `history`/`revert` 退化为单一基线。
- 安全不变量:只删 LWW 输家(任何 peer 拿到幸存者即收敛)、墓碑胜者必存活(不复活已删行)、保护 `MAX(rowid)` 行(防 SQLite rowid 复用跳 peer 游标)。
- **纯本地操作**(不 emit、不同步),各节点独立清理;配套 blob GC(删不再被引用的 cache 文件)与 `VACUUM` 还盘。

当前未实现:自动定时压缩(规划归 `mh config`)、"彻底抹除已删数据"(需全 peer 墓碑确认)。

## Blob 与缓存(内容寻址字节)

已实现(见 [22-blob-sync](../impl-context/22-blob-sync/design.md);core `src/core/blobs.ts`/`blobs-core.ts`):

```bash
mh blob add <file> [--name <alt>]      # 存为内容寻址 blob → 打印稳定 /blob/<hash>.<ext> URL + 可嵌入的 Markdown 行
mh blob get <hash> [--out <file>]      # 取字节:本地 cache → HTTP peer → 桶;--out 写文件,否则裸字节到 stdout(可 pipe)

mh cache                               # status(默认):缓存量 / 可清量 / pinned / 全量设备 / redundancy
mh cache clear | gc                    # 清可清 blob / 清不再被引用的孤儿 cache 文件
mh cache full-device list|add|rm [--node <id>]   # 指定 1~N 台"全量设备(durable 锚)":永不清 + 拉全量
mh cache redundancy all|any            # 判定 anchored 需要"全部/任一"全量设备在场
mh cache pin <hash> | unpin <hash>     # 用户"离线保留",永不自动淘汰
```

当前能力:
- **blob 字节**内容寻址(`cache/<hash>`),**不进 oplog**;`doc_blocks`/`site_files` 的清单(含 hash)照常同步,字节**按需**经 `/blob/<hash>` 取回。文档插图、图片、超阈值二进制走此路径。
- **可清判定** `isClearable = pending===0 && anchored===1`:`pending` 是本机自产、尚未确认落到锚的字节(唯一必护);`anchored` 由按需 presence-verify 依 `redundancy` 策略确认锚上有副本。`pin` 覆盖淘汰。
- 全量设备 = durable 锚(无对象存储桶拓扑时的落点),写进随 oplog 同步的 `blob_policy`。见 [data-model.md](./data-model.md) 的 `blob_cache`/`blob_policy`。

## 同步

已实现:

```bash
mh --server --port 7777
mh sync                      # 立即同步:已配置的每台设备 + 每个桶
mh sync http://host:7777     # 对某个服务器跑一轮
mh status [--json]           # 数据在哪几处、每处有多新
```

**命令分层(0.4 起)**:日常**工具**留在顶层(`sync` / `status` / `cache` / `doctor` / `compact` / `edge status|pull`),凡是改**长期状态**的都收进 `mh config <server|device|backup|edge>`;旧的 `config peer` / `config grant` / `config set` 写法保留为**隐藏别名**。

当前能力:

- 一轮 push/pull(单次轮回即双向:同时推本地、拉远端)。
- 基于 rowid cursor 防止 HLC 漂移漏同步。
- 通过 CRDT oplog 最终一致。
- **多设备配对 + 自动同步**:一次性配对码引导、交换长期 per-peer 凭据,server 内置定时器周期性双向同步已配对 peer(默认 30s);`/sync` 鉴权(主 token 或配对凭据)。统一入口 `mh config`(方向键交互向导 `@clack/prompts` + `--flag`)/ WebUI 设置页。撤销:`peer rm`(连带吊销)/ `grant revoke`。见 [11-device-pairing-sync](../impl-context/11-device-pairing-sync/design.md)。
- **浏览器离线副本(PWA)**:WebUI 设置页一键启用——自助配对(页面持主 token 自己铸码兑换凭据,在「已授权设备」可单独吊销)、按 `limit` 分页水合全量 oplog 至 OPFS、之后读写走本地 + 后台 `syncWithPeer()`,离线可查看编辑全部内容(含托管站点页的读写),回网块级合并。需 HTTPS(secure context)+ OPFS(Safari 17+);不满足时设置页显示原因并自动回落纯在线模式。见 [16-pwa-offline](../impl-context/16-pwa-offline/design.md)。
- **同步分页**:`/sync` 请求可带 `limit`(分页拉取)与 `exclude_datasets`(部分副本;协议就绪,设置 UI 未开),游标保证永不回退。
- **对象存储(S3)store-and-forward**:除 HTTP 对等外,可挂一个 S3 兼容桶作**数据盲的转发中继**——各设备把 oplog 变更推到桶、从桶拉,无需两端同时在线(离线转发)。桶 peer 记为 `peers.kind='s3'` + `peers.config`,拉取进度按 `storage_cursors`(每桶/每远端节点)。挂桶用 `--s3`(直填凭据)或 `--enroll <code>`(扫码/深链 `#enroll=`,只带访问描述符);`mh config backup cors` 自动配桶 CORS 以便浏览器直连。见 [17-s3-storage-sync](../impl-context/17-s3-storage-sync/design.md) / [21-enroll-code-onboarding](../impl-context/21-enroll-code-onboarding/design.md)。

```bash
mh config                                     # 交互向导(server / device / backup / edge)
mh config server --port 7777 --host 127.0.0.1 --sync-interval 30s

mh config device code                         # 生成一次性配对码(HTTP 对等)
mh config device add --url http://host:7777 --code <code>
mh config device list [--refresh]             # 设备名册(--refresh 追加桶在场性)
mh config device revoke <device>              # 断开某台设备(连带吊销签发给它的凭据)

mh config backup connect --endpoint <s3-url> --bucket <name> --access-key … --secret-key …
mh config backup connect --enroll <code>      # 用 enroll 码/扫码加入别人的桶
mh config backup connect --provision-r2 --bucket <name> --yes    # 先替你建好 R2 桶
mh config backup list | rotate | recovery     # 桶列表 / 换钥换短语 / 打印恢复码卡
mh config backup anchors redundancy all|any   # blob 锚点冗余判定
```

当前未实现:

- 冲突解释或用户可见 diff。
- blob **离线**取图(浏览器侧 Cache Storage LRU + OPFS spool;字节**按需**跨机传输已实现,见 [22-blob-sync](../impl-context/22-blob-sync/design.md))。
- 配对凭据过期(目前靠撤销管理)。
- TLS 已可由 `--tls-cert/--tls-key` 直出或反代承担;裸 HTTP 下凭据仍是明文 Bearer,需可信网络。

## 信任面:数据在哪、谁碰得到、丢了怎么办

已实现(见 [25-trust-and-settings](../impl-context/25-trust-and-settings/design.md)):

```bash
mh status [--json]                    # 数据地图:每处副本 + 新鲜度 + 首要问题 + 对症建议
mh config device list [--refresh]     # 设备名册:怎么加入的、最后活跃、能否吊销
mh config backup rotate               # 丢设备:换密钥 / 换密码短语
mh config backup recovery             # 打印恢复码卡(MH1-… 56 字符)
```

当前能力:

- **数据地图**:把 peers + 同步状态 + blob pending + 同步策略折成"地点列表 + 一个总状态"。`mh status` 与 WebUI 设置页共用同一份派生与优先级——**并发多个问题时,标题点名优先级最高的那个并指向清单**,不会遮蔽其它;建议语句对症(某个目标一直失败时提示去查它的配置,而不是让你再 `mh sync` 一遍已知坏掉的对端)。**纯本地、零网络**,离线照样答得出。
- **设备名册**:本地 oplog 即名册(凡变更到过本机的节点都有行,最大 HLC 就是真实最后活跃时间),因此**离线可列**;`--refresh` 才去查桶在场性(段流是否存在、发布者心跳是否活)。每台设备给出**诚实的可吊销判定**——纯靠桶加入的设备,吊销要靠换钥而不是删一行。
- **换钥 / 恢复码**:`rotate` 换掉桶密钥与密码短语;`recovery` 打印可手抄的恢复码卡——能重置密码短语,也能让新设备在不知短语时加入。**持码 = 可读全部数据**,卡面明写。校验位抓单字符笔误,字母表去掉 I/L/O/U。

当前未实现:自动定时的备份体检提醒;恢复码的"已打印/已确认"状态跟踪。

### 文件导出/导入

同一条 `sync` 命令在「单个文档/数据表」与「本地文件」间双向搬运(单参数=服务端 URL,走上面的对等同步;双参数=文件导出/导入):

```bash
mh sync <doc-ref> notes.md     # 导出文档正文 → markdown
mh sync <db-ref>  rows.csv     # 导出数据表 → CSV（表头=属性名，首列 id）
mh sync notes.md  <doc-ref>    # 导入 markdown → 更新已存在文档正文
mh sync rows.csv  <db-ref>     # 导入 CSV → 数据表（有 id 列则按 id upsert，否则新建）
```

当前能力:

- 方向自动判别:`resolveEntity` 能解析的一侧是实体,另一侧是文件路径;歧义 ref 直接报候选列表(不会被误当文件)。
- 格式按实体类型固定:文档→markdown(`documents.body`)、数据表→CSV;扩展名只是文件名,不参与选格式。
- CSV 单元格:数组/对象(multi_select/relation)以 JSON 编码,导入时按 `[`/`{` 还原,故可往返;标量交给 core `coerce` 还原 number/checkbox 等。
- 复用既有 core 写入(`updateDocument`/`createRecord`/`updateRecord`),所有改动照常进 CRDT oplog,可再随 `mh sync <url>` 复制。

当前未实现:

- 导入新建实体(导入只更新已解析到的现有文档/数据表)。
- 整库/整目录的批量导出(一次一个实体)。
- 文档导出携带标题/front-matter(只写正文,保证往返无损)。

## WebUI 与 HTTP API

已实现(随 `mh --server` 一起提供):

```text
GET  /                       # 浏览器 WebUI（Preact 单页应用，可安装 PWA）
GET  /webui.js               # WebUI 应用 bundle（懒加载）
GET  /sw.js                  # Service Worker（离线壳 + 离线网关；版本=js+css 哈希内插）
GET  /db-worker.js           # 浏览器副本宿主（sqlite-wasm + OPFS，跑同一份 core）
GET  /sqlite3.wasm           # SQLite WASM（SW 独立 cache-first）
GET  /mh-runtime.js          # 注入式页面运行时（token shim + SW 注册 + 离线 RPC 桥）
GET  /metahub-sdk.js         # 站点数据 SDK（可选语法糖，裸 fetch 等价）
GET  /manifest.webmanifest  /icons/*   # PWA 安装元数据（豁免 token 门禁）
GET  /docs  /docs.json       # OpenAPI 文档（Scalar UI / 规范）

GET    /api/databases        POST /api/databases
                             PATCH/DELETE /api/database    # ?id=<id>（重命名/图标、删除）
POST   /api/database/duplicate                             # ?id=<id>（整库复制：属性列+记录）
GET    /api/properties       POST /api/properties          # ?db=<id>
                             PATCH/DELETE /api/property     # ?id=<id>（改名/类型/选项/排序、删除）
GET    /api/records          POST /api/records             # ?db=<id>
GET    /api/record           PATCH/DELETE /api/record       # ?id=<id>
GET    /api/documents        POST /api/documents
GET    /api/document         PATCH/DELETE /api/document      # ?id=<id>
                             PATCH /api/document/move        # ?id=<id>（拖拽：before/after/into，改父级+重排）
POST   /api/document/duplicate                               # ?id=<id>（复制文档：标题+全部块，副本紧随原文）
GET    /api/search           # ?q=<text>&limit=<n>

GET    /api/document/history   /api/record/history   /api/property/history   # ?id= 修订列表（新→旧）
GET    /api/database/activity                        # ?db=&limit= 表级活动流（全表记录修订聚合）
GET    /api/document/at        /api/record/at        # ?id=&version= 任意历史版本状态
GET    /api/record/field-history                     # ?id=&prop= 单元格值变迁
POST   /api/document/revert    /api/record/revert    /api/property/revert    # ?id= body {to[, if_match]}
GET    /api/nodes              # 本机 + 已配对 peer 的 node_id→设备名映射（历史列表显示用）

GET    /api/sites            POST /api/sites                # 站点列表（含 file_count）/ 建站
GET    /api/site/files       PATCH/DELETE /api/site          # 文件清单（?site=）/ 改名·改标题·可见性·SPA·删站（?id=）
POST   /api/site/file        DELETE /api/site/file          # 上传(裸字节)/删文件（?site=&path=）
GET/PUT /api/site/grants                                    # 站点公开数据授权（GrantSet）
GET/POST/DELETE /api/site-hosting    POST /api/site-hosting/verify   # 托管目标与入口验证
POST   /api/site/publish     POST /api/site/publish/recover  DELETE /api/site/channel  # 发布 / 发布恢复 / 撤渠道
GET    /sites/<name>/<path>  # 托管的静态站点（public=免 token 原样返回；private=自带 token 门禁且与不存在同响应）
*      /sites/<name>/api/*   # 访客数据面（匿名按 GrantSet；持 token 的同源请求进程内转发回 /api/*）

GET    /share/<slug>         # 公开分享页 SSR（view 只读渲染 / edit 接受 guest 写入；在 token 门禁前，豁免、不套 shim）
*      /share/<slug>/api/*   # 该分享的访客数据面（按 shares.grants）
POST   /api/share            GET /api/shares    DELETE /api/share    # 分享创建 / 列表 / 撤销（WebUI 分享弹窗与 mh share --via 用）
GET/DELETE /api/share/request   GET /api/share/servers   GET /api/share/buckets   GET /api/shares/all
POST   /api/share/renew      GET /api/share/managed       # 续期 / 受管分享清单
GET    /blob/<hash>          POST /api/blob     GET /api/blobs/has    # blob 取字节 / 上传 / 存在性探测（内容寻址）
POST   /api/pair             POST /api/pair/new   POST /api/peers/pair  # 设备配对握手 / 铸码 / 自助配对
GET    /api/peers   GET/PATCH/DELETE /api/peer   POST /api/peer/sync   # 同步目标管理
GET    /api/sync/health      GET /api/devices   POST /api/devices/refresh   # 数据地图 / 设备名册（+桶在场性）
POST   /api/peer/s3   GET /api/peers/s3   GET /api/peer/s3/config
POST   /api/peer/s3/rotate   GET /api/peer/s3/recovery     # 换钥 / 恢复码
GET    /api/grants           DELETE /api/grant             # 本机签发的入站凭据
GET/DELETE /api/edge         POST /api/edge/deploy   POST /api/edge/connect   POST /api/edge/r2
POST   /api/edge/oauth/begin  GET /api/edge/oauth/status  DELETE /api/edge/oauth   # 用 Cloudflare 登录（PKCE）
GET    /api/version          # 版本与更新状态（设置「关于」页）

GET    /auth/token           # token 交换：持当前或宽限内旧 token → 返回 {token, exp}（无感续期；豁免门禁）
```

Edge 侧(部署在**用户自己**的 Cloudflare 账号上,不是本机 server 的路由):

```text
GET  /health   /owner/health           # 公开健康检查 / 所有者视角状态
POST /v1/inbox/<drop_id>/envelopes     # 访客投递密文信封（Turnstile / 密码 / ≤64KiB / 容量在此强制）
     /v1/inbox/<drop_id>[/stats]       # 所有者用 drt_ secret 拉取、ack、看容量
     /r/<slug>/*                       # 房间：站点页 + unlock + api/* + ws（Durable Object，按 slug 路由）
```

当前能力:

- 浏览器打开 `http://localhost:<port>/` 即用，**Notion-like 模块化 Preact 应用**（v2，见 [07-webui/implementation.md](../impl-context/07-webui/implementation.md)）：
  - **侧栏**：文档树（折叠/拖拽改嵌套与同级排序）、宽度可拖拽、整栏可收起/展开；条目菜单（重命名/复制/删除/新建子页）、新建数据库 Modal（模板）。
  - **表格**：按类型行内编辑（checkbox/select/multi_select/relation/text/number/date/url）、列头菜单（改名/**改类型**/选项增删/排序/插入/删列）、加列、行菜单、多选删除、记录侧栏 peek、彩色 select chip。单元格读写一律按**属性 id**（record 响应的 `cells` 字段；`values` 按名供 CLI/agent），重名列互不串扰；新建列默认名自动去重（「日期」→「日期 2」）。
    - **覆盖式单元格编辑器**（v3.3）：编辑器悬浮于单元格上方（行高不变）；双击或选中后直接打字进入（打字替换原值）；点击别处/Enter/Tab 均提交、Esc 放弃，值不变不发请求/不写历史；乐观更新即时生效、失败 toast+回滚；中文 IME 选词 Enter 不误提交。
    - **电子表格键盘**（v3.3）：方向键移动选中格（Shift 扩展为框选）、Enter/F2 进编辑、编辑中 Tab/Shift+Tab 提交并左右走格、Enter 提交并下移一行、Delete 清空；框选 Cmd/Ctrl+C 复制 TSV、底部操作条复制/填充/清空。
  - **文档**：基于 **CodeMirror 6** 的所见即所得编辑器(v3.4,文档 = 单份 Markdown 文本、块是派生模型、装饰驱动;详见 [webui-editor.md](./webui-editor.md))。
    - **块**:光标感知的 reveal-to-edit——标题/引用/列表/待办/分隔线渲成块样式,光标进入则标记复现;`/` 斜杠菜单、悬停 gutter 的 +/grip 拖拽(改类型/重排)、选区浮动格式条、行内实时预览(粗体/斜体/代码/删除线/链接/行内图)。Typora 风格快捷输入(空格/回车提交 marker)、Tab/Shift+Tab 缩进、有序列表**字面序号权威**。
    - **void 区块**:图片/视频/音频/文件/**GFM 表格**/代码/HTML 作为原子或 reveal-to-edit 组件。代码块含语法高亮、行号、语言选择、软换行开关与**一键格式化**(懒加载 prettier/wasm 引擎,见 architecture.md 的 fmt 子系统);表格支持 Notion 式行列 pill 手柄 + autofit + 多选。
    - **source/blocks 模式** `⌘/` 切换(同一 CM view reconfig,非另起 textarea);**⌘F 文档内查找**、右侧 **TOC** + 滚动高亮、右下**字数 pill**、图片标注/lightbox。
    - **文档内链 `[[doc_id]]`**:输入 `[[` 弹出标题选择器(本地标题表,无网络往返),插入的是**规范 id**;渲染成显示实时标题的胶囊,点击应用内跳转,目标不存在时显示为缺失态。支持 `[[id|别名]]`;从站内复制的链接粘贴进来会自动转成内链;分享页把内链渲成**惰性文本**(不外链到未被分享的目标)。见 [webui-editor.md](./webui-editor.md)。
    - **撤销/重做**为原生 CM6 `history()`(所有结构操作都是普通文本 transaction);粘贴/拖拽图片自动上传成 media void。
    - 防抖保存(700ms)复用 `PATCH /api/document` 的按块 reconcile;标题走 `textContent` 播种(非 innerHTML,XSS 安全),标题类可编辑区**只接受纯文本**粘贴/拖放(挡住 Word/Excel 带来的内联字号与 `<style>`);正文首行按 Backspace 会**并入标题**(光标落在接缝处)。
  - **版本历史**：文档「…」菜单 → 右侧抽屉（修订列表 + 任意版本只读预览 + 「对比当前」git 式行级 diff，行内改动深浅双层高亮）；记录 peek「…」菜单 → 历史视图（逐修订字段 diff、恢复）；数据库「…」菜单 →「最近动态」（表级活动流只读抽屉）。恢复带 `if_match`（409 stale → 提示刷新重试）；repair 修订默认隐藏（「显示修复」开关）；设备名经 `/api/nodes` 解析。
  - **设置页(Notion 化)**：两组 + 一个无头组、共六页(`settings/nav.ts` 是导航单一来源)——**设备**组:外观 / 快速笔记(仅桌面) / 离线与缓存(桌面隐藏);**工作区**组:数据与备份 / 设备 / 站点与发布;末尾无头的**关于**页(版本与更新)。原语是 `SetRow`(粗标题 + 灰副标 + 右对齐控件),一物一家、不重复摆放;`#/settings?sec=<page>` 是公共深链约定(旧的章节 id 经 `LEGACY_SEC` 映射)。见 [25-trust-and-settings](../impl-context/25-trust-and-settings/design.md)。
  - **发布对话框(受众优先)**：站点分支第一屏只问**"谁可以访问？"**(有链接的人 / 任何人 / 仅自己),托管是**派生摘要行**("Edge 始终在线 — 你的设备离线也能访问 · 更改"),数据授权折叠进"高级"。站点卡片副标题与 SitePeek 的**访问渠道**区块由同一份派生给出(受众徽章 + 托管 + 状态 + URL + 复制/打开)。托管不可用时是**内联引导块 + 深链到设置**,不是提交时才抛错。见 [24-sites-ux-refresh](../impl-context/24-sites-ux-refresh/design.md)。
  - **顶栏菜单**（v3.1+）：「分享」打开**能力分享弹窗**——选受众/目标(本机 server / 已配对 peer server / 挂载的对象存储桶 / Edge 房间)、权限 view|edit(edit 仅 server)、可选密码 + 过期 + 数据授权,并管理/撤销/续期已有分享(另有全局「分享」视图);此外仍可复制链接与导出(文档=Markdown、数据库=CSV)。「…」菜单含**创建副本**（文档=标题+全部块、数据库=属性列+全部记录，服务端 core 级原子复制、单一修订随 sync 收敛，完成后跳转副本；后缀「副本」是 WebUI 文案，core 不写死 locale）、视图切换、版本历史、重命名、删除。
  - 真实弹窗/菜单/SVG 图标（取代 `alert/prompt/confirm`）、明暗主题。
  - **移动端适配**（v3.0，触摸设备 + ≤768px）：首页变整页导航侧栏、点条目下钻到整屏内容、顶栏「←」返回；操作按钮无 hover 常显、≥16px 字号与触点（输入框 16px 防 iOS 放大）；状态栏 `theme-color` 随主题跟随、安全区适配。桌面端不受影响（判据含 `pointer:coarse`，拖窄桌面窗口不会切移动样式）。
- 所有写操作复用 CLI 同款 core 函数,经 CRDT oplog 落库,可随 `mh sync` 复制。
- REST 路由与 `/sync`、`/health` 同表(`routes.ts`),自动进 OpenAPI;id 通过 query 参数携带。
- WebUI 资源(含 Preact)单独打包 `dist/webui.js`,懒加载,不影响 CLI 启动性能。
- **暂未做**（需加 schema/后续）：数据库描述字段与文档独立图标、保存视图/持久化筛选排序（当前排序为客户端临时态、看板/日历占位）、同级/行手动顺序持久化；文档数学公式、脚注、callout（文档表格与 TOC 已实现）。
- **静态站点托管**:AI agent 用 `mh site create|scaffold|put|upload|list|files|access|grant|rm|delete` 发布站点,`--server` 在 `/sites/<name>/` serve(`serveSite` 懒加载,默认 `index.html`,`--spa` 时无扩展名 miss 回退);站点/文件进 CRDT oplog 随 `mh sync` 复制(文本/小二进制内联;图片与大二进制走 `cache/` blob,字节不进 oplog、**按需**跨机取回,见 [22-blob-sync](../impl-context/22-blob-sync/design.md))。见 [08-agent-sites](../impl-context/08-agent-sites/design.md)。
  - **WebUI「站点管理」页**(v2.9,2026-06-09):侧栏页脚入口 → 卡片列表 + 右侧 peek 文件抽屉(上传/预览/删除)+ 应用内 iframe 预览(直指已 serve 的 `/sites/<name>/`);配套补了 `POST/PATCH/DELETE /api/site*` HTTP 写接口(建站/改名·改标题/删站/传文件/删文件),仍是同一套 `emit()`。见 [08-agent-sites §6](../impl-context/08-agent-sites/design.md)。
  - **站点读写数据正式化 + 离线**(v3,2026-06-11):站点页同源调用 `/api/*` 的写路径纳入契约;可选 SDK `/metahub-sdk.js`(类型化方法 + code 化错误 + token 续期,裸 fetch 永远等价)。启用离线副本的浏览器里站点页**离线可打开**(含从未访问过的——站点文件随 oplog 在副本里,SW 网关从副本 serve,冷启动走自举壳页)、**离线可读写数据**,回网自动同步。信任模型显式化:站点同源=持有完整 hub 读写权限,只发布自产站点。见 [08-agent-sites v3](../impl-context/08-agent-sites/design.md) / [16-pwa-offline](../impl-context/16-pwa-offline/design.md)。
  - **公开访问 + 匿名数据授权**(2026-07):站点有了独立的 `visibility`(public 免 token)与 `spa` 开关;公开站点可经 `mh site grant` 开出一条**窄的、表×操作**授权的访客数据面 `/sites/<name>/api/*`(read/create/update,无 delete,反枚举 401),写入受 Turnstile/密码统一门保护。所有者设备离线时,访客投稿可经 **Edge 写信箱**异步收下(密文),或经 **Edge 房间**实时读写。见 [23-sites-experience](../impl-context/23-sites-experience/design.md)。
- **PWA 离线副本**:设置页「离线副本」开关(环境不满足时显示具体原因:HTTP 非安全上下文 / 无 OPFS);启用=自助配对+全量水合,之后本地优先(Proxy 门面,HTTP 回落永久保留)、离线编辑块级合并、离线 FTS 搜索、`synced` 事件驱动编辑器/表格原位合并刷新;「立即同步/停用/重置本地副本」与占用显示(`storage.estimate()`),水合后申请 `storage.persist()`。多标签 Web Locks 选主 + BroadcastChannel 代理。见 [16-pwa-offline](../impl-context/16-pwa-offline/design.md)。
- **鉴权**:`--debug` 全开;否则单 token 守护每个请求,经 `Authorization: Bearer`/Cookie `mh_token`/`?token=` 携带;浏览器走解锁页(存 `localStorage`+cookie)+ 注入 `/mh-runtime.js` 页面运行时(token 套壳 + SW 注册 + 离线桥;PWA 安装元数据豁免门禁)。**token 默认持久化在 `~/.metahub`**(重启复用),带 TTL(默认 30 天,env `METAHUB_TOKEN_TTL`),到期或 `mh token [show|refresh]` 的 refresh 时轮换;轮换后旧 token 在宽限期内(默认 7 天,env `METAHUB_TOKEN_GRACE`)仍可经 `GET /auth/token` 无感换新(解锁页静默续期 + 套壳 401 自动重试)。`--token`/`METAHUB_TOKEN` 则为固定、不持久化、不过期的静态覆盖。默认绑 `127.0.0.1`,`--host` 可改。见 [10-persistent-token](../impl-context/10-persistent-token/design.md)。

当前未实现/限制:

- blob 字节不进 oplog(按设计),但已可**按需**跨机取回(`/blob/<hash>`:本地 → HTTP peer → 桶,见 [22-blob-sync](../impl-context/22-blob-sync/design.md));浏览器副本**离线**仍取不到图(待浏览器侧 Cache Storage/OPFS spool)。
- 表格无分页、无范围/contains 过滤(沿用 `listRecords` 现状)。
- 快速加属性仅支持 text/number/checkbox/date/url;select/relation 等需带配置的类型仍走 CLI。
- 无并发编辑冲突的用户可见提示(底层 CRDT 仍按字段 LWW 收敛)。

## 输出模式

当前输出规则:

- stdout 是 TTY 时偏人类可读。
- 非 TTY 时输出紧凑 JSON。
- `--json` 强制 JSON。
- `--pretty` 强制人类输出。

当前限制:

- `--json`/`--pretty` 是通过扫描 `process.argv` 实现,不是正式 root command schema。
- JSON envelope 尚未统一成稳定的 `{ok,data,error}` 结构。
