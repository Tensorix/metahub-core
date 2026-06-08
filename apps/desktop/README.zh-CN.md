# Metahub Desktop

[English](./README.md) · 简体中文 · [主项目 README](../../README.zh-CN.md)

[metahub](../../README.zh-CN.md) 的桌面 App：在 core 同步服务端之上提供 notion 风格的图形界面，外加一个 **Quick Notes** 浮窗（全局快捷键 / 托盘唤起，可悬浮在任意 Space 的全屏应用之上）。

底层是一个 Electron 外壳；窗口加载由 Bun **边车（sidecar）** 在回环 HTTP 上提供的 WebUI。

- **dev**：边车从源码运行（`bun run src/server-entry.ts`，WebUI 懒构建），需要 PATH 上有 Bun。
- **prod**：边车是一个自包含的 `bun build --compile` 二进制，内嵌 Bun 运行时、`bun:sqlite`、core 服务端和预构建的 WebUI bundle。打包后的 App **既不需要 PATH 上的 Bun，也不需要任何源码树**。

数据存在 `~/.metahub`（与 `mh` CLI 共享），可用 `METAHUB_HOME` 覆盖。

## 安装（Homebrew）

```sh
brew install --cask tensorix/tap/metahub-app
```

未签名（开源）。经 Homebrew 安装的 App 不会被浏览器隔离；若 Gatekeeper 仍拦截，加 `--no-quarantine`。CLI 是单独的 formula：`brew install tensorix/tap/metahub-cli`。两者都由 CI 在每次发布时保持最新（见 `apps/desktop/scripts/gen-cask.ts`、`scripts/gen-formula.ts` 与 `update-tap` job）。Tap 仓库：<https://github.com/Tensorix/homebrew-tap>。

## 开发

```sh
bun install
bun run dev        # 构建 main/preload、启动 Electron、从源码 spawn 边车
```

## 构建产物

```sh
bun run build      # build:main + build:icon + build:sidecars
bun run dist:mac   # → release/*.dmg, *.zip（arm64 + x64）
bun run dist:win   # → release/*.exe（NSIS）
bun run dist:linux # → release/*.AppImage, *.deb
bun run dist       # 当前平台
```

`build:sidecars` 把四个边车二进制交叉编译进 `resources/`（命名匹配 electron-builder 的 `${arch}` 宏）。若缺 `dist/webui.js` 会先跑根目录的 `bun run build`。

`build:icon` 写出 `build/icon.png`（1024×1024 占位图）。electron-builder 据此派生 `.icns` / `.ico` / `.png`——换成真实 logo 即可改品牌。托盘图标仍为 `assets/trayTemplate.png`。

## 跨平台说明

`bun build --compile` 可在单一主机交叉编译全部边车二进制。安装包制作则更受限：

- **macOS** dmg/zip（含 x64）可直接在 Mac 上构建。目前未签名 / ad-hoc（`electron-builder.yml` 里 `identity: null`）——之后要签名/公证，在那里设 identity + entitlements 即可，无需改代码。
- **Windows** 从 macOS 构建 NSIS 需要 **wine**。没有的话，在 Windows 或 CI 上跑 `dist:win`。
- **Linux** 从 macOS 构建 `.deb` 可能需要 `dpkg`/`fakeroot`（AppImage 通常没问题）。不稳定时在 Linux 或 CI 上跑 `dist:linux`。

## Core 自动更新

App 与 `core`（CLI + 同步服务端）**独立发布**。打包后的 App 内嵌一个边车作离线兜底，但每次启动都会检查 core 的 GitHub Releases 是否有更新的边车，下载到 `<userData>/core/`，在**下次**启动时生效（绝不热替换正在运行的那个）。见 `src/core-updater.ts`。这让 core 能高频发布，而无需重打包（慢、三系统的）Electron App。

- 渠道：GitHub Releases（`v*` tag），对 `SHA256SUMS-sidecars.txt` 校验。
- 未签名安全：以程序方式下载的二进制不会被 macOS 隔离；我们仍防御性地剥除该属性。
- `resolveSidecarCommand()` 优先用缓存的二进制而非内嵌的。设置页页脚显示 **App**（外壳）与 **Core**（运行中的边车，经 `/api/version`）两个版本。

## 发布

版本相互独立。改版本号、在 `main` 上提交，然后推 tag：

```sh
# 桌面外壳（三系统安装包 → release-desktop.yml）
#   改 apps/desktop/package.json，提交，然后：
cd apps/desktop && bun run release      # 打 desktop-v<version>

# core（CLI + 边车二进制 → release.yml；也是自动更新源）
#   改根 package.json，提交，然后：
bun run release                          # 打 v<version>
```

暂不在范围内：代码签名/公证（按设计未签名/ad-hoc）。

## 许可证

[AGPL-3.0-only](../../LICENSE)。
