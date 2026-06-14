# 无 origin 静态壳 + 扫码接入 + 离线站点(移动端成形)设计文档

承接 [16-pwa-offline](../16-pwa-offline/design.md)(浏览器=一等 CRDT 节点)与 [17-s3-storage-sync](../17-s3-storage-sync/design.md)(S3 哑存储 + Phase A 硬化)。本文记录让 metahub **无需任何 metahub 服务器**即可在手机上安装、配置、双向同步:PWA 壳从任意**数据盲静态站(CDN)**装上,运行时只跟用户自己的 S3 桶对话。

**核心立场:同一份 bundle 两种部署。** 由 metahub 服务器托管(**origin 模式**,16/11 行为完全不变),或放数据盲静态站(**no-origin 模式**,桶是唯一数据源)。壳**零硬编码域名**——全程 `self.location.origin` + 相对路径,运行时自动探测自己跑在哪。验证:真浏览器对真实腾讯云 COS,双向 + 离线站点全跑通(§8)。

## 1. 背景与目标

现状(16/17):PWA 壳 + 配对来自 origin,首次安装/配对需一台 metahub server 一次性 TLS 可达("免了持续同步的服务器,没免安装一次");手机接入要手敲桶 endpoint/key/口令。

目标:**壳放静态 CDN(免服务器安装)+ 手机扫码即接入 + 之后只跟桶同步**。不引入任何官方数据中继;官方(若有)只交付壳,看不见数据。

## 2. 无 origin 自动探测(B1 核心)

`replica.ts:detectOriginMode()`:探 `/health`,看**响应 body** `{ok:true}`(而非状态码——CDN 的 SPA 回退会把 `/health` 200 成 index.html,只能靠 body 判别)。结果缓存(`mh_origin_mode`):离线重载不误判;网络错时**不缓存、默认 server**,使离线的 origin 用户不会被错丢进 enroll 屏。`isNoOrigin()` 同步读缓存。SW 侧 `swNoOrigin()` 同一套(自己探一次、缓存到 worker 生命周期)。

## 3. 副本优先运行模式(SW + app 门面 + 引导)

- **SW**(`sw.ts`):no-origin 时 `/api/*`、`/sites/*` **走副本优先**(`localRpc`),跳过对 CDN 的网络尝试——否则会吃到 CDN 的 404(合法响应、非网络失败)而把副本遮蔽。origin 模式保持原"网络优先、失败回落副本"。
- **app 门面**(`api.ts` Proxy):`replicaActive()` 时数据方法走本地;**站点管理仅在 `isNoOrigin()` 时走本地**(`localSites`)——origin 模式仍走 HTTP,保住服务端的 blob 大文件上传不回归。
- **`<Root>`**(`app.tsx`):origin → `<App>`(零回归);no-origin 未注册 → `<Enroll>` 屏(读 `#enroll`);已注册 → `startReplica()` + **水合门**(显示"正在从云端水合…",`replicaActive()` 后才进 App,因为无 HTTP 可回落、绝不露半空库)。
- `replica.ts`:`requestSync` 放开(原 gate 在 origin 配对,排除了桶-only)+ `visibilitychange` 双向(可见拉新 / 隐藏 force-flush);`enableReplicaFromBucket(config, passphrase)`(跳过 origin 配对,直接 `addStorageReplica` = provision + 水合)。

## 4. 静态壳托管(B2)

`scripts/build-shell.ts`(`bun run build:shell [--out dist/shell]`):**复用 `serveWebui()`** 把每个资产路径"请求"一遍、响应写成文件(HTML/manifest/`sw.js` 版本戳/打包/wasm/icons 单一真相,零重复)→ 输出 `index.html + webui.js/css + sw.js + db-worker.js + mh-runtime.js + metahub-sdk.js + sqlite3.wasm + manifest + icons/` + Cloudflare `_redirects`(`/* /index.html 200`,真实文件优先)/`_headers`(`Service-Worker-Allowed: /`、wasm MIME)。约 2.7MB。CDN 无 `/health` → 探针自然判 no-origin,无需额外配置。

## 5. 扫码接入(B3)

- **深链** `<shell-origin>/#enroll=<base64url(S3Config 去 masterKey/口令)>`。**系统相机直接打开 URL**(规避 iOS Safari 不支持 BarcodeDetector,无需 app 内扫描器、无新扫描依赖)。**口令不进码**(机密性靠口令);桶凭据放 **fragment**(不上送服务器/CDN 日志,留客户端)。
- **接收端** `<Enroll>`:读 `#enroll` 预填,只输口令 → `enableReplicaFromBucket` → `provisionMasterKey` 用口令解出/创建 `keys/main.json` 的主钥 → 水合 → App。含"添加到主屏"引导(iOS 持久存储/防回收依赖它)。
- **生成端**:`settings.tsx`「同步存储」每行「在手机上打开」→ `QrModal`(`qrcode-generator` 依赖,**壳域名可配** `mh_shell_base`,默认 `location.origin`,适配 LAN/Tailscale)+ db-worker `storagePeerConfig` op 取该桶配置。

## 6. 离线/无 origin 站点(B4)

- **serve**:随副本优先直接工作(SW `serveSiteFromReplica` → `siteFile` op → `sites-core.getFileRow`;HTML 注入 runtime;冷启动 bootstrap 仍在)。
- **authoring**:把**可移植** mutations(`createSite/updateSite/deleteSite/deleteFile/putFileInline/writeFileRow/fileCount`)从 `sites.ts` 搬进 `sites-core.ts`(`sites.ts` 只留 node-only 两块:blob 大文件写 + blob 字节 serve)。db-worker 加 `listSites/listSiteFiles/createSite/updateSite/deleteSite/putSiteFile/deleteSiteFile` ops(`MUTATING` 正则加 `put`);`local-api.ts` 新增 `localSites`,Proxy **仅 no-origin** 路由本地。浏览器侧只支持 utf8 + 小 base64;**超大二进制 blob 仍服务端 only**(浏览器无 blob 存储,`putFileInline` 抛错)。

## 7. 涉及文件

- 新增:`scripts/build-shell.ts`、`core/sync/storage-s3.integration.test.ts`(见 17 §13)、依赖 `qrcode-generator`(仅 QR 生成端)。
- 改动(webui):`data/replica.ts`(探针 + `enableReplicaFromBucket` + `requestSync`)、`sw.ts`(`swNoOrigin` + 副本优先 + `serveSiteFromReplica`)、`app.tsx`(`<Root>/<Enroll>/<Splash>`)、`settings.tsx`(`QrModal` + 在手机上打开)、`data/db-worker.ts`(站点 ops + force + `storagePeerConfig`)、`data/local-api.ts`(`localSites` + `isNoOrigin` 再导出)、`api.ts`(Proxy no-origin 分支)、`styles.css`。
- 改动(core):`sites-core.ts`(可移植 mutations)、`sites.ts`(精简到 blob-only)。

## 8. 验证(真浏览器 Playwright + 真实腾讯云 COS)

localhost 静态壳(no-origin)+ CORS=`*`:
- 扫码深链 enroll → 输口令 → **从 COS 水合** → 侧栏显示电脑端种入的「库/文档」;浏览器新建文档 → 强制同步 → **COS 出现第二个节点段**(双向写回)。
- 无 origin 下建站「demo」+ 传 `index.html` → `/sites/demo/` 经 SW 副本 serve 出该 HTML → **全新 Bun 节点从 COS 拉到 demo + index.html 内容一致**。
- 单测:`putFileInline`(utf8 / 小 base64 / 超大二进制抛错)。`bun test` 325 全过、tsc 维持基线 12、`app/sw/db-worker` 浏览器包 + `build:shell` 均 OK。

## 9. 已知限制 / 未做

- **桌面自动配 CORS**(`PutBucketCors`)未做:`Bun.S3Client` 无此 API(需 raw SigV4),且浏览器侧鸡生蛋——现需手动给桶配 CORS(允许 PWA origin 的 GET/PUT/HEAD/DELETE;测试期可 `*`)。
- **浏览器 QR 视觉 + 真手机扫码**待用户实测(深链接收端已 e2e)。
- **站点 authoring 浏览器侧只 utf8/base64**(blob 大二进制服务端 only,延续既有限制)。
- **信任代价(诚实记录)**:CDN 壳 = **壳发布者进入机密性信任链**(理论上能发一版偷口令的 JS;origin 模式壳来自用户自己的 server 则无此问题)。缓解:开源 + 可复现构建 + SRI / 版本固定(未做)。
- **iOS**:装 PWA 需 HTTPS + 受信证书;加主屏才有持久存储/无 ~7 天回收。Web Push / 真后台同步未做(取舍见记忆 `mobile-landing-design-stance`)。
- **COS 配置坑**(见 17 §13):bucket 须填完整桶 id `<名>-<APPID>`,否则自动探测落回 path-style → `404 NoSuchKey`。
