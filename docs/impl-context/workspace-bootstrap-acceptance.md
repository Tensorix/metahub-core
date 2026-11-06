# 工作区首次接入验收记录

日期：2026-11-06。实现提交：`e09d775`；本轮补充修复、测试及本文一并作为后续提交。测试针对验收时的工作树，包含开始验收前已有的其他未提交改动，不能视作纯净的发布构建验收。所有数据均为本地临时测试数据，没有连接生产桶或修改其权限。

## 环境与结果

| 范围 | 环境 | 结果及边界 |
| --- | --- | --- |
| Core、CLI、SDK 自动化 | macOS 27.2 arm64，Bun 1.3.14，SQLite | 1000 通过、3 跳过、0 失败；115 个文件。使用 `--timeout 15000` 完整确认。 |
| WebUI、移动端自动化 | 同上，Bun 测试环境 | 合计 1001 通过、0 失败；108 个文件。包括 WebUI 766 项和移动端 235 项；这不是浏览器或原生运行测试。 |
| 类型检查 | Bun 执行仓库 TypeScript | Core `tsconfig.sync.json`、WebUI、移动端、补充 CLI/Electron 验收脚本均通过。 |
| 移动端 lint | Expo 58.0.23 CLI，由 Bun 执行 | 通过。 |
| CLI 真实进程 | macOS arm64，Bun；临时独立数据目录；本地 HTTP/S3 fixture | HTTP 全新、旧版空库、配对凭据；桶全新、旧版空库；独立设备身份、安装内容、编辑上传、进程重开均通过。错误令牌不切换副本；v1 HTTP 保持兼容。 |
| Electron 真实应用 | macOS arm64，Electron 33.4.11；重建主进程；Bun 开发 sidecar | HTTP/桶首次接入自动 IPC 各执行一次、无升级确认、sidecar 停止及重启、内容显示、应用重启后不重复切换，均通过。 |
| Electron 旧副本恢复 | 同上，隔离应用 profile 和测试桶 | 编辑器拒绝保全、附件校验失败保留原副本、成功切换、草稿恢复、历史读取、重启持久化，以及下载中杀进程保留原副本，均通过。 |
| Chromium PWA 运行 | macOS，Chromium 133.0.6943.16，headless，真实 OPFS/SQLite WASM | 现有 v2 桶首次接入、两个标签页协调、两页内容一致、v2 编辑上传、页面重开、零升级对话框，均通过。运行实际 worker/宿主协调代码，使用测试页面和合成桶。 |
| iOS 原生运行（部分验收） | 专用 iPhone 17 Pro 模拟器，iOS 27.0；本机 Xcode/iOS 27.2 SDK；Debug；Expo 58、RN 0.88.1、Hermes、Metro | 原生构建通过。手动连接本地 HTTP 服务后定位并修复运行问题；清除测试 App 数据、保留系统 Keychain 测试凭据后，从空库恢复会话自动接入 v2 成功。原生资料库和文档正文显示正确，无升级确认；独立设备实例、HTTP 基线/游标正确。完全重启后数据库和 incarnation 不变、恢复事项为 0，界面显示同步完成且可离线编辑。 |

真实 CLI/Electron 桶测试使用 localhost 上实现条件 PUT 的合成 S3 服务。仅在测试 preload 中为该 fixture 声明条件创建能力；使用实际 Bun/SigV4 传输。此结果不证明某个真实云服务支持条件创建或已配置正确 CORS。

Core 包含空桶直接建立 v2 且不写 v1、非空副本拒绝自动替换、403/未知状态/缺失 root、HTTP 鉴权和配对、原始快照摘要、下载并发编辑、代际变化不激活影子副本，以及 HTTP 基线不能替代桶覆盖证明等检查。具体覆盖见 `src/core/sync/workspace-access.test.ts`、`http-bootstrap.test.ts` 和 `http-bootstrap-cursor.test.ts`。

## 本轮发现并修复

1. 原生影子数据库不复制 SecureStore 中的连接，HTTP 游标的 UPDATE 会更新零行，首个增量请求从 0 开始。改为 UPSERT；新增回归测试先复现失败，再确认从快照游标续传并接收下载期间的编辑。
2. 共享核心动态 import 在原生 Metro 开发包中错误地相对于移动端目录解析。改为已有模块的静态导入，覆盖 HTTP 检查和桶初始化竞争路径。真实 iOS 重新打包后验证 HTTP 路径。
3. 宿主 resume 会关闭源数据库，但外层随后仍写初始化标记，产生“Access to closed resource”。源库状态和错误记录现在在交还宿主前收尾。新增成功和下载失败时由宿主关闭源库的回归测试。
4. 首次登录时，Protected 移除 onboarding 后可能留下 public connect 页及其过期工作区 wrapper，导致空白。完成首次连接时统一重置历史，保留首次 hydration 的深链；会话导航测试通过。修复后的首次登录输入界面流程尚未完整重跑，空库会话恢复路径已在 iOS 运行通过。
5. 更新既有 Electron 验收脚本，匹配当前的一次升级确认和持久恢复结果，避免依赖短暂 toast。

完整 Core 默认 5 秒超时的一轮中，既有 `drop-wire` 测试调用外部 Turnstile 服务超时；单独重跑 9 项通过，再以 15 秒单项超时完整重跑，结果为 1000/3/0。未为此修改产品代码或测试逻辑。

## 尚未完成的验收

- 生产 S3/R2、真实权限/CORS/条件创建、真实网络断连和代理环境。3 个 live-storage 测试因没有真实桶配置而跳过，分别为双设备收敛、CORS、密钥封装。
- iOS 存储桶首次接入、触屏编辑后的上传、连接表单首次登录修复的完整重跑、安装中断/系统杀进程、系统密码弹层全自动化。系统“保存密码？”由用户手动点“以后”后继续。
- Android 模拟器、Android/iOS 物理设备、移动端 release/商店构建。
- Chromium 中 HTTP 首次接入、PWA 安装启动和完整 Service Worker 离线/缓存升级；本轮浏览器测试覆盖桶 worker 和多标签页。
- Windows/Linux Electron、打包签名后的应用、CLI 编译后的发布二进制。当前 CLI 测试执行 TypeScript 入口，Electron 使用开发 sidecar。
- 各宿主全部故障矩阵的逐项运行验收：不能将核心单元测试等同于所有宿主的完整端到端覆盖。
- HTTP 服务端能力发布、新客户端发布与生产灰度。没有推送提交或部署。

## 复跑命令

```sh
bun test --timeout 15000 src/core src/cli src/sdk
bun test src/webui apps/mobile
bun node_modules/typescript/bin/tsc -p tsconfig.sync.json --pretty false
bun node_modules/typescript/bin/tsc -p src/webui/tsconfig.json --pretty false
# 在 apps/mobile 目录运行：
bun ../../node_modules/typescript/bin/tsc --noEmit --pretty false
bun --bun node_modules/expo/bin/cli lint
# 在 apps/desktop 目录运行：
bun run build:main
# 仓库根目录；MH_ELECTRON 指向本机 Electron 可执行文件：
MH_ELECTRON=/path/to/Electron bun scripts/workspace-bootstrap-native-acceptance.ts
MH_ELECTRON=/path/to/Electron bun scripts/rebuild-desktop-acceptance.ts
MH_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs MH_CHROME=/path/to/Chromium bun scripts/workspace-bootstrap-browser-acceptance.ts
```

## 本机证据

日志保存于 `/private/tmp/mh-bootstrap-final-*`：`core-confirmed.log`、`consumers.log`、`native.log`、`electron-rebuild.log`、`browser.log`、`ios-build.log`、`ios-db.json`、`ios-restart.json`。iOS 截图为 `ios-document.png` 和 `ios-restart.png`（相同前缀）。临时目录不作为持久 CI 工件。

- 最终 CLI/Electron JSON、命令输出和截图：`/var/folders/jh/899d_ywd5b769hnj3jvwkzy40000gn/T/mh-bootstrap-native-3kv63G`
- 最终 Chromium 截图：`/var/folders/jh/899d_ywd5b769hnj3jvwkzy40000gn/T/mh-bootstrap-chromium-aIPGtS`
- iOS 专用模拟器：`461C9648-8212-45F0-9AB0-0A02803331AB`，仅操作本次隔离测试数据；未操作其他模拟器或用户手机。
