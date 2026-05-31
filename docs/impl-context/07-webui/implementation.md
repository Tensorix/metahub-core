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
- 列头菜单 `ColMenu`（菜单内受控）：改名、改类型（含 select/multi 自动补默认选项）、选项增删、在右侧插入列、删除列（confirm）。改类型/选项即调 `PATCH /api/property` 并 `reload`。
- 加列类型选择器、行 ⋯ 菜单（打开/复制/删除）、底部多选操作条（复制/删除选中）、记录 peek 侧栏（属性逐项编辑 + 正文占位）。chip 颜色由字符串哈希到固定色相、`color-mix` 适配明暗。

### 4.5 侧边栏（`sidebar.tsx`）

文档树按 `parent_id` 递归渲染、可折叠；HTML5 拖拽：drop-into 设 `parent_id=目标`，drop-before/after 设为目标的同级（均经 `updateDocument` 持久化；防环检测）。宽度拖拽（210–460px，临时态）。条目菜单：新建子页、重命名、移到顶层、删除（递归删子树）。新建数据库 Modal 含名称/图标/模板（空白/任务/联系人），模板按序 `createProperty`。

**整栏折叠**：折叠状态 `sbCollapsed` 提升到 `app.tsx`，经 `collapsed` prop 下传；折叠时给 `.sidebar` 加 `collapsed` class 并设 `marginLeft:-width`（复用既有 `transition:margin-left` 平滑滑出）。头部收起按钮 `onCollapse` 置位，顶栏 `panelLeft` 按钮在折叠时显示（`.hamburger.show-collapsed`）以重新展开——它与移动抽屉复用同一按钮：桌面折叠态点击展开侧栏，否则打开移动抽屉。（修复：旧 `onCollapse` 误接移动抽屉的 `setDrawerOpen(false)`，桌面端 drawer 本就关闭，故按钮无效。）

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
