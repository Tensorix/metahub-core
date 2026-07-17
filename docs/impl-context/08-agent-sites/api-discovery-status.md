# Agent 站点：内部 API / SDK 的可发现性现状

> **注（2026-07-16）**：本文所述发现链缺口已由 `docs/impl-context/23-sites-experience/design.md`（Batch 1）修复——SKILL.md site 条目、`mh site` help、publish/create 输出均已补 URL/SDK/docs.json 指引。以下为修复前的现状核查存档。

> 现状核查（2026-07-15）。回答一个问题：**当 Agent 写一个 site 时，它怎么知道能调哪些内部 API、以及有没有 SDK？**
> 一句话结论：**API 的"存在"只在 `SKILL.md` 里有一句；SDK 在任何面向 Agent 的表面都没有。Agent 走 CLI 这条线（help + 运行输出）得不到的只是 SDK 信息——顶层 `mh --help` 的 SITE DATA 块与 `--server` 输出已覆盖 `/api` 与 `/docs`。**

## 0. 结论速览

站点与 WebUI **同源**，页面里 `fetch('/api/*')` 即可读写整个 hub。围绕"怎么让 Agent 知道这件事"，各渠道的实际覆盖：

| 渠道 | Agent 会看到吗 | 提到 `/api/*` | 提到 SDK `/metahub-sdk.js` |
|---|---|---|---|
| `SKILL.md`（唯一常驻加载） | ✅ | ✅ 一句（`SKILL.md:292`） | ❌ 零命中 |
| `mh site --help`（整棵命令树） | ✅ 按需 | ❌ | ❌ |
| `mh site publish` 运行输出 | ✅ 每次 | ❌ | ❌ |
| `/docs.json`（OpenAPI） | ⚠️ 需主动拉 | ✅ 完整枚举 | ❌ SDK 是静态资源，不进 OpenAPI |
| 内部 design docs / `README.md` / `client.ts` 注释 | ❌ 不进上下文 | ✅ | ✅ |

**净结论**：Agent 对 API 的唯一"进上下文"来源是 SKILL.md 那一句 `/api/*`；SDK 对 Agent 事实上是隐藏的，只活在内部文档和源码注释里。

## 1. site 写作体验现状

site 不是文档/块，是一个**文件桶**（HTML/CSS/JS/图片），底层两张 CRDT 表 `sites` / `site_files`，随 `/sync` 复制。Agent 的主路径是 CLI：

```bash
mh site publish <site> <dir> [--create]   # glob 本地目录逐个 putFile（site.ts:61-101）
mh site put <site> <path> --from <file>   # 单文件（site.ts:33-59）
```

发布后由 `serveSite()` 在 `/sites/<name>/<path>` 直出（`sites-serve.ts`）。关键：**站点与 WebUI 同源** → 页面 `fetch('/api/*')` 就能读写数据（设计文档里说的"给 agent 造的 UI 配一个本地 mini-backend"，`08-agent-sites/design.md:9`）。

相关文件：`src/core/sites.ts`（node 侧：blob 卸载/解码）、`src/core/sites-core.ts`（可移植：CRUD/MIME/路径归一，浏览器副本复用）、`src/cli/commands/site.ts`（CLI）、`src/core/sync/sites-serve.ts`（静态直出）、`src/core/sync/sites-routes.ts`（`/api/site[s]` 写入路由）、`src/webui/sites.tsx`（GUI）。

## 2. 内部 API 的三层暴露（机制层面都在，只是没接到 Agent 面前）

**① REST `/api/*`（公开契约）**
站点页要调的数据面是 WebUI 路由表（`src/webui/server/routes.ts`：databases/properties/records/documents/search/blobs）+ 站点写入路由（`sites-routes.ts:56-128`）。

**② `/docs` + `/docs.json`（OpenAPI，自描述、完整）**
服务器从**带 schema 的 Route 注册表**自动生成 OpenAPI 3.1（`openapi.ts:8` "so /docs always matches what is actually served"），`/docs.json` 返回 spec、`/docs` 是 Scalar UI（`server.ts:201-205`）。Agent 可 `curl /docs.json` 拿到全部端点——但 **SDK 是静态资源、不是 schema 化 Route，不会出现在 OpenAPI 里**。

**③ `/metahub-sdk.js`（可选 typed client）**
源码头注释本身就是用法说明（`src/sdk/client.ts:1-14`）：

```js
import { api } from "/metahub-sdk.js";
const rows = await api.listRecords("我的库");
await api.updateRecord(rows[0].id, { 状态: "完成" });
```

方法目录 `client.ts:101-142`（`listDatabases/listRecords/getRecord/createRecord/updateRecord/deleteRecord/listDocuments/.../search`）1:1 映射到 REST。SDK 自称 **"OPTIONAL sugar over /api/*，裸 fetch 永远等价有效"**（`client.ts:8`）——即设计上**故意**让裸 fetch 成为默认路径。

**让裸 fetch 直接能用的胶水：`/mh-runtime.js`（自动注入）**
服务器给每个 site HTML 注入一段 runtime：`RUNTIME_TAG = <script src="/mh-runtime.js">`（`auth.ts:352`）由 `injectShim/withShim` 插入（`auth.ts:355-376`），`/sites/*` 分支明确走 `withShim`（`server.ts:216-219`）。runtime 负责包 `window.fetch` 自动带 Bearer、401 续期、离线走本地副本（`src/webui/runtime.ts`）。两个资产由 `assets.ts` 挂载（`getRuntime`/`getSdk`，`assets.ts:204-205, 339-340`）。

→ 效果：Agent 写普通静态页 `fetch('/api/...')`，token 与离线全部由注入 runtime 隐形处理，**无需嵌 token**。

## 3. Agent 的实际发现路径（这才是缺口所在）

```
读 SKILL.md → 知道 "site 页面能 fetch('/api/*')"（SKILL.md:292） → 写裸 fetch
                                    │
                                    └─ SDK 从头到尾没被告知；/docs 也要 Agent 主动想到去拉
```

发现 SDK 目前只有三条**非自动**途径：① Agent 主动读仓库 `README.md`；② `curl /metahub-sdk.js` 看到头注释；③ 人告诉它。

## 4. 逐条核查证据

**SKILL.md**（`grep -ni sdk SKILL.md` → 零命中）。对 site 的说明仅：
```
mh site create|put|publish|list|files|rm|delete — host static HTML/CSS/JS an
agent generates; served at /sites/<name>/, and those pages call /api/*
same-origin to read your data ...            （SKILL.md:291-293）
```
即：提了 `/api/*`，没提 SDK，没提 `/docs`。

**`mh site` 帮助文案**（`src/cli/commands/site.ts`，citty 从 `meta.description` + arg `description` 生成）——全树逐条，无一提 API/SDK/docs：

| 命令 | 帮助文案原文 | 行 |
|---|---|---|
| `site`（父） | `Manage static sites served at /sites/<name>/` | `site.ts:156` |
| `create` | `Create a static site (bucket)` | `site.ts:21` |
| `put` | `Upload or replace one file in a site` | `site.ts:34` |
| `publish` | `Upload every file in a directory to a site (--create to create a missing site)` | `site.ts:63-64` |
| `list` | `List sites` | `site.ts:104` |
| `files` | `List a site's files` | `site.ts:114` |
| `rm` | `Delete one file from a site` | `site.ts:131` |
| `delete` | `Delete a whole site and its files` | `site.ts:145` |

参数级 description 也只有 `Site name (URL slug)` / `File path within the site, e.g. index.html` / `Content-Type (else inferred from path)` 之类。唯一沾边的是父命令那句 `served at /sites/<name>/`（只说访问位置）。

**`mh site publish` 运行输出**（`site.ts:82-85`）：只打印 `published N file(s) to <name>:` + 文件清单，**无** 站点 URL、`/api`、SDK、`/docs` 任何提示。

**`/docs.json`**：从 Route 注册表生成（`openapi.ts:8`），列 `/api/*`；`/metahub-sdk.js` 走 `assets.ts` 静态挂载，不在其中。

**提到 `metahub-sdk` 的文件**（`grep -rl metahub-sdk`，均不进 Agent 上下文）：`docs/impl-context/08-agent-sites/design.md`、`16-pwa-offline/design.md`、`docs/system-design/{architecture,capabilities}.md`、`README.md`、`src/sdk/client.ts`、`src/webui/server/assets.ts`、`src/cli/compiled-entry.ts`。

## 5. 缺口与补法建议

**缺口**：若目标是"Agent 优先用 typed SDK / 至少知道有 `/docs`"，链路断在唯一进上下文的入口——SKILL.md 只给了 `/api/*` 一句，既没引 SDK 也没引 `/docs`；CLI（help + 输出）的零覆盖仅对 SDK 成立（`/api` 与 `/docs` 在顶层 help 的 SITE DATA 块与 `--server` 输出里已有）。

**低成本补法**（按性价比排序，择一或组合）：

1. **SKILL.md 的 `mh site` 段补一句**（改动最小、最直接进上下文）：
   `pages call /api/* same-origin (typed sugar: import { api } from "/metahub-sdk.js"); browse /docs for the full API.`
2. **`mh site publish` 成功输出追加一行**：`site: /sites/<name>/ · API: /api/* (typed: /metahub-sdk.js) · docs: /docs`（每次发布必现，命中率最高）。
3. **新增 `mh site scaffold <name>`**：生成模板页，顶部带好 `import { api } from "/metahub-sdk.js"` + 注释里的可用方法清单（把 API 清单直接放进 Agent 要编辑的文件）。

建议优先 (1)+(2)：一处进常驻上下文、一处进每次运行输出，改动小、覆盖全。
