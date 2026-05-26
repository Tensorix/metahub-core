# metahub

库 + CLI + 独立二进制三合一的项目。

## 三种用法

### 1. 作为 npm 库引入

```bash
bun add metahub      # 或 npm i / pnpm add / yarn add
```

```ts
import { greet } from "metahub";

console.log(greet({ name: "Noah" })); // Hello, Noah!
```

### 2. 作为 CLI 全局安装

```bash
npm i -g metahub
metahub hello --name Noah   # 或简写: mh hello --name Noah
```

也可一次性运行：`npx metahub hello --name Noah` / `bunx metahub hello`。

### 3. 直接下载独立二进制（免运行时）

从 Releases 下载对应平台文件，赋予执行权限后即可运行：

```bash
chmod +x metahub-darwin-arm64
./metahub-darwin-arm64 hello --name Noah
```

支持平台：`darwin-arm64` / `darwin-x64` / `linux-x64` / `linux-arm64` / `windows-x64`。

## 开发

```bash
bun install                       # 安装依赖
bun run dev hello --name Noah     # 热重载运行 CLI
bun test                          # 跑测试
bun run build                     # 产出 dist/ (库 + CLI + 类型声明)
bun run build:binaries            # 产出 binaries/ 五平台二进制
```

## 目录结构

```text
src/
  core/      # 业务逻辑 (库和 CLI 共享)
  cli/       # citty 子命令
  index.ts   # 库入口
scripts/     # 构建脚本
dist/        # 构建产物 (gitignored)
```
