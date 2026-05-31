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
mh doc read <doc-ref>
mh doc edit <doc-ref> --old "旧文本" --new "新文本"
mh doc append <doc-ref> --body "追加段落"
```

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
- 富附件引用和 blob 同步。

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
```

当前体验结论:

- 可用于备份、迁移和简单多节点同步。
- 命令形态偏工程化。
- 对普通用户还缺少状态解释、冲突说明和同步历史。
- 文件导出/导入便于把单篇文档或单张表交给外部编辑器/表格工具,再导回;但导入只更新已存在实体、一次一个,尚不支持批量入库。

## WebUI 当前流程

### 1. 启动并打开

```bash
mh --server --port 7777
# 浏览器打开 http://localhost:7777/
```

> v2 改版为 Notion-like 模块化 Preact 应用，下述流程为现状（见 [07-webui/implementation.md](../impl-context/07-webui/implementation.md)）。

### 2. 侧栏：导航与组织

- 左侧栏分「数据库」「文档」两组；文档为**树**，可折叠、拖拽改嵌套（drop-into 设父、before/after 设同级，经 `PATCH /api/document` 的 `parent_id` 持久化）。
- 悬停条目出现「+ 子页」与 ⋯ 菜单（重命名/复制/删除/移到顶层）。「数据库」组的「+」弹**新建数据库 Modal**（名称 + 图标 + 模板：空白/任务/联系人）。侧栏宽度可拖拽；窄屏（≤768px）变抽屉。

### 3. 表格（Notion-like）

- 点选数据库 → 按属性渲染网格。单元格按类型行内编辑：checkbox 即时切、select/multi_select 弹彩色 chip 菜单、relation 逗号分隔、其余文本/数字/日期框；提交 `PATCH /api/record`。
- **列头菜单**：改名、**改类型**（`PATCH /api/property`，改类型会清空该列单元格）、select 选项增删、排序、在右侧插入列、删除列。末列「+」按类型新建属性。
- 行 ⋯ 菜单（打开/复制/删除）、勾选多行后底部操作条（复制/删除）、首列「打开」进**记录侧栏 peek**（属性逐项编辑）。

### 4. 文档（块级所见即所得）

- 点选文档 → 标题 + 块编辑器。悬停块左侧出现「+」与拖拽手柄；输入 `/` 唤出**块类型菜单**（文本/标题/列表/待办/引用/代码/分隔线），选中文字弹**行内格式条**（粗/斜/下划线/删除线/代码/链接）。
- Markdown 快捷输入：`# ` / `## ` / `### ` 转标题，`- ` / `* ` / `+ ` 转无序列表，`1. ` 转有序列表，`- [ ] ` / `- [x] ` 转待办，`> ` 转引用，```` ``` ```` 或 ```` ```python ```` + Enter 转代码块并保留语言名。
- 列表行为：Enter 续同级列表，空列表项 Enter 退出列表；Tab/Shift+Tab 缩进/反缩进形成嵌套。列表项内可包含段落、引用、代码块和子列表。
- 代码块：实时 highlight.js 语法高亮 + 行号；右下角 hover 出语言下拉与复制；末行空行按 Enter 或末行按 ↓ 退出代码块并在下方建块（不再「卡住」）；空代码块 Backspace 顶层转文本段落，列表项内则删除代码块并保留当前列表编号/marker。
- 编辑防抖保存：前端逻辑块树序列化为规范 Markdown body → `PATCH /api/document`，服务端 `reconcileBody` 按 core block 规则保留 CRDT 身份。保存会规范化缩进和同级有序列表编号，不保证保留原始源码排版。

### 5. 搜索

- 侧栏搜索框回车 → `GET /api/search`,结果点击跳转到对应文档或记录所在库。

当前体验结论:

- 提供了 CLI 之外的 Notion-like 可视化编辑入口（全面 CRUD、真实弹窗/菜单、明暗主题、移动端适配），编辑经 CRDT oplog,可随 `mh sync` 复制。
- 暂未做：数据库描述/文档独立图标、保存视图与持久化筛选排序（当前排序为客户端临时态）、同级/行手动顺序持久化；关系列暂以文本解析；文档表格、数学、脚注、callout、TOC 未实现。无鉴权外的复杂权限,假定可信网络/本机。
- WebUI 与 Preact 单独打包(`dist/webui.js`)、懒加载,不影响 CLI 启动性能。
