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
mh doc list [--db <db-ref>]                 # 按 parent_id 缩进成树
mh doc get <doc-ref>
mh doc update <doc-ref> [--title] [--body] [--parent <doc-ref>]
mh doc delete <doc-ref>
```

文档层级:`--parent <doc-ref>` 把文档挂到某个父文档下,`--parent ""`(空值)移回顶层(清空 parent_id)。core 在改 parent 时做防环校验(不能挂到自身或后代下)。CLI 与 WebUI 拖拽改嵌套共用同一 `updateDocument(parent_id)` 路径。

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
GET  /                       # 浏览器 WebUI（Preact 单页应用）
GET  /webui.js               # WebUI 应用 bundle（懒加载）
GET  /docs  /docs.json       # OpenAPI 文档（Scalar UI / 规范）

GET    /api/databases        POST /api/databases
                             PATCH/DELETE /api/database    # ?id=<id>（重命名/图标、删除）
GET    /api/properties       POST /api/properties          # ?db=<id>
                             PATCH/DELETE /api/property     # ?id=<id>（改名/类型/选项/排序、删除）
GET    /api/records          POST /api/records             # ?db=<id>
GET    /api/record           PATCH/DELETE /api/record       # ?id=<id>
GET    /api/documents        POST /api/documents
GET    /api/document         PATCH/DELETE /api/document      # ?id=<id>
GET    /api/search           # ?q=<text>&limit=<n>

GET    /api/sites            GET /api/site/files          # 站点 / 文件清单（只读，?site=<id|name>）
GET    /sites/<name>/<path>  # 托管的静态站点（HTML/CSS/JS，agent 经 mh site 发布）

GET    /auth/token           # token 交换：持当前或宽限内旧 token → 返回 {token, exp}（无感续期；豁免门禁）
```

当前能力:

- 浏览器打开 `http://localhost:<port>/` 即用，**Notion-like 模块化 Preact 应用**（v2，见 [07-webui/implementation.md](../impl-context/07-webui/implementation.md)）：
  - **侧栏**：文档树（折叠/拖拽改嵌套）、宽度可拖拽、整栏可收起/展开、移动端抽屉；条目菜单（重命名/复制/删除/新建子页）、新建数据库 Modal（模板）。
  - **表格**：按类型行内编辑（checkbox/select/multi_select/relation/text/number/date/url）、列头菜单（改名/**改类型**/选项增删/排序/插入/删列）、加列、行菜单、多选删除、记录侧栏 peek、彩色 select chip。
  - **文档**：块级**所见即所得**编辑器（`/` 斜杠菜单、块拖拽重排、选中浮动格式条、待办/列表/引用/代码/分隔线）；防抖保存复用 `PATCH /api/document` 的按块 reconcile。
  - 真实弹窗/菜单/SVG 图标（取代 `alert/prompt/confirm`）、明暗主题、移动端适配。
- 所有写操作复用 CLI 同款 core 函数,经 CRDT oplog 落库,可随 `mh sync` 复制。
- REST 路由与 `/sync`、`/health` 同表(`routes.ts`),自动进 OpenAPI;id 通过 query 参数携带。
- WebUI 资源(含 Preact)单独打包 `dist/webui.js`,懒加载,不影响 CLI 启动性能。
- **暂未做**（需加 schema/后续）：数据库描述字段与文档独立图标、保存视图/持久化筛选排序（当前排序为客户端临时态、看板/日历占位）、同级/行手动顺序持久化。
- **静态站点托管**:AI agent 用 `mh site create|put|publish|list|files|rm|delete` 发布站点,`--server` 在 `/sites/<name>/` serve(`serveSite` 懒加载,默认 `index.html`);站点/文件进 CRDT oplog 随 `mh sync` 复制(文本/小二进制内联,大二进制走 `cache/` blob、字节暂本机)。见 [08-agent-sites](../impl-context/08-agent-sites/design.md)。
- **鉴权**:`--debug` 全开;否则单 token 守护每个请求,经 `Authorization: Bearer`/Cookie `mh_token`/`?token=` 携带;浏览器走解锁页(存 `localStorage`+cookie)+ 注入 fetch 套壳。**token 默认持久化在 `~/.metahub`**(重启复用),带 TTL(默认 30 天,env `METAHUB_TOKEN_TTL`),到期或 `mh token [show|refresh]` 的 refresh 时轮换;轮换后旧 token 在宽限期内(默认 7 天,env `METAHUB_TOKEN_GRACE`)仍可经 `GET /auth/token` 无感换新(解锁页静默续期 + 套壳 401 自动重试)。`--token`/`METAHUB_TOKEN` 则为固定、不持久化、不过期的静态覆盖。默认绑 `127.0.0.1`,`--host` 可改。见 [10-persistent-token](../impl-context/10-persistent-token/design.md)。

当前未实现/限制:

- `/sync`(CRDT 复制端点)本身仍无鉴权;token 门禁覆盖其余请求面。
- blob 字节不随 oplog 复制(大二进制站点资源跨机需另传)。
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

