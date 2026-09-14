# 桌面小窗泛化与「打开方式」文件编辑器(0.5.0)

承接 [12-desktop-app](../12-desktop-app/design.md) §7(快速笔记),把「小窗」从一个特例变成一类,并让 Metahub 成为 `.md`/`.txt` 的可选打开方式。

## 1. MiniWindow:小窗外壳泛化

快速笔记那套外壳(全局快捷键 / 托盘唤起 / 可置顶 / mac 半透明 / 本地 JSON 记住位置与尺寸 / `qn:*` IPC)原本与「笔记」硬绑。现在抽成 `MiniWindow` 类,由一份 spec 描述:

```text
{ title, hash, ipcPrefix, defaultShortcut, settingsFile, defaultSize, minSize }
```

两个实例:

| 小窗 | hash | IPC 前缀 | 设置文件 |
| --- | --- | --- | --- |
| 快速笔记 | `#quick` | `qn` | `quicknote-settings.json` |
| 快速看板 | `#board` | `qb` | `quickboard-settings.json` |

笔记沿用原来的 `quicknote-settings.json`,**存量安装不需要迁移**。

### 1.1 快速看板(`#board`)

- 复用同一份 WebUI bundle 与既有的 `BoardView`,渲染**一个数据库**的看板。
- 看哪个库、按哪列分组是**本机选择**(localStorage),core 与服务器对此一无所知——和「core 不含 quicknote 概念」同一条原则。
- 存在意义是**实时**:接 [28-live-change-feed](../28-live-change-feed/design.md),agent 跑 `mh record update` 时卡片自己会动;`LIVE_STATUS_EVENT` 渲染成一颗呼吸的 live 点,推送到达时卡片闪一下。
- 视觉全部挂在 `body.quickboard` 下(无边框分栏 + 玻璃卡片 + Notion 式切库 chip),不影响主窗口。
- 「在主应用中打开」按钮走 `#/db/<id>?view=` 深链;主窗口冷启动时直接在该 hash 上创建。
- macOS 置顶用 **floating 层级**,否则系统输入法候选框会被小窗盖住。

## 2. 文件编辑器窗(`.md` / `.txt` 打开方式)

`electron-builder.yml` 的 `fileAssociations` 把 Metahub 注册成 `md`/`markdown`/`txt` 的 **Alternate** 编辑器(不抢默认)。双击打开的文件得到一个独立窗口:一个 CM6 编辑器直接编辑**磁盘上的文件**——没有文档记录,没有服务器持久化,`⌘S` 写回磁盘。

- **文件 I/O 留在主进程**:`file:read` / `file:read-sync` / `file:write` IPC,并且**只接受本进程自己打开过的路径**(文件关联 / argv / `open-file` 进入的集合)。渲染进程无法借这座桥读任意文件。
- **不启用粘贴上传**(`CmDocBody disableUploads`):这里没有 hub 可存 blob。
- 「导入到 MetaHub」把当前文本快照成一篇新文档(普通 `api.createDocument`),再经 `BroadcastChannel("mh-open-doc")` 让主窗口深链过去——跨过 `file://` → `http://` 的源边界。
- 文件关联启动**只开文件编辑器窗**,主窗口保持惰性。
- 单实例锁:第二次启动把路径转交给已在运行的实例。

### 2.1 秒开:磁盘加载的独立壳

`apps/desktop/scripts/build-file-editor.ts` 另出一份 `dist/file-editor.{html,js,css}`,由 `win.loadFile` 加载——**不经边车**。于是打开一个 `.md` 与「服务器是否已经起来」彻底解耦:

- preload 收到 `--mh-open-file=<path>`,经允许列表内的**同步** IPC 先把文本读出来,所以**第一帧就已经画着正文**,没有 splash、没有 spinner。
- bundle 只含编辑器子树(约为完整 `webui.js` 的一半多)。
- 依赖服务器的能力(导入到 MetaHub、`[[doclink]]` 标题、代码格式化)在边车报告健康后经 `setApiBase` **惰性挂上**,挂上之前优雅降级。
- 主题:`file://` 与边车不共享 localStorage,所以由主进程把解析好的 `?theme=` 传进来,系统偏好兜底(防白闪)。
- 打包缺这份产物时自动回退到边车提供的 `#file` 路由。

### 2.2 启动性能配套

- 文本资源一律 `ETag` + `cache-control: no-cache`:每次加载都重新校验(更新不需要硬刷新),未变则 304。
- 代码格式化 wasm 引擎保持按需加载,永不进主 bundle。
- 小窗**预热**只跟随主窗口首帧,不跟随文件编辑器窗——否则「双击一个 md」会顺手拖起一堆无关窗口。
- **开发运行使用独立 userData 目录**:常驻的正式版应用与 dev 实例共享同一 profile 时,跨进程缓存锁恢复会让每次首个 JS 加载卡约 4 秒。
- 每窗口打点 `created → did-start-loading → dom-ready → did-finish-load → ready-to-show`,冷启动预算靠它保持诚实。
- 实测**否决**的两条:V8 bytecode 缓存、以及为迁移加的启动门控——收益不抵复杂度。

## 3. 涉及文件

`apps/desktop/src/main.ts`(`MiniWindow`、文件窗、允许列表、单实例、perf 打点)、`apps/desktop/src/preload.ts`(`file` / `server` 桥、同步初读)、`apps/desktop/scripts/build-file-editor.ts`、`apps/desktop/electron-builder.yml`(`fileAssociations`)。

WebUI:`src/webui/quickboard/quickboard.tsx`、`src/webui/fileviewer/{file-editor,standalone}.tsx`、`src/webui/app.tsx`(`#preview` / `#file` / `#quick` / `#board` 分派)、`src/webui/cm6/CmDocBody.tsx`(`disableUploads`)、`src/webui/server/assets.ts`(ETag/304)。
