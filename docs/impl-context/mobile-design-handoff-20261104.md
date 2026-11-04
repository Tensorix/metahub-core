# Metahub 移动端现状与设计交接

更新时间：2026-11-04，Asia/Shanghai。用途：把这份文件交给其他 Agent，讨论移动端交互、视觉与用户体验，并据此形成可实现、可验收的改进方案。

Metahub 是面向人和 AI Agent 的本地优先数据与文档工作空间。移动端已经具备原生导航、结构化记录、文档编辑、本地离线副本及双同步路径。当前阶段是功能较完整、可靠性和体验验收尚未收口的开发版本。不能把“功能已实现”“单元测试通过”“历史模拟器流程通过”合并成“可稳定日用或可发布”的结论。

## 1 代码基线与本次整合

| 项目 | 状态 |
| --- | --- |
| 仓库 | Tensorix/metahub-core |
| 移动端 worktree | `/Users/noah/Work/Tensorix/metahub-core.feat-mobile` |
| 移动端分支 | `feat/mobile` |
| rebase 前 HEAD | `9e9d407` |
| rebase 后代码 HEAD | `51b600dde3cd2043e67f5cac34ca4454d32ef44e` |
| 本次基线 | 本地 `dev`，`10fbee8` |
| 已 fetch 的远端 dev | `origin/dev`，`2f00b4e`；本地 dev 额外包含 3 个已提交的官网改动 |
| 恢复分支 | `codex/mobile-before-dev-20261104`，指向 rebase 前 HEAD |
| 移动端独立提交 | 39 个，已全部重放到 dev 上 |
| 远端发布 | rebase 完成时远端仍是旧历史；后续按用户要求连同交接与编辑器生成文件提交并推送 |

唯一手工冲突位于 `src/core/sync/storage-s3-bun.ts`。保留移动端的 provider-safe 原子条件写：条件创建/覆盖转给共享 fetch 适配器；同时提供 `makeBunStorageClient = createBunStorageClient` 兼容导出，保留 dev 新测试依赖的入口。range-diff 显示其余 38 个移动端提交补丁一致。

本机 GPG 在非交互环境无法完成签名，本次重放使用单次 `commit.gpgsign=false` / `--no-gpg-sign`，没有修改全局 Git 配置。后续发布应知晓重放后的提交没有本次 GPG 签名。

主 worktree `/Users/noah/Work/Tensorix/metahub-core` 的未提交改动未动；移动端原有未跟踪 `.workbuddy/` 未动。本交接文件与重新生成的 `apps/mobile/src/lib/editor/editor-bundle.ts` 随后按用户要求一并提交。生成文件来自 `bun run build:editor`，吸收当前 dev 的共享编辑器/样式源码。

## 2 整个项目的产品与架构地图

### 产品对象

- 数据库是结构化记录的集合，字段承载文本、选择、日期、引用等数据；记录可以关联其他记录或文档。
- 文档是 Markdown 编辑与组织对象，支持层级、内部链接、历史与回滚；编辑器使用共享 CodeMirror 6 实现。
- 人通过 WebUI、桌面端、PWA 和移动端读写；Agent 通过 CLI、SDK、HTTP 接口操作同一套数据。
- SQLite 与 CRDT/oplog 是数据与多端收敛基础。附件字节内容寻址、按需获取，与结构化变更的同步分开处理。
- 同步支持用户自有 HTTP 服务，以及加密对象存储桶。连接、数据落盘、数据同步、附件传输是不同状态。
- 整体产品还有保存视图、公开分享、Sites、Edge、访客写入、审计、桌面快速看板与独立文档窗口等能力。不要由此推断移动端已具备这些能力的全部管理入口。

根包版本为 `0.5.8`；移动包为 `0.1.0`，二者独立。版本号不代表移动端已完成发布验收。

### 代码分层

| 路径 | 责任 |
| --- | --- |
| `src/core/` | 数据模型、命令、SQLite schema、CRDT、历史、搜索、同步、附件等共享核心 |
| `src/core/replica/` | 本地副本服务与查询/写入接口，供移动端等客户端复用 |
| `src/sdk/`、`src/cli/` | 外部程序接口与 Agent/终端入口 |
| `src/webui/` | WebUI、共享 CM6 编辑器与浏览器数据层 |
| `src/webui/mobile-editor/` | 移动端打包编辑器入口与原生宿主桥接 |
| `src/shared/views/` | 视图配置、筛选与排序等共享语义 |
| `apps/desktop/` | Electron 桌面壳、窗口和平台集成 |
| `apps/mobile/` | Expo / React Native 原生应用 |
| `docs/system-design/` | 全产品现状入口，细节仍需结合当前代码 |
| `docs/impl-context/mobile-*.md` | 移动端方案、阶段记录和验收边界 |

本次没有现成 graphify 图可供查询，架构结论直接核对源码、提交和验收记录；不要把交接理解成生成过依赖图或完成了全仓逐行审计。

## 3 移动端技术现状与约束

当前依赖声明：Expo `~57.0.31`、React Native `0.86.3`、React `19.2.3`、Expo Router `~57.0.29`、`@expo/ui ~57.0.26`。导航用 Expo Router；原生控件通过 SwiftUI / Compose，长数据列表使用 RN 虚拟列表和 FlashList。

移动端是本地优先客户端：`SessionProvider` 为工作区打开 `expo-sqlite` 数据库，通过共享 `createReplicaService` 提供页面使用的 `ReplicaClient`；凭据由 SecureStore 管理。会话管理隔离工作区切换后的旧回调和写入。HTTP 服务连接与加密桶直连共用本地副本能力。

正文编辑器是随包携带、无网络依赖的 WebView/CM6 shell。原生宿主负责持久化、附件、同步及退出协调，凭据不进入 WebView。记录输入采用原生 observable state 与 text bridge，不能按普通字符串受控输入直接重写；已有延迟 state echo 覆盖新输入的回归保护。

iOS 和 Android 当前都使用 NativeTabs。iOS 保留系统玻璃风格；Android 使用 Material 3，支持品牌色及 Material You 壁纸取色选项。主题偏好支持跟随系统、浅色、深色，并向原生导航和编辑器传递。

设计实现必须保留：

1. 输入先持久化再离开：返回、关闭、关联跳转、系统分享/选择器都涉及保存协调；失败时保留草稿并允许重试。
2. 本地已保存不等于已同步；数据同步完成也不等于附件已上传。
3. 切工作区不能串入旧请求、旧草稿和旧回执。断开连接会保留本地数据库与未同步内容。
4. 视图设置复用 `meta.views`；保留未知布局和配置。整份 views 的 LWW 语义需要在并发讨论中保留。
5. 手动记录排序要求无搜索、无筛选、无排序，跨页移动使用记录锚点；不能只对当前一页重建全局顺序。
6. 附件 pending/pinned/active 字节不能被普通清理删除；损坏的待上传附件需匹配哈希的原文件修复。
7. `ios/`、`android/` 是 CNG 生成物；原生行为改 `app.json` / config plugins。改 Expo/RN API 前读 SDK 57 文档和已安装类型。

## 4 当前页面和关键用户旅程

| 页面 | 已实现的交互 | 讨论重点 |
| --- | --- | --- |
| 首次连接 | 扫码、HTTP ServerForm、存储桶 BucketForm、邀请链接、短语/恢复码路径 | 同屏技术信息偏多；文案还说“连接服务器”，未准确涵盖存储桶。是否先呈现扫码和简短解释，再展开手工连接？ |
| 首页 | 最近访问、文档与数据库分区、新建文档/数据库、下拉同步；文档每页 60 项 | 快速捕获、继续上次工作、浏览库的优先级；分页层级文档能否被理解；工作区身份是否足够明确 |
| 搜索 | 本地文档/记录搜索、摘要、每页 60 条、上一页/下一页、查询变化重置 | 当前空查询界面几乎只有输入提示；结果缺少什么上下文；分页是否符合手机习惯；返回能否保持上下文 |
| 数据库 | 保存视图、搜索、筛选/排序、卡片列表、看板、新建记录、管理入口 | 表格语义在手机上如何映射；视图和管理的层级；横向看板、长标题、多字段信息密度 |
| 看板 | 按 select 分组，跨列移动、记录顺序和列顺序操作 | 当前不要求拖拽；是否保留显式菜单作为可达操作，并另外提供手势；跨页定位如何解释 |
| 记录详情 | 原生字段表单、引用标题、关联选择与打开分离、保存状态、历史/回滚 | 自动保存与关闭预期、字段密度、长文本/键盘、关联按钮视觉权重 |
| 文档 | 随包 CM6 编辑、关联导航、媒体、历史；创建/子文档/重命名/复制/移动/移至根/删除 | 阅读和编辑切换、工具栏可达性、中文 IME、选择与滚动、退出时保存反馈 |
| 数据库/视图管理 | 新建/编辑数据库、字段和选项配置与顺序、视图配置、保存/取消及离开保护 | 普通编辑和管理模式要区分；复杂表单返回/取消语义；错误保持现场 |
| 设置 | 本地保存/数据同步/附件传输、连接列表与凭据恢复、离线附件重试/修复/清理、主题 | 当前集中在长页，技术操作与日常状态混在一起；哪些状态需要移到内容页或首页 |

移动端对非 table/board 布局有降级提示；没有完整原生 calendar/timeline。现阶段范围不包含字段类型转换、数据库/字段/选项删除等完整管理能力。不能把 WebUI 四布局直接算成移动端四布局。

建议讨论先贯穿五条旅程：扫码接入并等待首次数据就绪；从首页/搜索找到内容并返回；记录输入未失焦直接打开关联文档再返回；离线编辑并重启，联网后双向收敛；添加附件后分享、取消分享并继续编辑。

## 5 视觉与交互观察

当前 iOS/共享 fallback 是白/暖灰底、低对比边框、蓝紫强调色，正文 16、UI 15、小字 13/12；Android 映射 Material 3 roles。布局同时包含原生表单/菜单/Sheet、RN 列表与 WebView 正文，需要对齐语义和反馈，但不必把两个系统做成像素完全一致。

本次查看了仓库里的两张历史脱敏截图：

- `mobile-evidence/20261102/android-fa82-search-light.png`：浅色搜索页顶部系统状态图标为白色，背景很浅，对比明显不足；记录也将其列为 OPEN。搜索初始页大面积空白，输入提示的可操作性和引导价值值得评审。
- `mobile-evidence/20261028/ios-fa82-record-light.png`：原生 Sheet、关闭/更多按钮、已保存提示、分组输入和关联操作清楚可见；关联的“打开”和“更改关联”都使用明显的蓝紫按钮。建议讨论主要动作层级、长标题换行与表单密度，不能凭单张截图判定触控尺寸或全局无障碍合格。

这些是旧构建截图，本次没有启动新 HEAD 的设备 UI；视觉判断不能冒充 rebase 后的原生验收。

## 6 实现与验收必须分开看

| 领域 | 已有证据 | 仍未关闭 |
| --- | --- | --- |
| 本地数据与同步 | 双端驱动/加密/重启及实际 HTTP 传输诊断；历史真实桶接入与下载 | 四组合工作流的完整固定候选验收：iOS/Android × HTTP/桶 |
| iOS 桶路径 | 2026-10-28 普通 Release：邀请/短语/初始化、记录未失焦跳文档、正文修改、在线杀进程重启、手机→桌面→手机往返、部分深浅色通过 | 该次未覆盖真正离线冷启动、新建记录/看板排序、新附件、中文 IME、手势及完整无障碍 |
| Android 最新恢复 | 2026-11-02 保留原数据启动、既有记录打开/关闭、原看板名、取消、浅/深色三 Tab 导航、恢复主题偏好通过 | 没有输入压力测试，没有证明 ANR 修复；状态栏对比仍 OPEN |
| 原生输入与退出 | 多轮快输入、未失焦退出、保存/取消、关联跳转、重启已有部分通过；有 text bridge/draft/guard 单测 | Android 历史输入 ANR 仍 FAIL；中文组合输入、长文本、手势/返回完整矩阵未关闭 |
| 媒体 | 历史双端部分选取、上传、重启、远端字节哈希、长时间系统分享取消后继续编辑通过 | 全离线、损坏/缺失、待上传修复、进程中断与权限矩阵未完成 |
| 搜索 | iOS/Android 已有 65 条跨页结果、末页与返回上下文的部分原生证据 | 大字体、读屏、键盘和多工作区矩阵仍需验证 |
| 性能 | 固定 Release 模拟器诊断完成 20,012 个 HTTP 操作；warm search p95：iOS 2.229ms，Android 2.608ms | 不等于交互端到端；JS timer gap 未达标，真机性能和可交互冷启动未测完 |
| 发布 | 可追踪构建脚本、CNG、原生 artifact manifest、CI、历史普通 Release 包 | 新 HEAD 未重建双端 Release；无商店发布验收；iOS 产物是模拟器包 |

Android 历史 ANR 包含 KeyEvent 等待 18,475ms。11 月 2 日的无输入导航没有出现新 ANR，只能证明该有限流程正常，不能消除旧失败。

固定 Release 性能记录中，Android 网络上传/初始化/服务 ingest 的 timer gaps 分别达到约 2261/896/3095ms；iOS service ingest 约 133ms，都涉及超过 100ms 的目标。模拟器调度和同步代码的因果尚未隔离，不能把根因直接归到某个控件或 SQLite。Activity 启动耗时、SQLite reopen 耗时都不是“首页可交互时间”。

产品应继续作为待验收版本推进。第一优先级是避免丢输入、卡死和错误的保存承诺；视觉方案可以同步讨论，但不能用视觉更新替代可靠性闭环。

## 7 建议交给设计 Agent 的讨论任务

以下是建议，尚未作为产品决策实施。

| 优先级 | 任务 | 期待输出 |
| --- | --- | --- |
| P0 | 输入、保存、返回与同步反馈统一 | 记录/文档/管理表单各自的状态图；正常、离线、失败、返回/手势、切后台、切工作区的行为；明确本地保存与同步文案 |
| P0 | Android ANR 与卡顿定位配合 | 按短输入/长输入/中文 IME/慢输入/快速输入/同步压力拆分复现；记录固定构建、日志和精确时间，设计不预设根因 |
| P1 | 首次连接渐进披露 | 扫码优先、手工连接二级、首次下载进度/失败恢复、连接成功后首次任务；保留 HTTP/桶能力 |
| P1 | 首页与搜索信息架构 | 给出“继续工作优先”和“快速捕获优先”两种方案，比较触达步数和信息密度；明确近期、文档、库与工作区的关系 |
| P1 | 记录/文档的移动阅读与编辑 | 按典型任务组织字段、关联、历史和媒体；长标题、空字段、大字体、键盘出现时的布局 |
| P1 | 设置与状态层级 | 日常状态与高级连接/附件维修分层；失败信息说明用户下一步，避免单一绿色同步完成掩盖附件失败 |
| P1 | 系统一致性与无障碍 | 修复 Android 状态栏对比；核对触达区域、读屏顺序、Dynamic Type/font scale、主题、减少动画、键盘和安全区 |
| P2 | 数据库和看板效率 | 视图切换、筛选、分组、排序入口，跨页手动顺序和禁用原因；保留显式移动控制的可达性 |

每个方案都请给出：目标用户和任务、现状问题及证据、至少一个完整前后流程、关键页面说明、加载/空/失败/离线状态、双平台差异、需要修改的代码范围、验收标准与取舍。先讨论方案，不默认执行大规模重写。

可直接转发给另一个 Agent 的任务说明：

> 请基于这份 Metahub 移动端交接，评审其信息架构、交互和用户体验。它已有原生 Expo SDK 57 UI、本地 SQLite 副本、HTTP/加密桶同步和随包 WebView/CM6 文档编辑器。请先区分现有能力、已验收范围、已知失败和设计假设；重点围绕首次连接、首页/搜索、记录与关联文档往返、保存/同步反馈、键盘和表单密度提出方案。保留原生平台习惯、离线能力与输入安全约束。输出优先级明确的改进清单、两种首页/导航方向、关键流程和状态说明、代码落点及可执行验收标准。Android ANR 未解决，历史模拟器证据不代表当前 HEAD 真机通过。无需重做同步协议或替换编辑器来完成视觉方案。

## 8 后续 Agent 的代码阅读顺序

所有路径相对移动端 worktree 根目录。

1. `apps/mobile/src/app/_layout.tsx`、`src/app/(tabs)/_layout.tsx`（后者位于 apps/mobile 内）：根导航、诊断与普通应用分流、三 Tab。
2. `apps/mobile/src/app/onboarding/index.tsx`、`onboarding/scan.tsx`、`connect.tsx`、`components/ServerForm.tsx`、`components/BucketForm.tsx`：接入流程。组件路径也位于 apps/mobile/src 下。
3. `apps/mobile/src/lib/auth/session.tsx`、`session-lifecycle.ts`、`credentials.ts`：会话与连接；`apps/mobile/src/lib/replica/open.ts`、`src/core/replica/service.ts`：本地数据语义。
4. `apps/mobile/src/app/(tabs)/(home)/index.tsx`、`(tabs)/search.tsx`、`db/[id].tsx`：浏览与查询；`apps/mobile/src/components/BoardView.tsx`、`RecordCard.tsx`：卡片/看板。
5. `apps/mobile/src/app/record/[id].tsx`、`components/RecordTextInput.tsx`、`components/RefField.tsx`、`lib/native-text-bridge.ts`、`lib/browse/text-draft.ts`、`lib/browse/form-exit-controller.ts`：输入与离开安全。
6. `apps/mobile/src/app/doc/[id].tsx`、`components/DocumentEditor.tsx`、`lib/editor/host.ts`、`lib/editor/native-presentation.ts`、`src/webui/mobile-editor/`：正文与宿主桥接。
7. `apps/mobile/src/app/manage/`、`components/DatabaseManageSheet.tsx`、`components/ViewSettingsSheet.tsx`、`components/RecordOrderSheet.tsx`：管理流程。
8. `apps/mobile/src/app/(tabs)/settings.tsx`、`lib/attachments/native.ts`、`lib/theme/`、`components/native/`：状态、附件、主题与原生封装。
9. `apps/mobile/e2e/ios/`、`e2e/android/`、`scripts/acceptance-fixture.ts` 与 `docs/impl-context/mobile-evidence/`：可复用验收流程和证据。

除显式根路径外，上述省略前缀的组件/lib 路径均指 apps/mobile/src 内同名位置。改动前先读根与移动端 `AGENTS.md`。

## 9 文档可信度与历史陷阱

- `apps/mobile/README.md` 严重滞后：仍称瘦在线客户端、不持有副本、从服务器加载编辑器、动态取色在规划中；都不能作为当前架构依据。
- `mobile-native-acceptance.md` 是多阶段累积记录，包含历史 iOS JS Tabs fallback。当前源码已经恢复 NativeTabs，后续 completion ledger 记录了原生 Tab 验证。
- 早期 unused i18n 翻译测试失败已在后续基线关闭，`mobile-builds.md` 记录 2026-10-28 的 1,978 pass / 3 skip；不要把早期失败机械带进当前待办。
- 原生证据的旧 commit hash 和 artifact hash 应保留。rebase 只改源码历史，不能把已安装 `fa82bf0` 包的验收重命名成新 HEAD 的验收。
- `mobile-native-completion-plan.md` 的 R00–R12 表适合阅读“实现 vs 验收”；其历史计划正文不是所有决策都仍然有效。
- 关键证据入口：`mobile-ios-fa82bf0-20261028.md`、`mobile-android-fa82bf0-20261102.md`、`mobile-release-diagnostics.md`、`mobile-builds.md`。
- 分享给其他 Agent 使用已脱敏材料；`apps/mobile/dist/acceptance/**/private` 及邀请/凭据文件不属于交接附件。

## 10 本次检查与后续复现

已完成：移动端及共享同步/副本/编辑器/SDK 相关回归 703 pass、3 skip、0 fail（87 文件，4,956 assertions）。3 项跳过是真实桶相关测试，本次没有使用真实服务凭据补跑。

移动端 `bun run typecheck`、`bun run lint`、`bun run build:editor` 通过；根 `bun run build:shell` 通过。lint 第一次因沙箱无法写 worktree 缓存失败，获准在该目录写缓存后重跑通过。

全仓 `bun test`：**2,009 pass、3 skip、0 fail**，214 文件、11,071 assertions；`git diff --check` 通过，确认 dev 是当前 HEAD 的祖先。日志保留于 `/tmp/metahub-mobile-rebase-tests-20261104.log`、`/tmp/metahub-mobile-full-tests-20261104.log` 和 `/tmp/metahub-mobile-shell-20261104.log`。

常用复现命令：

```sh
cd /Users/noah/Work/Tensorix/metahub-core.feat-mobile
bun install --frozen-lockfile
cd apps/mobile
bun install --frozen-lockfile
bun run build:editor
bun run typecheck
bun run lint
cd ../..
bun test
bun run build:shell
```

新的原生验收应在固定源码/锁文件上，用 `bun apps/mobile/scripts/native-build.ts ios` 或 `android` 创建普通 Release 候选，再记录 artifact hash、设备/OS 和具体场景。脚本会执行 CNG，宜用干净一次性 checkout，避免覆盖正在使用的原生工程。Android 包目前用模板开发签名，iOS 为 simulator 包；均不等于正式商店发行包。

验收最低矩阵：两平台 × HTTP/桶，覆盖连接/初始化、真正离线冷启动、搜索/浏览、记录与文档修改、看板、附件、杀进程恢复、双向桌面收敛、授权过期、主题/大字体/读屏/中文 IME。性能单独测可交互冷启动、端到端搜索和大 backlog 下的输入响应，不能用诊断 PASS 替代。
