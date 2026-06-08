# 贡献指南

面向 metahub core 仓库的开发者。架构、数据模型与能力清单见 [docs/system-design/](./docs/system-design/)；用户向的介绍见 [README.md](./README.md)。

本仓库默认用 [Bun](https://bun.sh)（`bun:sqlite` / `Bun.serve`），不用 Node.js / npm / vite。

## 本地开发

```bash
bun install
bun run dev init                  # 热重载运行 CLI（= bun --hot src/cli/index.ts）
bun test                          # 跑测试（含 CRDT 收敛测试）
bun run build                     # 产出 dist/（库 + CLI + 类型声明）
bun run build:binaries            # 产出 binaries/ 五平台二进制
```

用 `METAHUB_HOME` 环境变量覆盖数据目录，便于多实例 / 测试隔离。

## 作为库使用

库入口 `src/index.ts` 把整个 `src/core/` 的能力从包根导出（数据库、记录、文档、搜索、同步等）。

```ts
import {
  openMetahub,
  createDatabase,
  createRecord,
  createDocument,
  search,
} from "@tensorix/metahub";
```

完整导出见 [`src/core/index.ts`](./src/core/index.ts)，各能力的语义见 [docs/system-design/capabilities.md](./docs/system-design/capabilities.md)。

## 目录结构

```text
src/
  core/        # 业务逻辑（库和 CLI 共享）；含 sites.ts（静态站点模型，进 CRDT）、csv.ts（文件导入导出）、config.ts（服务器级设置，存 meta）
    sync/      # CRDT 同步协议 + 服务端 + 客户端 + WebUI/REST 路由 + 静态站点托管与鉴权
               #   routes / webui-routes / openapi / webui / sites-routes / sites-serve / auth
               #   files.ts：单文档/数据表与文件互导（markdown/CSV）
               #   pairing.ts / peers.ts / peers-routes.ts：多设备配对、peer 管理与自动同步
  cli/         # citty 子命令（含 site、config）
  webui/       # 浏览器 WebUI（Preact，独立打包为 dist/webui.js）
  index.ts     # 库入口
scripts/       # 构建脚本（含 webui 打包入口）
apps/desktop/  # Electron 桌面 App（见 apps/desktop/README.md）
```

## 发布

core 与 desktop **独立版本、独立发布**（推 tag 触发 GitHub Actions）。

```sh
# core：CLI 二进制 + sidecar 二进制 + 校验和 → .github/workflows/release.yml
#   先改根 package.json 版本并在 main 上提交，然后：
bun run release                     # 打 v<version> 并推送

# desktop 桌面 App：三平台安装包 → release-desktop.yml
#   先改 apps/desktop/package.json 版本并提交，然后：
cd apps/desktop && bun run release  # 打 desktop-v<version> 并推送
```

core Release 里的 sidecar 二进制同时是**桌面端运行时自动更新 core 的下载源**：桌面 App 每次启动后台检查 core 最新版、下载校验后缓存，下次启动生效——所以 core 高频发版无需重打包桌面 App。详见 [apps/desktop/README.md](./apps/desktop/README.md)。

## 许可证

本项目以 [AGPL-3.0-only](./LICENSE) 授权。提交贡献即表示你同意你的贡献以同一许可证发布。
