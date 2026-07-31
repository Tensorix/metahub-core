# 目标差距与用户体验优先级

本文按用户体验整理优先级。当前阶段暂不讨论同步安全性和并发写锁。

## 产品目标

Metahub 的目标不是只做一个 SQLite 包装 CLI,而是为 AI Agent 和人类用户提供一套通用本地数据与文档操作层:

- 简单数据需求可以快速建表和查询。
- 复杂但常见的数据需求,例如记账和 IM 历史消息,可以通过通用表结构和通用查询能力覆盖。
- AI 可以稳定读 schema、写数据、查数据、修正文档。
- 人类可以用直观命令和编辑器完成相同数据的查看和修正。

## 已改善: ID 引用体验

原硬伤「每次都要粘贴完整 id、id 不带类型(`test-abc` 分不清 db/rec/doc)、record 操作重复带库 id」已通过友好 ID 特性解决(见 [data-model.md](./data-model.md) 的「ID 与引用」、`docs/impl-context/06-friendly-ids/design.md`):

- 类型前缀 id(`<kind>_…`)使 id 自解释。
- 引用解析层支持完整 id / 唯一前缀 / 名字。
- `mh use <db>` 提供当前库上下文;relation 值也按引用解析。
- 歧义报错列候选(git 风格),不静默误选。
- `mh completion` 提供 Tab 补全。

## 已改善: 数据完整性

原硬伤「schema 只保主键,关联字段全是弱引用,API/CLI/sync/restore 都可能写出孤儿/重复/断链,且在 CRDT 下被同步放大」已通过 core 层最终一致约束解决(见 [data-model.md](./data-model.md) 的「完整性约束」、`docs/impl-context/13-data-integrity/design.md`):

- `validateHub`/`repairHub`(`src/core/integrity.ts`):只读体检 + 确定性、幂等修复。
- 两条铁律:修复只针对 tombstone(容忍尚未到达的前向引用)、修复是收敛态纯函数(winner 取 `(created_hlc,id)` 全序,循环到不动点),故各节点独立修复后既收敛又有效。
- 删除 database/property/document 内置写时级联(主路径);`repairHub` 兜底 sync 引入的坏数据,并在 `restore` 后自动跑。
- `mh doctor` / `mh repair [--dry-run]` 暴露给用户;**绝不 hard-delete 用户内容**(重名只报告)。

仍未做:`/sync` 后增量校验、WebUI 暴露体检入口。(属性重名已**定策不做**写时强校验——访问层报 `ambiguous` + CLI warning + WebUI id-keyed,见下文「属性重名」。)

## 已改善: 修改历史与回滚 + 磁盘回收

原缺口「误改/误删不可恢复(只能整库快照回滚),oplog 无限增长无清理手段」已解决(见 [capabilities.md](./capabilities.md) 的「历史与回滚」「存储压缩」、`docs/impl-context/15-history-rollback-compaction/design.md`):

- oplog 即历史:文档/记录/属性的修订列表、任意时点重建、回滚(回滚 = 正向写入,随 sync 收敛,自身可再回滚);已删实体可复活。
- `txn` 修订分组随 sync 复制,各端历史视图一致;`kind` 区分 user/repair/revert,WebUI 默认过滤修复噪音。
- schema 回滚(`prop revert`)恢复列定义 + 被级联清掉的单元格,用户后写保留。
- WebUI 历史面板:文档抽屉(预览 + git 式行级 diff、行内深浅高亮)、记录字段级 diff;CLI/HTTP 全量暴露。
- 表级活动流:`mh db activity` / `GET /api/database/activity` / WebUI「最近动态」抽屉——全表记录修订聚合时间线(含已删记录)。
- `mh compact` 保留窗口压缩 + blob GC + VACUUM,纯本地,头部状态不变;`mh doctor` 报告可压缩量。

仍未做:sites 历史、自动定时压缩、彻底抹除已删数据(需全 peer 墓碑确认)。

## 属性重名(已定策,不做硬约束)

同库重复属性名是**有意保留的合法状态**——离线多端并发创建同名列经 sync 汇合天然存在,写时硬约束会与收敛冲突。已落地的处理(见 [data-model.md](data-model.md) records 节 / [capabilities.md](capabilities.md) 属性节):

- name-keyed 记录读写/过滤/排序命中多个重名属性 → 报 `ambiguous`(exit 4),要求改用 property id;不静默 last-wins。
- `prop add` / `prop update --name` 造成重名 → 操作成功 + stderr warning(列出冲突 id)。
- record 读返回 name-keyed `values`(重名有损)+ id-keyed `cells`(无损);WebUI 全程按 id 读写,重名列互不串扰,新建列默认名自动去重。
- `mh doctor` 报告 `dup_name`(repair 只报告、不自动改名/删,以免破坏用户内容)。

## 已改善: 富文档编辑、媒体与分享(0.3.x)

0.3.x 版本线关闭了一批"编辑与协作"缺口(见 [webui-editor.md](./webui-editor.md)、[capabilities.md](./capabilities.md)):

- **文档编辑器重写为 CodeMirror 6**:文档 = 单份 Markdown 文本、块是派生模型、装饰驱动的所见即所得;结构编辑都是普通文本 transaction + 原生撤销,行/行内语法下沉共享的 `core/md/*`(编辑器/保存/分享三面一致,parity 测试钉住)。取代了原自研 contenteditable 嵌套块树(整类导航/往返 bug 结构性消失)。
- **AI 批量编辑** `mh doc edit --edits`:一次 read 下 N 个锚定 delta,原子落笔、一次 `--if-match`。
- **富媒体与 blob 同步**:图片/视频/音频/文件 void 区块 + 粘贴/拖拽上传;blob 字节内容寻址、不进 oplog、**按需**跨机取回(`mh blob`/`mh cache`,全量设备/桶作 durable 锚)。
- **代码块一键格式化**:懒加载 prettier + per-language wasm(ruff/gofmt/clang/lua/taplo/sh),从不进主 bundle。
- **能力分享与发布**:文档/数据库/站点发布成公开链接——server 实时 SSR(view 只读 / edit 接受 guest 写入)或 S3 预签名静态导出;可加密码/过期;URL 经 `safeUrl` 净化。
- **PWA 离线副本 + 多设备接入**:浏览器成一等 CRDT 节点(离线读写全部内容);设备接入支持 HTTP 配对码与对象存储桶扫码 enroll(离线 store-and-forward)。
- **文档表格与 TOC**:GFM 文档表格(Notion 式行列手柄)与目录 + 滚动高亮已实现(此前列在"未实现")。

仍未做(编辑侧):文档数学公式/脚注/callout、按 block id 或行号的精确编辑、返回具体 changed block、浏览器副本**离线**取图。

## 已改善: 对外发布、访客写入与信任面(0.4.x)

0.4.x 版本线把"发布出去"从"要么全公开、要么设备得一直开着"变成了有档位的能力,并把"我的数据安全吗"变成能直接回答的问题(见 [architecture.md](./architecture.md) 的访客面/Edge/信任面三节、[23-sites-experience](../impl-context/23-sites-experience/design.md)、[24-sites-ux-refresh](../impl-context/24-sites-ux-refresh/design.md)、[25-trust-and-settings](../impl-context/25-trust-and-settings/design.md)):

- **访客面三原语**:`GrantSet`(表×操作、无 delete、default-deny、反枚举)、`AccessPolicy`(三套存储的只读投影,一个访客服务路径)、`GuestIntent`(访客提交意图,运行时负责鉴权/时钟/幂等)。公开站点与分享链接共用**同一份**访客数据面实现。
- **Edge 子系统(用户自己的 Cloudflare 账号)**:写信箱让所有者离线时也能收到访客投稿(密文,主机只见 ciphertext);DO 房间让站点分享**常在线**。一条 `mh edge deploy`,支持"用 Cloudflare 登录"(PKCE,无官方后端居中)。
- **站点渠道控制面**:期望态同步、观测态本地;卡片/对话框/CLI 的"现在谁能访问、依赖什么在线"由**一份**派生给出;非控制器设备也能吊销。
- **发布体验受众优先**:第一屏只问"谁可以访问",托管自动推导且可展开修改;死胡同报错换成内联引导 + 设置深链。首次发布的必答决策从 5-6 个降到 1 个。
- **信任三件套**:数据地图(`mh status` / 设置页同一份派生,离线可答)、设备名册(离线优先,诚实的可吊销判定)、换钥 + 恢复码(丢设备/忘短语的最后兜底)。
- **设置页 Notion 化**:两组六页 + `SetRow` 原语 + `?sec=` 深链约定,取代原先越长越乱的单页堆叠。
- **文档内链 `[[doc_id]]`**:一等行内语法,往返无损,CLI/agent 直接写即可;分享页惰性渲染不泄露未分享目标。

仍未做:访客写入的用量/滥用可视化(目前只有拒收台账);房间的多分享共用与配额面板;`AccessPolicy` 的存储合一(现为只读门面);shares-view 尚未并入"渠道"概念。

## P0: 当前体验硬伤

### 友好参数错误

当前非法 `--limit` 可能冒出 SQLite `datatype mismatch`。JSON parse、未知字段、类型错误也需要更稳定的错误结构。

建议:

- CLI 层先校验 number 参数。
- 错误返回稳定 code,例如 `INVALID_LIMIT`、`UNKNOWN_PROPERTY`、`TYPE_MISMATCH`。

### 明确 unset 语义

当前 CLI 可以写 `null`,但不能表达删除单元格 key。

建议:

```bash
mh record unset <recordId> <field>
```

或:

```bash
mh record update <recordId> --unset fieldA,fieldB
```

### 当前状态文档持续维护

旧文档中仍有 EAV、整文档 LWW、`record_values` 等过期描述。后续应以本目录作为当前事实入口。

## P1: 通用表查询体验

这是记账和 IM 两个目标场景的共同基础。

### 查询 DSL

当前只有 `{field:value}` 等值过滤。

建议新增:

```json
{
  "date": { "between": ["2026-05-01", "2026-05-31"] },
  "amount": { "lt": 0 },
  "category": { "in": ["food", "transport"] },
  "tags": { "contains": "invoice" },
  "text": { "contains": "发票" }
}
```

### multi_select / relation contains

当前数组字段按 JSON 完全相等比较,不符合 Notion-like 使用预期。

建议:

- multi_select 支持 contains/contains-all/contains-any。
- relation 支持 contains record id。

### 稳定分页

IM 场景不能只依赖 `--limit 50`。

建议:

- 支持 cursor。
- cursor 至少包含 sort field + record id tie-break。

### 日期规范化

当前 date 是 string。

建议:

- 写入时规范化为 ISO。
- query DSL 对 date range 做明确比较。

## P2: 记账体验

### 内置模板

未实现:

```bash
mh template use bookkeeping --name personal-ledger
```

建议 transactions 表至少包含:

- date
- amount
- currency
- account
- category
- counterparty
- note
- source
- source_id
- raw_text
- tags
- confidence

### 聚合查询

记账必须支持:

```bash
mh record query transactions --where '{...}' --sum amount --group-by category
```

或领域命令:

```bash
mh ledger summary --month 2026-05
```

### 导入和去重

未实现:

- CSV 导入。
- JSONL 导入。
- source_id 去重。
- upsert。

## P3: IM 历史消息体验

### 内置模板

未实现:

```bash
mh template use chat-log --name im-history
```

建议至少包含:

- conversations 表。
- messages 表。
- messages.conversation 关联 conversations。
- message_id/source 去重字段。

### 批量导入

未实现:

```bash
mh record bulk-create messages --jsonl @messages.jsonl
```

### 搜索后回上下文

IM 搜索结果需要支持:

```bash
mh chat around <messageId> --before 20 --after 20
```

通用表层可以先支持:

- 按 conversation + sent_at 查询前后消息。
- 搜索结果返回 message id、conversation、sender、sent_at、snippet。

## P4: AI Agent 操作体验

### Schema introspection

当前 Agent 要通过多个命令拼 schema。

建议:

```bash
mh db describe <dbId>
```

返回:

- database 信息。
- properties。
- 类型配置。
- 示例 create payload。
- 可用 query operators。

### 稳定 JSON envelope

建议所有机器输出统一成:

```json
{
  "ok": true,
  "data": {},
  "meta": {}
}
```

错误:

```json
{
  "ok": false,
  "error": {
    "code": "UNKNOWN_PROPERTY",
    "message": "unknown property: foo"
  }
}
```

### 批量操作

Agent 导入 IM 和账单时需要批量写:

- bulk-create。
- bulk-update。
- upsert by unique key。

## P5: 人类表格体验

建议:

- `record list --columns date,amount,category,note`。
- CJK 宽度正确的表格输出。
- 复杂字段可折叠显示。
- CSV/JSONL export。
- `prop rename`、`prop reorder` 等直观命令。

