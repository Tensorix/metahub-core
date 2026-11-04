# 移动端浏览体验与 Expo SDK 58 交接

日期：2026-11-04。工作分支：`feat/mobile`。本轮实现、验证和功能边界记录如下。

## 用户确认的方向

依据 Metahub 文档 `doc_doc-l7nlls`（《移动端布局设计》）：首页只放最近使用的 Sites 和最近文档；Sites 使用圆形图标、下方名称，最后一个入口是“更多”。资料库以原生分段控件切换文档和数据表。保留设置。

iOS 使用原生导航大标题，随内容滚动折叠，导航栏保留系统透明与滚动边缘效果；下拉可见搜索；底栏最右为系统 Search Tab，不能用普通 Tab 模拟。右上角“新建”菜单提供文档/数据表。Android 使用 Material 3，顶部搜索栏和悬浮新建按钮。

## 本轮实现

- 首页从全量资料列表改为本机最近访问：最多 5 个 Site、12 篇文档；过滤已删除内容；没有历史时提供资料库入口。
- 资料库采用 SwiftUI segmented Picker / Compose SingleChoiceSegmentedButtonRow；文档支持树形缩进、查询、60 条分页，数据表进入既有数据库页。
- iOS 的首页、资料库、搜索分别嵌套原生 Stack。`BrowseStack` 配置透明大标题，滚动容器直接处于屏幕根层，`contentInsetAdjustmentBehavior="automatic"`。搜索使用 `NativeTabs.Trigger role="search"` 和嵌套 `Stack.SearchBar`，保留系统自动激活行为。
- 搜索逻辑抽成 `SearchResults`，保留防抖、分页、实时失效、文档/记录跳转。Android 顶部原生搜索提交至 `/find`。
- 复用编辑器、记录详情、管理表单、工作区和同步能力；本轮没有修改用户的云端设计文档或创建演示内容。

关键代码在 `apps/mobile/src/app/(tabs)/`、`src/components/Browse*.tsx`、`SearchResults.tsx`、`SearchScreen.tsx` 和 `src/lib/navigation/`。

## Sites 的真实边界

手机尚未实现本地 Site runtime。本轮从同步数据库读取站点与公开发布渠道，只打开合法 HTTP(S) 发布地址；HTTP 工作区可使用服务器的公开 Site 地址。对象存储工作区中未发布的站点会显示“尚无发布链接”，不能离线运行。不会把工作区凭据转发到站点地址。

最近使用目前是设备本地历史，非跨设备统计。站点图标使用已同步的内联 PNG；不可用时显示首字。不要向用户宣称已完成离线 Sites。

## Expo 升级

从 SDK 57 升至当前稳定 SDK 58：Expo 58.0.23、Expo Router 58.0.30、@expo/ui 58.0.27、React Native 0.88.1、React 19.3.0。依赖使用 `expo install --fix --bun` 对齐，锁文件一并更新。

迁移包括：稳定的 `expo-router/native-tabs` 导入；导航拦截采用公开的 `usePreventRemove` repeat 回调；文件读取适配异步 FileHandle.readBytes；WebView 与 FlatList 类型适配；导航主题统一；Scene 支持改用 SDK 默认行为。iOS 是 CNG 重新生成，不手改或提交生成目录。

官方技能已安装到本机 Codex skills：expo-overview、expo-router、expo-native-ui、expo-ui、expo-upgrade，来自 `expo/skills`。

参考：
- https://docs.expo.dev/router/advanced/native-tabs/
- https://docs.expo.dev/router/advanced/stack/
- https://expo.dev/changelog/sdk-58

## 验证

- 移动端 TypeScript、lint 通过。
- `bun test apps/mobile/src`：214 通过，0 失败（28 个文件）。
- Expo Doctor：20/20 通过。
- Android 生产 JS 导出通过；没有 Android 模拟器交互证据。
- iOS SDK 58 Release 原生构建通过：0 errors、2 条依赖工具链 warning。已覆盖安装至现有 iPhone 18 Pro / iOS 27.0 模拟器，保留工作区。
- 原生交互已验证：首页最近文档、资料库大标题滚动折叠与透明模糊、独立系统 Search Tab、实际搜索结果和文档打开/离开，设置页同步完成。
- 资料库深色 + accessibility-extra-large 字体截图检查通过；验证后恢复 light / large。
- SDK 58 文档与记录详情离开拦截额外迁移到 repeat()，修复旧 dispatch(action) 被重复拦截的问题。文档保存与表单退出定向测试追加 15/15 通过，最终 typecheck/lint 通过。
- 独立设计复核：ship，仅覆盖已捕获的 iPhone 浏览体验；Android、iPad、真机行为不在该结论范围。设置页保持既有结构，暂无大标题，是后续一致性优化项。
- 截图位于 apps/mobile/.impeccable/review/：home-ios.png、library-ios.png、library-scrolled-ios.png、search-ios.png、settings-ios.png、library-dark-large-ios.png。截图包含真实工作区内容，作为本机验收证据；共享前自行决定范围。

## 后续讨论重点

1. 是否需要真正的手机离线 Site runtime，以及对应可信代码、资源和权限模型。
2. 最近访问是否跨设备同步；首页是否增加固定/收藏。
3. 资料库树状导航与大库分页的产品选择。
4. Android 原生交互、平板布局、大字体与 VoiceOver 的完整验收。

另有先前同步超时修复见 `mobile-sync-timeout-20261104.md`；本轮没有实现快照 GC。并行工作中的 retention 设计文档不属于本轮 UI 改动。
