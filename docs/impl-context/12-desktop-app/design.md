# 桌面端(Bun + Electron)设计文档

承接 [07-webui/design.md](../07-webui/design.md)(Preact WebUI,由 `startServer()` 在 `/` 提供)与 [11-device-pairing-sync/design.md](../11-device-pairing-sync/design.md)(`startServer()` 内嵌同步服务 + 自动同步)。

本文记录在 `apps/desktop` 下用 **Bun + Electron** 构建桌面端。**核心原则:复用既有 core/WebUI,不重复实现任何功能核心**——桌面端只是一层外壳。

**关键定位**:桌面端不引入新的业务逻辑,它把现有的「`mh --server` 起服务 + 浏览器开 WebUI」两步打包进一个原生窗口。core 一行不改。

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
- **`src/preload.ts`**:最小 `contextBridge.exposeInMainWorld("metahubDesktop", { platform, versions })`。WebUI 通过 HTTP 直连边车,不依赖 IPC,故 preload 轻量。

## 5. 构建与运行

**关键点**:Electron 主进程是 Node 运行时,**不能直接加载 `.ts`**,且 `electron` API 只在 Electron 进程内由 `require("electron")` 提供。因此:

- `main.ts`/`preload.ts` 用 `bun build --target=node --format=cjs --external electron` 编译到 `dist/`(`--format=cjs` 让 `__dirname` 与 `require("electron")` 正常工作;**`--external electron` 必须有**,否则 bun 会把 `electron` npm 包的「可执行文件路径字符串」打进 bundle,运行时 `app` 为 `undefined`)。
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

## 7. 生产打包 —— 暂未实现(仅记录方向)

当前交付范围:本地 `bun run dev` 可运行(从终端启动时 PATH 含 bun)。

后续要做免装 Bun 的可分发安装包:用 `bun build --compile`(参考 `scripts/compile-binaries.ts`)把 `server-entry.ts` 产出独立二进制,放进 `process.resourcesPath`;再用 `electron-builder` 打 `.dmg`/`.exe`,把边车二进制放进 `extraResources`。GUI 双击启动时 PATH 精简,届时主进程改为优先用打包的二进制(或用户设 `BUN_PATH`)。

## 8. 涉及文件

- 新增:`apps/desktop/{package.json,tsconfig.json}`、`apps/desktop/src/{server-entry,main,preload}.ts`
- 依赖:`electron`(仅 `apps/desktop` 的 devDependency;不进 core/CLI 依赖图)
- 改动:**core 零改动**(纯复用)
