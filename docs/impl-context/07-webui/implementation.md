# 浏览器 WebUI v2（Notion-like 改版）实现文档

配套设计见 [design.md](./design.md)（v1 见 §1–6，本次改版的设计取舍见 §7）。本文是代码级实现说明。

## 1. 背景

v1（design §1–6）把整个前端塞在单个 `src/webui/app.tsx`(~500 行)：文档编辑是「markdown textarea + 预览」非所见即所得；表格只能行内改值，无法改/删/排序列、无法配 select 选项；侧边栏是扁平列表（无树/拖拽/折叠）；无移动端适配；交互用 `alert/prompt/confirm`。

本次改版把它重写为**模块化 Preact 应用**，补齐完整 CRUD 与专业交互，并把简陋点逐项消除。**底层 core / oplog / sync 不变**；文档编辑仍复用 `PATCH /api/document`(body) → `reconcileBody()` 的按块 reconcile，无需新增 block 级 API。

## 2. 后端改动

| 文件 | 改动 |
|------|------|
| `src/core/databases.ts` | 新增 `updateDatabase(db, id, {name?, icon?})`（仿 `createDatabase`，经 `emit`） |
| `src/core/properties.ts` | `updateProperty` 增加可选 `type`；类型变更时校验新 config，并清空该属性所有记录单元格（`SELECT id FROM records WHERE database_id=? AND data ->> ? IS NOT NULL` 逐行 `emit(records, recId, propId, null)`）——旧值在新类型下可能非法 |
| `src/core/sync/webui-routes.ts` | 暴露 `PATCH/DELETE /api/database`、`PATCH/DELETE /api/property`（沿用 `handle()`/`need()` 与 Zod schema；`deleteDatabase`/`removeProperty` core 已有） |
| `src/core/databases.test.ts` / `properties.test.ts` | 新增：`updateDatabase` 改名/图标；`updateProperty` 改名/config/排序、改 type 清空单元格、select 无 options 被拒、`removeProperty` |

路由清单新增：`PATCH/DELETE /api/database?id=`、`PATCH/DELETE /api/property?id=`。其余沿用 v1。`routes.ts`/`server.ts` 无需改动（经 `webuiRoutes` 汇入，精确路径匹配）。

## 3. 前端模块结构（`src/webui/`）

`app.tsx` 仍是唯一构建入口（`scripts/build.ts`、`webui.ts` 的 dev 构建均从它出发，Bun 跟随 import 自动打包）。拆分为：

| 文件 | 职责 |
|------|------|
| `api.ts` | 类型化 `/api/*` 客户端（databases/properties/records/documents/search 全量 CRUD），`Db/Prop/Rec/Doc` 等类型，`TYPE_META` |
| `icons.tsx` | Lucide 风格 `<Icon name>` SVG 图标集 + `TYPE_ICON`（取代 v1 的 emoji/unicode 字形） |
| `ui.tsx` | 命令式 UI 原语：`toast`、`openMenu/MenuItem/MenuSep/MenuLabel`、`Modal/openModal`、`confirmDialog`、`promptDialog`，以及单一挂载点 `<UiHost/>`。**彻底取代 `alert/prompt/confirm`** |
| `blocks.ts` | 纯函数块模型：`blocksFromBody/bodyFromBlocks/textToBlock/blockToText`，复用 core `parseBlocks` 对齐块边界。配 `blocks.test.ts` |
| `markdown.tsx` | 受限行内 markdown ⇄ contenteditable HTML（`**粗**`/`*斜*`/`` `码` ``/`[文](url)`）。配 `markdown.test.ts` |
| `sidebar.tsx` | 文档树（折叠/拖拽改嵌套/宽度可拖拽）、条目菜单、新建数据库 Modal（模板）、删库/删文档 |
| `table.tsx` | `DatabaseView`：视图 tab、工具栏、网格、各类型单元格编辑、列头菜单、加列、行菜单、多选删除条、记录 peek 侧栏 |
| `editor.tsx` | `DocView`：块渲染、`/` 斜杠菜单、块菜单、拖拽重排、选中浮动格式条、防抖保存 |
| `app.tsx` | 壳：顶栏/面包屑、视图路由（doc/db/search/empty）、nav 数据与 `reloadNav`、移动抽屉、错误条、`<UiHost/>` |

设计系统 CSS 内联在 `src/core/sync/webui.ts` 的 HTML 外壳（tokens + 深色模式 + 组件样式 + ≤768px 移动断点；引 Google Fonts: Hanken Grotesk / JetBrains Mono，系统字体兜底）。

## 4. 关键实现点

### 4.1 命令式 UI（`ui.tsx`）

用极小的外部 store（`makeStore<T>` = 闭包值 + 订阅 + `use()` hook）驱动三个全局宿主：`MenuHost`（定位浮层 + 外点关闭）、`ModalHost`（scrim + Esc 关闭）、toast 列表。`openMenu(anchor, render)` 的 `render(close)` 返回任意 VNode，故列菜单/选项编辑器可在菜单内用自己的 hooks 与受控输入。`confirmDialog/promptDialog` 返回 `Promise`，调用处 `await` 即可。

### 4.2 块级编辑器（`editor.tsx` + `blocks.ts`）

- **块=core block**：`blocksFromBody()` 用 core `parseBlocks`（空行分隔、围栏代码整块）切块，再把多行紧凑列表**逐项拆成独立块**（Notion 式一行一块）；保存 `bodyFromBlocks()` 各块以 `\n\n` 连接 → `PATCH /api/document` 的 `reconcileBody` 按块保留 CRDT 身份。空段不持久化。
- **uncontrolled contentEditable**：editable 的 `innerHTML` 只在「结构变化」时由 `useEffect([renderKey, type])` 写入，**不随每次 re-render 重设**——否则输入 `/` 触发斜杠菜单 re-render 时会重置光标。输入只读回 `htmlToInline()` 存进 `blocksRef`（不 setState），防抖 700ms 保存。
- **斜杠菜单**：块文本以 `/` 开头时按查询过滤 `BLOCK_MENU`，↑↓/Enter 选择，选中即 `convert()` 转换块类型。
- **行内格式条**：选区非空时浮现，`document.execCommand` 执行 bold/italic/underline/strike，code 包 `<code>`，link 走 `createLink`，完成后回写块内容。
- **键盘**：Enter 新建（列表块回车续列表、空列表项回车降级为段落）；空块 Backspace 降级/合并。

### 4.3 markdown 行内（`markdown.tsx`）

`inlineToHtml` 先用私有区哨兵 `U+E000/E001` 把 `` `code` `` 占位保护，再转义 + 解析链接/粗/斜，最后还原 code（避免 code 内 `*`、`<` 被二次解析、避免误伤正文数字）。`htmlToInline` 递归遍历 contenteditable DOM 还原为 markdown。

### 4.4 表格（`table.tsx`）

- 单元格按类型行内编辑：text/number/url/date 用 `<input>`；checkbox 点击即切；select/multi_select 点击弹 `SelectMenu`（彩色 chip、多选不关菜单 + 清空）；relation 暂以逗号分隔文本 → core `resolveRelation` 按名/前缀解析。提交 `PATCH /api/record`。
- 列头菜单 `ColMenu`（菜单内受控）：改名、改类型（含 select/multi 自动补默认选项）、选项增删、在右侧插入列、删除列（confirm）。改类型/选项即调 `PATCH /api/property` 并 `reload`。
- 加列类型选择器、行 ⋯ 菜单（打开/复制/删除）、底部多选操作条（复制/删除选中）、记录 peek 侧栏（属性逐项编辑 + 正文占位）。chip 颜色由字符串哈希到固定色相、`color-mix` 适配明暗。

### 4.5 侧边栏（`sidebar.tsx`）

文档树按 `parent_id` 递归渲染、可折叠；HTML5 拖拽：drop-into 设 `parent_id=目标`，drop-before/after 设为目标的同级（均经 `updateDocument` 持久化；防环检测）。宽度拖拽（210–460px，临时态）。条目菜单：新建子页、重命名、移到顶层、删除（递归删子树）。新建数据库 Modal 含名称/图标/模板（空白/任务/联系人），模板按序 `createProperty`。

## 5. v1 范围外（未改 schema，明确标注）

- 数据库描述字段、文档独立 emoji 图标（需加列）。
- 保存视图 / 持久化筛选排序（当前排序为客户端临时态；看板/日历为占位 tab）。
- 文档同级顺序、表格行手动拖拽顺序的**持久化**（跨层级移动 `parent_id` 已持久化）。
- 关系列的目标库选择器（v1 走文本解析）；行内格式条依赖 `execCommand`。

## 6. 测试与验证

- `bun test`：95 通过、零回归。新增 `databases.test.ts`/`properties.test.ts`（core）、`blocks.test.ts`/`markdown.test.ts`（前端纯函数：块 round-trip 幂等、行内渲染哨兵正确）。
- `bunx tsc --noEmit -p tsconfig.build.json`（core）与 `-p src/webui/tsconfig.json`（DOM+preact）均通过。
- `bun run build`：`dist/webui.js` 打包成功（~67KB，多模块）。
- 端到端手验（`mh --server --debug` 后开 `/`）：建库（模板）/改名/删库；建文档/子页/拖拽改嵌套/删（含子页）；表格各类型编辑、改列名与类型、选项增删、加/删列、多选删除、记录 peek；文档 `/` 斜杠菜单、块拖拽、加粗/斜体/代码/链接、列表回车退格；≤768px 移动抽屉；系统深色模式。

## 7. 涉及文件

- 后端改：`src/core/databases.ts`、`src/core/properties.ts`、`src/core/sync/webui-routes.ts`；新增 `src/core/{databases,properties}.test.ts`。
- 前端：重写 `src/webui/app.tsx`、`src/core/sync/webui.ts`(CSS)；新增 `src/webui/{api.ts,icons.tsx,ui.tsx,blocks.ts,blocks.test.ts,markdown.tsx,markdown.test.ts,sidebar.tsx,table.tsx,editor.tsx}`。
- 视觉规范留档：`prototype/webui.html`（评审用静态原型）。
