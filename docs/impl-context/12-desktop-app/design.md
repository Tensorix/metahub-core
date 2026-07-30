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
  package.json          # electron + electron-builder 依赖 + bun 脚本
  electron-builder.yml  # 打包配置(四平台 / extraResources / ad-hoc 不签名)
  tsconfig.json         # 继承根 tsconfig,加 bun+node types / DOM lib
  src/
    sidecar.ts          # 共享边车启动逻辑(runSidecar:调 startServer,打印端口)
    server-entry.ts     # 开发态 Bun 入口(bun run,WebUI 源码懒构建)
    server-bundle.ts    # 生产态编译入口(内嵌 dist/webui.js,供 --compile)
    main.ts             # Electron 主进程:spawn 边车 / 建窗 / 生命周期
    preload.ts          # 最小 contextBridge(平台/版本信息)
  scripts/
    build-sidecars.ts   # bun build --compile 交叉编译四平台边车二进制
    gen-icon.ts         # 纯 TS PNG 编码器生成 1024² 占位图标
  assets/trayTemplate.png  # 托盘图标
  build/icon.png        # 应用图标源图(electron-builder 自动派生 icns/ico/png)
  resources/            # 构建产物:各平台边车二进制(metahub-sidecar-*)
  dist/                 # 构建产物(main.js / preload.js)
  release/              # 打包产物(.dmg / .zip / .exe / .AppImage / .deb)
```

## 4. 各文件职责

- **`src/sidecar.ts`**(共享启动逻辑):导出 `runSidecar()`——`import { startServer } from "../../../src/core/sync/server.ts"`;`startServer({ debug:true, host:"127.0.0.1", port:0 })`;按约定打印 `METAHUB_PORT=<port>`;`SIGTERM`/`SIGINT` → `s.stop()` 优雅退出。开发态与生产态两个入口都调它,避免重复。
- **`src/server-entry.ts`**(开发态入口,由 bun 运行、不编译):仅 `import { runSidecar } from "./sidecar.ts"; runSidecar()`。WebUI 由 `getJs()` 从源码懒构建,故**不**内嵌 bundle。
- **`src/server-bundle.ts`**(生产态入口,被 `bun build --compile` 编成独立二进制):`import webuiBundle from "../../../dist/webui.js" with { type: "text" }` 把预构建 bundle 作为**内嵌文本**带进二进制,`setWebuiBundle(webuiBundle)` 注入 core 后再 `runSidecar()`。编译二进制无源码、无 sibling `dist/webui.js`,靠这条把 WebUI 嵌进去(详见 §8.1)。
- **`src/main.ts`**(Electron 主进程):`resolveSidecarCommand()` 按 `app.isPackaged` 分流——**打包态**用 `process.resourcesPath` 下的编译二进制(`metahub-sidecar`/`.exe`,免装 Bun、免源码);**开发态**走 `resolveBun()` + `bun run src/server-entry.ts`(`BUN_PATH` > `/opt/homebrew/bin/bun`、`/usr/local/bin/bun` > PATH)。`spawn` 边车并从 stdout 正则提取端口;`waitForHealth()` 轮询 `/health`(常量镜像 `src/core/sync/protocol.ts` 的 `HEALTH_PATH`,带超时/重试);`createWindow()` 建窗加载;`window-all-closed`(macOS 保留 dock)/`before-quit`/`will-quit`/`process exit` 统一 `killSidecar()`;启动失败 `dialog.showErrorBox` 兜底。
- **`src/preload.ts`**:`contextBridge.exposeInMainWorld("metahubDesktop", { platform, versions, quicknote })`。WebUI 的数据读写通过 HTTP 直连边车、不依赖 IPC,故 preload 仍很轻;`quicknote` 子对象(`qn:*` IPC)是唯一例外,为快速笔记的原生能力(全局快捷键/置顶)服务,详见 §7。

## 5. 构建与运行

**关键点**:Electron 主进程是 Node 运行时,**不能直接加载 `.ts`**,且 `electron` API 只在 Electron 进程内由 `require("electron")` 提供。因此:

- `main.ts`/`preload.ts` 用 `bun build --target=node --format=cjs --external electron` 编译到 `dist/`(`--format=cjs` 让 `require("electron")` 正常工作;**`--external electron` 必须有**,否则 bun 会把 `electron` npm 包的「可执行文件路径字符串」打进 bundle,运行时 `app` 为 `undefined`)。
  - **坑**:`bun build` 会在编译期把 `__dirname` 内联成**源文件**目录(`apps/desktop/src`),不是产物目录 `dist/`。所以主进程**不能用 `__dirname` 拼路径**,否则会指向不存在的文件(详见 §7.4)。一律改用运行时的 `app.getAppPath()`。
- `server-entry.ts` 由边车的 bun 运行,**不编译**;`server-bundle.ts` 则用 `bun build --compile` 编成独立二进制(§8)。

```jsonc
// package.json scripts
"build:main":     "bun build src/main.ts src/preload.ts --target=node --format=cjs --external electron --outdir=dist",
"build:icon":     "bun run scripts/gen-icon.ts",          // → build/icon.png
"build:sidecars": "bun run scripts/build-sidecars.ts",    // → resources/metahub-sidecar-*
"build":          "bun run build:main && bun run build:icon && bun run build:sidecars",
"dev":            "bun run build:main && electron .",
"dist":           "bun run build && electron-builder --publish never",       // 当前平台
"dist:mac":       "bun run build && electron-builder --mac --publish never",  // 另有 dist:win / dist:linux
```

- **开发运行**:`cd apps/desktop && bun install && bun run dev`(从含 bun 的终端启动,边车跑源码)。
- **打可分发包**:`bun run dist:mac`(产物在 `release/`)。详见 §8。

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
- **跨全屏空间置顶(Raycast 式)**:mac 上小窗用 `type:"panel"`——Electron 运行时给它加 `NSWindowStyleMaskNonactivatingPanel`,使其能浮在**别的 App 的全屏空间**之上、出现在所有 Space,且**显示时不激活 Metahub**(否则 `show()+focus()` 会激活应用、把焦点切回主窗所在桌面 = 用户感知的「跳回」)。主应用仍保留 Dock 图标,只有这一个窗口表现为面板。创建后再补两步:`setAlwaysOnTop(alwaysOnTop, "screen-saver")`(普通层级被 macOS 10.14+ 禁止浮于全屏之上,须升到 `screen-saver`)+ `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })`(`skipTransformProcessType` 避免调用时进程类型切换导致的 Dock 闪烁)。「始终置顶」开关(`qn:set-always-on-top`)同样按 `screen-saver` 层级设置。
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

## 8. 生产打包

**目标**:产出免装 Bun、免源码、双击即用的可分发安装包,覆盖 macOS(arm64+x64)、Windows(x64+arm64)、Linux(x64+arm64)。开发态 `bun run dev` 行为不变。

**根因**:原 `main.ts` 运行时 `bun run src/server-entry.ts` 依赖两个前提——①用户机器装有 Bun;②磁盘存在整个 monorepo 源码(边车会再 `import ".../core/sync/server.ts"`)。打成 `.app`/`.exe`/AppImage 后两者皆不成立。

**方案**:把边车用 `bun build --compile` 编成**自包含二进制**(内嵌 Bun 运行时、`bun:sqlite`、core 服务端、WebUI bundle),由 `electron-builder` 作为 `extraResources` 打进安装包;`main.ts` 按 `app.isPackaged` 分流(§4)。数据目录仍用 `~/.metahub`(与 CLI 共享),不改。

### 8.1 关键缝隙:编译二进制如何服务 WebUI

`getJs()`(`src/core/sync/webui.ts`)原逻辑:优先读 sibling `dist/webui.js`,否则从源码 `Bun.build`。**在编译二进制里两条都失效**——`import.meta.url` 指向虚拟 `/$bunfs/...`(找不到 sibling 文件),且无源码可构建。这是连带发现的潜在缺陷(现有 `compile-binaries.ts` 产出的 CLI 二进制同样无法服务 WebUI)。

修复:在 `webui.ts` 加一个**领域中立**的注入缝隙:

```ts
export function setWebuiBundle(js: string): void { cachedJs = js; }
```

`server-bundle.ts` 在编译期 `import webuiBundle from "../../../dist/webui.js" with { type: "text" }`(Bun 的 import attribute,`--compile` 会把文本嵌进二进制),启动前 `setWebuiBundle(webuiBundle)`,首个 `/webui.js` 请求即命中缓存。开发态走 `server-entry.ts`(不 import bundle),仍是源码懒构建,因此开发**不需要**先 build。

### 8.2 边车交叉编译(`scripts/build-sidecars.ts`)

从仓库根 `bun build --compile` 全部 target(单机即可全产出),输出名对齐 electron-builder 的 `${arch}` 宏:

| bun target | 输出文件名 |
|---|---|
| `bun-darwin-arm64` | `metahub-sidecar-mac-arm64` |
| `bun-darwin-x64`   | `metahub-sidecar-mac-x64` |
| `bun-windows-x64`  | `metahub-sidecar-win-x64.exe` |
| `bun-windows-arm64`| `metahub-sidecar-win-arm64.exe`(需 Bun ≥ 1.3.10) |
| `bun-linux-x64`    | `metahub-sidecar-linux-x64` |
| `bun-linux-arm64`  | `metahub-sidecar-linux-arm64` |

入口为 `apps/desktop/src/server-bundle.ts`,故需先有 `dist/webui.js`(脚本检测缺失则先跑根 `bun run build`)。复用既有 `bun build --compile` 模式(`scripts/compile-binaries.ts`)。

### 8.3 打包配置(`electron-builder.yml`)

- `files: dist/** + assets/** + package.json`,`asar: true`——只把 Electron 外壳进 asar;WebUI 在边车二进制里、经 loopback HTTP 服务,**不**进 app 包。
- 各平台 `extraResources` 用 `${arch}` 选匹配的边车,`to` 统一成 `metahub-sidecar`(.exe),落在 `Contents/Resources/`(= `process.resourcesPath`),与 `main.ts` 查找一致。mac 两个架构各自打进对应二进制。
- `mac.identity: null`——ad-hoc 不签名/不公证(留好缝隙,后续接入只改 yml + 证书,无需改代码)。
- bun 编译出的二进制自带可执行位,electron-builder 在 mac/linux 保留。

### 8.4 应用图标(`scripts/gen-icon.ts`)

纯 TS + `node:zlib` 手写 PNG 编码器,2×2 超采样画一个圆角紫渐变方块 + 白「M」,输出单张 `build/icon.png`(1024²)。electron-builder 从这一张**自动派生** `.icns`/`.ico`/`.png`,无需 iconutil/ImageMagick。换真 logo 只需替换该文件(≥512²);托盘图标仍是 `assets/trayTemplate.png`。

### 8.5 跨平台构建注意

边车二进制可单机全交叉编译;**安装包**受工具链限制:macOS dmg/zip(含 x64)可在 Mac 直接产出;**Windows NSIS 从 macOS 需 wine**;**Linux deb 从 macOS 可能需 dpkg/fakeroot**(AppImage 通常可直接出)。不稳定时在对应 OS 或 CI 跑 `dist:win`/`dist:linux`——属工具链限制,非代码问题。

### 8.6 验证结论

- 独立边车二进制:打印 `METAHUB_PORT`、`/health` 返回 `{ok:true}`、`/webui.js` 返回与 `dist/webui.js` **逐字节一致**(内嵌 WebUI 生效)。
- 全平台边车全部交叉编译成功;`bun run dist:mac` 产出 arm64/x64 的 dmg+zip,各 `.app` 内 `metahub-sidecar` 架构正确(`${arch}` 路由)、`icon.icns` 已派生、asar + extraResource 落点正确。

### 8.7 暂不在范围

代码签名/公证、**外壳整体**自动更新(electron-updater 级别)。core 边车的更新已另行实现——启动静默暂存 + 设置页手动检查,详见 §9。顺带可复用 `setWebuiBundle` 缝隙修 CLI 编译二进制的 WebUI(后续项)。

## 9. 核心更新(自动暂存 + 手动检查)

桌面外壳与 core **独立发版**(`v*` / `desktop-v*`),外壳内嵌一份边车作离线兜底,但每次启动会去 GitHub Releases 查更新的 core 并按需下载,**永不热替换运行中的边车**——更新落到 `userData/core/` 缓存,下次启动由 `packagedSidecarPath()` 优先采用。本节在此机制上加用户可见的提醒与手动入口。**纯桌面能力,经 IPC 实现;core/CLI 与浏览器 WebUI 一行不改**(区块以 `window.metahubDesktop.coreUpdate` 桥存在与否门控,同 §7 快速笔记的桌面守卫)。

### 9.1 自动暂存(已有,`apps/desktop/src/core-updater.ts`)

`maybeUpdateCore()`:拉最新 core release(`v*`,排除 `desktop-v*`)→ 比 `version.json` 已暂存版本 → 下载对应平台边车、校验 SHA256(对 `SHA256SUMS-sidecars.txt`)→ 原子写入缓存 + `version.json`。全程吞错、绝不阻塞启动;`main.ts` 在窗口首帧后(**仅打包态**)后台触发一次。

### 9.2 「关于」页与三版本号状态机(`src/webui/settings.tsx` `AboutPage`)

版本事实与更新入口整体住在设置的**「关于」页**——`nav.ts` GROUPS 的第三个**无头分组**
(`{ key:"app", pages:[about] }`,cube 图标即产品标记);组头按 key 渲染
(device=设备名 / workspace=工作区 / app=无)。宽壳里关于行**钉在 rail 底部**
(`.set-rail-foot`:渲染在 `<nav>` 之外、`margin-top:auto` + sticky bottom,底 pad 在
sticky 盒内避免滚动到底时跳动;矮视口 `max-height:600px` 退回 static)——accent 滑块只
服务 nav 内的行,关于激活时滑块收起(`--mark-h:0`),行自身的 active 色承担指示;窄壳
索引里它是末尾的无头组。全局微指示不变:app 侧栏 `.sbf-ver` 的 `v<core>` 与设置入口
`.nav-dot` 红点保持原样,`updatePending` 时关于行/索引行的图标角上亮同一颗 `.nav-dot`
(红点轨迹:侧栏 → 关于行 → 更新行)。

页面结构:`about-hero` 产品身份块(44px cube 铭牌 + Metahub + mono 版本行——桌面
`App I · Core R`、浏览器/CLI 仅 `Core R`、PWA/桶壳 `Web WEBUI_VERSION` 兜底)→
「更新」SetSection(**仅桌面壳**,无桥整节不渲染)→「资源」SetSection
(GitHub 仓库 / 更新日志,`REPO_URL` 与 core-updater.ts `REPO` 同源,`window.open` 外开)。

由三个版本驱动:

- **R = 运行中**:边车 `/api/version`(= hero 里显示的 `Core` 版本)
- **I = 已暂存**:IPC `coreUpdate.installedVersion()` 读 `version.json`(下次启动会用的)
- **L = GitHub 最新**:IPC `coreUpdate.check()`(**仅手动触发**,不下载)

更新 SetRow(标题「软件更新」)按状态换 caption/control,SetRow 给了状态机应有的空间
——完整错误详情、全宽进度条:

| 状态 | 条件 | caption | control |
|---|---|---|---|
| idle | `I ≤ R` | 从 GitHub Releases 获取核心更新 | `检查更新` |
| checking | — | 正在检查… | 置灰 |
| downloading | — | 下载中 · N%(detail 区放全宽 `.ver-bar`) | 置灰 |
| available | `L > max(I,R)` | `●` 新版本 vL 可用 | accent `下载` |
| staged | `I > R` | `●` vI 已就绪,重启后生效 | accent `重启` |
| error | 失败 | **完整 errMsg**(danger 色) | `重试` |

桌面外壳同时给主窗/预览窗/快速笔记窗装了 `setWindowOpenHandler`:`http(s)` 外链一律
`shell.openExternal` 到系统浏览器、其余 deny——修掉 `target="_blank"` 弹无边框
Electron 子窗的旧问题(站点/分享链接一并受益)。

**关键**:`staged`(已下载待重启)**无需联网**即可判定——只比 `I > R`,因此 §9.1 的启动静默暂存会被自动 surface 成提醒。手动「检查更新」只负责发现 *更新于 I* 的版本;`download` 复用 `maybeUpdateCore()`,返回 null(已是最新/重复点击)则回退 staged/idle 并 toast,不报错。

### 9.3 IPC 桥与提醒位

- preload `window.metahubDesktop.coreUpdate`(`apps/desktop/src/preload.ts`):`installedVersion` / `check` / `download`(复用 `maybeUpdateCore()`)/ `restart`(`app.relaunch()` + `app.quit()`);`main.ts` `registerIpc()` 对应 4 个 `core:*` handler(`check` 用 `fetchLatestCoreRelease` + `tagToVersion`)。
- **侧边栏红点**:`app.tsx` 挂载时无联网比 `I > R` → 点亮 `sidebar.tsx` 设置入口的 `.nav-dot`;`VersionFooter` 进入 available/staged 时回调 `onUpdatePending` 同步点亮。浏览器/CLI 无桥 → 无红点、footer 仅 `Core x`。

### 9.4 涉及文件

- 桌面:`apps/desktop/src/{preload,main}.ts`(`coreUpdate` 桥 + `core:*` IPC + `routeExternalLinks` 外链外开);既有 `core-updater.ts` / `version-util.ts` 复用不改。
- 前端:`src/webui/settings/nav.ts`(`about` 页注册,第三无头分组)、`src/webui/settings.tsx`(`AboutPage` 状态机 + 组头按 key)、`src/webui/app.tsx`(共享 `updatePending` 值/回调 + 无联网探测)、`src/webui/sidebar.tsx`(设置入口红点)、`src/webui/desktop.d.ts`(桥类型声明)、`src/webui/styles.css`(`.about-*` 与 `.ver-num`/`.ver-dot`/`.ver-bar*`、rail/索引图标上的 `.nav-dot`)。

## 10. 主窗口窗框(macOS 无标题栏)

主窗口在 macOS 复用 §7.3 小窗同样的 `titleBarStyle:"hiddenInset"`——隐藏系统原生标题栏、保留内嵌交通灯、内容上移至顶端,呈现原生 app 观感;同时 app 版去掉侧栏左上角 logo。其它平台保持默认原生边框不变。**纯桌面外壳 + WebUI 样式,core 零改动**;以桌面守卫 `window.metahubDesktop` 门控(同 §7 快速笔记),浏览器版完全不受影响。

- **窗框(`apps/desktop/src/main.ts` `createWindow()`)**:mac 下 `titleBarStyle:"hiddenInset"` + `trafficLightPosition:{x:18,y:17}`(让交通灯在 ~49px 顶栏内垂直居中);非 mac 不传、保留原生边框。
- **桌面标记(`src/webui/app.tsx` 入口)**:存在 `window.metahubDesktop` 时给 `<body>` 加 `desktop`,平台为 `darwin` 再加 `desktop-mac`(渲染前置,首帧布局即正确)。
- **样式(`src/core/sync/webui.ts` 内联 CSS)**:
  - `body.desktop .brand{display:none}`——去掉侧栏左上角 logo;折叠按钮 `margin-left:auto` 仍贴侧栏右侧(位置与浏览器版一致)。
  - `body.desktop-mac` 把 `.sb-head` / `.topbar` 设 `-webkit-app-region:drag` 实现拖拽移窗,内部 `.iconbtn`/`.btn` 设 `no-drag` 保持可点。
  - 侧栏折叠时交通灯落在主区顶栏,`.sidebar.collapsed ~ .main .topbar` 加左留白给汉堡按钮让位。
- **涉及文件**:`apps/desktop/src/main.ts`(主窗 hiddenInset)、`src/webui/app.tsx`(body 标记)、`src/core/sync/webui.ts`(内联 CSS)。

## 11. 涉及文件

- 外壳(§1–6)新增:`apps/desktop/{package.json,tsconfig.json}`、`apps/desktop/src/{server-entry,main,preload}.ts`
- 快速笔记(§7)见 §7.5。
- 生产打包(§8)新增:`apps/desktop/src/{sidecar,server-bundle}.ts`、`apps/desktop/scripts/{build-sidecars,gen-icon}.ts`、`apps/desktop/electron-builder.yml`、`apps/desktop/{README.md,.gitignore}`;改 `apps/desktop/src/{server-entry,main}.ts`、`apps/desktop/package.json`(scripts + `electron-builder` devDep);**core 仅加领域中立缝隙** `setWebuiBundle()`(`src/core/sync/webui.ts`)。
- 核心更新(§9)见 §9.4。
- 依赖:`electron`、`electron-builder`(仅 `apps/desktop` 的 devDependency;不进 core/CLI 依赖图)。
- 改动总结:**外壳本身 core 零业务改动**(纯复用 + 一个通用注入缝隙);快速笔记(§7)在接口侧加了**领域中立**的文档树能力(`parent_id` 透传 + `?parent=` 过滤),核心更新(§9)纯走桌面 IPC,core/CLI 仍不含任何更新或 quicknote 概念。

## 12. 图片预览窗(独立原生窗 + popover vibrancy + 主题适配)(2026-06-19)

文档里双击图片,桌面 app 弹**独立无标题栏原生窗**预览(浏览器/PWA 则用页内浮层灯箱)。复用 §7 快速笔记的「IPC + 独立 BrowserWindow」成例;预览窗与主窗同源(`http://127.0.0.1:<port>/#preview?src=&name=&bid=`),共享 localStorage token 与 blob 字节,**自行**上传标注结果,经同源 `BroadcastChannel("mh-doc-image")` 把新 `/blob` URL 回传主窗替换该块(主窗 `DocView` 订阅、改 `blocksRef.current` 的 `src`)。媒体区块本体见 07-webui §19。

- **窗口(`main.ts` `openPreview`)**:复用单个 `previewWin`(已开则 `loadURL`+`focus`);mac 用 `titleBarStyle:"hiddenInset"` + `trafficLightPosition` + `vibrancy:"popover"` + `visualEffectState:"active"` + `backgroundColor:"#00000000"` → 半透明毛玻璃;非 mac 用 `frame:false` + 主题色不透明底(`nativeTheme.shouldUseDarkColors`)。
- **关键坑(mac 透明)**:曾用 `frame:false`(全无边框),mac 上无 `transparent:true` 时内容层是不透明背衬,会把 vibrancy **整个挡死**(切任何材质都不透明);改回 `hiddenInset`(同 §7/§10)保留 NSVisualEffectView 背衬才透出。此外 `html` 默认刷不透明 `var(--bg)`(iOS Safari chrome 取色用),预览窗须 `html:has(body.preview-window){background:transparent}` 把 root 改回透明,否则同样挡死(与 `body.quicknote` 同理)。
- **路由(`app.tsx`)**:`location.hash` 以 `#preview` 开头 → body 加 `preview-window`、只渲染 `ImagePreviewWindow`(复用共享 `ImageViewer`,不启 sidebar/replica)。
- **主题适配(`styles.css` `body.preview-window`)**:`popover` 材质跟随系统外观,故叠色用 `color-mix(in srgb, var(--bg) 42%, transparent)`、控件用 `var(--fg)` → 浅色=浅磨砂+深控件、深色=深玻璃+浅控件,不再恒深。页内浮层灯箱(`.lightbox` 非 `.preview-win`)保持白字深底不变。
- **涉及文件**:`apps/desktop/src/{main.ts,preload.ts}`(`preview.open` IPC + frameless/vibrancy 窗)、`src/webui/desktop.d.ts`、`src/webui/app.tsx`、`src/webui/media/{image-preview-window,image-lightbox}.tsx`、`src/webui/styles.css`。
