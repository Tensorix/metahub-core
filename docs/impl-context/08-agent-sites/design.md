# Agent 托管静态站点 设计文档

承接 [07-webui/design.md](../07-webui/design.md)、[05-json-record-storage/design.md](../05-json-record-storage/design.md)、[06-friendly-ids/design.md](../06-friendly-ids/design.md)。本文记录让一个**驱动 `mh` CLI 的 AI agent** 把自己生成的 HTML/CSS/JS **发布**为命名「站点」,由 `mh --server` 在 `/sites/<name>/` serve 出去;被托管的页面同源调用既有 `/api/*` 读取数据表与文档——`mh --server` 由此成为一个本地 mini-Supabase(静态托管 + 数据 API),并配一套 token 解锁鉴权使其可对外暴露。

**关键定位:发布是 CLI 路径,不是 HTTP 写接口。** 外部「agent」指的是用 `mh` 命令行的 AI(如 Claude Code),所以建站/上传/删除走 `mh site` 子命令;`--server` 的 HTTP 角色只是**serve 站点 + 只读数据 API + 鉴权**。**底层 core / oplog / sync 协议不改**——站点与文件经 `emit()` 进 CRDT,与 records/documents 一样自然可同步。

## 1. 背景与目标

现状:`mh --server`(`src/core/sync/server.ts`)用极简 `Bun.serve()` 暴露 `/sync`、`/health`、`/docs`、根路径 WebUI 与一组 `/api/*` 读写接口;但没有「托管任意 HTML」的能力,路由器是**精确路径匹配**。

目标:

- AI agent 用 CLI 把一组文件发布成站点:`mh site publish <name> <dir>`(整目录一把推,站点不存在则自动建),也支持单文件 `mh site put`。
- `mh --server` 在 `/sites/<name>/<path...>` serve 这些文件,带正确 MIME;被托管页面同源 `fetch('/api/...')` 即可读本库数据(无 CORS 问题)。
- 站点与文件**进 CRDT oplog**,随 `mh sync` 跨机复制——复用 `emit()`,不新写存储。
- 因为开始托管「外部写的 HTML」并可能对外暴露,引入**单 token 鉴权**:`--debug` 全开,否则每个请求需 token,浏览器走解锁页 + fetch 套壳。
- 维持 07 的硬约束:**对 CLI 启动性能零影响**——serve 模块懒加载,不进 CLI import 图。

## 2. 设计要点

### 2.1 数据模型(进 CRDT,与既有表同构)

新增两张表(`src/core/schema.ts`),并在 `crdt.ts` 的 `DOMAIN` 登记可写列(列白名单是安全关键——change 可能来自不受信任的 sync peer):

```text
sites(id, name, title, created_hlc, __deleted)
site_files(id, site_id, path, content_type, encoding, content, created_hlc, __deleted)
```

- `id` 带类型前缀:`site_<slug>-<rand>` / `sf_<slug>-<rand>`(`ids.ts` 的 `Kind`/`KINDS` 加 `site`、`sf`)。
- `(site_id, path)` 映射到**稳定 id**:重复上传同一路径复用该 id,于是「改文件」是同一 CRDT register 的合并而非产生重复行。
- `encoding ∈ {utf8, base64, blob}`:
  - 文本类型(html/css/js/json/svg/...)→ `utf8` 内联,**可读且随 oplog 同步**。
  - 二进制 ≤ 256KB → `base64` 内联,**随 oplog 同步**。
  - 更大二进制 → `putBlob()`(`cache.ts`,sha256 内容寻址),`encoding=blob`、`content=hash`。**取舍:blob 字节存 `cache/`,暂不随 oplog 复制(清单照常同步),故主用例为文本时可接受;blob 同步留作后续。**

### 2.2 发布:`mh site` CLI(agent 的路径)

`src/cli/commands/site.ts`,镜像 `commands/doc.ts`(`openMetahub`/`guard`/`print`/`table`,文本输入复用 `resolveValue` 的 `@file`/`@-`):

- `site create <name> [--title]`、`site list`、`site files <site>`、`site rm <site> <path>`、`site delete <site>`。
- `site put <site> <path> --from <file> | --content <txt|@file|@->`:二进制走 `Bun.file(path).arrayBuffer()`(`resolveValue` 只读文本),文本走 `--content`。
- `site publish <site> <dir>`:用 `Bun.Glob("**/*").scanSync` 遍历目录逐个 `putFile`,站点不存在则自动 `createSite` ——**agent 最常用的一把梭**。
- `<site>` 经 `resolveSite` 按 id(`site_…`)或名字解析。

### 2.3 静态 serve:前缀分支 + 懒加载(沿用 07 的隔离手法)

`server.ts` 原为精确匹配。在 404 前加一个**前缀分支**,与 `serveWebui` 同样用 `await import()` 懒加载:

```ts
if (req.method === "GET" && url.pathname.startsWith("/sites/")) {
  const { serveSite } = await import("./sites-serve.ts");
  const res = await serveSite(req, ctx);   // null → 落到 404
  if (res) return withShim(res, auth);
}
```

`serveSite`(`src/core/sync/sites-serve.ts`)解析 `/sites/<name>/<rest>`:按名字 resolve 站点、查文件(`""`/结尾 `/` → `index.html`),返回字节 + `content_type`;`/sites/<name>`(无结尾斜杠)→ 301 到 `/sites/<name>/` 以便相对资源 URL 正确。

### 2.4 只读 HTTP 站点接口

`src/core/sync/sites-routes.ts` 沿用 07 的 `Route` + `handle()` + `?param` 约定,append 进 `routes.ts`,自动进 `/docs`。v1 **只读**(写在 CLI):`GET /api/sites`、`GET /api/site/files?site=<id|name>`。无需给 `Route.method` 加 `PUT`。

### 2.5 鉴权:token 解锁 + fetch 套壳(`src/core/sync/auth.ts`)

`startServer` 增 `{ debug?, token?, host? }`。token = `--token` → `METAHUB_TOKEN` →(非 debug)`randomSuffix(24)` 自动生成并打印。默认绑 `127.0.0.1`,`--host 0.0.0.0` 才对外。

`server.ts` 一处门禁(debug 时整体跳过):token 可经 `Authorization: Bearer`、Cookie `mh_token`、`?token=` 任一携带。

- `/api/*`、`/sync` 等无 token → `401`。
- **浏览器导航**(GET 且 `Accept` 含 `text/html`)无 token → 返回**解锁页**:输入密码,存 `localStorage` **和** `document.cookie`,reload。
- reload 后 cookie 过门禁,真实页面被 serve,并经 `withShim` 在 `<head>` 后注入 **fetch 套壳**:把 `localStorage` 里的 token 作为 `Bearer` 头加到同源请求上——agent 写的页面 `fetch('/api/...')` 无需内嵌密钥即可工作。

## 3. 取舍

- **发布走 CLI 而非 HTTP 写接口**:本工具的「外部 agent」= 用 CLI 的 AI;HTTP 面只做 serve + 只读 + 鉴权,写侧零碎管理交给 `mh site`。若将来有非 CLI 客户端再补 `POST /api/sites/publish`。
- **站点进 CRDT 而非文件系统**:与项目本地优先 + 可同步的气质一致,复用 `emit()`,免第二套存储与同步;代价是大二进制的 oplog 体积,故用 256KB 阈值把大文件转 blob(其字节暂本机)。
- **内联 utf8/base64 默认、blob 仅兜底大文件**:主用例 HTML/CSS/JS 是文本,内联即可读且随 oplog 完整复制;不为少见的大二进制提前做 blob 同步。
- **路径用 `/sites/<name>/...` 前缀分支,id/manifest 仍走 query**:静态 serve 必须前缀匹配(精确匹配做不到任意路径),但只读 API 沿用既有精确匹配 + `?param`,不动路由器与 OpenAPI 生成。
- **单 token + 解锁页 + 套壳,而非双 key(anon/service)**:既保护写、又让被托管页面读数据时不必把密钥写进前端源码(浏览器输入一次,存浏览器);双 key 更像真 Supabase 但 v1 偏重。cookie 负责导航、套壳负责 fetch,二者皆被服务端接受。
- **懒加载 serve 模块**:延续 07,`/sites/*` 与 WebUI 一样 `await import()`,对 `mh <命令>` 启动零开销。

## 4. 涉及文件

- 新增:
  - `src/core/sites.ts` — 站点/文件模型(全部经 `emit()`):create/get/getByName/list/delete(级联)/resolve、`putFile`(按 site+path upsert、MIME 推断、utf8/base64/blob 选择)、`getFileForServe`、`listFiles`、`deleteFile`。
  - `src/cli/commands/site.ts` — `mh site`(create/put/publish/list/files/rm/delete)。
  - `src/core/sync/sites-serve.ts` — `serveSite`:`/sites/<name>/<path>` 静态托管。
  - `src/core/sync/sites-routes.ts` — `sitesRoutes`:`GET /api/sites`、`GET /api/site/files`。
  - `src/core/sync/auth.ts` — token 门禁 / 解锁页 / fetch 套壳注入。
- 修改:
  - `src/core/schema.ts` — `sites` + `site_files` 表 + `idx_site_files_site`。
  - `src/core/crdt.ts` — `DOMAIN` 加 `sites`、`site_files` 列白名单。
  - `src/core/ids.ts` — `Kind`/`KINDS` 加 `site`、`sf`。
  - `src/core/sync/routes.ts` — append `sitesRoutes`。
  - `src/core/sync/server.ts` — `/sites/` 前缀分支、token 门禁、`startServer` 选项、默认 host、HTML 响应注入套壳。
  - `src/cli/index.ts` — 注册 `site` 子命令;`--debug`/`--token`/`--host` 解析 + 启动输出打印 token。
  - `src/core/index.ts` — 导出 `sites.ts`。

## 5. 实现记录（与设计的偏差 / 验证）

- **`new Response(Uint8Array)` 的 TS 兼容**:`getFileForServe` 多分支返回的 `Uint8Array<ArrayBufferLike>` 在当前 lib 下与 `BodyInit` 联合匹配出错,serve 处 `as BodyInit` 收口(运行时正确)。
- **cookie 与套壳双保险**:同源 cookie 已能让导航与 fetch 都过门禁;额外注入的 Authorization 套壳满足「存浏览器、所有请求带 token」的要求,且 cookie 被禁时仍可用。解锁页不内嵌密钥(运行时由用户输入)。
- **端到端已验证**:`mh site publish` 推 3 文件(png→base64、html/css→utf8、MIME 正确);`--server --debug` 下 `/sites/demo/`、子路径、二进制、`/sites/demo`→301、`/api/sites`、`/api/site/files`、`/docs.json` 含新路由、缺失→404 全通。非 debug:无 token→401,`?token`/`Bearer`→200,错 token→401,浏览器导航→解锁页,带正确 cookie→页面 + 注入套壳。跨节点:`ingest(changesSince)` 后另一节点能取到站点与内联文件。`bun test` 69 通过(新增 `sites.test.ts` 10 例),零回归。
