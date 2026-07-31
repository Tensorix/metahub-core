# 当前架构

## 总体结构

```text
                            所有者(AI Agent / 人)
        |                            |                            |
        v                            v                            v
CLI (src/cli)              桌面端 (apps/desktop)        浏览器 PWA(离线副本)
  - citty command tree       - Electron 外壳              - WebUI / 托管站点页
  - JSON / human-readable    - Bun 边车跑 startServer()   - Service Worker 网关
  - editor integration       - 窗口加载内嵌 WebUI          - db-worker: sqlite-wasm+OPFS
        |                            |                       跑同一份 core(经 DbDriver)
        v                            v                            |  POST /sync(配对凭据)
        +----------------------------+----------------------------+
                                     v
                          Core API (src/core)
                            - databases / properties / records
                            - documents / blocks
                            - resolve(引用解析)/ context(当前库)
                            - integrity(validateHub / repairHub)
                            - search / snapshot / restore
                            - sync client/server
                            - 访客面: AccessPolicy / GrantSet / GuestIntent
                                     |
                +--------------------+--------------------+
                v                                         v
      SQLite + cache                          Edge 子系统(用户自己的 CF 账号)
        ~/.metahub/metahub.db                   - Worker + D1: 写信箱(密文信封)
        ~/.metahub/cache/                       - Durable Object: 常在线房间
      (浏览器侧: OPFS metahub.db 全量副本)             ^
                                                        |
                                     匿名访客(公开站点 / 分享链接 / 房间)
```

访客永远走**访客面**:公开站点的 `/sites/<name>/api/*`、分享链接的 `/share/<slug>/api/*`,或所有者设备离线时经 Edge(写信箱异步收、房间实时读写)。所有者设备把信封拉回来、解密、过隔离层,才可能进 oplog。

当前实现把 CLI 和库能力共享在 `src/core` 中。CLI 只负责参数解析、输入解析、输出渲染和命令接线;业务写入都通过 core 完成。core 的可移植子集(领域逻辑、CRDT、搜索、sync client)类型挂在 `DbDriver` 最小驱动接口(`src/core/driver.ts`)上——Bun 侧由 `bun:sqlite` 结构性满足,浏览器侧由 sqlite-wasm 适配器实现,**同一份领域代码在服务器与浏览器副本中执行**(见 [impl-context/16-pwa-offline](../impl-context/16-pwa-offline/design.md))。

## 运行时和分发

已实现:

- 运行时基于 Bun。
- SQLite 使用 `bun:sqlite`;可移植 core 模块类型挂 `DbDriver` 接口(`src/core/driver.ts`),浏览器副本用 sqlite-wasm(OPFS)实现同一接口。
- HTTP 同步服务使用 `Bun.serve()`;`--tls-cert/--tls-key` 可直出 HTTPS(PWA 的 secure context 要求;推荐 Caddy/Tailscale Serve 反代)。
- 构建脚本输出库入口 `dist/index.js`、CLI `dist/cli.js`,以及浏览器资产:`webui.js` / **`webui.css`**(独立提供,不再内联进 HTML 壳) / `sw.js` / `db-worker.js` / `mh-runtime.js` / `metahub-sdk.js` / `sqlite3.wasm`,外加**懒加载的代码格式化子系统产物**(见下)。统一三态解析(编译内嵌 > dev 按 mtime 重建 > dist 兄弟产物)。
- **代码格式化子系统** `src/webui/fmt/*`:WebUI 代码块一键"格式化"的引擎——原生 JSON / prettier core(js/ts/css/html/yaml/php/sql/json5/jsonc)/ per-language wasm(ruff·gofmt·clang-format·stylua·taplo·shfmt)/ 括号重缩进兜底,**按需懒加载**、从不进主 `webui.js`。`fmt/manifest.ts` 是**单一来源**,被浏览器 loader(`fmt/load.ts`)、服务器(`src/webui/server/assets.ts`)、构建(`scripts/build.ts`,含反内联标记断言)、静态壳(`scripts/build-shell.ts`)与编译二进制(`src/cli/compiled-entry.ts`)共同消费;dist 产物 `webui-fmt.js` + 每引擎 bundle `webui-fmt-{ruff,gofmt,clang,lua,taplo,sh}.js` + 5 个 wasm sidecar;Service Worker 首次用到才缓存(不预热)。
- `package.json` 暴露 `metahub` 和 `mh` 两个 bin。
- 支持通过 `bun build --compile` 生成独立二进制。
- **Edge 产物(第 5 种分发形态)**:`scripts/build.ts` 另出 `dist/edge-worker.js`——**一份可审计的、零 `node:`/`bun:` 导入的 Worker 模块**(构建期断言),由 `mh edge deploy` 上传到**用户自己的** Cloudflare 账号(Worker + D1 + Durable Object)。同一份代码在 `bun test` 里逐字节跑同样的 handler。另有 `src/cli/site-starter.html.txt`(`mh site scaffold` 写出的起步页)作为内嵌文本资源。
- **静态壳(第 4 种分发形态)**:`scripts/build-shell.ts` → `dist/shell` 产出**数据盲的静态 PWA 壳**(Cloudflare Pages/R2 等无源站托管,`_redirects`/`_headers`),复用 `serveWebui()` 的同一份 WebUI,靠 `detectOriginMode` 走 no-origin 模式(数据来自用户挂载的对象存储桶,不假设有后端)。见 [18-no-origin-shell](../impl-context/18-no-origin-shell/design.md)。
- 桌面端 `apps/desktop`(Electron + Bun 边车):外壳是 Electron(自带 Node 运行时),core/server 跑在 spawn 出的 Bun 边车里(因 core 依赖 `bun:sqlite` 等 Bun 专有 API,无法在 Electron 主进程直接运行),窗口加载边车在回环临时端口提供的内嵌 WebUI。还含「快速笔记」小窗(全局快捷键/托盘唤起、mac 半透明、可置顶):复用同一份 WebUI 的 `#quick` 路由 + CM6 文档编辑器,笔记是挂在通用 `parent_id` 下的普通文档,**core 不含 quicknote 概念**。详见 [impl-context/12-desktop-app](../impl-context/12-desktop-app/design.md)。

### 可移植性与 bundle 边界(承重约定)

core 现在要在**四个运行时**上跑同一份领域代码:Bun(CLI/server)、浏览器(sqlite-wasm 副本)、workerd(Edge Worker 与 Durable Object 房间)、以及 SDK 所在的访客页面。约定:

- **portable / driver-only**:凡标注 PORTABLE 的模块只依赖 `DbDriver` + WebCrypto/fetch,禁止 `node:`/`bun:` 导入(`grants-core`、`guest-intent`、`access-policy`、`room-*`、`partition`、`drop-protocol`、`anti-abuse`、`grants-routes`、`site-channels`、`data-map`、`recovery`…)。`scripts/build.ts` 对 Worker bundle 做**断言**,违规即构建失败。
- **Bun-only 的一半必须可分离**:S3 签名与 CORS 文档拆到 runtime-agnostic 的 `sync/storage-s3-sign.ts`(Bun 客户端、浏览器 SigV4 客户端、分享导出共用一份签名器,免得"改一处 403 另一处"),真正绑 Bun 的只剩需要 Content-MD5 的 `PutBucketCors`,经 `storage.ts` 的注册表反查。blob 字节解析器同理走 `blobs-core.ts` 的 seam(`src/core/blobs.ts` 注册 Bun 实现)。
- **注入点单一化**:页面运行时 `<script src="/mh-runtime.js">` 的注入逻辑只有一份(`src/core/inject-runtime.ts`),服务器 `withShim`、Service Worker 的离线站点服务、冷启动自举壳三处共用,不许各写各的。
- **SDK bundle 不许被拖胖**:`src/sdk/drop.ts` 只用 drop 协议的"轻的一半"(id/编解码/封装),对 `GuestIntent` 只做 type-only 导入,构建期断言浏览器 SDK 不会把 `grants-core` 拖进来。

## 本地目录

```text
~/.metahub/
  metahub.db
  cache/
```

可通过 `METAHUB_HOME` 覆盖根目录,测试和多实例运行依赖这个能力。

## 写入路径

所有领域写入都走 CRDT oplog:

1. 领域函数调用 `emit(db, dataset, rowId, col, value)`。
2. `emit` 生成 Hybrid Logical Clock 时间戳。
3. 写入 `crdt_changes`。
4. `applyChange` 判断当前 change 是否为该 register 的最大 HLC。
5. 如果胜出,物化到领域表。

当前 register 由 `(dataset, row_id, col)` 定义。记录单元格也是 register,其中 `col` 是 property id。

所有公开变更函数由 `grouped()`/`withChangeGroup`(`crdt.ts`)包裹:一次逻辑变更的全部 emit 共享一个 `txn` 分组 id(嵌套调用保持外层),供历史按"修订"聚簇;repair/revert 用带前缀的 label 标记来源。txn 随 sync 复制,不参与 LWW。

新建实体的 `row_id` 带类型前缀(`<kind>_<slug>-<rand>`,见 `src/core/ids.ts`),对 oplog/物化/同步完全不透明;旧的无前缀 id 与之共存。

## 引用解析路径

CLI 在调用 core 写/读函数前,先把用户输入的「引用」解析成确切 id:

1. CLI 命令拿到 id 参数(可能是完整 id、唯一前缀、名字/标题)。
2. 调 `resolveRef`(`src/core/resolve.ts`,纯只读)在指定 kind/库范围内解析,歧义或找不到则抛错(经 `guard` 转成 `{error}` 输出)。
3. 用解析出的精确 id 调 core 的 `getX`/`updateX`/`deleteX`——**core API 仍只接受精确 id**,解析便利只在 CLI 边界。
4. `database` 参数缺省时回退到 `meta.current_db`(`src/core/context.ts`,本机上下文);relation 值在写入(`coerce`)时于目标库内解析。

这样保持了 core API 的精确可预测,同时把「不必粘贴完整 id」的体验集中在解析层。

## 读取路径

读取直接走物化表:

- 数据库和属性直接查 `databases`、`properties`。
- 记录从 `records.data` JSON 中读取 property id 到 value 的映射,再映射回属性名。
- 文档读取 `documents.body`,该字段是从 `doc_blocks` 重算出来的缓存。
- 搜索读取 `search_fts`,不可用或无命中时降级 LIKE。

## 查询路径

当前记录查询由 `listRecords` 编译为 SQL:

- `filter` 支持 `{field: value}` 等值过滤。
- scalar 值下推到 SQL。
- array/object/null 值在 JS 层过滤。
- `sort` 支持单字段排序,默认 `created_hlc`。
- `limit` 在没有 JS 过滤时下推到 SQL。

当前没有正式查询 DSL,也没有范围查询、contains、聚合和 cursor pagination。

## 文档架构

文档正文采用 block-level CRDT:

- `doc_blocks` 是权威数据。
- `documents.body` 是物化缓存。
- Markdown 按段落切块,fenced code block 保持为一个块。
- `doc edit --old --new` 优先在单块内做锚定替换。
- 跨块或引入块分隔时走整篇 reconcile。
- WebUI 文档编辑器是 **CodeMirror 6**:文档就是一份 Markdown 文本、"块"是派生的扁平展示模型;保存仍只是完整 Markdown body(`getDoc()`),服务端按上述 core block 规则 reconcile。行/行内分类下沉到共享的 `src/core/md/{grammar,inline,heal}.ts`,由 CM6 编辑器扫描、保存解析器(`src/webui/blocks.ts`)与分享渲染器**三面共用**(同一字节各面分类一致,由 `cm6/grammar-parity.test.ts` 钉住)。详见 [webui-editor.md](./webui-editor.md)。

这让不同段落的并发编辑可以合并,比整篇 LWW 更适合 AI 增量编辑。

## 搜索架构

搜索模块当前实现:

- 优先使用 SQLite FTS5。
- 用 `meta.search_seq`(`crdt_changes.rowid` 游标)+ `meta.search_index_version` 记录索引进度与版本。
- 搜索前**增量**维护:只读取游标之后的 oplog 变更,归并受影响对象,重写其 `search_fts` 行;首次建索引 / 版本升级 / 快照 reset / 手动修复时才全量重建。整个增量更新与游标推进在同一事务内,保证不漏索引。
- FTS 无命中或不可用时使用 LIKE 子串搜索。

当前搜索是全文搜索 MVP,不是面向 IM 上下文检索的完整体验。

## 同步架构

同步是简单 C-S 模式:

- 服务端也是一个 Metahub 节点。
- `POST /sync` 接收客户端 changes,服务端 ingest 后返回服务端游标之后的 changes。
- 客户端用 `peers` 表记录 `pull_cursor` 和 `push_cursor`。
- 游标基于 SQLite `rowid`,避免 HLC 时钟漂移导致漏同步。
- 请求可带可选 `limit`(分页拉取——浏览器副本首次水合按 2000/轮循环)与 `exclude_datasets`(部分副本,协议就绪、UI 未开)。游标语义:分页未尽停在末行;扫尽跳到高水位(免重扫排除尾);**永不回退**(防 compact 后回拉旧数据)。
- **浏览器也是一等节点**:启用「离线副本」的浏览器经自助配对持有可单独吊销的凭据,在 db-worker 里原样跑 `syncWithPeer()` 与服务器互同步(见下「PWA 离线架构」)。
- **三类对端一张表**:`peers.kind` 现有 `http`(对等设备)、`s3`(数据盲桶转发)、`room`(某个分享的 Edge 房间)。房间不是"另一台设备"——它只承载**一个分享的分区**,所以数据地图刻意把它排除在"我的数据存在几处"之外。

**自动同步定时器的计费意识**:所有**计量成本**的远端轮次(桶轮询、房间同步、写信箱拉取)共用一套**空闲退避**——hub 没推进且该轮次连续空转时,间隔翻倍,上限 2.5min(≈ 发布者租约 TTL 的一半,保证故障切换仍及时);任何 hub 推进(本地编辑或拉到远端编辑)立刻回到基础节奏。http 对端每 tick 都同步。写信箱有自己的基础节奏(60s),并且**排在 peers 轮次之后**——这样每 tick 里桶的 push 先于 drop 轮,ack 门禁(`seqAtIngest ≤ push_cursor`)才可能通过。

当前同步对大 oplog 已有分页,仍没有压缩传输或差异优化。

## HTTP 路由与 WebUI

`Bun.serve()` 的 fetch handler 用精确路径匹配分发。core 侧路由表 `src/core/sync/routes.ts` 合并 `syncRoutes`(`/sync`、`/health`)、`sitesRoutes`(`/api/sites` 等)、`peersRoutes`(`src/core/sync/peers-routes.ts`,含 `POST /api/pair` 配对握手)与 `blobRoutes`(`src/core/sync/blob-routes.ts`,`GET /blob/<hash>`、`POST /api/blob`、`GET /api/blobs/has`);WebUI 的 `/api/*`(`webuiRoutes`)与**分享路由**(`/api/share`、`/api/shares`,`src/webui/server/share-routes.ts`)从 `src/webui/server/` 注入。合并后的路由表既被 fetch handler 命中,也被 `openapi.ts` 遍历生成 OpenAPI(`/docs`、`/docs.json`),无 codegen。静态站点 `startsWith("/sites/")`、公开分享 `startsWith("/share/")`(在 token 门禁**前**、原样返回)各用一个**前缀分支**处理。

- **REST API**(`src/webui/server/routes.ts` 的 `webuiRoutes`):一组只读 + 写入路由,**复用与 CLI 同一套 core 函数**(`listDatabases`/`updateDatabase`/`listRecords`/`createRecord`/`updateProperty`/`updateDocument`/`search` 等),因此写操作同样经 `emit()` 进 CRDT oplog、随 sync 复制。id 用 query 参数携带(`?db=`/`?id=`),以保持精确路径匹配与 OpenAPI 生成不变;`Route.method` 扩展出 `PATCH`/`DELETE`。handler 统一包一层 try/catch,异常转 `{error}` 400。
- **浏览器 WebUI**(`src/webui/`,Preact):根路径 `/` 返回 HTML 外壳,`/webui.js`/`/webui.css` 返回应用 bundle/样式。服务模块 `src/webui/server/assets.ts` 的 `serveWebui`(经 `server.ts` 懒加载)优先读打包产物 `dist/webui.js`,开发态(从源码运行、无 dist)即时 `Bun.build` 兜底并缓存。应用入口 `app.tsx`,主要子目录:`cm6/`(CodeMirror 6 文档编辑器 + `chrome/`/`voids/`)、`fmt/`(代码格式化引擎)、`media/`(图片/表格/代码等 void 组件)、`share/`(分享 viewer)、`quicknote/`、`server/`(资源/路由服务)、`data/`(浏览器副本),以及 `api/icons/ui/blocks/markdown/sidebar/settings` 等;行/行内语法在 `src/core/md/`。文档编辑详见 [webui-editor.md](./webui-editor.md);历史实现见 [07-webui](../impl-context/07-webui/implementation.md)。
- **CLI 性能隔离**:WebUI 与 Preact 单独打包为 `dist/webui.js`,**不进入 `cli.js` 的启动 import 图**;懒加载使其仅在浏览器首次访问 `/` 时载入,普通 `mh <命令>` 启动不受影响。
- **静态站点托管**(`src/core/sync/sites-serve.ts`,经 `server.ts` 懒加载):`/sites/<name>/<path...>` 按名字 resolve 站点、查 `site_files`(默认 `index.html`,`spa=1` 时无扩展名的 miss 回退 `index.html`),返回字节 + MIME;站点经 `mh site` CLI 发布,文件经 `emit()` 进 CRDT(见 [08-agent-sites](../impl-context/08-agent-sites/design.md))。**站点分支自治**:公开站点(`visibility='public'`)免 token **原样返回**(不套 shim);私有站点由 `serveSite` 自己再跑一次 token 门禁,并且**私有与不存在的响应完全一致**(反枚举)。`/sites/<name>/api/*` 是访客数据面(见下),持 token 的同源请求则被**进程内转发**回主路由表——重写成 `/api/*` 后按普通 API 调用分发,不额外开一套实现。
- **鉴权**(`src/core/sync/auth.ts`、`src/core/sync/token.ts`):fetch handler 顶部一处 token 门禁,`--debug` 跳过。`/sync` **不再豁免**——经 `acceptsSyncToken` 单独门禁,接受**主 token 或任一配对凭据**(旧的开放信任对等模型已移除,凭据由配对分发,见 `src/core/sync/pairing.ts`、[11-device-pairing-sync](../impl-context/11-device-pairing-sync/design.md))。仅 `/health`、`/auth/token`、`/api/pair` 豁免该 token 门禁(分别为:peer 健康检查;让持过期 token 者仍能换新;配对握手在 handler 内用一次性配对码自证)。其余请求需经 `Authorization: Bearer`/Cookie `mh_token`/`?token=` 携带 token。**token 默认持久化在 `~/.metahub` 的 `meta` 表**(非 `--token`/`METAHUB_TOKEN` 静态覆盖时),带 TTL(默认 30 天,env `METAHUB_TOKEN_TTL`),到期或 `mh token refresh` 时**惰性轮换**(以 DB 为单一来源、每请求读,故另一进程刷新立即生效);轮换后旧 token 在宽限期内(默认 7 天,env `METAHUB_TOKEN_GRACE`)仍可经 `GET /auth/token` 换到新 token,实现浏览器**无感续期**。浏览器导航无 token 返回**解锁页**(`unlockPage()`,0.3.x 重做:与 WebUI 匹配的明暗主题 + cube 标记、**进入前内联校验** token(不再盲存后 reload)、支持粘贴 `…?token=xxx` 登录链接、16px 输入防 iOS 缩放、安全区适配;成功后存 `localStorage`+cookie)。解锁页先尝试 `/auth/token` 静默续期;响应带 `x-mh-unlock` 头供 Service Worker 识别拒缓存。其后 HTML 响应经 `withShim` 注入 `<script src="/mh-runtime.js">` 页面运行时——承接旧内联 fetch 套壳的 token 职责(自动带 `Bearer`、401 换取重试一次),并叠加 SW 注册与离线 RPC 桥(`--debug` 也注入,离线桥与 token 无关)。SW 注册**在桌面外壳窗口里跳过**(`runtime.ts` 门禁 `isSecureContext && !metahubDesktop`;`app.tsx` 进一步只在持副本的客户端注册),否则 SW 的 network-first 兜底会把桌面窗口钉在过期缓存壳上(见记忆 `desktop-windows-no-sw`)。PWA 安装元数据(`/manifest.webmanifest`、`/icons/*`、`/sw.js`)豁免 token 门禁,`/metahub-sdk.js` 同理(公开分享页/站点页要 import 它,且它不携带任何机密)。见 [10-persistent-token](../impl-context/10-persistent-token/design.md)、[16-pwa-offline](../impl-context/16-pwa-offline/design.md)。
  - **Cookie 只是只读的环境权限**:`cookieMutationRejection` 要求一切**改状态**的 `/api` 请求显式出示 token——否则同源的站点页能凭所有者的 cookie 直接改工作区。
  - **`?token=` 导航即刻擦除**:`tokenStripRedirect` 落好 cookie 后重定向到去掉 token 的地址,凭据不在地址栏久留。
  - **桌面边车的 `loopbackUiOnly`**:桌面故意关掉 token 门禁,于是另加一道——非 `127.0.0.1:<实际端口>` 一律 403,非幂等方法要求 `Origin` 与 `Sec-Fetch-Site` 同源,挡 DNS rebinding 与跨站改写。

## 访客面架构(公开站点 / 分享链接 / 房间)

匿名访客能读写工作区的**一个被明确授权的切片**。三种访客面(公开站点、分享链接、Edge 房间)的授权状态原本活在三套存储里,现在统一由三个原语收口:

- **`GrantSet`(`src/core/grants-core.ts`)**:表×操作的授权原语,`op ∈ {read, create, update}`——**`delete` 永不入枚举**,匿名删除不是一种能力。表按 **database id** 记(不按名字:名字会改,授权不能跟着改)。`parseGrantSet` 是 **default-deny**:`sites.public_grants` 是同步寄存器,任何对端都能写进任意字符串,畸形输入一律退化为空集;本地写入走 `validateGrantSetInput`,不合法就大声抛错。**反枚举**:"没授权"与"不存在"返回**同一个** `MhError("auth")`,访客无法探测出授权之外的库/记录是否存在。
- **`AccessPolicy`(`src/core/access-policy.ts`)**:对上述三套存储的**只读投影**(门面,不迁移存储)。三个 resolver 各读各的存储、返回同一个形状(`audience` / `grants` / `writeGate` / `limits` / 策略版本),于是访客服务路径 `serveGrantedApi` 由策略驱动,而不是每个挂载点手工接线 grants + 开关。**隔离不变**:每个站点 / slug / 房间各自解析出自己的策略,resolver 之间永不合并。
- **`GuestIntent`(`src/core/guest-intent.ts`)**:访客提交的是**意图**,不是 changes——运行时自己负责鉴权、盖 HLC、发 CRDT、以及**持久幂等**(见 data-model 的 `intent_receipts`)。这样"提交两次"天然无害。

访客数据面本身是 `src/core/sync/grants-routes.ts` 的 `serveGrantedApi`:**同一份实现**挂在 `/sites/<name>/api/*`(public 主体)与 `/share/<slug>/api/*`(share 主体),纯 `Request → Response` + driver-only,所以房间里能原样复用。面很窄——`GET records|record|properties` + `POST records` + `PATCH record`,没有 DELETE、没有库枚举,`limit` 上限 500;响应形状与主 API **逐字节一致**(SDK 无需分叉)。写入还要过 `sync/anti-abuse.ts` 的统一门(Turnstile siteverify + 密码 verifier):**站点授权的两条写入传输(Edge 写信箱、server 实时面)强制共用这一个门**,免得 `mh site grant --password` 在一条路上生效、另一条被悄悄跳过;siteverify 失败关闭(含 5s 超时)。

## Edge 子系统:写信箱(drop)与房间(room)

**一条部署命令、一个 Worker、两个命名空间**(`src/workers/edge-worker.ts`,`mh edge deploy` 上传到用户自己的 Cloudflare 账号):

```text
/v1/inbox/*   写信箱(D1 支撑)      —— 异步:访客投递密文,所有者稍后收
/r/<slug>/*   分享房间(Durable Object)—— 实时:所有者离线也能读写
```

- **写信箱 = 数据盲的写入面**,与桶的数据盲**读取面**互为对偶:访客浏览器把预签名的 op **封装**(`MH-SEAL-P256`,`sync/seal.ts`)给所有者公钥,Edge 只存密文,所有者设备拉回来解密→过隔离层→ingest。Edge 只强制**信封级**约束(注册、体积 ≤64KiB、Turnstile、密码 verifier、容量),**语义校验一律在所有者的隔离层**(`drop-protocol.checkDropPayload`)。
- **"信封是邮件,不是数据"**:没过隔离层前它永远不进 oplog;拒收的信封记进 node-local `drop_rejects` 后**立刻从 Edge 删除**(垃圾不许占信箱容量)。
- **无游标**:oplog 的 `UNIQUE(dataset,row_id,col,hlc)` + 稳定的 `drop:<envelope_id>` txn 让重复拉取变成 no-op,所以整个信箱**没有游标表**。**ack 门禁**:挂了桶时,信封只有在"已落本地 oplog **且** 已被桶的 push 游标覆盖"后才删除;没挂桶则本地 oplog 就是耐久锚点,立即 ack。
- **收件人 keyring**(`sync/drop-keys.ts`):P-256 密钥对独立生成(WebCrypto 无法由种子派生 P-256),私钥用桶主密钥包裹后存 `keys/drop.json`(挂桶时它是权威,本地 meta 只是缓存)。**轮换是追加**:旧密钥标记 retired 但保留,在途信封仍能解开;`--purge-retired` 留给"上一代已排空"之后。
- **房间**(`sync/room-*.ts` + `src/workers/room.ts`):一个分享的常在线服务面。房间的数据库就是一份普通 core schema,只装**一个分区**(该分享的授权闭包:granted 库的 databases/properties/records + 该站点的 sites/site_files;documents/doc_blocks/meta 一律排除)。红线:房间**零出站凭据、从不主动外呼**,所有交换由所有者驱动;`evict` 是**本地物理删除、绝不产生 op**(否则墓碑会流回所有者、把所有者的数据删掉);访客写入由**房间**盖 HLC(访客的偏斜/恶意时钟永不进 oplog),归属该访客会话的 guest 子 id;grants 从 `room_config` 快照按 default-deny 解析。所有者用一个独立的 `drt_` secret(常数时间比较)认证,**绝不是主 token**。
- **分区同步**(`sync/partition.ts` + `room-client.ts`):成员集从**物化表当前态**算(行的历史可能跨授权/未授权库,只有它此刻的归属说了算);所有者持 node-local 影子 `room_rows`,每轮 `entered = M − shadow`、`left = shadow − M`,传输失败时**什么都没提交**(游标与影子不动,重试重放同一份 payload,房间侧靠 oplog UNIQUE 幂等);周期性 digest 不一致则全量对账。
- **同一份 handler 两处跑**:`room-serve.ts` 是纯 `Request → Response`,在 workerd 里跑在 `DoSqlDriver`(`src/room/do-driver.ts`)上,在 `bun test` 里跑在 `bun:sqlite` 上;`src/room/driver-contract.ts` 是**一份共享的驱动行为契约用例集**,bun:sqlite 与 workerd 两个 runner 各跑一遍。
- **开通方式**:`mh edge deploy` 支持**用 Cloudflare 登录**(OAuth 2.0 Authorization Code + PKCE,公有客户端;回调落在本机临时 loopback 监听器上,**没有任何官方后端居中代理**),也保留手填 Account ID + API token。诚实注记:CF 的 API token 作用域到**账号**级(Workers Scripts Edit 没有按脚本粒度),所以"只动指定资源"是可在源码里审计的**行为承诺**,不是 token 强制的边界。

## 站点渠道(site channels)控制面

"谁能访问这个站点"由**期望态**驱动:`site_channels`(同步)记 audience × hosting × 期望状态 × 控制器节点,`site_channel_observations`(node-local)记本节点实际执行到哪。**运行成功与否绝不同步**——就绪/报错是节点相对的事实。

- 卡片与对话框上看到的"已上线 / 同步中 / 入口未验证 / 创建中 / 待回滚 / 待清理"由 `src/core/site-channels.ts` 一处派生(纯函数、可移植),UI 文案由 `src/webui/site-status.ts` 一处提供;组合合法性(哪些 传输×权限×类型 组合非法)只在 `assertShareCombo` 一处声明。三份"唯一来源"是不变量,详见 [24-sites-ux-refresh](../impl-context/24-sites-ux-refresh/design.md)。
- **别的设备也能吊销**:不持 Edge 账号凭据的设备只写 `desired_state='revoked'` 并同步,控制器节点上线后完成真正的拆除(`sync/site-channel-reconcile.ts`);控制器本地的分享行(能力秘密)缺失时,渠道显示为**错误**而不是"已撤销"。
- **发布可恢复**:`sync/site-publish-recovery.ts` 记录"本地已回滚、目标 peer 尚未确认到那个 seq"的补偿态,避免半途失败留下一个谁也说不清的公开入口。

## 分享架构

把文档/数据库/站点**作为公开能力链接**对外发布(见 [17-s3-storage-sync](../impl-context/17-s3-storage-sync/design.md) / 记忆 `share-feature-impl`)。分享登记在本机 `shares` 表(node-local、不进 oplog、永不 sync)。三条传输:

- **server**:`mh --server` 在 `/share/<slug>`(token 门禁**前**、原样返回、不套 shim)**实时 SSR**。渲染器 `src/core/sync/share-render.ts` 是 **runtime-agnostic** 的纯字符串 Markdown→HTML(无 DOM/node,既服务器用、也能在静态 viewer 里跑):走**共享行/行内语法**(`core/md/*`,与编辑器/保存三面一致)、按 kind 渲染媒体(`<video>`/`<audio>`/下载卡,图片内联)、每个 URL 过 `safeUrl` scheme 白名单(`allowData` 仅图片/媒体),写进 HTML 属性时再 `escapeHtml`(挡实体编码绕过);`[[doc_id]]` 内链渲染为**惰性文本**(不自动链到目标——目标未必也被分享了)。`share-serve.ts` 按 slug 做访问控制(过期 + 可选密码);`view` 只读、`edit` 接受 guest 节点写入;带 grants 的分享另开 `/share/<slug>/api/*` 访客数据面。
- **s3**:`share-export.ts` 预签名对象存储静态导出 + 独立的**解密 viewer**(`src/webui/share/`),只读、`view` only、链接上限 7 天。E2EE 相关在 `e2ee.ts`/`storage-s3*.ts`。
- **room**:一个 `kind='room'` 的 peer,分区被推进用户自己 Cloudflare 账号里的 Durable Object——**所有者设备离线时链接依然可用**(见上「Edge 子系统」)。删除分享 = 销毁房间(数据的生命周期仍在 CRDT 这边)。

**设备接入(enroll)**:除 HTTP 配对外,挂对象存储桶用 **enroll 码**——`src/core/sync/enroll.ts` 编解码一个**只带访问描述符**的 enroll token(base64url,深链 `#enroll=<token>` / `mh config backup connect --enroll`),`src/webui/enroll.tsx` 提供应用内**扫码取景器**(BarcodeDetector/jsQR + 粘贴/选图/手输兜底),连上后即清除 URL 片段。见 [21-enroll-code-onboarding](../impl-context/21-enroll-code-onboarding/design.md)。

## 信任面架构:数据地图 / 设备名册 / 恢复码

三块回答用户"我的数据安全吗、谁碰得到它、丢了怎么办"的能力,共同的做法是**把散落的存储折算成一个派生答案**,再让 CLI 与 WebUI 共用(见 [25-trust-and-settings](../impl-context/25-trust-and-settings/design.md)):

- **数据地图**(`src/core/data-map.ts`,纯函数 + 可移植;`sync/data-map-db.ts` 是读库包装):把 peers 行 + 同步状态 + blob 账本的 pending 标记 + 同步的 blob 策略折成**一份地点列表 + 一个总状态**(`no_backup` / `pending_blobs` / `unsynced_changes` / `peer_error` / `syncing` / …),`mh status` 与设置页同步头**共用同一份优先级**。只读本地表、**零网络**,所以离线也答得出;桶侧的在线事实(如发布者选举)刻意不在范围内。房间 peer 被排除——它不是"我的数据的一处"。
- **设备名册**(`sync/devices.ts`):设备身份原本散在出站 peers、入站配对凭据、以及 oplog 的**每节点变更流**(纯靠桶加入的设备只在这里留痕)三处;折成一份列表 + 每台设备**诚实的可吊销判定**。**离线优先**:本地 oplog 就是名册(凡是变更到过本机的节点都有行,最大 HLC 就是真实的最后活跃时间);`refreshBucketPresence()` 才去查在线才知道的部分(桶里是否有该节点的段流、发布者心跳是否还活),默认列表不查。
- **换钥与恢复码**(`sync/recovery.ts`):恢复码是桶主密钥 K 的**可打印、抗手抄错**编码——`MH1-` + Crockford base32(K ‖ SHA-256(K) 前 3 字节),共 56 字符、14 组 4;校验位能抓住任意单字符笔误,Crockford 字母表去掉 I/L/O/U 且解码折叠 o→0、i/l→1。**持码即可读全部数据**,卡片上明写这一点。它能重置密码短语(对 `keys/main.json` 做无需解包的重新包裹),也能让新设备在**不知道密码短语**的情况下加入——是"设备全丢 + 短语忘光"的最后兜底。

## PWA 离线架构

浏览器(尤其手机加主屏的 PWA)可启用「离线副本」成为一等 CRDT 同步节点——弱网/离线下查看与编辑**全部**内容(含从未打开过的文档/数据表/托管站点),回网自动合并。完整设计与关键决策见 [impl-context/16-pwa-offline](../impl-context/16-pwa-offline/design.md);要点:

- **立场:全量副本,不是请求缓存。** 否决了 REST 变更队列(块级合并退化整文档 LWW、客户端复刻冲突逻辑)与手写 IndexedDB 物化器(fork `crdt.ts` 语义必漂移);浏览器在 OPFS 跑 sqlite-wasm + **同一份 core**,离线编辑/冲突合并/历史/FTS 搜索都是既有代码换运行时。
- **分层**:`/mh-runtime.js` 注入运行时(token shim + SW 注册 + RPC 桥)→ Service Worker(壳缓存 + 离线网关)→ `ReplicaBus`(Web Locks 选主 + BroadcastChannel 跨标签代理,sahpool 单连接故一浏览器一 worker)→ db-worker(`WasmDriver implements DbDriver`,SAVEPOINT 嵌套事务)。
- **本地优先门面**:`api.ts` 导出的 `api` 是 Proxy——副本启用**且完成首次全量水合**后数据方法走本地,否则逐调用回落 HTTP(永久保留;管理面恒走 HTTP)。水合前绝不展示半空库。
- **编辑语义**:本地路径不带 `if_match`(单写者不自我竞争;stale 是 HTTP 模式概念);远端变更经 `synced` 事件触发编辑器/表格的原位合并刷新(先 flush 未保存键入,块级 CRDT 兜底)。
- **SW 网关**:`/api/*`、`/sites/*` 网络失败→映射为副本 op→经 MessageChannel 问页面 client 执行;**非 GET 永不超时竞速**(防双写);离线直开从未访问的站点走「自举壳页」——壳页自己从副本拉真实 HTML 并 `document.write` 原位替换。解锁页带 `x-mh-unlock` 头,SW 拒缓存(否则离线启动被砖)。
- **约束**:需要 secure context(HTTPS 或 localhost;`--tls-cert/--tls-key` 直出或 Caddy/Tailscale Serve 反代,iPhone 需受信证书)+ OPFS(Safari 17+);iOS 非主屏访问有 ~7 天存储回收,主屏豁免。站点 blob 编码文件字节不进 oplog,离线 404。
- **踩坑规约**:SW 源文件顶层变量禁用与 WorkerGlobalScope 属性同名的标识符(打包降级 `var` 会把原型 getter 遮蔽成 `undefined`,worker 评估期即死且页面无报错);SW 注册失败必须 `console.warn`。

## 历史与回滚架构

oplog 是 append-only 的,历史是纯读侧能力(`src/core/history.ts`,见 [15-history-rollback-compaction](../impl-context/15-history-rollback-compaction/design.md)):

- **重建**:时点 T 的状态 = 每个 register 取 `hlc ≤ T` 的最大值(与头部物化同一条 LWW 规则);文档经 `serializeDocBlocks` 还原正文,legacy body 寄存器按 `isBlockManaged` 同款规则回退。
- **修订聚簇**:按 `txn` 分组(无 txn 的存量数据退回 node+时间间隙启发式);聚簇是 oplog 内容的纯函数,各端视图一致。
- **回滚 = 正向写入**:重建旧状态 → diff → 作为新 emit 写回(文档复用 `updateDocument` 的块 reconcile 与 `if-match`),不删改 oplog,随 sync 收敛;revert 自身是 kind=revert 的新修订。
- **schema 回滚**:`revertProperty` 直接 emit 寄存器恢复列定义(不走 `updateProperty`,避免其改类型级联再次清格),单元格凭共享 txn 区分"级联清格"与"用户后写",只恢复前者。

## 存储压缩架构

`mh compact`(`src/core/compact.ts`)做保留窗口式 oplog 压缩:窗口外每 register 只留"截止点胜者"。四条承重不变量:只删 LWW 输家(收敛不变)、墓碑胜者存活(不复活)、保护 `MAX(rowid)` 行(防 rowid 复用跳 peer 游标)、纯本地不复制(各节点独立清理)。配套 blob GC(引用集 = 剩余 oplog `site_files.content` ∪ 物化行 ∪ `doc_blocks` 里 `/blob/<hash>` 文档插图,见 [22-blob-sync](../impl-context/22-blob-sync/design.md))与 `VACUUM`。代价:窗口外 `history`/`revert` 坍缩为基线。

## 快照架构

快照包是 gzip JSON:

- `changes`: 全量 CRDT oplog。
- `meta`: `node_id` 和 `hlc`。
- `peers`: 同步游标。
- `blobs`: cache 文件的 base64 内容。

恢复有两种模式:

- merge: 将包内 oplog ingest 到当前库。
- reset: 先保存安全快照,再清空领域表和 oplog,重放包内 changes。

两种模式在重建索引后都会跑一次 `repairHub`,把合入数据可能破坏的不变量确定性修好(见下「完整性架构」)。

## 完整性架构

schema 刻意只有主键、无 FK/UNIQUE(per-field LWW oplog 需要前向引用、并发同名存活、幂等回放),完整性改在 core 层做最终一致约束(`src/core/integrity.ts`,见 [13-data-integrity](../impl-context/13-data-integrity/design.md)):

- `validateHub(db)` 只读体检,`repairHub(db)` 确定性、幂等修复(循环到不动点,改动经 `emit()` 进 oplog 随 sync 复制)。
- **两条铁律**:① 修复只针对 tombstone(`__deleted=1`),容忍 absence(可能是尚未到达的前向引用);② 修复是收敛态的纯函数,winner 用全序 `(created_hlc, id)`,故各节点独立修复后既收敛又有效。
- **两层协作**:删除操作(`deleteDatabase`/`removeProperty`/`deleteDocument`)内置写时级联,删除节点一次性 emit,是主路径;`repairHub` 作为事后兜底,处理 sync 引入的坏数据(典型竞态:A 删库时 B 并发往该库建记录)。
- **触发时机**:`restoreSnapshot`(merge+reset)后自动跑;`mh doctor`/`mh repair` 手动触发;**不**在每次 `/sync` 后自动跑(避免重扫描与修复 op 抖动)。

## 当前暂缓边界

以下问题存在,但当前用户体验复盘中暂不作为优先级核心:

- 同进程或多进程并发写入的 SQLite lock 体验。
- 同步服务和快照导入的安全边界。
