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
- 侧栏：文档**树**（折叠/拖拽改嵌套）、宽度可拖拽、移动端抽屉；条目菜单与新建数据库 Modal（模板）。
- 全面 CRUD + 真实弹窗/菜单/SVG 图标，移动端适配，明暗主题。

### 7.2 关键设计决策
1. **编辑器自研、不引重依赖**：contenteditable 块编辑器（保持依赖仅 citty/preact/zod）。**每个编辑器块 = 一个 core block**；保存时把所有块序列化为 markdown body，复用 `PATCH /api/document` + `reconcileBody`，**无需新增 block 级 API**，CRDT 按块合并语义不变。多行紧凑列表在前端拆为逐项块（一行一块），序列化为以空行分隔的列表项。
2. **后端缺口极小**：core 已有 `updateProperty`/`removeProperty`/`deleteDatabase`/`listRecords(filter/sort)`，仅新增 `updateDatabase` 与 `updateProperty` 的 `type` 支持，并暴露 `PATCH/DELETE /api/database`、`PATCH/DELETE /api/property`（沿用 query 携带 id）。
3. **属性类型变更**：扩展 `updateProperty` 接受 `type`；变更时清空该列所有单元格（旧值在新类型下可能非法）——有意的有界取舍。
4. **前端模块化**：`app.tsx` 仍是唯一构建入口，拆为 `api/icons/ui/blocks/markdown/sidebar/table/editor`；Bun 跟随 import 自动打包，**性能隔离不变**（不进 `cli.js` 启动图）。命令式 `ui.tsx`（Modal/Menu/Toast）替换原生 `alert/prompt/confirm`。

### 7.3 v1 范围外（避免改 schema，明确标注）
- 数据库描述字段、文档独立 emoji 图标（需加列）。
- 保存视图 / 持久化筛选排序（v2 排序为客户端临时态；看板/日历占位）。
- 文档同级顺序、表格行手动拖拽顺序的**持久化**（跨层级移动 `parent_id` 已持久化）。

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

- 表格、数学、脚注、callout、TOC、代码高亮。
- CLI 和 core markdown 切块规则不变；嵌套能力先服务 WebUI 文档编辑器。
