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
| `sidebar.tsx` | 文档树（折叠/拖拽改嵌套与同级排序/宽度可拖拽）、条目菜单、新建数据库 Modal（模板）、删库/删文档 |
| `table.tsx` | `DatabaseView`：视图 tab、工具栏、网格、各类型单元格编辑、列头菜单、加列、行菜单、多选删除条、记录 peek 侧栏 |
| `editor.tsx` | `DocView`：块渲染、`/` 斜杠菜单、块菜单、拖拽重排、选中浮动格式条、防抖保存 |
| `app.tsx` | 壳：顶栏/面包屑、视图路由（doc/db/search/empty）、nav 数据与 `reloadNav`、侧栏折叠/移动抽屉、错误条、`<UiHost/>` |

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
- 列头菜单 `ColMenu`（菜单内受控）：改名、改类型（含 select/multi 自动补默认选项）、选项管理（行内输入新增、点 chip/铅笔重命名、grip 拖拽排序、删除带 confirm）、在右侧插入列、删除列（confirm）。改类型/排序/新增走 `PATCH /api/property`（config 为键级合并 patch）；重命名/删除选项走 `POST /api/property/option/rename|remove` —— core 级联重写所有用旧值的单元格，避免孤儿值。
- 加列类型选择器、行 ⋯ 菜单（打开/复制/删除）、底部多选操作条（复制/删除选中）、记录 peek 侧栏（属性逐项编辑 + 正文占位）。chip 颜色由字符串哈希到固定色相、`color-mix` 适配明暗。

### 4.5 侧边栏（`sidebar.tsx`）

文档树按 `parent_id` 递归渲染、可折叠；HTML5 拖拽：drop-into 嵌为目标子页、drop-before/after 在同级间重排，三态统一经 `moveDocument`（`PATCH /api/document/move`）持久化——一次原子更新 `parent_id` 与 `order_key`，core 端 `placeInSiblings` 收口防环与排序。宽度拖拽（210–460px，临时态）。条目菜单：新建子页、重命名、移到顶层、删除（递归删子树）。新建数据库 Modal 含名称/图标/模板（空白/任务/联系人），模板按序 `createProperty`。

**整栏折叠**：折叠状态 `sbCollapsed` 提升到 `app.tsx`，经 `collapsed` prop 下传；折叠时给 `.sidebar` 加 `collapsed` class 并设 `marginLeft:-width`（复用既有 `transition:margin-left` 平滑滑出）。头部收起按钮 `onCollapse` 置位，顶栏 `panelLeft` 按钮在折叠时显示（`.hamburger.show-collapsed`）以重新展开——它与移动抽屉复用同一按钮：桌面折叠态点击展开侧栏，否则打开移动抽屉。（修复：旧 `onCollapse` 误接移动抽屉的 `setDrawerOpen(false)`，桌面端 drawer 本就关闭，故按钮无效。）

## 5. v1 范围外（未改 schema，明确标注）

- 数据库描述字段、文档独立 emoji 图标（需加列）。
- 保存视图 / 持久化筛选排序（当前排序为客户端临时态；看板/日历为占位 tab）。
- ~~文档同级顺序~~、表格行手动拖拽顺序的**持久化**（跨层级移动 `parent_id` 已持久化）。文档同级顺序已于后续补上(documents `order_key` + `moveDocument`)；表格行手动排序仍为缺口。
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

## 8. v2.1 文档编辑器嵌套 Markdown（2026-05-31）

本节记录 2026-05-31 在 v2 WebUI 之上的增量改动。目标是让文档编辑器更接近 Typora Live Preview 的核心 Markdown 体验，同时保持后端 API、schema、core CRDT 与 sync 协议不变。

### 8.1 范围

- 列表块增加前端 `children`，代码块增加前端 `lang`。
- `blocksFromBody()` 改为解析 Markdown 行序列，重建嵌套列表结构，并支持列表项内段落、引用、代码块和子列表。
- `bodyFromBlocks()` 保存为规范 GFM 缩进 Markdown；同级有序列表编号会重新计算。
- Markdown 快捷转换：
  - 空格触发：`# ` / `## ` / `### `、`- ` / `* ` / `+ `、`1. `、`- [ ] ` / `- [x] `、`> `。
  - Enter 触发：```` ``` ```` 或 ```` ```python ```` 转代码块，隐藏 fence，保留语言名。
- 键盘行为：
  - 列表项 Enter 创建同级下一项。
  - 空列表项 Enter 退出列表。
  - Tab/Shift+Tab 在列表项中缩进/反缩进。
  - 代码块内 Tab 插入两个空格。
- 代码块新增轻量语言输入框；不做语法高亮。

### 8.2 设计边界

- 不新增 block 级 HTTP API；仍通过 `PATCH /api/document` 保存完整 Markdown body。
- 前端逻辑块树不是存储模型。`children/lang` 只存在于 `src/webui/blocks.ts` 的编辑模型里；服务端仍按 core `parseBlocks` 的段落/fenced code 规则 reconcile `doc_blocks`。
- 保存后的 Markdown 以稳定、规范为优先，可能 canonicalize 非规范源码排版。
- 本次不实现表格、数学、脚注、callout、TOC、代码高亮（代码高亮已在 §10 / v2.2 补齐）。

### 8.3 涉及文件

- `src/webui/blocks.ts`：块类型扩展、嵌套 Markdown parse/serialize、快捷转换纯函数。
- `src/webui/editor.tsx`：树形块查找/插入/删除/拖拽、Tab/outdent、代码语言输入、代码块纯文本编辑。
- `src/webui/blocks.test.ts`：新增嵌套列表、代码语言名、同级编号重算、缩进/反缩进序列化、快捷转换测试。
- `src/core/sync/webui.ts`：嵌套 wrapper 与代码语言输入框 CSS。

### 8.4 验证

- `bun test`：110 通过。
- `bun run build`：通过。
- `git diff --check`：通过。
- `bunx tsc --noEmit`：仍有既存无关类型错误（`src/cli/index.ts` 的 citty 泛型、`src/core/sync/sites-serve.ts` 的 `Uint8Array` BodyInit、`src/webui/table.tsx` 的 nullable `dataTransfer`）；本次 editor 相关类型问题已修正。
- 服务烟测：用临时 `METAHUB_HOME` 启动 `bun src/cli/index.ts --server --debug --port 7781`，验证 `/`、`/webui.js`、`/api/documents` 可访问，并通过 API 创建含嵌套列表 + fenced code 的文档成功。
- 当前会话的 in-app browser 后端不可用，未做视觉点击手验。

## 9. v2.1.1 列表项代码 Fence 归属修正（2026-05-31）

本节记录 v2.1 嵌套 Markdown 实现后的行为修正，便于回溯。问题：在列表项内输入 ```` ``` ```` 或 ```` ```python ```` 后按 Enter，初版会把当前列表块整体转换成代码块；Typora 预期是保留列表项，并把代码块作为该列表项的子块。

### 9.1 改动

- `src/webui/editor.tsx`：Enter 的代码 fence 快捷转换增加列表项分支。当前块为列表项且快捷目标为 `code` 时，清空当前列表项文本，创建子代码块并聚焦；普通段落里的代码 fence 仍转换当前块。
- `src/webui/editor.tsx` / `src/core/sync/webui.ts`：空列表项承载子代码块时收起父列表项的空 editable，只保留列表 marker，让代码块直接显示在列表项第一行。
- `src/webui/blocks.ts`：空列表项只有非列表子块时，序列化不再额外插入空行，保存为缩进在列表项下的 fenced code。
- `src/webui/blocks.test.ts`：新增 “list items can own fenced code children” round-trip 测试，覆盖列表子代码块的保存与读取。

### 9.2 验证

- `bun test src/webui/blocks.test.ts`：10 通过。
- `bun test`：111 通过。
- `bun run build`：通过。
- `git diff --check`：通过。
- `bunx tsc --noEmit`：仍有既存无关类型错误，位置同 v2.1 记录：`src/cli/index.ts`、`src/core/sync/sites-serve.ts`、`src/webui/table.tsx`。

## 10. v2.2 代码块语法高亮与块样式打磨（2026-06-01）

本节记录在 v2.1 / v2.1.1 之上的增量，配套设计见 [design.md §9](./design.md)。补齐代码块语法高亮，重写代码块 / 引用块 / 嵌套子块的视觉与交互。后端 API、schema、core CRDT、sync 协议不变；数据模型（`Block`/`BlockType`）与 Markdown parse/serialize 不变，纯表现层 + 交互层改动。

### 10.1 依赖与块模型

- `package.json`：新增运行时依赖 `highlight.js`（Bun 打包进 lazy 的 webui bundle，零 CLI 启动开销）。
- `src/webui/blocks.ts`：导出 `COMMON_LANGS`（highlight.js 合法语言 id + 中文标签）供下拉；解析/序列化与 `cleanLang` 不变，语言名往返保真（旧文档遗留的未知语言保留为下拉额外选项）。

### 10.2 代码块组件（`editor.tsx` `CodeBlock`）

- 结构：`.codeblock` > `.code-body`（`.code-gutter` 行号 + `.code-scroll` 内 `.code-hl` 高亮镜像 `<pre><code>` + `.code-input` textarea）+ 右下角 hover `.code-tools`（语言 `<select>` + 复制按钮）。
- 高亮：模块级 `highlightCode(code, lang)` —— `lang && hljs.getLanguage(lang)` 用 `hljs.highlight({ignoreIllegals})`，否则 `highlightAuto`，异常回退 `escapeHtml`；内容以 `\n` 结尾时补一空行使高亮层高度跟齐 textarea。
- 非受控：仅 `renderKey`/`block.lang` 变化时用 ref 写 `textarea.value`；输入时命令式 `paint(value)` 刷新高亮 innerHTML + 行号 + auto-grow（`height="auto"` → `height=scrollHeight`）；`onScroll` 同步 `.code-hl` 横向滚动。`wrap="off"` 防软换行对齐；`rows={1}` 见 §10.4。
- 复制：`navigator.clipboard.writeText`，1.4s 内切 `check` 图标 + 「已复制」反馈。

### 10.3 代码块键盘（`onCodeKeyDown`，独立于全局 `onKeyDown`）

- `Tab`：`document.execCommand("insertText","  ")`（保留原生 undo + 触发 input 重绘）。
- `Enter`：当前行为空且为最后一行 → 去尾空行后 `insertAfter(b.id,"p")` 退出；否则放行原生换行。
- `ArrowDown`：光标在最后一行 → `nextBlock()` 聚焦下块，无下块则建段落。
- `ArrowUp`：光标在第一行 → `previousBlock()` 聚焦上块末尾。
- `Backspace`：顶层空代码块 → `convert(b.id,"p")`；列表项内的空子代码块 → 移除该子块并聚焦回空列表项，保留编号/marker。
- 配套：新增 `nextBlock`/`flatten`；`focusBlock` 选择器扩展 `.code-input`，textarea 用 `setSelectionRange` 定位（atEnd → `value.length`）。

### 10.4 关键修复：短代码块底部空白

textarea 的 `scrollHeight` 以 `rows` 属性为下限，`rows` 默认 **2**，故即使先 `height="auto"` 再取 `scrollHeight`，单行/空代码块也永远 ≥2 行高 → 底部多一行空白。修复：`rows={1}`。用隔离复现页 + 浏览器实测确认（1 行块 55px→35px，空块同；2/3 行块不受影响）。

### 10.5 CSS（`src/core/sync/webui.ts` 内联）

- 新增 `.codeblock`（圆角卡片、紧凑度量变量 `--code-fs:12.5px / --code-lh:1.55 / --code-pad:8px`）、`.code-body/.code-gutter/.code-scroll/.code-hl/.code-input`、右下角 hover `.code-tools`（半透明 `backdrop-filter` chip，`opacity:0` → `:hover`/`:focus-within` 显示），及自写 hljs token 主题（明/暗双套，`--hl-*`、`--code-bg` 变量）。
- 引用块 `.b-quote`：中性左边条（`--line-strong`）+ 斜体柔色，无底纹。
- 嵌套：`.block-wrap.nested` 缩进 24px；`:has(> .b-bullet/.b-numbered/.b-todo)::before` 仅给子列表画细引导线；`.list-code-host + .block-wrap.nested .gutter { display:none }` 消除列表内嵌代码块与序号重叠的冗余 gutter。

### 10.6 验证

- `bunx tsc --noEmit`：本次相关文件零错误；既存无关错误位置同前（`src/cli/index.ts`、`src/core/sync/sites-serve.ts`、`src/webui/table.tsx`）。
- `bun test`：111 通过（数据模型未变，`blocks.test.ts` 往返测试全绿）。
- `bun build src/webui/app.tsx`：通过（~237KB min，highlight.js 已打入 lazy bundle）。
- 视觉点验（隔离复现 + 用户实机刷新）：高亮 / 行号 / 语言下拉 / 复制反馈、代码块键盘退出各场景、引用与嵌套新样式、明暗主题、短代码块无底部空白。

### 10.7 涉及文件

- `package.json`、`src/webui/blocks.ts`、`src/webui/editor.tsx`、`src/core/sync/webui.ts`。

### 10.8 v2.2.1 列表内空代码块删除修正（2026-06-01）

问题：列表第一行或任意列表项内用 code fence 创建嵌套代码块后，清空代码块并按 Backspace，旧逻辑会把子 `code` 转成空 `p`，导致 UI 显示「空列表项 + 空段落子块」两行 placeholder。

修正：`onCodeKeyDown` 在空内容 Backspace 时先检查当前代码块是否位于空列表项下；若是，只从父列表项 `children` 中移除该代码块，必要时清掉 `parent.children`，然后聚焦回父列表项。顶层空代码块仍按原行为转成普通段落。

验证：

- `bun test src/webui/blocks.test.ts src/webui/markdown.test.ts`：14 通过。
- `bun test`：111 通过。
- `bun build src/webui/app.tsx --outdir /private/tmp/metahub-webui-check`：通过。
- `bun run tsc --noEmit`：仍有既存无关类型错误，位置为 `src/cli/index.ts`、`src/core/sync/sites-serve.ts`、`src/webui/table.tsx`；本次改动文件未新增类型错误。

## 11. v2.3 多块选中、撤销/重做、有序列表起始号（2026-06-01）

配套设计见 [design.md §10](./design.md)。在 v2.2 之上为文档编辑器三项增量；后端/CRDT/sync 不变。分两批落地：多块选中（提交 `e73d818`）+ 撤销/重做与有序列表（本次）。

### 11.1 多块选中（`editor.tsx` + `editor-ops.ts`）

- **根因清理**：每块正文是独立 contentEditable 宿主，原生 `Selection` 不能跨宿主 → 旧 `getBlockSelection` 恒返回单块、批量分支（`selection.ids.length <= 1` 守卫）永不触发。删除整套失效代码（`getBlockSelection`/`deleteBlockSelection`/`serializeBlockSelection`/`applyFormatToBlockSelection`/`rangeForEditableSegment`/`wrapRangeWithInlineCommand`/`editableForBlock`/`elementContainsNode`），并简化 `applyFormatCommand` 只保留单块行内格式。
- **状态**：`sel:{anchorId,focusId}|null`；派生 `selectedIds = blockRangeIds(blocks, anchor, focus)`（flatten 连续区间）。
- **指针框选**：`.doc` 的 `onMouseDown` + window 级 `mousemove`/`mouseup`（`useEffect` 注册）。文本区按下记 anchor 与 `mode:"text"`，拖动越过另一块 → 转 `"block"`（`getSelection().removeAllRanges()` + blur + `.doc.selecting`）；gutter/marker 空白按下直接整块；Shift+点击扩展。`document.elementFromPoint(x,y).closest('.block[data-bid]')` 求落点块。表单控件（`input/button/select/a`）/`.gutter`/`.pop` 上的按下直接放行。
- **批量纯函数**（`editor-ops.ts`，配单测）：`deleteBlocks`（删 topmost、回退聚焦前/后邻块）、`duplicateBlocks`（topmost 成组复制到选区后）、`moveBlocks`（成组移动，拒入自身子树）、`serializeBlocks`（topmost→`blockToText`）；缩进复用 `indentBlocks`/`outdentBlocks`。
- **键盘**（document 捕获 `onBlockKeyDown`，经 `blockKeyRef` 取最新闭包）：Backspace/Delete、Tab/Shift+Tab、Cmd/Ctrl+C·X（块模式无原生 copy 事件，故走快捷键 + `navigator.clipboard.writeText`）、Cmd/Ctrl+D、Cmd/Ctrl+A、Shift+↑/↓ 扩展、其余打字/方向键退出。多块拖拽：`renderBlocks` 的 `onReorder` 内若 `srcId ∈ selectedIds` 走 `moveBlocks`，否则原 `moveBlock`。
- **CSS**（`webui.ts` 内联）：`.block.selected{background:var(--accent-soft)}`、`.doc.selecting *{user-select:none}`。按用户要求**无浮动工具栏**，仅底色 + 键盘。

### 11.2 撤销/重做（`editor.tsx`）

- `history` ref `{past,future,present,lastKey,lastTime}`；`snapshot()=structuredClone(blocksRef)+title+focusedBlockId()`。
- `recordHistory(key)`：`present` 为空则初始化；`key` 与 `lastKey` 相同且间隔 <600ms → 仅刷新 `present`（合并打字）；否则把 `present` 压 `past`（上限 200）、清 `future`。
- 接线：`bump()` 改为 `recordHistory(null) + setVersion`（每个结构 op 记一步，因几乎所有结构变更都经 bump）；`onContentInput`、代码 `onCodeInput`、标题 `onInput` 分别调 `recordHistory("text:"+id)` / `"title"`。
- `restoreSnap` 用 `setVersion` 直接重渲染（绕过 bump，不记录）+ 清 `sel` + rAF 恢复聚焦；`undo`/`redo` 在 `onBlockKeyDown` 顶部拦 Cmd/Ctrl+Z、Shift+Z / Ctrl+Y 并 `preventDefault` 屏蔽原生撤销；docId 切换时重置 history。

### 11.3 有序列表起始号（`blocks.ts` + `editor.tsx`）

- `Block.start?:number`；导出 `computeListNumbers(siblings)`（run 首项 `start??1` 起算、逐项 +1、遇非 numbered 兄弟断开）→ `renderBlocks`（显示）与 `renderContainer`（序列化）共用，保证「序列重建」单一来源。
- 解析：`matchListLine` 与 `RE.numbered`、`textToBlock` 捕获实际数字；`blocksFromBody` 末尾 `normalizeNumbering`（每个 run 只首项留 `start`，为 1 则删，其余丢弃 → CommonMark）。
- 创建：`shortcutFromInput` 的 `N. ` 解析出 `start`；`makeBlock`/`convert` 落 `start`（仅 numbered 且 >1，否则删）。

### 11.4 验证

- `bun test src/webui/`：32 通过（`blocks`/`markdown`/`editor-ops`）；新增块批量 op 与有序列表起始/往返/重建用例，更新旧的「从 1 重排」断言为「按首项起始」。
- `bunx tsc --noEmit -p src/webui/tsconfig.json`：本次文件零错误（既存无关：`src/webui/table.tsx` nullable `dataTransfer`）。
- 视觉手验（用户实机刷新）：跨块/边栏拖拽框选 + 底色、键盘批量删/缩进/复制/移动；Ctrl+Z 撤销结构 op 与整段打字、Shift+Z 重做、切档历史不串；`5.` 起始、`1.1.1.→1,2,3`、删首项重排。

### 11.5 涉及文件

- 前端：`src/webui/editor.tsx`、`src/webui/editor-ops.ts`、`src/webui/blocks.ts`；CSS `src/core/sync/webui.ts`。
- 测试：`src/webui/editor-ops.test.ts`、`src/webui/blocks.test.ts`。

## 12. v2.4 跨块光标导航、Markdown 粘贴、双击全选（2026-06-01）

配套设计见 [design.md §11](./design.md)。在 v2.3 之上为文档编辑器补四项交互；后端/CRDT/sync 不变。分批落地：↑/↓ 跨块 + 删块光标修正（提交 `7796db8`）、富文本 Markdown 粘贴（提交 `a990214`）、双击 Ctrl+A 渐进全选（本次）。

### 12.1 ↑/↓ 跨块导航（`editor.tsx` `onKeyDown`）

- 现象：每块是独立 contentEditable，原生 ↑/↓ 只在本宿主内移动，到块首/块尾无法跨块（此前仅代码块 textarea 有跨块逻辑）。
- 实现：contentEditable 的 `onKeyDown` 增 ↑/↓ 分支，仅当光标位于块的**首个/末个可视行**才跨块（↑→上一块末尾 `focusBlock(prev,true)`、↓→下一块开头 `focusBlock(next)`），否则放行原生逐行移动；按住 Shift（扩选）或已有非空选区时不接管。
- 行边界判定 `caretLineEdge(el)`：取折叠光标 `getRangeAt(0).getBoundingClientRect()` 与 `el` 盒比较，容差半个 `line-height`（`first: cr.top-er.top < lh*0.5`、`last: er.bottom-cr.bottom < lh*0.5`）；空块（无 caret rect）视为既首行也末行 → 直接跨块。

### 12.2 删块后光标落到上一块**末尾**（坑点：全局 renderKey 重置 innerHTML）

- 现象：空块 Backspace 删除后，`focusBlock(prev.id, true)` 已请求落到块尾，但光标却跳到上一块**开头**。
- 根因：`renderKey` 取自全局 `version` 计数，任一结构 op `bump()` 都会让**所有**块 re-render；`BlockRow` 的 `useEffect([renderKey, type])` 因此对每个块（含目标上一块）重写 `innerHTML`，把刚用 rAF 设好的光标 range 冲掉，浏览器回退到位置 0。（代码块 ↑ 跨块无此问题，因纯导航不触发 bump/重渲染。）
- 修复：`useEffect` 仅在 `innerHTML` **确有变化**时才重写（`if (el.innerHTML !== html)`）。删别的块时目标块 HTML 未变 → 跳过重写 → 光标保留；顺带省掉每次结构变更对全部块的无谓 DOM 重写。

### 12.3 富文本 Markdown 粘贴（`editor.tsx` `onContentPaste`）

- 现象：原本无 `onPaste`，走浏览器默认，`**粗**` 粘进来是字面文本、多行 Markdown 塌成单块。
- 实现：拦 `paste` 取 `clipboardData.getData("text/plain")`（非文本/图片放行默认），经 `blocksFromBody()` 解析为块树，再围绕光标拼接：
  - `splitEditableAtCaret(el)`：用 Range 克隆光标（或选区）两侧内容 → `htmlToInline()` 得前后两段**行内 Markdown**（兼容「替换选中再粘贴」）。
  - **纯行内**（解析结果为单段落且落在非空行）：`content = before + 段落 + after` 留在原块，`focusBlockAtOffset()` 按可视文本偏移落光标到粘贴内容之后（`inlineTextLength()` = `inlineToHtml` 后的 `textContent.length`，绕开 Markdown 源串长 ≠ 渲染文本长）。
  - **块级**（多块 / 单个非段落）：`before` 留原块（保留原类型），解析块整组 splice 到其后，`after` 作为新段落收尾；空行则整块替换（带子块的列表项不替换以免丢子树）。光标落 `after` 块开头或末块末尾。
- `blocksFromBody` 产出的块已带 `genId()` 与子块，可直接 splice。代码块 textarea 不接管，保持字面粘贴（代码应原样插入）。

### 12.4 双击 Ctrl/Cmd+A 渐进全选（`editor.tsx`）

- 语义：编辑态首次 Ctrl+A 走原生选中本块文字；本块文字**已全选**时再按 → 升级为选中所有块（复用块选模式）。采用「读当前选区是否已全选」的**无状态**判定，而非「计按键次数 + 超时窗口」——与 Notion 式逐级扩选语义一致，且不会与点击/移动光标后的真实选区脱节（计数方案需在 click/keydown/blur/selectionchange 上逐一失效，易漏）。
- 接线：contentEditable `onKeyDown` 顶部加 Ctrl/Cmd+A 分支，`blockTextFullySelected(el)` 为真才 `preventDefault + selectAllBlocks()`，否则放行原生；`selectAllBlocks()` = `enterBlockSelecting()` + `setSel(首块..末块)`，并重构 `onBlockKeyDown` 块模式 Ctrl+A 共用之。
- **坑点：尾部隐形 `<br>`**。最初用 `selectNodeContents(el)` + `compareBoundaryPoints(END_TO_END)` 判全选，被浏览器在 contentEditable 末尾自动插入的隐形 `<br>`（bogus br）坑了——`selectNodeContents` 结束点落在 `<br>` 之后，而原生 Ctrl+A 只选到文字，比较恒判「未全选」，第二次永不升级。改用**选中文本长度**判定：`sel.toString().length >= el.textContent.length`（`<br>` 不计入 `textContent`），空块直接视为已全选。

### 12.5 坑点：改前端不生效（stale bundle）

- 浏览器加载的 `/webui.js` 经 `src/core/sync/webui.ts` 的 `getJs()` 提供，两层缓存会挡住源码改动：① 跑编译产物时**优先读预构建 `dist/webui.js`**（早于改动即是旧码）；② 进程内 `cachedJs` 整个进程生命周期只构建一次，且 `editor.tsx` **不在 `--hot` 的 import 图内**（刻意隔离出 CLI 启动图），改它不触发热重载。
- 结论：改完前端需 `bun run build` 重建 `dist/webui.js` + **重启服务进程** + 浏览器硬刷新（`/webui.js` 未设 cache 头）。debug「为何没生效」时先排除此项——本次 ↑↓/粘贴生效而 Ctrl+A 不生效，恰好反证 bundle 已新、Ctrl+A 是真 bug。

### 12.6 验证

- `bun test src/webui/`：32 通过（无回归；本批为交互逻辑，未加单测）。
- `bunx tsc --noEmit -p src/webui/tsconfig.json`：本次文件零错误（既存无关：`table.tsx` nullable `dataTransfer`）。
- 视觉手验（实机重建 + 重启 + 硬刷新）：段落内 ↑/↓ 逐行、块首/尾跨块；空块 Backspace 落到上一块末尾；粘贴行内 `**粗**`/链接即时渲染、粘贴多块 Markdown 拆成对应块；同块两次 Ctrl+A（先选文字、后全选块）。

### 12.7 涉及文件

- 前端：`src/webui/editor.tsx`——`onContentPaste`、`onKeyDown` 的 ↑↓ 与 Ctrl+A 分支、`selectAllBlocks`，helpers `caretLineEdge`/`splitEditableAtCaret`/`inlineTextLength`/`focusBlockAtOffset`/`blockTextFullySelected`，`BlockRow` 的 `onPaste` 接线与 `innerHTML` 守卫。
- 复用：`blocksFromBody`/`htmlToInline`/`inlineToHtml`（`blocks.ts`/`markdown.tsx`）、`flattenBlocks`/`findBlock`/`previousBlock`/`nextBlock`（`editor-ops.ts`）。
- 构建：`dist/webui.js`（经 `scripts/build.ts` 由 `app.tsx` 打包；改前端须重建）。

## 13. 表格单元格底色打磨（2026-06-02）

### 13.1 单选 popup 选项竖排（逐字换行）

单选/多选编辑 popup 里每个选项被包进 `<span class="lico plain">`，而 `.lico.plain` 是 **22×22px 的图标盒**（本为小图标/色块设计）。把整段文字 `<Chip>` 塞进去后,中文只有 ~22px 宽 → 逐字竖排,且 22px 高度还裁切。修复:`SelectMenu`（`table.tsx`）里直接渲染 `<Chip text={o} />`,去掉 `.lico.plain` 包裹（`.item` 本是 flex、`.chk` 带 `margin-left:auto`,布局天然正确）;并给 `.chip` 加 `white-space:nowrap` 作防御,保证 pill 在 popup/单元格/peek 任何位置都不逐字换行。

### 13.2 关键修复：同行有更高 cell 时,hover/选中底色缺一块

**现象**：某行里一个 cell 文字换成多行把 `<td>` 撑高后,相邻 cell 的 hover/选中灰底**只覆盖上半截,底部留一条未着色空白**（叠在 `tr:hover` 整行浅色上,缺口处只剩整行浅色,故看起来"缺一块"）。

**根因**：底色画在内层 `.cell` 上,而 `.cell` 只有内容高度（`min-height:37px`）+ `td.cell-td{vertical-align:top}` 顶部对齐;同行更高的兄弟 cell 把 `<td>` 撑高时 `.cell` 不跟着长 → 底部空出。

**失败尝试（均用隔离复现页 + Playwright 实测排除）**：
- `.cell{height:100%}`+`td{height:100%}`：**无效**。表格 `table.grid` 无确定高度,`tr`/`td` 高度 auto,百分比高度解析为 auto。实测 `.cell` 仍 53px、`td` 106.5px。
- 经典 `td{height:1px}` hack + `.cell{height:100%}`：在本表 `table-layout:fixed`+`border-collapse:collapse` 下**溢出**到 122px,不可靠。

**正解**：把 hover/active 底色从内层 `.cell` 移到外层 `td.cell-td`。`<td>` 由表格布局保证天然等于整行高度,无需任何百分比高度技巧。实测 `td` = 106.5px = 整行高度,填满。`.cell-td:hover` 只命中数据列（复选框列 `.selcell`、拖拽列 `.rowgrip` 是独立 td,范围与原 `.cell:hover` 一致）。

**通用经验**：
1. **表格里要让某区域等高整行,把样式/底色画在 `<td>` 上,不要画在 td 内层 div 上**。表格布局只保证 `<td>` 等高,内层元素默认只有内容高度。
2. **表格内的 `height:100%` 百分比高度极不可靠**：祖先无确定高度时解析为 auto;`td{height:1px}` hack 在 `fixed`/`collapse` 下行为还会因浏览器而异。能靠 `<td>` 天生等高解决就别用百分比技巧。
3. **CSS 布局疑难先建隔离复现页 + Playwright 量 `getBoundingClientRect()` 实测各方案,再改源码**,避免盲改反复 miss（本次三方案一次性量清）。

### 13.3 涉及文件 / 验证

- `src/webui/table.tsx`——`SelectMenu` 选项渲染（去 `.lico.plain` 包裹）。
- `src/core/sync/webui.ts`（内联 CSS）——`.chip` 加 `white-space:nowrap`；底色规则 `.cell:hover` → `td.cell-td:hover`（`transition` 同移到 td）。
- 验证：`bun run build` + 重启服务 + 硬刷新;把某 cell 撑成多行,hover/选中相邻 cell,确认底色铺满整行高度、底部无缺口;单选/多选 popup 选项为横向 pill、单行。

## 14. v2.5 回车拆分、空行保留、光标确定性、空行无提示（2026-06-07）

配套设计见 [design.md §12](./design.md)。文档编辑器四项修正;前三项纯 WebUI,空行保留连带 core 改造(`doc_blocks.blank_after`,见 [04-block-level-doc-crdt §2.7](../04-block-level-doc-crdt/design.md))。

### 14.1 回车在光标处拆分（`editor.tsx` `onKeyDown` Enter 分支）

普通/列表块的 Enter(非 code、非 shortcut、非空列表项退出)改为:`const { before, after } = splitEditableAtCaret(el)`(复用 §12.3 的 helper);`b.content = before`;`insertAfter(b.id, isListType(b.type) ? b.type : "p", { content: after })`。`insertAfter` 已 `bump()` + 聚焦新块开头;`bump()` 触发的 `useEffect`(HTML 有变才写)把当前块重写成 `before`、新块写 `after`。`after` 为空时即原「新建空行」。原生选区非空时 `splitEditableAtCaret` 天然丢弃选中段(Enter 替换选区)。

### 14.2 光标落点确定性（`editor.tsx` `focusBlock`）

`atEnd=false` 分支原先只 `el.focus()`、不设 caret,依赖浏览器默认 → 结构 op 重写 `innerHTML` 后落到位置 0,与粘贴/拆分落点竞态。改为始终显式建 Range:`selectNodeContents(el)` + `collapse(!atEnd)`(`!atEnd`→始端、`atEnd`→末端),textarea 分支不变(`setSelectionRange`)。与 §12.2 的「HTML 有变才写」守卫共同消除粘贴/删块/拆分后的光标漂移。

### 14.3 空段落的「/」提示仅在聚焦行显示（`editor.tsx` `placeholder` + `webui.ts` CSS）

`placeholder("p")` 保留 `"输入文本,'/' 唤出命令"`(写进 `data-ph`);新增内联 CSS `.b-p .editable:empty:not(:focus)::before { content:"" }` 覆盖基础 `.editable:empty::before`(特异性更高),使**未聚焦**的空段落不渲染提示,光标所在的空行仍提示。标题/引用/代码块等用基础规则始终显示类型提示。空文档入口仍由 `blocks.length===0` 的独立引导 div 兜底。

> 取舍:用户初版只要「空行不显示斜杠」,实现成「`placeholder("p")` 返回 `""`」会**连聚焦行也不提示**,不符直觉;改为焦点条件的 CSS 后,既让闲置空行干净、又保留当前行的「/」入口。

### 14.4 空行往返（`webui/blocks.ts`）

顶层空段落 ⇄ body 空行,与 core `blank_after` 对齐:

- `bodyFromBlocks` 重写为顶层逐块走查:非空块经 `renderBlock` 输出 + `shouldSeparate` 单空行分隔;每个空段落(`isBlankParagraph`)多压一行空行;文末空段落补「空行 + 约定换行符」。其它空块(空列表项/表格/代码)仍按 `shouldPersist` 丢弃。
- `parseContainer` 加 `top` 参数:**仅顶层**把超出单分隔的空行游程(`blankRun>1`)物化为空 `p`;嵌套(列表子树)不变,空行仍按结构分隔。`blocksFromBody` 以 `top=true` 调用,文末空行仍由既有 `trailingNewlines` 逻辑补空段落。
- 之所以连带改 core:WebUI 这套之前对**文末**也有等价代码且单测通过,但端到端仍丢——因为 body 经 core `serializeBlocks`(`filter(t.length>0).join("\n\n")`)被规整。core 改造后 body 原样往返,WebUI 映射才生效(见 design §12.3 坑点)。

### 14.4.1 列表项之间的空行(2026-06-07 修正)

首版只验证了**段落**间空行,**列表项**间空行仍丢(用户实测列表文档复现)。两个根因:

1. `bodyFromBlocks` 对相邻列表项 `shouldSeparate` 返回 `false`(紧凑列表 0 空行),故 `[bullet, 空p, bullet]` 只输出 `sep(0)+extra(1)=1` 个空行 `- a\n\n- b`——而 1 个空行正是松散列表的标准分隔,无法与「1 个空 p」区分。修正:`const sep = shouldSeparate(prev,b) || extraBlanks>0 ? 1 : 0`——一旦项间有空段落就强制基准分隔,输出 `1+extra` 个空行,与段落情形统一,`blocksFromBody` 的 `max(0,B-1)` 注入公式即可对列表/段落通用。
2. `parseListItem` 的子 `parseContainer` 会**吞掉列表项后面的空行**(它们本属父级),顶层因此数不到。修正:`parseContainer` 遇空行先**前瞻**——只有后随更深缩进内容(`indent>=minIndent`)的空行才并入本容器消费,否则 `break` 把空行留给父级计数。嵌套子树内部空行(test 85)仍按缩进归属,行为不变。

`[bullet a, 空p, bullet b]` → `- a\n\n\n- b` → core(`blank_after=1`)→ 回读 `[bullet a, 空p, bullet b]`,端到端往返(`bun ./_e2e` 真库验证)。配 `blocks.test.ts` 「blank lines between list items round-trip」用例。

**空列表项也是空行(关键补丁)**:用户在列表里加空行的自然手势是回车后留一个**空列表项**(`- ` 空 bullet),而旧 `shouldPersist` 把空列表项直接丢弃 → PATCH body 里列表始终是紧凑单 `\n`,空行存不下。修正:`isBlankParagraph` 升级为 `isBlankSpacer`——空 `p` **或**空列表项(无 content、无 children)都算间距,`bodyFromBlocks` 一律序列化成空行。回读时空行变空 `p`(列表外的可聚焦空行)。`computeListNumbers` 改为对**过滤掉 spacer** 的兄弟计算(`bodyFromBlocks` 与 editor `renderBlocks` 同步),使有序列表中间夹空行不会重置编号(1, 2 而非 1, 1)。`isBlankSpacer` 从 `blocks.ts` 导出供 editor 复用。

> ⚠️ **本补丁(空列表项=spacer)已被 §14.4.3 取代**:把空列表项序列化成空行会**丢类型**(空有序项刷新后变普通空行),且嵌套空行仍丢。§14.4.3 改为「空列表项是带标记的类型块、空行专指空段落」,并把空行处理递归到每一层。`isBlankSpacer` 收窄回「只认空 `p`」、`shouldPersist` 让列表项恒持久化。`computeListNumbers` 仍对过滤 spacer 的兄弟计算(空有序项现在不再是 spacer,故会正常参与编号)。

### 14.4.2 行首退格合并上一块（`editor.tsx` `onKeyDown` Backspace,2026-06-07)

Enter 拆分(§14.1)有了逆操作前,**非空块**光标在行首按 Backspace 无反应(列表项是剥 marker,普通段落什么都不做)。补:非空块、无选区、光标在块首时,若上一块是有可编辑文本的块(非 code/table/divider),把本块文本并入上一块尾部(`prev.content += blockEditorText(b,el)`)、`remove(b.id)`、光标用 `focusBlockAtOffset(prev.id, inlineTextLength(prev.content))` 落在拼接点——即「删掉换行符回到上一块」。列表项仍保留「先剥 marker → 段落」的既有一步。

**光标落点坑(同 §12.2 竞态)**:合并后上一块 content 变了,其 `renderKey` effect 会重写 `innerHTML`;若 rAF 的 `focusBlockAtOffset` 先于 effect 运行,effect 重写会把光标冲回块首(用户报「跑到行首」)。修正:在 rAF 里**先把合并后的 HTML 写进上一块**(`pe.innerHTML = inlineToHtml(prev.content)`),再定位光标——之后 effect 的「HTML 有变才写」守卫看到一致即跳过,光标稳定落在拼接点。

### 14.4.3 空块类型保真:空列表项 ≠ 空行(`webui/blocks.ts`,v2.6,2026-06-07)

§14.4.1 把空列表项当 spacer 引入两个 bug:**① 空有序/无序项刷新后退化成普通空行(类型丢失);② 嵌套层空行刷新后消失(`- a\n  - b\n\n\n  - c` → `- a\n  - b\n  - c`)**。设计见 [design.md §13](./design.md)。core 已验证无损,改动**全部在 `src/webui/blocks.ts`**。

诊断(运行时实测的**解析/序列化不对称**):`blocksFromBody("1. foo\n2. \n3. bar")` 本就回出 `[numbered, numbered "", numbered]`——解析器对;但 `bodyFromBlocks([numbered, numbered "", numbered])` 输出 `"1. foo\n\n\n2. bar"`——序列化器把空有序项当 spacer 销毁。markdown 里 `2. `(标记行)与真空行本就不同,无需推断。

改动:

1. **`isBlankSpacer` 收窄**:`b.type === "p" && b.content.trim() === ""`(去掉 `isListType` 分支)——空列表项不再是 spacer。
2. **`shouldPersist` 列表项恒 true**:空项也经 `renderListBlock` 输出裸标记(`- `/`2. `/`- [ ] `),类型随 markdown 存活。
3. **统一递归序列化 `serializeContainer(blocks, indent, isTop)`**:合并旧 `bodyFromBlocks`(顶层)与 `renderContainer`(嵌套、`filter(shouldPersist)` 会丢 spacer)两条路。每层都:跳过空 `p` 但计 `extraBlanks`、真实块间发 `sep + extraBlanks` 空行(`sep = shouldSeparate(prev,b) || extraBlanks>0 ? 1 : 0`)、进入列表 children 用**同一函数**递归;仅 `isTop` 的尾随游程补约定换行符。`renderListBlock` 把**原始** children(不预过滤)交给它,`firstReal` 决定是否在标记行后补空行。`renderContainer` 删除。
4. **`parseContainer` 去掉 `top` 门槛**:`blocks.length && blankRun>1` 在**每一层**把多余空行游程物化为空 `p`(归属逻辑——遇更浅行 `break` 交还父级——不变,已把游程路由到正确层)。`blocksFromBody` 调用改 3 参。
5. **`matchListLine` 加固**:`/^(\d+)[.)](?:\s+(.*))?$/`、`/^[-*+](?:\s+(.*))?$/` 让尾随内容可选,裸标记(`-`、`2.`)也解析为空列表项,防尾随空格被 strip 后退化;`---` 仍是分隔线、`-foo`/`2.foo` 仍是段落。

`blocks.test.ts` 旧「an empty list item is a blank-line spacer」断言改为「保留为 bullet」,新增有序空项 round-trip、删标记→p、嵌套空项、嵌套空行间距等用例。

验证:`bun test` 215 通过;`bun -e` 全链路(`bodyFromBlocks`→core `parseDocBlocks/serializeDocBlocks`→`blocksFromBody`)12 场景全部 `in===out` 且幂等(含上面两个曾丢数据的 case);`bunx tsc --noEmit` 改动文件零错误;`bun run build` 成功。

### 14.5 验证

- `bun test`:206 通过(新增 core `parseDocBlocks`/`serializeDocBlocks` 往返+幂等、`documents` 端到端「空行存活 + 只改间距块身份不变」、webui 内部空行 round-trip;`webui/blocks.test.ts` 旧「内部空段落丢弃」断言改为「保留为空行」)。
- `bunx tsc --noEmit`:本次改动文件零错误(既存无关错误同前:`src/cli/index.ts`、`src/core/sync/sites-serve.ts`、`apps/desktop`)。
- `bun run build`:`dist/webui.js` 打包成功。
- 手验(重建 + 重启 + 硬刷新):段落中间回车拆成两块;空段落无「/」提示;粘贴 Markdown 后光标落内容末尾;文末/段间加空行 → 保存刷新后仍在。

### 14.6 涉及文件

- core:`src/core/schema.ts`、`src/core/db.ts`、`src/core/blocks.ts`、`src/core/documents.ts`、`src/core/crdt.ts`;测试 `src/core/blocks.test.ts`、`src/core/documents.test.ts`。
- 前端:`src/webui/editor.tsx`(Enter 拆分、`focusBlock`、`placeholder`)、`src/webui/blocks.ts`(`bodyFromBlocks`、`parseContainer` top、`isBlankParagraph`);测试 `src/webui/blocks.test.ts`。
- 构建:`dist/webui.js`(改前端须重建)。

## 15. v2.7 点击文末空白处建/聚焦尾随空行（`editor.tsx` `onDocMouseDown`，2026-06-08）

`.doc` 的 36vh 底部内边距是一大片可点空白,旧 `onDocMouseDown` 在未命中块(`!id`)时只 `clearSel()`。设计见 [design.md §14](./design.md)。改动仅在 `if (!id)` 分支:

1. 仅当 `target.classList.contains("doc")`(点在容器自身内边距,而非标题/meta/占位符/块)且 `mode === "blocks"`。
2. 算内容底缘:取 `doc.querySelectorAll(".block")` 最后一个的 `getBoundingClientRect().bottom`(无块时回退 `.doc-meta`);仅 `e.clientY > contentBottom` 才触发,避开标题上方的顶部内边距。
3. `const last = blocks[blocks.length-1]`:`last && isBlankSpacer(last)` → `focusBlock(last.id, true)`(光标进既有空行);否则 `insertAfter(null)`(追加空 `p`,内部 rAF 自动聚焦、`bump()` 记历史、`scheduleSave()`)。其余情形落回原 `clearSel()`。

验证:`bun run build` 成功;手验(重建+重启+硬刷新):末行有字 → 点下方空白建新空行并落光标;末行已空 → 光标进该行且 `.doc-meta` 块计数不增;点标题附近不建行;空文档占位符照旧。

涉及文件:`src/webui/editor.tsx`(`onDocMouseDown`);构建 `dist/webui.js`(改前端须重建)。

## 16. v2.8 粘贴 HTML 富文本来源（`editor.tsx` `onContentPaste` + `html-md.ts`，2026-06-09）

设计见 [design.md §15](./design.md)。原 `onContentPaste` 只取 `clipboardData.getData("text/plain")`,从 ChatGPT 等渲染页复制时,`text/plain` 已丢失代码围栏 / 标题 `#` / 列表缩进 → `blocksFromBody` 一路 fall through 到 `parseParagraph`,代码与标题塌成 `p`。Typora 正常是因为它读 `text/html`,本次对齐。

- **新增 `src/webui/html-md.ts`**:`htmlToMarkdown(html)` 单例封装 `TurndownService`(`codeBlockStyle:"fenced"`、`headingStyle:"atx"`、`bulletListMarker:"-"`)+ `use(gfm)`。自定义 `fencedCodeWithLang` rule:`filter` 命中含 `<code>` 的 `<pre>`,`replacement` 取 `<code>` 子孙 `textContent` + 从 `language-xxx`/`lang-xxx` class 提语言,输出带语言围栏(规避 ChatGPT 工具条 div 被折进代码)。
- **`onContentPaste` 接线**:`const html = clipboardData.getData("text/html"); const raw = html ? htmlToMarkdown(html) : getData("text/plain")`,再 `.replace(/\r\n?/g,"\n")`;后续围绕光标拼接(单段落就地行内 / 多块拆插)逻辑不变。空白(`!text.trim()`)放行浏览器默认。
- **依赖**:`turndown`、`turndown-plugin-gfm`(+ `@types/turndown`);`turndown-plugin-gfm` 无类型,补 `src/webui/turndown-plugin-gfm.d.ts` ambient 声明。
- **包体**:turndown 运行时用浏览器原生 `DOMParser`,Bun browser 构建未打进 domino 回退,`dist/webui.js` 313KB→327KB(+13KB)。

验证:新增 `src/webui/html-md.test.ts` 7 用例(标题 h1–h6、带语言围栏、ChatGPT 工具条不折进、有/无序列表、引用、inline strong/em/code/link、ChatGPT 风总合),经 `htmlToMarkdown → blocksFromBody` 断言块类型与代码内容;`bun test` 215 全通过;`tsc -p src/webui/tsconfig.json` 零错;`bun run build` 成功。手验(重建+重启+硬刷新):从 ChatGPT 选「标题+番号列表+多个代码块+引用」粘贴,代码块带语言、标题/列表正确成块,不再塌成段落;纯文本来源(无 `text/html`)仍走原 Markdown 解析。

涉及文件:新增 `src/webui/{html-md.ts,html-md.test.ts,turndown-plugin-gfm.d.ts}`、改 `src/webui/editor.tsx`(`onContentPaste` + import)、`package.json`(依赖);复用 `blocksFromBody`(`blocks.ts`);构建 `dist/webui.js`(改前端须重建)。

## 17. v2.9 站点管理页面（`src/webui/sites.tsx`，2026-06-09）

设计见 [design.md §16](./design.md)。给静态站点(08-agent-sites)补 WebUI GUI;后端 5 条 `/api/site*` 写接口 + `updateSite` + `GET /api/sites` 加 `file_count` 详见 [08-agent-sites/design.md §6](../08-agent-sites/design.md)。本节记前端。

- **新增 `src/webui/sites.tsx`**:
  - `SitesView` — `useState<Site[]|null>` + `useEffect` 拉 `api.listSites()`(仿 `settings.tsx` 的 `SyncDevices` 取数);卡片网格;`peek`/`preview` 两个本地状态控制抽屉与预览。
  - `NewSiteModal` — `openModal(<Modal>)`,名字 slug 化(`[^a-z0-9-]→-`)+ 调 `api.createSite`。
  - `SitePeek` — 复用 `.scrim.open`/`.peek.open`;拉 `api.listSiteFiles`;隐藏 `<input type=file multiple>` → 逐个 `api.uploadSiteFile`(裸 `fetch`,二进制不走会 JSON 化的 `req()`);文件行预览/复制路径/删除(`confirmDialog`)。
  - `FilePreviewModal` — `fetch('/sites/<name>/<path>')`:文本 → `<pre class="preview-box">`,图片 → `<img src>` 指同 URL,blob → 占位。
  - `SitePreview` — 近全屏 overlay(`.spv-*`,带浏览器外框)+ `<iframe src="/sites/<name>/" sandbox="allow-scripts allow-same-origin">`;Esc / 点遮罩关。**不内联**(服务端已 serve)。
- **接线**:`app.tsx` `View` 加 `{kind:"sites"}` + 内容区 / 面包屑分支 + 传 `onOpenSites/sitesActive`;`sidebar.tsx` `SidebarProps` 加 `onOpenSites/sitesActive`,页脚「站点」按钮(紧挨「设置」);`icons.tsx` 加 `globe/eye/lock/upload/externalLink`;`api.ts` 加站点方法 + `Site/SiteFile` 类型(`Site.file_count`)。
- **CSS(`src/core/sync/webui.ts` 内联)**:追加 `.sites-grid`/`.site-card*`/`.site-addr`/`.acc-link`/`.filerow`/`.enc-badge`/`.preview-*`/`.spv-*`;复用既有 `.db`/`.toolbar`/`.scrim`/`.peek`/`.modal`/`.btn`。空状态类命名为 `.site-empty`,**避开**已存在的全屏 `.empty`。

验证:`tsc` 改动文件零错(既存无关错误同前:`src/cli/index.ts`、`src/core/sync/sites-serve.ts`、`apps/desktop`)。`bun test` 221 全通过(`sites.test.ts` +`updateSite` 用例,11/11)。`bun run build` 成功,`dist/webui.js` 含站点代码。HTTP 端到端冒烟(`--server --debug`)建站→传文件→`/sites/demo/` 真发→改标题→删文件→删站点全通(详见 08 §6.3)。

涉及文件:新增 `src/webui/sites.tsx`;改 `src/webui/{api.ts,app.tsx,sidebar.tsx,icons.tsx}`、`src/core/sync/webui.ts`(CSS);后端见 08 §6;构建 `dist/webui.js`(改前端须重建)。

## 18. v3.0 移动端适配:整页 Sidebar 首页 + 触摸优化 + 状态栏跟随（2026-06-10）

配套设计见 [design.md §17](./design.md)。把移动端从 v2 的「滑入抽屉」重做为整页下钻导航 + 触摸优先;**取代 §3/§7 描述的 ≤768px 抽屉**。不改后端 API/schema/CRDT/sync,纯前端 + 内联 CSS。

### 18.1 移动判定（`app.tsx` `useIsMobile`）

- 模块级常量 `MOBILE_MQ = "(max-width: 768px) and (pointer: coarse)"`——**CSS `@media` 与 JS 共用此判据**。`useIsMobile()`:`useState` 初值同步取 `window.matchMedia(MOBILE_MQ).matches`(首帧即正确,返回箭头/布局无翻动),`useEffect` 注册 `mq.addEventListener("change", …)` 跟随旋转/设备模式切换。
- 之所以加 `(pointer: coarse)`:纯宽度让桌面拖窄窗口误入移动样式并在 768px 跳变(抖动根因);指针类型不随缩放变化,桌面恒精确指针 → 永不进移动样式。

### 18.2 导航模型与 body 类（`app.tsx`）

- `const contentActive = view.kind !== "empty"`;`useEffect([isMobile, contentActive])` 里 `document.body.classList.toggle("mobile", isMobile)` 与 `toggle("mobile-content", isMobile && contentActive)`,随后 `syncThemeColor()`。沿用 §文件底部既有 `body.desktop`/`quicknote` 的 body-class 范式。
- 顶栏汉堡按钮(原桌面折叠/抽屉双用)在移动端语义改为「返回」:`onClick` 为 `isMobile ? navigate({kind:"empty"}) : (sbCollapsed ? setSbCollapsed(false) : setDrawerOpen(true))`,图标 `isMobile ? "arrowLeft" : "panelLeft"`,title 同步。`drawerOpen`/`DrawerClass`/`.backdrop` 在移动端保持惰性(CSS 隐藏),桌面端逻辑原样不动。

### 18.3 状态栏同步（`theme.ts` + `app.tsx`）

- `theme.ts` 新增并导出 `syncThemeColor()`:取 `#theme-color-meta`,按 `body.mobile && !body.mobile-content`(移动首页)选 `.sidebar`、否则 `document.body`,`getComputedStyle(el).backgroundColor` 写入 meta `content`——读解析后色值,故随 `data-theme`(含手动切换)实时正确。`setTheme()` 末尾调用它(手动切 light/dark/system 立即跟随)。
- `app.tsx` 另注册一次性 `matchMedia("(prefers-color-scheme: dark)")` 的 `change` 监听 → `syncThemeColor()`,覆盖「跟随系统」时 OS 切深浅色(只变 CSS 变量、无应用事件)的情形。

### 18.4 Head meta（`src/core/sync/webui.ts` HTML 外壳）

- 视口加 `viewport-fit=cover`(启用安全区);**不**加 `maximum-scale`/`user-scalable=no`(保留可访问性缩放,靠 16px 输入框规避 iOS 自动放大)。
- 新增 `<meta name="theme-color" id="theme-color-meta" content="#ffffff">`(初值,JS 覆盖)、`apple-mobile-web-app-capable=yes`、`apple-mobile-web-app-status-bar-style=default`。

### 18.5 移动端 CSS（`webui.ts` 内联,重写 `@media` 块）

媒体查询由 `@media (max-width: 768px)` 改为 **`@media (max-width: 768px) and (pointer: coarse)`**(与 `MOBILE_MQ` 同步);整块由「抽屉」重写为:

- **整页下钻**:`.sidebar{ position:fixed; inset:0; width:100% !important; margin-left:0 !important; … transition:transform .25s }`(覆盖 sidebar.tsx 内联的 `width`/`marginLeft`);`.main{ position:fixed; inset:0; transform:translateX(100%); transition:transform .25s }`;`body.mobile-content .main{ transform:translateX(0) }`、`body.mobile-content .sidebar{ transform:translateX(-100%) }`;`.backdrop{ display:none !important }`;隐藏 `.sb-head .iconbtn`(移动端无折叠)与 `.sb-resizer`;`.topbar .hamburger{ display:grid }`(作返回键)。
- **触摸尺寸/无 hover**:`.navitem .acts, .sb-section-head .add{ opacity:1 }`(常显);`.navitem`/`.sb-footer .navitem`/`.crumb`/`.pop .item` 字号 16px、加 padding;`.iconbtn{ 40×40 }`、`.btn{ min-height:40px }`、`.navitem .acts button{ 34×34 }`;**`input, textarea{ font-size:16px }`**(iOS 防放大);`.doc .editable{ font-size:16px }`、`.codeblock{ --code-fs:14px }`。
- **安全区**:`.sb-head`/`.topbar` 顶部、`.sb-footer`/`.doc` 底部叠加 `env(safe-area-inset-*)`。
- `.theme-grid` 等纯排版断点(`max-width:560px`)保持纯宽度,不引起尺寸跳变,未改。

### 18.6 验证

- `bun install`(首次)+ `bun run build`:`dist/webui.js` 打包成功。
- `bunx tsc --noEmit`:改动文件(`app.tsx`/`theme.ts`/`icons.tsx`/`webui.ts`)零错误(既存无关错误同前:`src/cli/index.ts`、`src/core/sync/sites-serve.ts`、`apps/desktop`、`dist/webui` 模块型)。
- 手验(重建 + 重启服务 + 硬刷新):**桌面**反复拖宽/窄跨 768px → 字号/按钮/布局恒桌面、零跳变;**DevTools 设备模式/真机** → 首页整页导航、点条目整屏滑入、顶栏「←」返回;条目/分区操作常显;聚焦搜索/标题/正文/源码框 iOS 不自动放大;应用内切 light/dark/system 与系统切深浅色时状态栏实时跟随;刘海机顶栏/底部不被遮挡。

### 18.7 涉及文件

- 前端:`src/webui/app.tsx`(`useIsMobile`/`MOBILE_MQ`、body 类 effect、返回键、`prefers-color-scheme` 监听)、`src/webui/theme.ts`(`syncThemeColor` + `setTheme` 接线)、`src/webui/icons.tsx`(新增 `arrowLeft`)。
- CSS/外壳:`src/core/sync/webui.ts`(head meta + 重写移动 `@media` 块)。
- 构建:`dist/webui.js`(改前端须重建)。

## 19. v3.1 文档目录:右侧悬浮刻度条(`editor.tsx` `DocToc`,2026-06-10)

配套设计见 [design.md §18](./design.md)。文档编辑器右侧加悬浮目录(折叠刻度线 / 悬停展开 / 点击跳转 / 滚动高亮),纯前端 + 内联 CSS。

### 19.1 `DocToc` 组件(`editor.tsx`)

- `stripInline(s)`:正则依次去掉 `` `code` ``、`**b**`、`*i*`/`_i_`、`~~s~~`、`[t](url)` 标记,得到纯文本标签。
- `DocToc({ blocks })`:`flattenBlocks(blocks).filter(type ∈ {h1,h2,h3})` → `{id, level, text}`(`level = Number(type.slice(1))`,`text = stripInline(content) || "无标题"`)。无标题时返回 `null`。渲染 `<nav class="doc-toc">`,每条为 `<button class="toc-row lvl-N {active}">` 内含 `.toc-tick`(折叠刻度)+ `.toc-label`(展开文字),`title` 设为完整标题。
- **滚动高亮**:`useEffect` 依赖 `headings.map(h=>h.id).join("|")`。`compute()` 取 `.content` 滚动容器顶 + 100px 为基准线,顺序找「top ≤ 基准线的最后一个标题」设为 `activeId`;`IntersectionObserver`(`root=.content`,`rootMargin:"-90px 0px -70% 0px"`)+ rAF 节流 `scroll` 监听共同触发 `compute`;卸载/标题变更 `obs.disconnect()` + 移除监听 + `cancelAnimationFrame`。
- **跳转**:`document.querySelector('.block[data-bid="ID"]')?.scrollIntoView({behavior:"smooth", block:"start"})`。

### 19.2 接入点(`editor.tsx` `DocView` 渲染)

- `DocView` 返回值由单个 `.doc` 改包成 fragment;在 `mode === "blocks"` 时于 `.doc` 前渲染 `<DocToc key={version} blocks={blocks} />`(`version` 每次编辑 bump → 目录随之重渲染,标题实时同步)。源码模式不渲染。

### 19.3 CSS(`webui.ts` 内联,「document editor」段)

- `.doc-toc`:`position:fixed; top:72px; right:18px; z-index:40`;折叠态 `width:24px; overflow:hidden`,`:hover` → `width:228px; overflow-y:auto; background:var(--surface); border:var(--line); box-shadow:var(--shadow-md)`;`transition` 宽度/背景/边框/阴影。
- `.toc-tick`:右对齐刻度,`.lvl-1/2/3` 宽 16/11/7px,`.active` 用 `--accent`;`:hover` 时收为 `width:0`。
- `.toc-label`:`opacity:0` → `:hover` 时 `1`;`.lvl-2/3` 左缩进 12/24px;`.active` 用 `--accent` + `font-weight:550`。
- `.block` 加 `scroll-margin-top:60px`(跳转避开顶栏)。
- `@media (max-width:1100px){ .doc-toc{ display:none } }`(窄屏/移动端隐藏)。

### 19.4 验证

- `bun run build`:`dist/webui.js` 打包成功;`bunx tsc --noEmit`:改动文件(`editor.tsx`/`webui.ts`)零错误。
- 手验(重建 + 重启服务 + 硬刷新):多标题文档右侧出刻度条,悬停展开标题列表,点击平滑跳转,滚动时当前章节刻度/条目高亮跟随;编辑标题文字实时更新、增删标题块条目随之增减;源码模式目录消失;窗口拖窄至 <1100px / 移动端目录隐藏;深色模式配色正常。

### 19.5 涉及文件

- 前端:`src/webui/editor.tsx`(`stripInline`、`DocToc`、`DocView` 渲染接入)。
- CSS:`src/core/sync/webui.ts`(`.doc-toc`/`.toc-*` 样式 + `.block` `scroll-margin-top`)。
- 构建:`dist/webui.js`(改前端须重建)。

## 20. v3.2 移动端改文档流滚动:iOS 26 Safari chrome 适配（2026-06-10）

**取代 §18.5 的「整页下钻」fixed 双面板布局**(`.sidebar`/`.main` fixed + transform 滑动),并修正 §18.4 的认知——iOS 26 Safari 完全忽略 `theme-color` meta,`syncThemeColor()` 仅对 Android Chrome 生效。

盒装布局(fixed 全屏面板 + 内部滚动)在 iOS 26 Safari 上结构性拿不到玻璃透视与实时变色:玻璃栏只合成**文档画布**滚到其下方的像素。移动端因此改为文档流滚动:活动视图入流(`min-height:100dvh`),document 自己滚,非活动视图 `display:none`(导航即真实渲染树进出 → 顶部实色扩展每次导航重采样);`.topbar` 吸顶且背景必须在自身;html/body 背景随 `body.mobile`/`.mobile-content` 跟随当前表面;页面切换动画改单视图 `page-in`;app.tsx 负责两个视图间的 document 滚动位置交接;DocToc 兼容 window 滚动。

机制、5 轮踩坑过程与今后改动检查清单详见 **[ios26-safari-chrome.md](./ios26-safari-chrome.md)**。涉及文件:`src/webui/styles.css`(移动端 MQ 块)、`src/webui/app.tsx`(导航 effect)、`src/webui/theme.ts`(移除重采样 hack)、`src/webui/editor.tsx`(DocToc)。

## 21. v3.3 表格单元格编辑重做：覆盖式编辑器 + 电子表格键盘（2026-06-11）

用户反馈两个问题：编辑时出现"框中框"且整行被撑大；不按 Enter 直接点别处会丢失修改。涉及文件：`src/webui/table.tsx`（`InlineEditInput`/`CellView`/`DatabaseView`/`PeekValue`）、`src/webui/styles.css`（`.celledit`）。

### 21.1 根因

- **撑大行高**：旧编辑态把 `.cell` 的显示内容**替换**为自带 `outline:2px + padding:7px 9px` 的 input，嵌在 `.cell` 的 `padding:8px 11px` 里——双层框、总高超过 37px min-height。
- **丢改**（真 bug，不是"缺少 blur 提交"）：旧 input 是受控 `value={initial}`。点击另一单元格时，目标 td 的 `pointerdown → setCellSel` 触发的重渲染发生在 blur **之前**，Preact 把 DOM value 重置回旧值 → 随后 blur 提交的是旧值。只有 Enter（在任何状态更新前先 blur）能可靠保存。
- 次要问题：值没变也发 PATCH（每次都写一条记录历史）；提交 await API 返回才退出编辑态；中文 IME 按 Enter 确认候选词被当作提交。

### 21.2 设计

- **覆盖式编辑器**：`td.cell-td` 加 `position:relative`；编辑器渲染为 display 内容的 **sibling** `<div class="celledit">`（绝对定位铺满 td、`z-index:10`、accent 双层 box-shadow 环 + 投影、不透明背景），显示内容留在流内 → 行高永不变化。内层 input padding 与 `.cell` 一致（8px 11px），进入编辑文字零位移。`input.inlineedit` 全局规则保留给 peek 面板，覆盖层用 `.celledit input.inlineedit` 提高特异性归零边框。
- **非受控 + EditEnd 协议**：`InlineEditInput` 改为 ref 挂载时赋值一次（`seed ?? initial`、focus、光标置末尾），重渲染不再碰 DOM 值——丢改根治。结束统一走 `finish(reason)` → `onDone(EditEnd)`，`reason ∈ cancel|blur|enter|tab|shifttab`，携带 `changed`（raw 字符串 vs initial）与 `coerceInput` 后的值；`done` ref 标志吞掉 Enter/Esc/Tab 卸载后的尾随 blur，杜绝双重提交。IME 防护：`e.isComposing || e.keyCode === 229` 直接放行。
- **乐观提交**：`commit` 同步 `setEditing(null)` + 本地写 `cells`/`values` 双 map，后台 `PATCH /api/record`（id-keyed）reconcile，失败 toast + `reload()` 回滚（仿 `persistRecordMove`）。`changed === false` 时调用方直接跳过 commit——不发请求、不写历史。
- **电子表格键盘**（建立在已有 cellSel 框选态上，全局 keydown，editing/输入框聚焦时旁路）：方向键移动单格选区（Shift 扩展，复用 shift+click 的 anchor 语义）、`scrollIntoView(nearest)` 跟随；Enter/F2 进入编辑；**可打印字符直接进入编辑并以该字符替换原值**（`editing.seed` 经 CellView 传入编辑器；date 列不支持、number 列限 `[0-9.+-]`、IME 首键 229 进不来——标准取舍）；Delete/Backspace 清空（原先仅多格框选可用，现单格也行）；编辑中 Tab/Shift+Tab 提交并移到左右邻格继续编辑（到行边缘/不可编辑列则仅选中）、Enter 提交并下移一行（Airtable 式；排序激活时按提交前索引，行序跳变可接受）。checkbox/select/multi_select 键盘仅选中，交互保持点击驱动。
- **peek 面板**：`PeekValue` 接新协议（新增 `onCloseEdit` 关闭路径），不传 `captureTab`（Tab 走原生焦点序、blur 提交），外观不变，顺带获得 Esc 取消与值不变不请求。

### 21.3 验证

`bun test` 273 全绿、webui tsc 干净。手动回归重点：输入后点击别处保存成功（核心回归项）；编辑态行高不变（与多行邻格同行验证）；IME Enter 选词不提交；值不变 blur 无网络请求；Tab 串行编辑；切库后无残留编辑态（`[db.id]` effect 补了 `setEditing(null)`）。
