# PWA 离线副本与站点离线读写 设计文档

承接 [11-device-pairing-sync](../11-device-pairing-sync/design.md)、[08-agent-sites](../08-agent-sites/design.md)、[07-webui](../07-webui/design.md)。本文记录让浏览器(尤其手机加主屏的 PWA)在弱网/离线下仍能**查看和编辑全部内容**(包括从未打开过的文档、数据表与托管站点),恢复连接后自动同步;同时把「站点页读写 hub 数据」正式化(SDK + 离线网关)。

**核心立场:浏览器成为一等 CRDT 同步节点,而不是给 REST 加离线缓存。** 系统本就只有一套复制原语(oplog + HLC LWW + `/sync` cursor);让浏览器在 OPFS 里持有完整副本、变更先写本地、后台用**现成的** `syncWithPeer()` 与服务器互同步,则离线编辑、块级冲突合并、历史、搜索都不是新功能——是已有 core 代码换个运行时执行。被否决的备选:REST 变更队列回放(把块级合并退化为整文档 LWW、客户端复刻冲突逻辑)、手写 IndexedDB 物化器(fork `crdt.ts` 语义必然漂移)。

## 1. 分层总览

```
浏览器(任意标签页 / 主屏 PWA / 托管站点页)
├─ /mh-runtime.js      注入运行时:token shim + SW 注册 + 离线 RPC 桥 + 冷启动自举
├─ Service Worker      壳缓存(network-first)+ 离线网关(/api/*、/sites/* → 副本)
├─ ReplicaBus          Web Locks 选主 + BroadcastChannel 跨标签代理(单例跨 bundle)
└─ db-worker(仅 leader)sqlite-wasm + opfs-sahpool,跑真·src/core,syncWithPeer 同步循环
                         │
                         └── POST /sync(配对 grant)──> mh --server(又一个普通节点)
```

可移植性的地基(Phase 0):`bun:sqlite` 在 src/core 仅 `db.ts` 一处值导入,其余全部领域模块类型改挂 `DbDriver`(`src/core/driver.ts`,~20 行同步接口);bun:sqlite 的 `Database` 结构性满足之,浏览器侧由 `WasmDriver`(`src/webui/data/wasm-driver.ts`,oo1 API + SAVEPOINT 嵌套事务)实现。schema/迁移拆到 `schema-init.ts`(纯 driver 面),`sites.ts` 的可移植读路径拆到 `sites-core.ts`(blob 解码留服务端——blob 字节存服务器磁盘,不进 oplog,**离线 404 是设计内行为**)。

## 2. 副本生命周期

- **启用(设置页「离线副本」,每设备开关)**:自助配对——页面已持主 token,自己 `POST /api/pair/new` 铸一次性码,worker 兑换成**可单独吊销的 grant**(不发 `self_url`,服务器不会注册不可达的反向 peer),存本地 `peers` 表。grant 在服务端「已授权设备」列表可见/可吊销。环境不满足时区块**不隐藏而是显示具体原因**(纯 http 非安全上下文→无 OPFS/SW,提示配 TLS;或浏览器无 OPFS)——默默消失的开关无法排查(实测手机经局域网 http 访问即踩中)。
- **水合**:`SyncRequest` 新增可选 `limit`(分页,默认 2000/轮)与 `exclude_datasets`(部分副本,协议留好、UI 未开);`changesAfterSeq` 的 cursor 语义:分页未尽停在末行、扫尽跳到高水位(免重扫排除尾)、**永不回退**(防 compact 后回拉)。水合完成前 `replicaActive()` 为 false——**门面继续走 HTTP,绝不让用户看到半空的库**;完成后 `navigator.storage.persist()`。
- **本地优先**:`api.ts` 导出的 `api` 是 Proxy 选择器——`replicaActive()` 且方法有本地实现(`data/local-api.ts`,worker RPC,错误翻成 `ApiError` 同码同状态)→ 本地;否则逐调用回落 HTTP(未启用/水合中/worker 故障/老浏览器,**永久保留**)。管理面(peers/grants/站点上传/version/配对)恒走 HTTP。
- **同步循环**(worker 内):启动 / online / visibilitychange / 变更后防抖 800ms / 可见时 15s 轮询;每轮 pull 后从本地 oplog 高水位差分出 `synced` 事件(零 core 改动)。编辑器收到命中 documents/doc_blocks 的 `synced` → flush 未保存键入 → 本地重读 → version 没变即跳过,变了原位合并刷新(本地路径**不带 if_match**——单写者不自我竞争,stale 是 HTTP 模式概念);表格视图同理(单元格编辑中跳过)。
- **多标签**:opfs-sahpool 单连接 → `ReplicaBus`(`data/replica-bus.ts`):Web Locks `mh-replica-leader` 独占锁,持锁者 spawn worker,其余标签 BroadcastChannel 代理。关键竞态:BroadcastChannel **不回环发送者**,新晋 leader 必须把自己 pending 的广播请求转投本地 worker(becomeLeader drain + 超时兜底)。bus 是 `globalThis` 单例——app bundle 与注入 runtime 同页共存时不得各起一套。
- **停用/重置**:停用=解除配对+清 flags,OPFS 数据保留断点续传;重置=worker `reset` op(close + `poolUtil.wipeFiles()`)。设置页显示 `storage.estimate()` 占用。

## 3. Service Worker(`src/webui/sw.ts`)

- **壳**:`/`、webui.js/css、manifest、db-worker.js、mh-runtime.js → network-first + 3.5s 超时回落版本化缓存(保 dev 刷新即新与「在线必最新」);`sqlite3.wasm` 独立 cache-first(应用更新不重下 1MB);版本号 = 服务端内插的 `sha256(js+css)`,字节变化即触发更新、activate 清旧缓存。解锁页带 `x-mh-unlock: 1`,SW 拒缓存(否则离线启动被砖)。
- **离线网关**:`/api/*` GET 超时/失败 → `api-map.ts`(HTTP→op 映射表,与 routes.ts/local-api 三处同步维护)→ 经 MessageChannel 问页面 client(`{kind:"mh-rpc"}`)→ 副本执行 → 按同一套 code→status 映射回 JSON;**非 GET 永不超时竞速**(放弃一个服务器可能已应用的 POST 再本地重放=双写),只有硬网络失败才转本地。GET 末位回落 `mh-api` 缓存镜像。
- **站点离线**:`/sites/*` 失败 → 解析 name/path → `siteFile` op(`sites-core.getFileRow`,utf8/base64 解码,HTML 注入 runtime)→ Response。**冷启动自举**:导航请求发生时目标 client 尚不存在、又无其他标签应答 → 返回微型壳页,壳页加载 runtime 后 `__mhOfflineBootstrap()` 自己从 bus 取真实 HTML 并 `document.write` 原位替换(window 全局存活,此后页面自身应答自己的子资源/API 请求)。
- **踩坑实录(重要)**:顶层 `const caches = sw.caches` 打包后降级为 `var caches`——SW 全局的 `caches` 是**原型 getter**,`var` 提升先在全局对象创建 `undefined` 自身属性遮蔽之,worker 评估期即死(redundant,页面无任何报错)。诊断靠 CDP `ServiceWorker.workerErrorReported`。规约:**SW 源文件顶层变量禁用与 WorkerGlobalScope 属性同名的标识符**。SW 注册失败一律 `console.warn`,不准静默。

## 4. 注入运行时与 SDK(站点读写正式化)

- `/mh-runtime.js`(`src/webui/runtime.ts`)取代旧内联 shim,注入所有服务端/SW 出口的 HTML(解锁页除外;`--debug` 也注入——离线桥与 token 无关):token shim(同源 Bearer + 401 续期重试)、SW 注册、`mh-rpc` 应答桥(lazy bus,未启用副本回 `unavailable` 让 SW 试下一个 client)、冷启动自举入口。`globalThis` 守卫使 WebUI 页双注入无害。
- `/metahub-sdk.js`(`src/sdk/client.ts`):**可选语法糖,不是强制入口**——REST `/api/*` 永远是公开契约,站点裸 `fetch` 始终有效且自动获得离线能力(runtime+SW 是托管平台白送的)。SDK 提供类型化方法子集(databases/properties/records/documents/search)、`MetahubError`(带 code/status)、自带 token 续期;`import { api } from "/metahub-sdk.js"`。
- **信任模型(显式声明)**:站点与 WebUI 同源,可读 `localStorage("mh_token")`——**任何已发布站点等于持有完整 hub 读写权限**。只发布 agent/用户自产站点;按站点限权需要源隔离(子域名/服务端会话),列为未来工作。

## 5. 资产与构建

六件浏览器资产(webui.js / sw.js / db-worker.js / mh-runtime.js / metahub-sdk.js / sqlite3.wasm)统一三态解析(`assets.ts` 的 `bundleGetter` 工厂:编译内嵌 > dev 按 mtime 重建 > dist 兄弟产物),编译二进制经 `setWebuiBundle()` 注入(wasm 走 `with {type:"file"}`)。manifest + 图标(base64 内嵌)+ TLS 直通(`--tls-cert/--tls-key`,Bun.serve 原生;推荐 Tailscale Serve/Caddy——SW 要求 secure context,iOS 主屏对自签证书不可用)。smoke 脚本断言全部新端点。manifest/icons/sw.js 鉴权豁免(浏览器抓取不带凭证,内容非敏感)。

## 6. 边界与已知限制

- 首次「安装+水合」必须在线完成;此后任意时刻断网均持有完整副本(含未打开过的内容——全量复制,非按需缓存)。
- iOS Safari 对非主屏访问有 ~7 天数据回收;主屏 web app 豁免——iPhone 用户应加主屏。OPFS 需 Safari 17+,不支持则永远走 HTTP 回落。
- 站点 blob 编码文件(>256KB 二进制)字节不进 oplog,离线 404;文档当前纯文本块,无图片缺失问题(将来加图片块需同步预取)。
- token 过期超 37 天:同步提示重新认证,本地读写不受影响。
- 离线写语义:成功=已落本地副本稍后同步 ≠ 服务器已收到;冲突按 CRDT 列级/块级 LWW 合并(写入站点作者文档)。
- 站点离线**发布/上传**、SSE 即时推送、snapshot 水合引导、`exclude_datasets` 的设置 UI:未做,留作后续。

## 7. 验证记录(Playwright 真浏览器 + CLI 双端)

- 三端收敛:浏览器离线改第二段 + CLI 并发改第一段 → 回网自动双向同步 → 双端字节级一致;`mh doc history` 两个 node 的修订清晰可辨。
- 站点闭环:离线打开 `/sites/demo/`(副本 serve)→ 页内 `fetch /api/databases` 读 ✓ → `POST /api/records` 写 ✓ → 重启服务器 → 记录自动同步到服,CLI 可查。
- 水合门槛、解锁页防缓存、`x-mh-unlock`、SW 版本更新、占用显示、sahpool 单连接(双 worker 即错)均实测。
