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
mh doc append <doc-ref> --body "markdown"
mh doc prepend <doc-ref> --body "markdown"
```

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

## 同步

已实现:

```bash
mh --server --port 7777
mh sync http://host:7777
```

当前能力:

- 一轮 push/pull(单次轮回即双向:同时推本地、拉远端)。
- 基于 rowid cursor 防止 HLC 漂移漏同步。
- 通过 CRDT oplog 最终一致。
- **多设备配对 + 自动同步**:一次性配对码引导、交换长期 per-peer 凭据,server 内置定时器周期性双向同步已配对 peer(默认 30s);`/sync` 鉴权(主 token 或配对凭据)。统一入口 `mh config`(方向键交互向导 `@clack/prompts` + `--flag`)/ WebUI 设置页。撤销:`peer rm`(连带吊销)/ `grant revoke`。见 [11-device-pairing-sync](../impl-context/11-device-pairing-sync/design.md)。
- **浏览器离线副本(PWA)**:WebUI 设置页一键启用——自助配对(页面持主 token 自己铸码兑换凭据,在「已授权设备」可单独吊销)、按 `limit` 分页水合全量 oplog 至 OPFS、之后读写走本地 + 后台 `syncWithPeer()`,离线可查看编辑全部内容(含托管站点页的读写),回网块级合并。需 HTTPS(secure context)+ OPFS(Safari 17+);不满足时设置页显示原因并自动回落纯在线模式。见 [16-pwa-offline](../impl-context/16-pwa-offline/design.md)。
- **同步分页**:`/sync` 请求可带 `limit`(分页拉取)与 `exclude_datasets`(部分副本;协议就绪,设置 UI 未开),游标保证永不回退。

```bash
mh config peer code                                          # 生成一次性配对码
mh config peer add --url http://host:7777 --code <code> --self-url <self>
mh config peer list|sync|enable|disable|rm   |   mh config grant list|revoke
```

当前未实现:

- 冲突解释或用户可见 diff。
- blob **离线**取图(浏览器侧 Cache Storage LRU + OPFS spool;字节**按需**跨机传输已实现,见 [22-blob-sync](../impl-context/22-blob-sync/design.md))。
- 配对凭据过期(目前靠撤销管理)、`/api/pair` 限频。
- TLS 已可由 `--tls-cert/--tls-key` 直出或反代承担;裸 HTTP 下凭据仍是明文 Bearer,需可信网络。

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
GET    /api/site/files       PATCH/DELETE /api/site          # 文件清单（?site=）/ 改名·改标题·删站（?id=）
POST   /api/site/file        DELETE /api/site/file          # 上传(裸字节)/删文件（?site=&path=）
GET    /sites/<name>/<path>  # 托管的静态站点（HTML/CSS/JS，agent 经 mh site 发布）

GET    /auth/token           # token 交换：持当前或宽限内旧 token → 返回 {token, exp}（无感续期；豁免门禁）
```

当前能力:

- 浏览器打开 `http://localhost:<port>/` 即用，**Notion-like 模块化 Preact 应用**（v2，见 [07-webui/implementation.md](../impl-context/07-webui/implementation.md)）：
  - **侧栏**：文档树（折叠/拖拽改嵌套与同级排序）、宽度可拖拽、整栏可收起/展开；条目菜单（重命名/复制/删除/新建子页）、新建数据库 Modal（模板）。
  - **表格**：按类型行内编辑（checkbox/select/multi_select/relation/text/number/date/url）、列头菜单（改名/**改类型**/选项增删/排序/插入/删列）、加列、行菜单、多选删除、记录侧栏 peek、彩色 select chip。单元格读写一律按**属性 id**（record 响应的 `cells` 字段；`values` 按名供 CLI/agent），重名列互不串扰；新建列默认名自动去重（「日期」→「日期 2」）。
    - **覆盖式单元格编辑器**（v3.3）：编辑器悬浮于单元格上方（行高不变）；双击或选中后直接打字进入（打字替换原值）；点击别处/Enter/Tab 均提交、Esc 放弃，值不变不发请求/不写历史；乐观更新即时生效、失败 toast+回滚；中文 IME 选词 Enter 不误提交。
    - **电子表格键盘**（v3.3）：方向键移动选中格（Shift 扩展为框选）、Enter/F2 进编辑、编辑中 Tab/Shift+Tab 提交并左右走格、Enter 提交并下移一行、Delete 清空；框选 Cmd/Ctrl+C 复制 TSV、底部操作条复制/填充/清空。
  - **文档**：块级**所见即所得**编辑器（`/` 斜杠菜单、块拖拽重排、单块选中浮动格式条、待办/列表/引用/代码/分隔线）；支持 Typora 风格核心快捷输入（标题、列表、待办、引用、代码 fence）、列表 Tab/Shift+Tab 嵌套、列表内段落/引用/代码块/子列表、代码语言名。代码块为 textarea + highlight.js 高亮镜像，含**语法高亮**、行号、语言下拉、复制（右下角 hover）与键盘退出（末行空行 Enter / 末行 ↓）；空列表项内删除空代码块会保留当前编号/marker。
    - **多块选中**（v2.3）：拖拽跨块或左侧空白拖拽框选整块、Shift+点击扩展，选中块加底色（无浮动工具栏）；键盘批量删除/缩进/复制·剪切为 Markdown/复制(Cmd+D)/全选(Cmd+A)/Shift+↑↓ 扩展，多块整组拖拽移动。
    - **撤销/重做**（v2.3）：Cmd/Ctrl+Z 撤销、Cmd/Ctrl+Shift+Z 或 Ctrl+Y 重做，覆盖结构性块操作与文字输入（接管原生撤销，连续打字合并为一步）。
    - **有序列表起始号**（v2.3）：按用户输入的首项数字起算（`5.` 从 5 递增），后续自动递增；插入/删除/重排后序号自动重建。
    - 防抖保存复用 `PATCH /api/document` 的按块 reconcile,保存 Markdown 会规范化缩进，并保留同级有序列表的起始号。
  - **版本历史**：文档「…」菜单 → 右侧抽屉（修订列表 + 任意版本只读预览 + 「对比当前」git 式行级 diff，行内改动深浅双层高亮）；记录 peek「…」菜单 → 历史视图（逐修订字段 diff、恢复）；数据库「…」菜单 →「最近动态」（表级活动流只读抽屉）。恢复带 `if_match`（409 stale → 提示刷新重试）；repair 修订默认隐藏（「显示修复」开关）；设备名经 `/api/nodes` 解析。
  - **顶栏菜单**（v3.1）：「分享」收口复制链接与导出（文档=Markdown、数据库=CSV，「…」菜单不再重复导出项）；「…」菜单含**创建副本**（文档=标题+全部块、数据库=属性列+全部记录，服务端 core 级原子复制、单一修订随 sync 收敛，完成后跳转副本；后缀「副本」是 WebUI 文案，core 不写死 locale）、视图切换、版本历史、重命名、删除。
  - 真实弹窗/菜单/SVG 图标（取代 `alert/prompt/confirm`）、明暗主题。
  - **移动端适配**（v3.0，触摸设备 + ≤768px）：首页变整页导航侧栏、点条目下钻到整屏内容、顶栏「←」返回；操作按钮无 hover 常显、≥16px 字号与触点（输入框 16px 防 iOS 放大）；状态栏 `theme-color` 随主题跟随、安全区适配。桌面端不受影响（判据含 `pointer:coarse`，拖窄桌面窗口不会切移动样式）。
- 所有写操作复用 CLI 同款 core 函数,经 CRDT oplog 落库,可随 `mh sync` 复制。
- REST 路由与 `/sync`、`/health` 同表(`routes.ts`),自动进 OpenAPI;id 通过 query 参数携带。
- WebUI 资源(含 Preact)单独打包 `dist/webui.js`,懒加载,不影响 CLI 启动性能。
- **暂未做**（需加 schema/后续）：数据库描述字段与文档独立图标、保存视图/持久化筛选排序（当前排序为客户端临时态、看板/日历占位）、同级/行手动顺序持久化；文档表格、数学、脚注、callout、TOC。
- **静态站点托管**:AI agent 用 `mh site create|put|publish|list|files|rm|delete` 发布站点,`--server` 在 `/sites/<name>/` serve(`serveSite` 懒加载,默认 `index.html`);站点/文件进 CRDT oplog 随 `mh sync` 复制(文本/小二进制内联;图片与大二进制走 `cache/` blob,字节不进 oplog、**按需**跨机取回,见 [22-blob-sync](../impl-context/22-blob-sync/design.md))。见 [08-agent-sites](../impl-context/08-agent-sites/design.md)。
  - **WebUI「站点管理」页**(v2.9,2026-06-09):侧栏页脚入口 → 卡片列表 + 右侧 peek 文件抽屉(上传/预览/删除)+ 应用内 iframe 预览(直指已 serve 的 `/sites/<name>/`);配套补了 `POST/PATCH/DELETE /api/site*` HTTP 写接口(建站/改名·改标题/删站/传文件/删文件),仍是同一套 `emit()`。见 [08-agent-sites §6](../impl-context/08-agent-sites/design.md)。
  - **站点读写数据正式化 + 离线**(v3,2026-06-11):站点页同源调用 `/api/*` 的写路径纳入契约;可选 SDK `/metahub-sdk.js`(类型化方法 + code 化错误 + token 续期,裸 fetch 永远等价)。启用离线副本的浏览器里站点页**离线可打开**(含从未访问过的——站点文件随 oplog 在副本里,SW 网关从副本 serve,冷启动走自举壳页)、**离线可读写数据**,回网自动同步。信任模型显式化:站点同源=持有完整 hub 读写权限,只发布自产站点。见 [08-agent-sites v3](../impl-context/08-agent-sites/design.md) / [16-pwa-offline](../impl-context/16-pwa-offline/design.md)。
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
