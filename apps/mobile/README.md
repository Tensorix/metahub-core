# Metahub Mobile

Metahub 的原生移动端（Expo SDK 57 / React Native）。定位为**瘦在线客户端（window）**：
纯 HTTP 连接你自己的 metahub 服务器，不持有本地副本。

- iOS：SwiftUI（@expo/ui）+ iOS 26 Liquid Glass（NativeTabs / glassEffect / GlassView，运行时可用性检查，iOS<26 实色回退）
- Android：Jetpack Compose（@expo/ui）+ Material 3（动态取色规划中）
- 文档编辑：WebView 复用服务器的移动版 CM6 块编辑器（块级 CRDT 同步保真）
- 实时：`/api/changes` SSE（`expo/fetch` 流式读取，后台断流、前台带游标追赶）

## 开发

```sh
bun install
npx expo run:ios        # 首次构建原生工程（CNG，ios/ 不入库）
npx expo run:android
```

开发期跳过 onboarding（可选）：

```sh
EXPO_PUBLIC_MH_URL=http://127.0.0.1:5199 EXPO_PUBLIC_MH_TOKEN=<token> npx expo start
```

（Android 模拟器自动把 127.0.0.1 映射为 10.0.2.2。）

服务器侧：`mh --server --host 0.0.0.0 --token <token>`（真机需局域网可达）。

## 结构

- `src/app/` — expo-router 路由（`(tabs)/` 首页/搜索/设置、`db/[id]`、`record/[id]`、`doc/[id]`、`onboarding/`）
- `src/lib/api/` — `sdk.ts`（唯一出根导入点，复用仓库 `src/sdk/client.ts`）、`mobile-api.ts`（Bearer + 401 续期）、`live.ts`（SSE）
- `src/lib/auth/` — SecureStore 凭证 + 会话
- `src/lib/theme/` — WebUI 设计 token（浅/深）
- Metro 通过 `watchFolders` 引用仓库 `src/`；共享代码仅限同构模块与 `import type`。

## 约定

- 包管理一律 `npx expo install`（解析 SDK 兼容版本）
- `ios/`/`android/` 为 CNG 生成物，不入 git，原生配置走 `app.json` + config plugins
- 提交前：`npx tsc --noEmit` + `npx expo lint`
