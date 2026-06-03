# 桌面端(Bun + Electron)设计文档

承接 [07-webui/design.md](../07-webui/design.md)(Preact WebUI,由 `startServer()` 在 `/` 提供)与 [11-device-pairing-sync/design.md](../11-device-pairing-sync/design.md)(`startServer()` 内嵌同步服务 + 自动同步)。

本文记录在 `apps/desktop` 下用 **Bun + Electron** 构建桌面端。**核心原则:复用既有 core/WebUI,不重复实现任何功能核心**——桌面端只是一层外壳。

**关键定位**:桌面端不引入新的业务逻辑,它把现有的「`mh --server` 起服务 + 浏览器开 WebUI」两步打包进一个原生窗口。外壳本身 core 一行不改;后续叠加的快速笔记(§7)也只往接口加**领域中立**的文档树能力,**core 始终不含任何 quicknote 概念**。

## 1. 背景与关键约束

现状:能力都在 `src/core`,WebUI 由 `startServer()`(`src/core/sync/server.ts:60`)经 `Bun.serve` 在 `/` 提供;用户需手动 `mh --server` 再用浏览器访问。

**核心约束**:core 深度依赖 Bun 专有 API(`bun:sqlite`、`Bun.serve`、`Bun.build`、`Bun.file`)。Electron 主进程跑在它自带的 **Node/Chromium 运行时,不是 Bun**,因此 core/server **无法直接在 Electron 主进程内运行**。这一点决定了整体架构。

## 2. 设计决策:Bun 边车(sidecar)+ Electron 外壳

```
Electron 主进程 (Node)                    Bun 边车子进程
  app.whenReady()
    spawn bun run server-entry.ts  ───────►  startServer({ debug, host:127.0.0.1, port:0 })
    解析 stdout: METAHUB_PORT=<port>  ◄──────  console.log("METAHUB_PORT="+s.port)
    轮询 http://127.0.0.1:<port>/health 直到 {ok:true}
    BrowserWindow.loadURL(http://127.0.0.1:<port>/)  ──►  现有 Preact WebUI
  before-quit / will-quit → child.kill()        SIGTERM → s.stop()
```

- 边车调用现有 `startServer()`,**零 core 改动**;数据库共用 `~/.metahub`(`src/core/paths.ts`),与 CLI 数据一致。
- **`--debug`(关闭 token 鉴权)+ 临时端口 `port:0`**:窗口是唯一客户端、仅绑 `127.0.0.1`,无需 token 摩擦;系统分配端口,绝不与用户自己跑的 `mh --server`(7777)抢占。不对外暴露。
- 退出时杀边车,避免孤儿进程。

## 3. 目录结构

```text
apps/desktop/
  package.json          # electron 依赖 + bun 脚本
  tsconfig.json         # 继承根 tsconfig,加 bun+node types / DOM lib
  src/
    server-entry.ts     # Bun 入口:调 core 的 startServer,打印端口
    main.ts             # Electron 主进程:spawn 边车 / 建窗 / 生命周期
    preload.ts          # 最小 contextBridge(平台/版本信息)
  dist/                 # 构建产物(main.js / preload.js)
```

## 4. 各文件职责

- **`src/server-entry.ts`**(由 bun 运行,保持 `.ts` 不编译):`import { startServer } from "../../../src/core/sync/server.ts"`;`startServer({ debug:true, host:"127.0.0.1", port:0 })`;按约定打印 `METAHUB_PORT=<port>`;`SIGTERM`/`SIGINT` → `s.stop()` 优雅退出。
- **`src/main.ts`**(Electron 主进程):`resolveBun()` 定位 bun(`BUN_PATH` > `/opt/homebrew/bin/bun`、`/usr/local/bin/bun` > PATH 上的 `bun`);`spawn` 边车并从 stdout 正则提取端口;`waitForHealth()` 轮询 `/health`(常量镜像 `src/core/sync/protocol.ts` 的 `HEALTH_PATH`,带超时/重试);`createWindow()` 建窗加载;`window-all-closed`(macOS 保留 dock)/`before-quit`/`will-quit`/`process exit` 统一 `killSidecar()`;启动失败 `dialog.showErrorBox` 兜底。
- **`src/preload.ts`**:`contextBridge.exposeInMainWorld("metahubDesktop", { platform, versions, quicknote })`。WebUI 的数据读写通过 HTTP 直连边车、不依赖 IPC,故 preload 仍很轻;`quicknote` 子对象(`qn:*` IPC)是唯一例外,为快速笔记的原生能力(全局快捷键/置顶)服务,详见 §7。

## 5. 构建与运行

**关键点**:Electron 主进程是 Node 运行时,**不能直接加载 `.ts`**,且 `electron` API 只在 Electron 进程内由 `require("electron")` 提供。因此:

- `main.ts`/`preload.ts` 用 `bun build --target=node --format=cjs --external electron` 编译到 `dist/`(`--format=cjs` 让 `require("electron")` 正常工作;**`--external electron` 必须有**,否则 bun 会把 `electron` npm 包的「可执行文件路径字符串」打进 bundle,运行时 `app` 为 `undefined`)。
  - **坑**:`bun build` 会在编译期把 `__dirname` 内联成**源文件**目录(`apps/desktop/src`),不是产物目录 `dist/`。所以主进程**不能用 `__dirname` 拼路径**,否则会指向不存在的文件(详见 §7.4)。一律改用运行时的 `app.getAppPath()`。
- `server-entry.ts` 由边车的 bun 运行,**不编译**。

```jsonc
// package.json scripts
"build:main": "bun build src/main.ts src/preload.ts --target=node --format=cjs --external electron --outdir=dist",
"dev": "bun run build:main && electron ."
```

运行:`cd apps/desktop && bun install && bun run dev`。

## 6. 复用清单(不重复实现)

- `startServer()` — `src/core/sync/server.ts:60`:内嵌服务 + WebUI + API + 自动同步。
- `serveWebui()` / Preact 应用 — `src/core/sync/webui.ts` + `src/webui/**`:完整 UI。
- `~/.metahub` 路径 — `src/core/paths.ts`:与 CLI 共享数据。
- `HEALTH_PATH` — `src/core/sync/protocol.ts:59`:健康检查路径。

## 7. 快速笔记(Quick Notes)

全局快捷键 / 菜单栏唤起的小窗,半透明背景、可始终置顶、专做 Markdown 速记。复用主 WebUI 与块编辑器,**不在 core 引入「快速笔记」概念**。

### 7.1 视图:同一份 bundle 的 `#quick` 路由 + 桌面守卫

小窗不是新前端。主进程为它另开一个 BrowserWindow 加载 `http://127.0.0.1:<port>/#quick`,`src/webui/app.tsx` 在入口分流:

```ts
if (location.hash === "#quick" && window.metahubDesktop) {
  document.body.classList.add("quicknote");
  render(<QuickNote/>, …);          // src/webui/quicknote/quicknote.tsx
} else render(<App/>, …);
```

- **桌面守卫** `window.metahubDesktop`:只有桌面外壳(preload 注入了该桥)才渲染小窗;浏览器即使手动开 `/#quick` 也只看到主 app,概念不外泄。
- `QuickNote` 直接复用块编辑器 `DocView`(`src/webui/editor.tsx`),自带自动保存/斜杠命令,与主窗体验一致——零重复实现。
- 样式内联在共享样式表 `src/core/sync/webui.ts`:`body.quicknote #app` 铺满整窗(覆盖主 app 的 flex 布局),`.qn` 用低透明度 `color-mix(in srgb, var(--bg) 20%, transparent)` 让 mac vibrancy 透出。

### 7.2 数据:快速笔记 = 普通文档 + 通用父级,core 保持中立

**关键决策:core 不知道「快速笔记」。** 一条快速笔记就是一篇普通 `documents`,`parent_id` 指向一个特殊容器文档。core/接口只新增**领域中立**的文档树能力:

- `POST /api/documents` 透传 `parent_id`(原先被静默丢弃,顺带修了 bug);
- `GET /api/documents?parent=<id>` 过滤(薄包 `listDocuments(db, { parent_id })`);
- `PATCH /api/document` 早已支持 `parent_id`,`DocSummary` 早已带 `parent_id`。

**没有** `/api/quicknotes/*` 路由,`grep -rn quicknote src/core` 为空。

「哪篇文档是容器」纯前端解析(`resolveQuickNotesParent()`,`quicknote.tsx`):localStorage 缓存父 id → 失效则找顶层同名 `"Quick Notes"` 文档(跨设备同步去重)→ 都没有才新建。sentinel 标题与父 id 缓存只活在 UI 层。

> 收益:容器文档与子笔记也是普通文档,会随 `/sync` 复制,且在主窗 sidebar 里可见可编辑。
> 决策依据见全局记忆「功能/UI 概念不进 core,core 只加通用能力」。

### 7.3 原生能力(`apps/desktop/src/main.ts` + `preload.ts`)

- **小窗**:第二个 BrowserWindow——mac `vibrancy:"under-window"` + `visualEffectState:"active"` + `backgroundColor:"#00000000"` + `titleBarStyle:"hiddenInset"`(交通灯浮在拖拽顶栏上);默认右下角、可缩放、记忆 bounds;关闭即隐藏(保活,下次秒开)。
- **唤起**:`globalShortcut`(默认 `CommandOrControl+Shift+Space`)+ `Tray` 菜单栏图标(`apps/desktop/assets/trayTemplate.png`,构建期脚本生成的单色 template),点击均 toggle 显隐。因常驻托盘,`window-all-closed` 改为 no-op(托盘保活)。
- **置顶 / 快捷键设置**:经 preload 暴露 `window.metahubDesktop.quicknote`(IPC 频道 `qn:get-settings`/`qn:set-shortcut`/`qn:set-always-on-top`/`qn:hide` 等)。设置页 `settings.tsx` 仅当该桥存在时显示「快速笔记」区块(改快捷键、默认置顶)。
- **持久化**:快捷键 / 置顶 / 窗口 bounds 存 `app.getPath("userData")/quicknote-settings.json`(本机态,不入 CRDT)。

### 7.4 关键坑:bun 把 `__dirname` 写死成源码目录

`bun build --target=node` 在**编译期**把 `__dirname` 内联成**源文件**所在目录(`apps/desktop/src`),不是产物目录 `dist/`。于是 `join(__dirname, "preload.js")` 指向不存在的 `src/preload.js`,Electron **静默加载不到 preload** → `window.metahubDesktop` 始终 `undefined`(表现:置顶按钮消失、桌面守卫回退渲染成主 app)。此坑在最初的外壳里就潜伏,只是当时没有任何东西依赖该桥才没暴露。

**修复**:主进程一律用运行时 `app.getAppPath()`(= `apps/desktop`)解析路径,杜绝内联 `__dirname`:

```ts
function appFile(...p: string[]) { return join(app.getAppPath(), ...p); }
// preload → appFile("dist","preload.js");  sidecar → appFile("src","server-entry.ts");
// tray    → appFile("assets","trayTemplate.png")
```

### 7.5 涉及文件

- **接口(通用,非 quicknote)**:`src/core/documents.ts`(`listDocuments` 加 `parent_id` 过滤)、`src/core/sync/webui-routes.ts`(create 透传 `parent_id` + `?parent=`)、`src/webui/api.ts`(`listDocumentsByParent`)。
- **前端(快速笔记视图)**:新增 `src/webui/quicknote/quicknote.tsx`;`src/webui/app.tsx`(分流+守卫)、`src/webui/settings.tsx`(设置区块)、`src/webui/icons.tsx`(`pin` 图标)、`src/webui/desktop.d.ts`(桥类型声明)、`src/core/sync/webui.ts`(内联 CSS)。
- **桌面**:`apps/desktop/src/main.ts`(第二窗口 / 快捷键 / 托盘 / IPC / `app.getAppPath()` 路径修复)、`apps/desktop/src/preload.ts`(`quicknote` 桥)、新增 `apps/desktop/assets/trayTemplate.png`。

## 8. 生产打包 —— 暂未实现(仅记录方向)

当前交付范围:本地 `bun run dev` 可运行(从终端启动时 PATH 含 bun)。

后续要做免装 Bun 的可分发安装包:用 `bun build --compile`(参考 `scripts/compile-binaries.ts`)把 `server-entry.ts` 产出独立二进制,放进 `process.resourcesPath`;再用 `electron-builder` 打 `.dmg`/`.exe`,把边车二进制放进 `extraResources`。GUI 双击启动时 PATH 精简,届时主进程改为优先用打包的二进制(或用户设 `BUN_PATH`)。

## 9. 涉及文件

- 新增:`apps/desktop/{package.json,tsconfig.json}`、`apps/desktop/src/{server-entry,main,preload}.ts`
- 依赖:`electron`(仅 `apps/desktop` 的 devDependency;不进 core/CLI 依赖图)
- 改动:**外壳本身 core 零改动**(纯复用);快速笔记(§7)另在接口侧加了**领域中立**的文档树能力(`parent_id` 透传 + `?parent=` 过滤),core 仍不含任何 quicknote 概念。
