# 当前使用流程

本文只描述当前代码已经支持的用户体验,不描述理想最终形态。

## 记账数据当前流程

当前没有 `ledger` 专用命令,需要用通用数据表手动搭建。

### 1. 建表

```bash
mh init
mh db create "Transactions"
mh use transactions            # 设为当前库,后续 prop/record 免带库参数
mh prop add date --type date
mh prop add amount --type number
mh prop add category --type select --options food,transport,shopping,other
mh prop add account --type text
mh prop add note --type text
```

### 2. 写入一笔流水

```bash
mh record create --data '{
  "date": "2026-05-29",
  "amount": -38.5,
  "category": "food",
  "account": "alipay",
  "note": "coffee"
}'
```

### 3. 查询流水

当前可做:

```bash
mh record list --filter '{"category":"food"}' --sort date --desc --limit 20
mh record get <ref>            # 完整 id 或唯一前缀
mh record update <ref> --data '{"category":"transport"}'
mh search "coffee"
```

### 当前体验结论

已可完成:

- 手动建记账表。
- 单条写入。
- 按分类等值过滤。
- 按日期字段排序。
- 通过全文搜索找备注。

还不能完成:

- 按月份范围查询。
- 按分类汇总支出。
- CSV/JSONL 批量导入。
- 自动去重。
- 低置信度 review。
- merchant/category 规则。

所以当前记账体验是“通用表 MVP”,不是完整记账 Agent 体验。

## IM 历史消息当前流程

当前没有 `chat` 专用命令,需要用通用数据表手动搭建。

### 1. 建 messages 表

```bash
mh db create "Messages"
mh use messages
mh prop add conversation --type text
mh prop add sender --type text
mh prop add sent_at --type date
mh prop add text --type text
mh prop add source --type text
mh prop add message_id --type text
```

### 2. 写入消息

```bash
mh record create --data '{
  "conversation": "alice",
  "sender": "Alice",
  "sent_at": "2026-05-29T10:00:00Z",
  "text": "发票发你了",
  "source": "wechat",
  "message_id": "wechat_001"
}'
```

### 3. 查询消息

当前可做:

```bash
mh record list --filter '{"conversation":"alice"}' --sort sent_at --desc --limit 50
mh search "发票"
```

### 当前体验结论

已可完成:

- 手动建消息表。
- 单条写入消息。
- 按 conversation 等值过滤。
- 按 sent_at 排序取最近消息。
- 全文搜索消息文本。

还不能完成:

- 批量导入平台导出文件。
- message_id 去重或 upsert。
- 时间范围查询。
- 搜索后查看前后上下文。
- 按 conversation title/member 做关系查询。
- cursor pagination。

所以当前 IM 体验适合 demo 和小规模手动写入,还不适合真实历史消息归档。

## 文档当前流程

文档能力相对完整。

### 1. 创建和读取

```bash
mh doc create --title "架构说明" --body @arch.md
mh doc list
mh doc get 架构说明              # 标题/前缀/完整 id 均可
mh search "架构"
```

### 2. AI 增量编辑

```bash
mh doc read <doc-ref>                                    # 拿 body + version token
mh doc edit <doc-ref> --old "旧文本" --new "新文本" --if-match <version>
mh doc edit <doc-ref> --edits '[{"old":"A","new":"B"},{"old":"C","new":"D"}]' --if-match <version>
                                                          # 一次 read → 多处锚定改写,原子落笔
mh doc append <doc-ref> --body "追加段落"
```

多处零散改动优先用 `--edits` 批量:N 对锚定 find/replace 在一次 transaction 里原子应用,只需一次 `--if-match`、一次修订,任一对锚点缺失/歧义则整批中止、文档不变。

### 3. 人类编辑

```bash
mh edit <doc-ref>
mh edit <doc-ref> --vscode
```

### 当前体验结论

已可完成:

- Markdown 文档 CRUD。
- AI read-before-edit。
- 锚定替换。
- append/prepend。
- 人类编辑器编辑。
- block-level CRDT 合并不同段落编辑。

还不能完成:

- 根据 block id 或行号精确编辑。
- 返回具体 changed block。

（富附件/图片引用与 blob 同步**已实现**:`mh blob add` 内容寻址 + `/blob/<hash>` 按需跨机取回,WebUI 支持粘贴/拖拽上传成媒体块;见 [capabilities.md](./capabilities.md) 的「Blob 与缓存」。）

## 误改/误删恢复当前流程

任何实体粒度的恢复都不再需要整库快照回滚:

### 1. 查历史定位版本

```bash
mh doc history <doc-ref>                 # 修订列表:version / 时间 / 设备 / 摘要
mh record history <rec-ref> --field 金额  # 单字段的值变迁
mh prop history <prop-ref>               # 列改名/改类型/删除史(含级联清格计数)
mh db activity <db-ref>                  # 不知道哪条被改?先看全表动态(含删除事件)
mh doc get <doc-ref> --at <version>      # 先预览再决定
```

### 2. 回滚

```bash
mh doc revert <doc-ref> --to <version> --if-match <v>   # 正文+标题恢复
mh record revert <rec-ref> --to <version>               # 字段恢复
mh prop revert <prop-ref> --to <version>                # 误改类型/误删列:连同被清的单元格一起恢复
```

误删恢复:对已删除的文档/记录/列,用**完整 id** 走同样的 history/revert,revert 即复活。回滚本身是新修订,后悔可再回滚。WebUI 中文档「…」菜单与记录 peek 提供同等能力(预览 + diff + 恢复)。

### 3. 磁盘维护(可选)

```bash
mh doctor                  # 末行报告 oplog 行数 / 可压缩量 / 库大小
mh compact --dry-run       # 预览
mh compact --keep 90       # 窗口外历史坍缩为基线;当前数据不变;纯本地
```

## 快照和同步当前流程

### 快照

```bash
mh snapshot backup.mhpack
mh restore backup.mhpack
mh restore backup.mhpack --reset --force
```

### 同步

```bash
mh --server --port 7777
mh sync http://host:7777

# 也可与本地文件互导（同一条命令，双参数即进入导出/导入）
mh sync architecture arch.md   # 文档 → markdown
mh sync tasks tasks.csv        # 数据表 → CSV
mh sync arch.md architecture   # markdown → 文档（反向导入）

# 设备接入:HTTP 配对码,或对象存储桶 enroll(离线转发,两端无需同时在线)
mh config peer code                          # A 机生成一次性配对码
mh config peer add --url http://A:7777 --code <code> --self-url http://B:7777   # B 机配对
mh config peer add --enroll <code>           # 用 enroll 码/扫码挂对象存储桶(S3 转发)

# 公开分享:把文档/数据库/站点发布成能力链接
mh share create <ref> --permission view [--password <pw>] [--expires 7d]
mh share list | mh share revoke <slug>
```

当前体验结论:

- 可用于备份、迁移和简单多节点同步;HTTP 对等直连,或经对象存储桶做离线 store-and-forward;设备接入支持配对码与扫码 enroll。
- 公开分享:`view` 只读 SSR / `edit` 接受 guest 写入,可加密码与过期;WebUI 顶栏「分享」弹窗同款能力。
- 命令形态偏工程化。
- 对普通用户还缺少状态解释、冲突说明和同步历史。
- 文件导出/导入便于把单篇文档或单张表交给外部编辑器/表格工具,再导回;但导入只更新已存在实体、一次一个,尚不支持批量入库。

## 分享与设备接入当前流程

### 分享一篇文档 / 数据库 / 站点

**A. server 传输(实时 SSR,支持 view/edit)**

```bash
mh --server --host 0.0.0.0 --port 7777          # host 需别人可达(LAN IP / 域名 / 隧道)
mh share create 架构说明 --permission view       # 打印 https?://<base>/share/<slug> + 通过：<source>
mh share create 架构说明 --permission edit --password s3cr3t --expires 7d
mh share list                                    # 汇总本机 + 已配对 server + 桶上的分享
mh share revoke <slug>                           # 撤销(别名 rm;--via <peer> 让配对 server 代撤)
```

- 访问者打开 `/share/<slug>`(在 token 门禁**前**、公开):`view` 只读 SSR 渲染(走共享语法 + `safeUrl` 净化、按 kind 出媒体);`edit` 接受 guest 节点写入(归属独立合成节点)。密码/过期在此校验。
- WebUI 顶栏「分享」弹窗是同一套能力(选目标 server/桶、权限、密码、过期、管理/撤销)。

**B. s3 传输(预签名静态导出,只读)**

```bash
mh config peer add --s3 --endpoint <url> --bucket <name> --access-key <id> --secret-key <key>
mh share create 架构说明 --transport s3          # 预签名静态链接(最长 7 天)
mh share renew <slug>                            # 过期续期
```

### 接入一台新设备

**A. HTTP 配对(两端可互达)**

```bash
# 设备 A
mh config peer code                              # 打印一次性配对码(默认 10min)
# 设备 B
mh config peer add --url http://A:7777 --code <code> --self-url http://B:7777
mh config peer list                              # 确认已配对;之后 --server 定时器自动双向同步
```

**B. 对象存储桶 enroll(离线转发,两端无需同时在线)**

```bash
# 设备 A(已挂桶):在 WebUI 设置页生成 enroll 二维码 / 深链(#enroll=<token>,只带访问描述符)
# 设备 B:应用内扫码取景器扫一下,或复制码走 CLI:
mh config peer add --s3 --enroll <code>          # 从码里解出桶端点/凭据/前缀,挂桶并同步
```

- enroll token 只携带**访问描述符**(桶端点/凭据/前缀/可选口令),由 WebUI(`settings.tsx` `encodeEnroll`)铸出、`enroll.tsx` 或 CLI `--enroll` 消费;深链片段连上后即清除。挂桶后各设备把 oplog 变更推到桶、按 `storage_cursors` 拉,无需两端同时在线。

## WebUI 当前流程

### 1. 启动并打开

```bash
mh --server --port 7777
# 浏览器打开 http://localhost:7777/
```

> v2 改版为 Notion-like 模块化 Preact 应用，下述流程为现状（见 [07-webui/implementation.md](../impl-context/07-webui/implementation.md)）。

### 2. 侧栏：导航与组织

- 左侧栏分「数据库」「文档」两组；文档为**树**，可折叠、拖拽改嵌套与排序（drop-into 嵌为子页、before/after 在同级间重排，均经 `PATCH /api/document/move` 持久化——`parent_id` 与 `order_key` 一次原子更新）。
- 悬停条目出现「+ 子页」与 ⋯ 菜单（重命名/复制/删除/移到顶层）。「数据库」组的「+」弹**新建数据库 Modal**（名称 + 图标 + 模板：空白/任务/联系人）。侧栏宽度可拖拽；窄屏（≤768px）变抽屉。

### 3. 表格（Notion-like）

- 点选数据库 → 按属性渲染网格。单元格编辑：checkbox 即时切、select/multi_select 弹彩色 chip 菜单；其余类型（text/number/date/url/relation，relation 逗号分隔）双击或选中后直接打字进入**覆盖式编辑器**——悬浮于单元格上方、行高不变；点击别处/Enter/Tab 均提交、Esc 放弃、值不变不发请求；乐观更新本地即时生效，后台 `PATCH /api/record`，失败 toast+回滚。中文输入法 Enter 选词不会误提交。
- **键盘**：方向键移动选中格（Shift 扩展为框选）、Enter/F2 进入编辑、编辑中 Tab/Shift+Tab 提交并移到左右邻格、Enter 提交并下移一行、Delete/Backspace 清空；框选支持 Cmd/Ctrl+C 复制 TSV，底部操作条复制/填充/清空。
- **列头菜单**：改名、**改类型**（`PATCH /api/property`，改类型会清空该列单元格）、select 选项增删、排序、在右侧插入列、删除列。末列「+」按类型新建属性。
- 行 ⋯ 菜单（打开/复制/删除）、勾选多行后底部操作条（复制/删除）、首列「打开」进**记录侧栏 peek**（属性逐项编辑）。

### 4. 文档（CodeMirror 6 所见即所得）

编辑器是 **CodeMirror 6**:文档就是一份 Markdown 文本、块是派生的展示层、光标感知 reveal-to-edit(详见 [webui-editor.md](./webui-editor.md))。

- 点选文档 → 标题 + CM6 编辑器。悬停行左侧 gutter 出「+」与 grip 拖拽(改类型/重排);输入 `/` 唤出**块类型菜单**;选中文字弹**行内格式条**(粗/斜/删除线/代码/链接),行内标记(粗体/链接/代码/行内图)实时预览、光标进入才露出原始 Markdown。
- Markdown 快捷输入(空格/回车提交 marker):`# `/`## ` 标题、`- `/`* `/`+ ` 无序、`1. `/`5. ` 有序(**字面序号权威**)、`- [ ] ` 待办、`> ` 引用、```` ``` ```` / ```` ```python ```` + Enter 转代码块。列表 Enter 续行、空列表项 Enter 退出、Tab/Shift+Tab 缩进。
- **void 区块**:图片/视频/音频/文件/**GFM 表格**/代码/HTML 作为原子或 reveal-to-edit 组件。代码块含语法高亮、行号、语言选择、软换行开关与**一键格式化**(懒加载 prettier/wasm);表格支持 Notion 式行列 pill 手柄、autofit 与多选;图片支持标注与 lightbox。粘贴/拖拽图片自动上传成媒体块。
- **source/blocks 模式** `⌘/` 切换(同一 CM view reconfig);**⌘F 文档内查找**、右侧 **TOC** + 滚动高亮、右下**字数 pill**。
- **撤销/重做**为原生 CM6(所有结构操作都是普通文本 transaction);IME 合成友好(行内装饰跨合成 remap、表格/代码 void 合成期不逐字提交)。
- 编辑防抖保存(700ms):整篇 Markdown body(`getDoc()`)→ `PATCH /api/document`,服务端 `reconcileBody` 按 core block 规则保留 CRDT 身份;标题走 `textContent` 播种(非 innerHTML,XSS 安全)。
- 顶栏(文档与数据库视图同款):「分享」打开**能力分享弹窗**(选本机 server / 已配对 peer / 对象存储桶、权限 view|edit、可选密码 + 过期,并管理/撤销已有分享),另可复制链接与导出(文档=Markdown、数据库=CSV);「…」菜单含**创建副本**(`POST /api/document|database/duplicate`,服务端原子复制)、视图切换、版本历史、重命名、删除。

### 5. 搜索

- 侧栏搜索框回车 → `GET /api/search`,结果点击跳转到对应文档或记录所在库。

当前体验结论:

- 提供了 CLI 之外的 Notion-like 可视化编辑入口（全面 CRUD、真实弹窗/菜单、明暗主题、移动端适配），编辑经 CRDT oplog,可随 `mh sync` 复制。
- 暂未做：数据库描述/文档独立图标、保存视图与持久化筛选排序（当前排序为客户端临时态）、同级/行手动顺序持久化；文档数学公式、脚注、callout 未实现（文档表格与 TOC 已实现）。鉴权外无复杂权限,假定可信网络/本机(公开分享另有 slug/密码/过期访问控制)。
- WebUI 与 Preact 单独打包(`dist/webui.js`)、懒加载,不影响 CLI 启动性能。
