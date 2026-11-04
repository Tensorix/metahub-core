# Metahub Mobile

Metahub 的原生移动端，使用 Expo SDK 58、React Native 0.88.1 和 React 19.3.0。当前依赖声明为 Expo 58.0.23、Expo Router 58.0.30、`@expo/ui` 58.0.27；具体安装版本以锁文件为准。

移动端持有按工作区隔离的 SQLite 本地副本，通过 HTTP 服务器或对象存储桶同步。文档/记录读写走本地 replica service；HTTP 工作区的实时事件触发同步，前后台生命周期管理同步活动。凭证和相关授权由 SecureStore 管理。

- iOS：SwiftUI 原生控件、原生导航与底栏；浏览页使用折叠大标题、下拉搜索、右侧新建菜单，底栏最右为系统 Search Tab。
- Android：Jetpack Compose / Material 3，顶部搜索与悬浮新建按钮；默认品牌种子配色，可在支持的设备上启用 Material You 动态取色。
- 编辑器：WebView 加载 Bun 打包的本地 CM6 编辑器，通过消息桥与原生副本交互，保留共享文档编辑能力。
- 首页：本机最近 Sites 和最近文档；资料库：原生分段控件切换文档/数据表；保留搜索、设置和既有管理页面。

本地副本支持处理已有的本地资料，但未下载资源仍受网络影响。Sites 当前打开已发布 HTTP(S) 地址，没有移动端离线 Site runtime；对象存储工作区的未发布 Site 会显示“尚无发布链接”。

## 开发

从仓库根目录安装共享依赖，再进入移动端安装应用依赖：

```sh
bun install
cd apps/mobile
bun install
bun run build:editor
bun run ios
# 或 Android
bun run android
```

原生模块需要 development build / 本机构建，不应把 Expo Go 作为完整运行环境。`ios/` 和 `android/` 是 CNG 生成目录，不提交；原生配置通过 `app.json` 与 config plugins 管理。

启动 Metro：

```sh
bun run start
```

`prestart` 会构建本地编辑器包；直接执行原生构建或修改共享编辑器后，可先显式执行 `bun run build:editor`。安装 Expo 依赖时使用 SDK 对齐的解析器：

```sh
bunx expo install <package> --bun
```

开发期可通过 `EXPO_PUBLIC_MH_URL` 和 `EXPO_PUBLIC_MH_TOKEN` 跳过连接引导，仅用于本地开发，不把真实凭证写入文档或提交。Android 模拟器会把 localhost / 127.0.0.1 转为 10.0.2.2；真机需要可达的服务器地址。正常使用通过应用内连接表单或二维码建立工作区，也可配置对象存储同步。

## 验证

在 `apps/mobile` 中执行：

```sh
bun run typecheck
bun run lint
bunx expo-doctor
```

从仓库根目录执行移动端测试：

```sh
bun test apps/mobile/src
```

当前重设计的构建和设备检查结果见 [交接记录](../../docs/impl-context/mobile-redesign-20261104.md)。文档中的设计提取不能替代原生设备交互、平板、大字体和无障碍验收。

## 结构

- `src/app/`：Expo Router 路由；`(tabs)/` 包含首页、资料库、设置和 iOS 搜索，其他页面涵盖文档、数据库、记录、Sites、管理与引导。
- `src/lib/replica/`：Expo SQLite 驱动和本地 replica service。
- `src/lib/sync/`：原生加密、压缩和对象存储传输适配；同步协议复用仓库核心模块。
- `src/lib/auth/`：工作区、连接配置、SecureStore 和会话生命周期。
- `src/lib/api/`：共享 SDK 类型/接口入口、HTTP 传输与实时事件。
- `src/lib/editor/`、`scripts/build-editor.ts`：WebView 消息协议、宿主与本地编辑器打包。
- `src/lib/attachments/`：原生附件存储与同步适配。
- `src/lib/navigation/`：最近访问记录、Site 数据与发布链接解析。
- `src/lib/theme/`、`src/components/native/`：共享语义颜色、Android Material 角色与平台原生控件。

Metro 通过 `watchFolders` 引用仓库共享源码；原生平台适配和本地 SQLite 驱动留在移动端。编辑器生成文件通过构建脚本更新，不手工修改。

产品边界见 [PRODUCT.md](PRODUCT.md)，视觉规则及来源见 [DESIGN.md](DESIGN.md)，可视化预览扩展见 [.impeccable/design.json](.impeccable/design.json)。
