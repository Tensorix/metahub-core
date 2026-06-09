# 浏览器 WebUI 与 REST API 设计文档

承接 [01-init-basic-func/design.md](../01-init-basic-func/design.md)、[05-json-record-storage/design.md](../05-json-record-storage/design.md)、[06-friendly-ids/design.md](../06-friendly-ids/design.md)。本文记录在已有的 `mh --server`(CRDT 同步服务端 = 一个 metahub 节点)上,于根路径 `/` 内置一个**浏览器 WebUI**,用来浏览并轻量编辑已存储的数据表(databases/records)与文档(documents),并暴露配套的 `/api/*` REST 接口。

**硬约束:不影响 CLI 启动性能。** CLI(`dist/cli.js`)的启动成本 = 其模块 import 图;只要 WebUI 资源不进入该 import 图,前端框架选型对 `mh <命令>` 启动零影响。**底层 core / oplog / sync 协议全部不改**——WebUI 的写入复用与 CLI 完全相同的 core 函数,经 `emit()` 进 CRDT,自然可同步。

## 1. 背景与目标

现状:`mh --server`(`src/core/sync/server.ts`)用极简 `Bun.serve()` 暴露 `/sync`、`/health`,以及自动生成的 OpenAPI(`/docs`、`/docs.json`);根路径 `/` 返回 404。数据全在 `~/.metahub/metahub.db`,只能经 CLI 浏览/编辑,缺一个可视化的查看与编辑入口。

目标:

- 访问 `/` 即看到一个能**浏览 + 编辑**数据表与文档、并能全文搜索的 WebUI。
- 复用既有 core 读写函数(`listDatabases`/`listRecords`/`createRecord`/`updateDocument`/`search` 等),不新写存储逻辑;写入与 CLI 同路径,经 CRDT oplog,可随 `mh sync` 复制。
- **对 CLI 启动性能零影响**——这是选型与接线方式的决定性约束。

## 2. 关键评估:框架选型 vs CLI 性能

决定性事实:**影响 CLI 启动的是"代码是否进入 CLI 的模块图",而非框架本身。** 据此:

| 交付方式 | 是否进入 CLI 模块图 | 对 CLI 启动影响 |
|---|---|---|
| HTML/JS 字符串内联进 `server.ts`(被 `cli/index.ts` 静态 import) | 是,每次 CLI 都加载 | 小但非零 |
| WebUI 作为独立 bundle,`server.ts` 经 `await import()` 懒加载服务模块 | 否,仅浏览器访问时载入 | **0** |

体积(浏览器侧 gzip):原生 JS 0KB / **Preact ~5KB** / Vue ~16KB / React ~45KB。由于这是**本地优先(CRDT)工具**、UI 跑在 localhost,若用 CDN 拉框架则断网即挂,故一律**自托管打包**。

**选定 Preact + 自托管打包**:编辑型 UI(行内编辑、表单、保存后 re-render)用声明式框架远比手写 DOM 干净;Preact ~5KB、React 风格 JSX/hooks DX、离线可用;且因独立打包 + 懒加载,对 CLI 启动开销为 0。

## 3. 设计要点

### 3.1 性能隔离(最关键)

1. **WebUI 资源永不进入 CLI import 链**:`server.ts` 的 fetch handler 对 `/`、`/webui.js` 用 `await import("./webui.ts")` 动态加载服务模块。Bun 单文件打包会把该模块**内联**进 `cli.js`(以保持单文件 bin),但其模块体仅在首次 `import()` 被 await 时**执行**——故 HTML 外壳字符串只增加约 5KB 体积,运行时分配与执行延迟到浏览器访问 `/` 时,启动成本 ~0。
2. **Preact 只打进 `dist/webui.js`**(独立 entrypoint),`webui.ts` 自身不 import preact(只把 `app.tsx` 当字符串路径传给 `Bun.build` 兜底),故 **Preact 运行时不在 `cli.js`**。
3. 新增 `/api/*` 路由复用的 core 函数本就在 CLI 图中(各 CLI 命令已用),不引入新的启动开销。

### 3.2 REST API:路由表单一来源 + query 携带 id

沿用既有"路由表即 OpenAPI 来源"的模式(`routes.ts` + `openapi.ts`):新增 `src/core/sync/webui-routes.ts` 导出 `webuiRoutes`,在 `routes.ts` 里 `[...syncRoutes, ...webuiRoutes]` 合并。

- 路由器是**精确路径匹配**,故 id 用 **query 参数**携带(`/api/record?id=`、`/api/records?db=`),不改路由器、不破坏 OpenAPI 生成。
- `Route.method` 联合类型从 `GET|POST` 扩展为加 `PATCH|DELETE`(fetch 的 `r.method===req.method` 与 openapi 的 `method.toLowerCase()` 均已兼容)。
- handler 统一用 `handle()` 包一层:返回值序列化为 JSON,抛错转 `{error}` 400;找不到的单实体返回 404 `Response`。
- response/request 用**务实**的 Zod schema(列表 `z.array(...)`,写入对应字段),仅为 `/docs` 提供形状,不追求过度精确。

路由清单:`GET/POST /api/databases`、`GET/POST /api/properties`、`GET/POST /api/records`、`GET/PATCH/DELETE /api/record`、`GET/POST /api/documents`、`GET/PATCH/DELETE /api/document`、`GET /api/search`。

### 3.3 服务模块:懒加载 + 双解析路径

`src/core/sync/webui.ts` 导出 `serveWebui(req): Promise<Response|null>`:

- `GET /` → 返回内联 HTML 外壳(CSS 内联其中,省一个资源路由;支持暗色模式)。
- `GET /webui.js` → 返回应用 bundle,解析策略(首次后缓存到模块级变量):
  - **生产**:读取与 `cli.js` 同目录的 `dist/webui.js`(`new URL("./webui.js", import.meta.url)`)。
  - **开发兜底**(从源码运行、无 dist 时):`Bun.build({ entrypoints: ["…/webui/app.tsx"], target: "browser" })` 即时构建。
- 其它路径返回 `null`,交回主 handler。

### 3.4 前端(`src/webui/app.tsx`,Preact 单文件)

- 顶部 `/** @jsxImportSource preact */` pragma,JSX 走 preact 自动运行时(不依赖 tsconfig 解析,Bun 逐文件识别)。
- 左侧栏:databases + documents 列表,各带"+"新建(用 `prompt` 走最简创建流)。
- 数据表视图:列取自 `/api/properties`,行取自 `/api/records`;`Cell` 组件按属性类型渲染显示/编辑(checkbox 即时切换、select 下拉、multi_select/relation 逗号分隔转数组、其余文本框);提交 `PATCH /api/record?id=`,新增 `POST /api/records?db=`(空记录后再逐格填),删除 `DELETE`。
- 文档视图:`GET /api/document?id=` → 标题输入 + 正文 textarea + 内置 ~40 行零依赖 markdown 渲染器做实时预览;保存 `PATCH /api/document?id=`,删除 `DELETE`。
- 顶部全文搜索 → `GET /api/search?q=`,结果点击跳转(文档→文档视图,记录→其所在库)。

### 3.5 构建

`scripts/build.ts` 新增第三个 `Bun.build`:`src/webui/app.tsx` → `dist/webui.js`(`target:"browser"`、minify、Preact 一并打入)。`package.json` 的 `files` 已含 `dist`,发布即带上;`cli.js`/`index.js` 产物不受影响。`tsconfig.build.json` 的 `include` 不含 `src/webui`,且 `webui.ts` 只把 `app.tsx` 当字符串路径引用,故声明构建(tsc)不会因 JSX/preact 报错。

## 4. 取舍

- **Preact 而非原生 JS / React**:编辑型 UI 需要状态管理,原生手写易错;Preact 兼得 React DX 与 ~5KB 体积。React(~45KB)无额外收益时不必要。
- **自托管打包而非 CDN**:本地优先工具不能因断网而 UI 不可用;Bun 打包成本可忽略。
- **懒加载 + 单文件内联(`splitting:false`)**:保持 `cli` 为单文件可执行(`build:binaries` 依赖此),同时靠 `import()` 的延迟执行把启动成本压到 0;不开 code splitting 以免破坏单文件 bin。
- **id 走 query 参数而非路径参数**:避免改动精确路径匹配的路由器与 OpenAPI 生成;代价是 URL 风格不那么 RESTful,但对内部工具可接受。
- **复用 core 函数、不新写存储**:WebUI 写入与 CLI 完全同路径(经 `emit()`),自动获得 CRDT 收敛与可同步性;无第二套写逻辑。
- **轻量编辑面**:快速加属性只覆盖无需配置的标量类型,select/relation 等仍走 CLI;创建流用 `prompt` 而非完整表单——优先把"查看 + 常见编辑"做扎实,复杂建模交给 CLI。
- **无鉴权**:与 `/sync` 一致,假定可信网络/本机;引入鉴权是后续独立议题。

## 5. 涉及文件

- 新增:
  - `src/webui/app.tsx` — Preact 单页应用(侧栏 / 数据表行内编辑 / 文档编辑 + 预览 / 搜索)。
  - `src/webui/tsconfig.json` — 为编辑器配置 preact JSX(运行时构建靠 pragma)。
  - `src/core/sync/webui.ts` — `serveWebui`:`/` 外壳 + `/webui.js`(生产读 dist、开发 `Bun.build` 兜底),经 `server.ts` 懒加载。
  - `src/core/sync/webui-routes.ts` — `webuiRoutes`:`/api/*` 读写路由 + 务实 Zod schema,复用 core 函数。
- 修改:
  - `src/core/sync/routes.ts` — `Route.method` 加 `PATCH|DELETE`;`routes = [...syncRoutes, ...webuiRoutes]`。
  - `src/core/sync/server.ts` — fetch handler 在 API 路由前加 `/`、`/webui.js` 的懒加载分支。
  - `scripts/build.ts` — 新增 `dist/webui.js` 打包入口。
  - `package.json` — 加 `preact` 依赖(仅被 webui bundle 引用)。

## 6. 实现记录（与设计的偏差 / 验证）

- **`.tsx` 里禁用泛型箭头默认值**:`const get = <T = any>(p)=>…` 在 tsx 会被当成 JSX 解析报错;改为非泛型 `req()` 返回 `Promise<any>`,调用点用类型实参标注即可。
- **CSS 内联在 HTML 外壳**:避免第三个静态资源路由,也让 CSS 不进 JS bundle;单处维护。
- **性能隔离已验证**:`dist/cli.js` 中无 Preact 运行时符号(`preact/jsx-runtime`/`hooks` 等),仅余 `package.json` 里的版本字符串;普通 CLI 命令冷启动实测 ~30ms,不触碰 server/webui。
- **端到端已验证**:经 `/api/*` 建库→加属性→建记录→`PATCH` 改字段→建文档→搜索全通;改动确认进 `crdt_changes` oplog,且 `mh record get` 能读到 WebUI 所建记录——证明写入与 CLI 同一可同步路径。`bun test` 59 通过、零回归。

## 7. v2 改版（Notion-like 重写）

v1（§1–6）把"查看 + 常见编辑"做扎实，但编辑面仍偏简陋：文档非所见即所得、表格不能改/删/排序列、侧栏无树/拖拽、无移动端、用 `alert/prompt/confirm`。v2 在**不动 core/oplog/sync、不破坏性能隔离**的前提下，把前端重写为 Notion-like 体验。代码级实现见 [implementation.md](./implementation.md)。

### 7.1 范围与目标
- 文档：块级**所见即所得**编辑器（`/` 斜杠菜单、块拖拽重排、行内格式条、待办/列表/引用/代码/分隔线）。
- 表格：Notion-like——按类型行内编辑、列头菜单（改名/**改类型**/选项增删/排序/插入/删列）、加列、行菜单、多选删除、记录侧栏 peek、彩色 select chip。
- 侧栏：文档**树**（折叠/拖拽改嵌套；同级拖拽排序见下「后续补充」）、宽度可拖拽、移动端抽屉；条目菜单与新建数据库 Modal（模板）。
- 全面 CRUD + 真实弹窗/菜单/SVG 图标，移动端适配，明暗主题。

### 7.2 关键设计决策
1. **编辑器自研、不引重依赖**：contenteditable 块编辑器（保持依赖仅 citty/preact/zod）。**每个编辑器块 = 一个 core block**；保存时把所有块序列化为 markdown body，复用 `PATCH /api/document` + `reconcileBody`，**无需新增 block 级 API**，CRDT 按块合并语义不变。多行紧凑列表在前端拆为逐项块（一行一块），序列化为以空行分隔的列表项。
2. **后端缺口极小**：core 已有 `updateProperty`/`removeProperty`/`deleteDatabase`/`listRecords(filter/sort)`，仅新增 `updateDatabase` 与 `updateProperty` 的 `type` 支持，并暴露 `PATCH/DELETE /api/database`、`PATCH/DELETE /api/property`（沿用 query 携带 id）。
3. **属性类型变更**：扩展 `updateProperty` 接受 `type`；变更时清空该列所有单元格（旧值在新类型下可能非法）——有意的有界取舍。
4. **前端模块化**：`app.tsx` 仍是唯一构建入口，拆为 `api/icons/ui/blocks/markdown/sidebar/table/editor`；Bun 跟随 import 自动打包，**性能隔离不变**（不进 `cli.js` 启动图）。命令式 `ui.tsx`（Modal/Menu/Toast）替换原生 `alert/prompt/confirm`。

### 7.3 v1 范围外（避免改 schema，明确标注）
- 数据库描述字段、文档独立 emoji 图标（需加列）。
- 保存视图 / 持久化筛选排序（v2 排序为客户端临时态；看板/日历占位）。
- ~~文档同级顺序~~、表格行手动拖拽顺序的**持久化**（跨层级移动 `parent_id` 已持久化）。
  - **后续补充**：文档同级顺序已落地——documents 新增 `order_key`（per-parent fractional index），WebUI 侧栏拖拽走 `PATCH /api/document/move`（`moveDocument` before/after/into），父级与顺序由 core `placeInSiblings` 一处保持一致；详见 [data-model.md](../../system-design/data-model.md) 的 documents 段。表格行手动排序仍为缺口。

### 7.4 涉及文件（增量）
- 后端：改 `src/core/databases.ts`、`src/core/properties.ts`、`src/core/sync/webui-routes.ts`；新增 `src/core/{databases,properties}.test.ts`。
- 前端：重写 `src/webui/app.tsx`、`src/core/sync/webui.ts`(CSS)；新增 `src/webui/{api.ts,icons.tsx,ui.tsx,blocks.ts,blocks.test.ts,markdown.tsx,markdown.test.ts,sidebar.tsx,table.tsx,editor.tsx}`。
- 静态原型（评审规范）：`prototype/webui.html`。

## 8. v2.1 文档编辑器嵌套 Markdown（2026-05-31）

本节记录 v2 之后的增量设计。历史上 §7 描述的是 Notion-like v2 重写；本节只描述 2026-05-31 对文档编辑器的嵌套 Markdown 扩展。

### 8.1 范围与目标

- 目标：核心子集 + 前端兼容层 + Typora 近似体验。
- 不改后端 API、schema、core CRDT、sync 协议；`PATCH /api/document` 仍保存完整 Markdown body。
- 扩展 webui block 模型：列表块支持 `children`，代码块支持 `lang`，用于表达列表项内嵌段落、引用、代码块、子列表。
- `blocksFromBody` 读取现有 Markdown 时重建嵌套列表结构；`bodyFromBlocks` 保存为 GFM 兼容缩进 Markdown。
- 保留现有 slash menu、块拖拽、格式工具条；新增逻辑只作用于文档编辑器。

### 8.2 UX

- 空格触发：`1. ` 有序列表，`- ` / `* ` / `+ ` 无序列表，`- [ ] ` / `- [x] ` 待办，`> ` 引用，`# ` / `## ` / `### ` 标题。
- Enter 行为：列表项 Enter 创建同级下一项；空列表项 Enter 退出列表；普通块 Enter 创建下一段。
- Tab / Shift+Tab：列表项缩进/反缩进，形成嵌套列表；代码块内 Tab 插入空格。
- 代码块：输入 ```` ``` ```` 或 ```` ```python ```` 后 Enter 转为代码块，隐藏 fence，保留语言名；不做语法高亮，先提供轻量语言标签/输入。
- 列表项内可以继续创建段落、引用、代码块；保存为规范缩进 Markdown，不强求保留原始源码排版。

### 8.3 暂不实现

- 表格、数学、脚注、callout、TOC（代码高亮已在 §9 实现）。
- CLI 和 core markdown 切块规则不变；嵌套能力先服务 WebUI 文档编辑器。

## 9. v2.2 代码块语法高亮与块样式打磨（2026-06-01）

本节记录在 v2.1 嵌套 Markdown 之上的增量：补齐 §8.3 曾标注「暂不实现」的**代码高亮**，并重写代码块 / 引用块 / 嵌套子块的视觉与交互。仍不改后端 API、schema、core CRDT、sync 协议。

### 9.1 关键设计决策

- **高亮引擎**：`highlight.js/lib/common`（~30 常用语言，指定语言用 `hljs.highlight`，否则 `highlightAuto`）。token 配色自写一套用 CSS 变量（`--hl-*`），浅色 + `prefers-color-scheme:dark` 双套内联，不引第三方主题 CSS，保持与系统调性一致。新增运行时依赖 `highlight.js`——仅进 lazy 加载的 webui bundle，不入 CLI 启动 import 图。
- **代码块输入架构**：放弃 contentEditable，改 **transparent `<textarea>` + 下层 `<pre><code>` 高亮镜像**（经典 code-editor 方案）。原生光标 / 多行 / 方向键；逐键命令式刷新高亮与行号。`wrap="off"` 让 textarea 不软换行以对齐高亮层；`rows="1"` 修正 textarea `scrollHeight` 以 `rows`（默认 2）为下限导致短代码块底部多一行空白的问题。
- **退出代码块（消除「卡住」）**：末行为空行按 Enter，或光标在末行按 ↓，退出并在下方建块；首行按 ↑ 回上一块。此前全局 `onKeyDown` 用 `type!=="code"` 跳过代码块，Enter/↓ 都无法离开。
- **删除空代码块**：顶层空代码块 Backspace 转回普通段落；列表项内嵌空代码块 Backspace 只移除代码块子节点并聚焦回父列表项，保留列表编号/marker，避免留下额外空子段落。
- **代码块 UI**：语言下拉 + 复制按钮收进**右下角 hover 浮层**（默认隐藏，`:hover` / `:focus-within` 显示）；左侧行号栏；整体紧凑度量。
- **引用块**：收敛为中性左边条 + 斜体柔色（去掉早期带色底纹——它是文档里唯一的色块，与中性调性冲突）。
- **嵌套子块**：缩进为主；仅对**真正的子列表**（`:has(> .b-bullet/.b-numbered/.b-todo)`）显示细引导线，代码等其它嵌套内容不画线，避免多层堆叠成「乱线」。列表项内嵌代码块时隐藏冗余的子块 gutter，由列表项 host gutter 统一掌管（否则与列表序号重叠）。

### 9.2 暂不实现

- 高亮主题切换、复制以外的代码块操作（折叠/换行开关）、语言自动探测的可视化提示。

## 10. v2.3 多块选中、撤销/重做与有序列表起始号（2026-06-01）

本节记录在 v2.2 之上文档编辑器的三项增量：多块（整块）选中、自建撤销/重做（Ctrl+Z）、有序列表按用户输入的起始号。仍不改后端 API、schema、core CRDT、sync 协议；数据模型仅有序列表块新增可选 `start`。代码级实现见 [implementation.md §11](./implementation.md)。

### 10.1 多块选中

**背景**：每个块正文是**独立的 contentEditable 宿主**，浏览器原生 `Selection` 不能跨宿主——从 A 块拖到 B 块时选区被钳在起始块内。早先写过一套读原生选区映射块的 `getBlockSelection`/跨块删除/缩进/复制/行内格式，但因此从未触发；代码块是 `<textarea>` 更无法参与原生跨块选区。

**决策**：放弃依赖原生选区，引入**独立的块选择状态**（`anchor..focus` 连续区间），用指针事件自行框选：

- 触发：① 在块文本中拖拽、一旦越过另一个块即自动从文字选择切换为整块选择；② 在块左侧 gutter/marker 空白处按下即整块选择；③ Shift+点击扩展区间。仅连续区间，不做 Cmd+点击离散加选。
- 视觉：选中块加 `.selected` 底色（`--accent-soft`）；拖拽期间 `.doc.selecting` 关闭原生文字反白。**无浮动工具栏**（按用户要求，仅底色）。
- 批量操作（纯键盘）：Backspace/Delete 删除、Tab/Shift+Tab 缩进/反缩进（复用既有批量 `indentBlocks`/`outdentBlocks`）、Cmd/Ctrl+C·X 复制/剪切为 Markdown、Cmd/Ctrl+D 复制、Cmd/Ctrl+A 全选、Shift+↑/↓ 扩展、Esc/方向键/打字退出；选中多块整组拖拽移动。
- 取舍：多块=整块模式；单块内仍用原生文字选择驱动行内格式条。废弃失效的跨块行内格式路径。

### 10.2 撤销/重做（Ctrl+Z）

**背景**：结构性块操作直接改 `blocksRef` 再 `bump()` 重渲染，不进浏览器原生撤销栈，故 Ctrl+Z 对插入/删除/移动/缩进/转换/多块批量等**全部无效**（原生撤销只覆盖单块内文字输入）。

**决策**：自建快照式历史并接管 Ctrl+Z：

- 快照 = 深拷贝块树 + 标题 + 当前聚焦块 id；`present` 为最近一次记录，发生变更时把它压入 `past`（上限 200 步），清空 `future`。
- 记录时机：所有结构性操作经 `bump()` 各记一步；文字/代码/标题输入按块 id 在 600ms 窗口内合并为一步，避免逐字符撤销。
- 快捷键（document 捕获层，编辑文字时也生效，`preventDefault` 屏蔽原生）：Cmd/Ctrl+Z 撤销、Cmd/Ctrl+Shift+Z 或 Ctrl+Y 重做。
- 恢复：替换块树/标题、清空多块选择、重渲染并恢复光标；切换文档重置历史。

### 10.3 有序列表起始号

**背景**：序号原为实时重排计数（同级 numbered 计数），完全忽略用户输入的数字，永远显示 1、2、3…

**决策**：采用 CommonMark 语义——一个连续有序 run 由**首项**的数字定起点、后续自动递增（首项数字尊重用户输入，后续数字按规范忽略）：

- 模型：`Block` 增可选 `start`（仅 numbered，且只在 run 首项有意义）。
- 单一数字来源 `computeListNumbers(siblings)`（导出）：显示与序列化共用，故插入/删除/重排后序号自动「序列重建」。
- 输入入口：打字 `5. ` 快捷键、粘贴/加载 Markdown 解析首项数字。`normalizeNumbering` 只在每个 run 首项保留 `start`（为 1 则省略），其余项的数字丢弃。
- 行为：`5.` 起从 5 递增；`1. 1. 1.` 重排为 1,2,3；删除首项后余项重建。

### 10.4 暂不实现

- 离散（Cmd+点击）多块选中、块选浮动工具栏、多块批量类型转换 UI。
- 编辑已有有序列表起始号的 UI（仅创建/粘贴时按用户输入）。
- 撤销栈对大文档「每键全树深拷贝」的优化（当前文档规模无感）。

### 10.5 涉及文件

- `src/webui/editor-ops.ts`：新增 `blockRangeIds`/`deleteBlocks`/`duplicateBlocks`/`moveBlocks`/`serializeBlocks`（复用既有 `flattenBlocks`/`indentBlocks`/`outdentBlocks`/`topmostBlockIds` 等）。
- `src/webui/blocks.ts`：`Block.start`、导出 `computeListNumbers`、`normalizeNumbering`、解析/快捷转换捕获数字、`renderContainer` 改用统一编号。
- `src/webui/editor.tsx`：块选择状态与指针框选、document 键盘路由（撤销/重做 + 块批量）、快照历史、显示编号/创建/转换接入 `start`。
- `src/core/sync/webui.ts`：`.block.selected` / `.doc.selecting` CSS（注意 webui 真实 CSS 内联于此，非 `prototype/webui.html`）。
- 测试：`src/webui/editor-ops.test.ts`、`src/webui/blocks.test.ts`。

## 11. v2.4 跨块光标导航、Markdown 粘贴、双击全选（2026-06-01）

文档编辑器交互增量，对齐 Notion 手感；不改 schema/CRDT。实现见 [implementation.md §12](./implementation.md)。

### 11.1 关键设计决策

- **↑/↓ 跨块**：块是独立 contentEditable，原生方向键不跨宿主。仅当光标在块**首/末可视行**才跨块（↑→上块末尾、↓→下块开头），其余放行逐行移动；行边界用光标矩形 vs 块盒比较（半行容差），空块视为首尾皆是。
- **Markdown 粘贴**：粘贴的 `text/plain` 经块解析器渲染为行内格式 + 块结构（而非字面 `**` 或单块）。单段落就地行内插入；多块/非段落则在光标处拆行、整组插入、尾段收尾。代码块保持字面粘贴。
- **双击 Ctrl+A**：渐进扩选——首次选本块文字，已全选再按则全选所有块。判定读「当前选区是否已全选」的**无状态**信号，不计按键次数 + 超时窗口；用选中文本**长度比较**规避 contentEditable 尾部隐形 `<br>` 把边界点判定带偏。

### 11.2 暂不实现

- 跨块**文本级**选区（仍是块级整选）。
- ~~粘贴 **HTML 富文本**来源（仅取 `text/plain` 的 Markdown）。~~ **已由 §15 实现**：优先解析 `text/html`。
- 粘贴时的光标精确还原在含 Markdown 标记的混排场景下为近似（落到末块边界）。

### 11.3 工程坑点（供后续 debug 参考）

- **改前端不生效**：`/webui.js` 经 `getJs()` 提供，优先读预构建 `dist/webui.js` + 进程内 `cachedJs` 仅构建一次，且 `editor.tsx` 不在 `--hot` import 图内。改完须 `bun run build` + 重启进程 + 浏览器硬刷新。
- **全局 `renderKey` 重置光标**：结构 op 经 `bump()` 让全部块重渲染、重写 `innerHTML` 冲掉光标 → `useEffect` 改为「HTML 有变才写」。

## 12. v2.5 回车拆分、空行保留、光标确定性、空行无提示（2026-06-07）

文档编辑器四项修正,前三项是纯 WebUI 交互,空行保留连带 core 改造(见 [04-block-level-doc-crdt §2.7](../04-block-level-doc-crdt/design.md) 与 [data-model](../../system-design/data-model.md) `doc_blocks`)。实现见 [implementation.md §14](./implementation.md)。

### 12.1 关键设计决策

- **回车在光标处拆分块**：原 Enter 只 `insertAfter` 新建空块,后半段不动。改为复用既有 `splitEditableAtCaret(el)` 取光标前/后两段:`before` 留当前块、`after` 进新块、光标落新块开头;列表块续同类型,否则新建 `p`;`after` 为空即退化为原「下方新建空行」。
- **光标落点确定性**:`focusBlock(atEnd=false)` 原本只 `el.focus()`、不显式设 caret,依赖浏览器默认——结构 op 重写 `innerHTML` 后 caret 回退到位置 0,与粘贴/拆分的落点策略竞态。改为两种情形都显式 `selectNodeContents` + `collapse(!atEnd)`(始端/末端),消除竞态。补 §11.3 的 innerHTML 守卫成为完整修复。
- **空段落的「/」提示仅在聚焦行显示**(Notion 式):空白段落保留 `data-ph` 的「/」提示文案,但 CSS `.b-p .editable:empty:not(:focus)::before { content:"" }` 让**未聚焦**的空行不显示提示——光标所在的空行仍提示「输入文本,'/' 唤出命令」,其余空行读作真正的留白。标题/引用/代码等有语义的块仍始终显示类型提示。整篇空文档入口仍由「无块时的独立引导」兜底。
- **空行往返**:WebUI 把**顶层**空段落映射为 body 里的空行(`bodyFromBlocks` 每个空 `p` 多输出一行空行,`blocksFromBody`/`parseContainer(top)` 把超出分隔的空行游程解析回可聚焦的空 `p`);core 用 `blank_after` 真正持久化(否则 WebUI 这套端到端无效——之前正是 core 的 `serializeBlocks` 把空行规整掉)。嵌套(列表子树)内的空行仍按结构分隔处理,不变成空段落。**列表项之间**的空行需额外处理(见 implementation §14.4.1):紧凑列表 `shouldSeparate=false` 会把空段落坍缩进松散分隔,且列表解析器会吞掉项后空行——故 `bodyFromBlocks` 在有空段落时强制基准分隔、`parseContainer` 前瞻只消费属于本容器的空行。此外用户在列表里加空行的自然手势会留下**空列表项**(不是空段落),故 `isBlankSpacer` 把空 `p` 与空列表项一视同仁当间距(否则空列表项被 `shouldPersist` 丢弃);`computeListNumbers` 对过滤掉 spacer 的兄弟计算,使夹空行的有序列表不重置编号。
  > ⚠️ **「空列表项=空行」与「仅顶层物化」已被 §13 修订**:把空列表项当间距会丢类型(刷新后退化成普通空行),且嵌套空行被丢。§13 改为「空列表项是带标记的类型块、空行专指空段落」,并把空行处理递归到每一层。本段其余(顶层空段落 ⇄ body 空行、core `blank_after`)仍有效。
- **行首退格合并**:非空块光标在行首按 Backspace,把本块文本并入上一个文本块(删「换行符」,Enter 拆分的逆操作);列表项仍先剥列表符号→段落;code/table/divider 无可编辑文本,不合并。

### 12.2 暂不实现

- 行内 / 字符级跨块选区(仍块级)。
- 前导空行保留(文档开头的空行规整掉,中间与文末保留)。
- 空行间距的可视标尺 / 自定义行距;空行仍是「一个可聚焦空段落 = 一行空行」的离散模型。

### 12.3 工程坑点（供后续 debug 参考）

- **「已工作」需端到端验证**:WebUI 早有保留文末空行的代码且单测通过,但端到端仍丢——因为文档 body **不按原文存**,而是经 core `parseBlocks`/`serializeBlocks` 规整成块再重建。判断某行为是否生效务必走真实持久化路径,勿只看前端纯函数单测。

## 13. v2.6 空块类型保真:空列表项 ≠ 空行（2026-06-07）

§12 的空行方案把「空列表项」也当成间距(spacer),导致两个 bug:**① 列表里的空项(如有序列表中间的 `2.`)刷新后退化成普通空行(类型丢失);② 嵌套层(列表子树)里的空行刷新后直接消失(数据丢失)**。根因是 §12 的「空列表项=空行」决策 + `parseContainer` 的「仅顶层物化」。实现见 [implementation.md §14.4.3](./implementation.md)。

### 13.1 模型(核心心智)

**一个块原本是什么类型,刷新后还应该是什么类型——空块也不例外。** 把两个被混在一起的概念彻底分开:

- **空列表项**(`- `、`2. `、`- [ ] `,或带子块的列表项)= 真实的**带类型块**。序列化时**带标记输出**,类型由 markdown 标记自身承载、随 round-trip 存活。**不是 spacer。**
- **空行 = 空段落**(`type:"p"`、content 为空)= 纯垂直间距。序列化成空行、由 core `blank_after` 持久化。删掉列表项的标记 → 它变成 `p` → 一行普通空行。

关键洞察:markdown **本来就能区分**这两者(标记行 `- ` vs 真空行 `\n`),所以不需要任何「按上下文推断空行类型」。core(`src/core/blocks.ts` + `doc_blocks/blank_after`)是**类型无关且无损**的(连嵌套空行都能逐字节 round-trip),故修复**全部在前端 `src/webui/blocks.ts`,core 不动**。

### 13.2 关键设计决策

- **`isBlankSpacer` 只认空段落**(去掉「空列表项」分支);**`shouldPersist` 让列表项恒持久化**(空项也输出裸标记)。这把「序列化把空列表项销毁」这一根因拆掉——解析器本就能把 `2. ` 读回空有序项,只是旧序列化器把它当空行扔了(解析/序列化**不对称**)。
- **空行处理递归到每一层**:统一为一个递归 `serializeContainer(blocks, indent, isTop)`(取代旧 `bodyFromBlocks` 顶层逻辑 + `renderContainer` 嵌套丢 spacer 两条路);`parseContainer` 去掉 `top` 门槛,在**每一层**把超出分隔的空行游程物化为空 `p`。于是 `- a\n  - b\n\n\n  - c`、列表项内段落间空行等嵌套间距都能存活。
- **加固**:`matchListLine` 接受**无尾随空格**的裸标记(`-`、`2.`)当空列表项,防止 `- ` 的尾随空格被源码模式/外部工具 strip 掉后退化成段落;`---` 仍是分隔线、`-foo`/`2.foo` 仍是段落。

### 13.3 行为对照

| 操作 | 存成 markdown | 刷新后 |
|---|---|---|
| 有序列表留空项 | `1. foo` / `2. ` / `3. bar` | 仍是有序列表、中间空有序项 |
| 删掉某项的 `2.` 标记 | `1. foo` / 空行 / `2. bar` | 中间仍是普通段落 |
| 嵌套列表里的空项/空行 | 带缩进保留 | 原样保留 |

## 14. v2.7 点击文末空白处建/聚焦尾随空行（2026-06-08）

文档正文下方有大片空白(`.doc` 的 `padding ...36vh`),此前点它只清选区、无反应。改为 Notion 式:点文末空白区——**末行非空则在末尾新建空段落并落光标;末行已是空行则直接把光标放到那一行(不再多建)**。纯 WebUI 交互,core 不动。实现见 [implementation.md §15](./implementation.md)。

- **触发判定**:仅当 mousedown 落在 `.doc` 容器自身(非标题/meta/块/占位符)且 `clientY` 在最后一个 `.block` 底缘之下时生效,避开标题上方的顶部内边距。
- **建/聚焦决策复用 `isBlankSpacer`**(空段落):末块为空段落 → `focusBlock(last, atEnd)` 把光标放进既有空行;否则 `insertAfter(null)` 追加空 `p` 并自动聚焦(走既有 undo/save)。空列表项不算空行(它是带标记的类型块,见 §13),故其下点击仍新建空段落。整篇空文档仍由「无块时的独立引导」入口兜底。

## 15. v2.8 粘贴 HTML 富文本来源（ChatGPT 等）（2026-06-09）

从浏览器（如 ChatGPT）复制的内容粘贴进文档编辑器时,一部分应是代码块/标题/列表的内容塌成普通段落。根因:`onContentPaste` 只读 `text/plain`,而浏览器复制时富结构只存在于 `text/html`——`text/plain` 已丢掉代码围栏 ```` ``` ````、标题 `#`、列表缩进。改为优先解析 `text/html`(对齐 Typora),修订 §11.2 的「暂不实现」。不改后端 API/schema/CRDT/sync。实现见 [implementation.md §16](./implementation.md)。

### 15.1 关键设计决策

- **粘贴优先 `text/html` → Markdown → `blocksFromBody`**:剪贴板从渲染页复制时同时含 `text/html`(完整 DOM 结构)与 `text/plain`(渲染后纯文本,已丢块级标记)。改为有 `text/html` 就用 turndown 转成规范 Markdown,再走既有 `blocksFromBody` 块解析;无 `text/html` 回退原 `text/plain` 路径。编辑器行内格式本就以 Markdown 串存在 `block.content`,故「HTML→Markdown 串→块」与现有模型天然契合,无需改 block 模型。
- **选 turndown(+turndown-plugin-gfm)而非手写 DOM 遍历**:成熟、覆盖全(标题/列表/引用/表格/删除线/inline)。运行时用浏览器原生 `DOMParser`,故 domino 回退不进浏览器包,`webui.js` 仅 +~13KB。
- **健壮的代码块 rule**:ChatGPT 的 `<pre>` 内含工具条 div(语言标签 + Copy 按钮),默认 `pre>code` 首子规则会漏语言或把工具条文本折进代码。自定义 rule 取 `<code>` 子孙的 `textContent` 与 `language-xxx` class,输出带语言围栏。

### 15.2 暂不实现

- 补 `text/plain` 解析器的次要缺口(`RE.h` 仅 h1–h3、续行无 `>` 的多行引用、`~~删除线~~`)——`text/html` 路径已覆盖主场景,纯文本兜底改善优先级低。

## 16. v2.9 站点管理页面（2026-06-09）

WebUI 新增「站点管理」视图,给既有静态站点功能([08-agent-sites](../08-agent-sites/design.md))补一套 GUI——此前站点只能用 `mh site` CLI 管理。后端为此补了 `/api/site*` 写接口 + `updateSite`,数据/路由细节见 [08-agent-sites/design.md §6](../08-agent-sites/design.md);本节只记 WebUI 侧。实现见 [implementation.md §17](./implementation.md)。

### 16.1 关键设计决策

- **入口放侧栏页脚、紧挨「设置」**(单色 `globe` 图标):站点是「内容」不是配置,但比数据库/文档次级,故不进顶级区块、也不塞进设置页内。
- **列表用卡片网格而非表格**:站点是少量「项目」,卡片让操作(访问 / 更多)常驻可见,避免表格的空操作列 + hover 才出现按钮的别扭。卡片显示 slug / 标题 / 可复制的访问地址 / 文件数 · 创建日期。
- **详情用右侧 peek 抽屉**:复用 `RecordPeek` 的 `.scrim/.peek` 范式列文件;文件操作(预览 / 复制路径 / 删除)就地,上传走隐藏 `<input type=file multiple>`。
- **访问站点 = 应用内 iframe 预览**(带浏览器外框 overlay):`src` 直指服务端已 serve 的 `/sites/<name>/`,**不内联** css/js;另给「↗ 新标签」。文件预览同理 `fetch` 已 serve 的真实 URL。
- **零新 UI 原语**:建站 / 重命名 / 删除 / 提示复用 `ui.tsx` 的 `openModal`/`Modal`/`openMenu`/`confirmDialog`/`promptDialog`/`toast`。

### 16.2 暂不实现

- 文件字节大小(清单接口不含 → 卡片改显「文件数 · 日期」)、拖拽上传、列表内搜索过滤、blob 大文件同步(沿用 08 的取舍)。
