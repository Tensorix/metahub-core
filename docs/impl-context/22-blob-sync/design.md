# Blob 同步:按需字节传输 + 缓存可清账本 + 文档插图

承接 [09-file-sync](../09-file-sync/design.md)(站点文件 / `cache.ts` 内容寻址)、[17-s3-storage-sync](../17-s3-storage-sync/design.md)(S3 哑存储 + master key 加密)、[19-client-topology](../19-client-topology/design.md)(节点=存储+传输、窗口vs副本、桶=工作区后端、发布者租约)、[04-block-level-doc-crdt](../04-block-level-doc-crdt/design.md)(`doc_blocks` 块级 CRDT)、[16-pwa-offline](../16-pwa-offline/design.md)(replica + Service Worker 网关)。

本文把"大资源 blob(文档图片 / 大文件)"从**只同步 hash、字节困在产出机**,升级为**字节按需在节点间流动**:oplog 仍只搬 hash,字节经一个与传输无关的 resolver(本地 cache → HTTP peer → 桶)惰性取回;并据此让用户**安全清理本地缓存省空间**(以一台"全量 blob 设备"为锚),同时新增**文档拖拽/粘贴插图**。

> 性质:决策依据 + 实现记录。**已落地**(feat/syncv2):A(账本/判定/清理)提交于 `acd0e7e`+`1d90ca4`,B(传输)+C(插图)待提交;`bun test` 375 全过(新增 blob 判定 + 图片渲染用例),tsc 维持基线(11 既有错,均 `dist/*` 产物缺失 + `index.ts` citty 泛型),`bun run build` 前端打包过。冒烟:双节点 HTTP 回源(A 传图→B 同步只拿 hash→`GET B/blob/<hash>` 字节匹配、B 缓存回填)、文档插图往返(`POST /api/blob`→嵌入文档→经 `doc_blocks` 往返完好→serve 200)。**修订(已落地)**:durability 由同步 `blob_presence` 改为本地 `blob_cache.pending`、`blobMaintenance` 只 flush pending(消灭空闲桶风暴)——`bun test` 385 全过,新增 `blob-maintenance.test.ts` 风暴回归;见 D4/D7。**待办**:真桶(R2/COS)端到端、浏览器侧离线取图/插图(见 §7)。

---

## 1. 背景:两块空白

- **账本空白**:`cache.ts` 把 ≥256KB 二进制写成 `cache/<sha256>` 裸文件,**无任何 DB 记录**(无 size/refcount/last_access/持有信息);唯一关联是 `site_files.content=<hash>`。
- **传输空白**:oplog 只有 hash,字节从不复制 → 别的设备拿到 hash 取不到字节;浏览器 replica 连解码都做不到(`getFileRow` 注释明写 blob 不 replicate)。

目标(用户诉求):① blob 别在同步网里**急切扩散**,各节点**按需**取;② 本地放 cache、**用户可清掉省空间**但保留访问权;③ 别把 blob 塞满 PWA/浏览器 DB;④ **文档支持上传图片(拖拽+粘贴)**。

## 2. 关键决策

### D1 · 字节内容寻址,规范 hash = sha256 截短 32 hex(128-bit)
- 字节**仅按 hash 寻址**(`cache/<hash>`),传输/cache/清理全部 source-agnostic。
- `putBlob` 的 digest 截短到 **32 hex**(`cache.ts` `BLOB_HASH_HEX`/`blobHash`):缩短 doc markdown `![](/blob/<hash>.png)` 的噪声,碰撞概率 ~N²/2¹²⁹ 可忽略。
- `getBlob`/`resolveBlob` 按"引用里携带的字符串"寻址 ⇒ **长度无关**,旧 64-hex 引用继续可解,仅新 `putBlob` 输出 32-hex。校验用 `verifyBlobBytes`(`sha256Hex(bytes).slice(0, hash.length)===hash`,兼容两种长度)。

### D2 · 引用是并集,不是单一来源
- `referencedHashes(db)` = `site_files`(encoding=blob)的 content ∪ `doc_blocks.text` 里 `/blob/<hash>` 的提取(`blobRefsIn`)。驱动 GC 与全量设备的字节获取。
- **同步修了既有 `compact.ts/gcBlobs`**:原来只认 64-hex 文件名、且只扫 `site_files.content`——截短 hash 会让它漏删、文档插图会被压缩误删。现 gcBlobs 认 32|64-hex 且补扫 doc_blocks 的 `/blob/` 引用。

### D3 · 传输 resolver:本地 → HTTP peer(`?local=1` 防递归)→ 桶
- `resolveBlob(db, hash)`(`blobs.ts`):本地 `getBlob` → 各启用 HTTP peer `GET /blob/<hash>?local=1`(带 peer.token)→ 各 s3 peer 的桶 `blobs/<hash>`。取到必 `verifyBlobBytes`,按引用 hash `putBlobAt` 落盘 + `recordBlob`。
- **serve 两态**(`blob-routes.ts` `serveBlob`):默认 resolve(浏览器 `<img>`/远端按需回源);**`?local=1` 只查本地、不再 resolve**——peer 间取用此参,杜绝 A→B→A 取回环。
- 桶读写(`storage.ts` `putBucketBlob`/`getBucketBlob`):`<base>/blobs/<hash>`,复用 master key `encryptBytes`/`decryptBytes`,`ifNoneMatch` 去重;与 oplog 段/快照同桶但**独立 namespace,sync 轮次从不 list**。

### D4 · 可清安全锚:本地「待传队列」(`pending`),不再同步 presence
> **修订(已落地)**:初版用同步表 `blob_presence`(全量设备署名其持有,消费者据此离线判定)。**已弃用**,改为下面的本地 `pending` 模型——更简单、无 staleness、离线零网络。原 presence 方案保留在 git 历史。

- 不变量不变:**只清之后还能回源的 blob;本机未备份的产出绝不清。**
- **关键洞察**:判断"能不能清一个本地 blob"需要的信息**本就在本地**——不是"它 durable 吗"(要查桶/同步 presence),而是"**它是不是我自己还没上传成功的产出**"。
- `blob_cache.pending`(**node-local,不进 oplog**):本机产出、尚未确认 flush 到锚(桶,或无桶时的全量设备)的 blob,**是唯一必须保护的**。产出置 1;flush 成功置 0;**取得的缓存直接置 0**。
- `isClearable` = `本机非全量设备 && pending==0 && anchored==1`:**纯本地、可离线、零网络**(读三个本地标记)。
- **修订(按需现查 presence,已落地)**:初版只看 `pending`,对"取来的缓存"默认可回源——但**一处锚都没指定 / 锚上其实没这份**时,该缓存可能是全网唯一副本,清掉就违反本段不变量「只清能回源的」。改为**逐 blob 现查**:`blob_cache.anchored`(node-local 列)由 `verifyAnchorPresence(db)` 写入——**桶**走一趟 `listBucketBlobHashes`(分页 LIST `<base>/blobs/`)、**设备锚**走 `POST /api/blobs/has`(仿 `/blob/` 鉴权);按 `redundancy` 聚合(`any`=∃可达锚含它;`all`=每个指定锚都可达且含它,任一不可达→保守 0)。改策略(`setFullNodes`/`setRedundancy`)即 `invalidateAnchored` 清空所有 `anchored`+`last_verified`,逼重核对。
- **触发**:开存储面板 / 刷新按钮 / **超配额淘汰前**(`evictToQuota` 仅超额时现查,非每 tick → 避开桶风暴)。**离线退化**:锚不可达 → 该 blob `anchored=0` → 既不可手动清也不被淘汰 → 缓存允许暂时超额,等下个 tick 网络恢复自然补做(**宁可超额,不可丢数据**;不沿用旧 `anchored` 值)。`cacheStats`/`evictToQuota`/`clearCache`/CLI/WebUI 经 `isClearable` 自动跟随。
- 比初版同步 `blob_presence`(staleness、桶风暴)和 pending-only 近似(消费者假定可回源)都更准:现查 = 清理那刻真值、零陈旧;按需 = 不进 60s 循环。
- `blob_policy`(同步)**保留**,只做**锚的指定**(全量设备:永不清 + pull 全量,是无桶拓扑的 durable 落点);`redundancy(all|any)` 现由 `verifyAnchorPresence` **真正生效**(WebUI 控件已恢复)。
- **为何弃 presence**:① presence 把"远端桶/锚的内容"缓存成同步声明,必然可能过期(假性可清);② 它存在的唯一理由是"让任意设备离线随时判断",而清理本是非紧急操作——`pending` 把同一判断变成对**自己动作**的认知,从本机视角**永不过期**;③ **缓存副本不是 durability 责任**(系统故意不保全"生产者没传成就掉线、只靠消费者缓存吊命"的 blob),承认这点后离线本地判定即自洽。

### D5 · 图片一律 blob(不再 base64 inline 进 oplog)
- `image/*`(svg 除外,svg 当文本)**不论大小**都走 `putBlob`、只同步 hash(`sites.ts` 调整判定 + 新 `isImageType`)。保持 oplog/每台 OPFS 精简,契合"别撑爆浏览器"。代价:小图离线也得靠 cache 命中(由 §7 浏览器侧补)。

### D6 · 文档插图 = markdown `/blob` 进 doc_blocks,零 core schema 改动
- 插图 = 普通 `doc_block`,文本 `![原文件名](/blob/<hash>.<ext>)`(`alt` 写文件名→Agent 读 alt 即懂语义,不必读 hash)。`parseDocBlocks/serializeDocBlocks` 当普通块,随 `doc_blocks` 正常同步、同图去重——**core 不动**。
- URL 用真实路径 `/blob/<hash>.<ext>`(**非** `blob://`:`blob:` 是浏览器 Object URL 保留 scheme,`<img>` 不认且不可移植);serve 的 content-type 由 URL 后缀 `inferContentType` 定。
- 上传走**新 `POST /api/blob`**(`blob-routes.ts`),区别于 `/api/site/file`:**只存内容寻址字节、不建 `site_files` 引用行**——引用只在 doc markdown,避免双重引用(与"不加引用表"一致)。
- 渲染:`markdown.tsx` `inlineToHtml` 加 `![alt](url)`→`<img class="doc-img">`、`htmlToInline` 回写 `<img>`→`![alt](src)`;编辑器 `editor.tsx` 粘贴(`clipboardData.items` 图片)/拖拽(`dataTransfer.files` 图片)→ `api.uploadDocImage` → 插入图片块。`.doc-img` CSS 限宽圆角。

> **修订(已落地)· 拖拽落点改容器级 + 就近插入 + 指示线**:旧实现把 `onDragOver/onDrop` **只挂在每个 `.block`** 上,落点不在块上就失效——**空文档**(只有占位 `.editable`)、**块间空隙 / 末块下方 / 标题区**全拖不进,浏览器默认行为接管(导航打开图片)。
> - **决策**:外部图片拖放**全部上移到 `.doc` 容器**(`docRootRef`)统一处理,块级 `onDragOver/onDrop` 只留**内部块重排**;重排 `onDrop` 补 `stopPropagation`,防同一次 drop 既被块处理又冒泡到容器**重复插入**。
> - **就近插入 + 指示线**:新 `nearestTopBlock(root, clientY)` 在 `:scope > .block-wrap > .block`(**仅顶层块**,避免误插入列表子项)里取光标所在/最近的块;复用 `pointer-drag.ts` 的 `markDropHalf`/`clearDropMarks` 画 `.block.drop-before/after` 指示线(CSS 已存在),松手按上下半区插到该块前/后;空文档则 `appendImages` 追加到根。
> - **容器 `onDragOver` 必须 `preventDefault` + `dropEffect="copy"`**,否则浏览器在空隙处显示禁止光标并在 drop 时导航离开页面。`onDragLeave` 仅在真正离开文档(`relatedTarget` 不在 `docRootRef` 内)时清指示线,避免跨块时闪烁。
> - **插入辅助**:抽 `uploadImageMarkdowns`(共享上传链路)+ `insertImagesAt(id, where, files)` / `appendImages(files)`,替代原 `insertImagesAfter`;`onDropFiles` prop 一并移除。源码模式 textarea 本次不处理。
> - **坑**:`onDrop` 不能先 `clearBlockDrop()` 再读 `drop-after` class(class 已被清,`where` 恒为 before)——改用 `markDropHalf` 的返回值定 `where`。

### D7 · 清理 + 全量设备后台维护(只 flush `pending`)
> **修订(已落地)**:`blobMaintenance` 不再每分钟对**所有被引用 blob** 调 `putBucketBlob`。旧设计 = 每个持有 blob × 每个桶 一次「读盘 + 全量 AES 加密 + `ifNoneMatch` HEAD」的**空闲风暴**,纯为确认不可变对象还在桶里而空烧。

- 清理**手动为主**(Settings + `mh cache`)+ 可选**自动配额 LRU**(`evictToQuota`:只淘汰 `isClearable` 且非 `pinned`,按 `last_access` 降到低水位)。
- `blobMaintenance`(server tick,60s 节流)三件事:① 全量设备 pull 缺失的被引用 blob(经 resolver,O(缺失)、自限,持有后不再取);② **只 flush 本机 `pending`**(`pendingBlobs`,稳态为空 → 近乎 no-op)到各桶,成功后 `setPending(0)` → 变 clearable;③ 配额淘汰。**不再扫已传 blob**,稳态对桶零调用。
- NAT 后生产者若自身挂桶,产出经同一 flush 进桶 → 全量设备可从桶拉到。

## 3. 实现落点

| 层 | 文件 | 内容 |
|---|---|---|
| schema | `src/core/schema.ts` | `blob_cache`(本地,含 `pending`/`pinned`) / `blob_policy`(同步)。**`blob_presence` 已删** |
| oplog | `src/core/crdt.ts` | `DOMAIN` 只注册 `blob_policy`(presence 已删) |
| 字节 | `src/core/cache.ts` | `sha256Hex`/`blobHash`(截短)/`verifyBlobBytes`/`putBlobAt`/`deleteBlob` |
| 账本/判定/传输 | `src/core/blobs-core.ts`(可移植) | policy、`pending`/`isClearable`(本地)、`setPending`/`pendingBlobs`、`referencedHashes`/`blobRefsIn`、`blob_cache` 账本(含 `pinned`)、`knownNodes` |
| ↑ node 半 | `src/core/blobs.ts` | `resolveBlob`、`blobMaintenance`(只 flush pending)、`clearCache`/`gcOrphans`/`evictToQuota`/`reconcileCache` |
| 桶 | `src/core/sync/storage.ts` | `putBucketBlob`/`getBucketBlob`(`blobs/<hash>`)|
| 路由 | `src/core/sync/blob-routes.ts`(新) | `GET /blob/:hash`(resolve;`?local=1` 仅本地)、`POST /api/blob` |
| 服务器 | `src/core/sync/server.ts` | `/blob/` 鉴权用 `acceptsSyncToken` + 前缀分发 + tick 节流 `blobMaintenance` |
| 站点 | `src/core/sites.ts` / `sites-core.ts` | 图片一律 blob + `isImageType` + serve 刷 last_access |
| 压缩 | `src/core/compact.ts` | `gcBlobs` 认 32\|64-hex + 补扫 doc `/blob/` 引用 |
| CLI | `src/cli/commands/cache.ts`(新) | `mh cache status\|clear\|gc\|full-device\|redundancy` |
| WebUI | `src/webui/server/routes.ts` | `GET /api/blob-cache`、`POST /api/blob-cache/clear`、`POST /api/blob-policy` |
| WebUI | `src/webui/api.ts` / `settings.tsx` | `blobCache`/`clearBlobCache`/`setBlobPolicy`/`uploadDocImage` + 「存储」面板 |
| WebUI | `src/webui/editor.tsx` / `markdown.tsx` / `styles.css` | 插图粘贴/拖拽(`.doc` 容器级 drop + `nearestTopBlock` 就近插入 + `markDropHalf` 指示线)+ `<img>` 渲染/回写 + `.doc-img` |

**鉴权**:`/blob/<hash>` 像 `/sync` 一样走 `acceptsSyncToken`(master token 或 per-peer grant),故已配对 peer 凭 grant 即可取字节;`POST /api/blob` 走 master-token 门(浏览器上传)。serve 用 `cache-control: immutable`(内容寻址 URL 永不变)。

## 4. 数据流

- **写(产出)**:`putFile`/`POST /api/blob` → `putBlob`(32-hex)→ `cache/<hash>` + `recordBlob`(blob_cache,**pending=1**)。取得侧 `resolveBlob`→`storeFetched` 记 **pending=0**(缓存)。引用:site 走 `site_files.content=hash`,文档走块内 `![](/blob/<hash>)`。
- **读(消费)**:`<img src="/blob/<hash>.png">` → server `serveBlob` resolve(本地→peer→桶,回填本地)→ 字节 + content-type。peer 间取用 `?local=1` 只查本地。
- **可清**:本机 `blobMaintenance` 把 `pending` 产出 flush 到桶 → `setPending(0)` → `isClearable` 转真 → 用户在 Settings/`mh cache` 清理(或自动配额 LRU），字节释放、引用与 hash 留存、再浏览自动回源。全量设备 pull 全量、自身永不清,作 durable 锚。

## 5. 验证
- 单测(`bun test`):`blobs.test.ts`(`isClearable`:pending 受保护不可清 / flushed+acquired 可清 / 全量设备恒不清、纯本地无需同步、`referencedHashes` 并集、`cacheStats`);`blobs-evict.test.ts`(配额 LRU 只淘汰 clearable、pinned 永留、sole-copy 不动);**`blob-maintenance.test.ts`(计数 FakeBucket:flush pending 后稳态再跑 `blobMaintenance` 对桶零调用 —— 风暴消失回归)**;`markdown.test.ts`(图片渲染/不吞链接);`sites.test.ts`(图片一律 blob,临时 home 隔离);`compact.test.ts`(gcBlobs 认截短 hash + 不误删 doc 图)。
- 端到端冒烟见顶部「性质」。

## 6. 浏览器离线体验(replica)——已落地

> 浏览器离线取图 + 离线 compose 插图 + 节点/浏览器双侧配额淘汰与 pin 已实现。`bun test` 全过(新增 `blobHash32`↔服务端 `blobHash` 对拍、`evictToQuota`/clearCache pinned/setPinned 用例),tsc 维持基线(root 11、webui 0),`bun run build` 前端打包过。SW/IndexedDB 部分待真浏览器 e2e。

- **结构化数据全可用**(文档/记录/表,OPFS,离线可读写);utf8 + 小号非图片 base64 站点文件可 serve。
- **图片离线取图**:`sw.ts` fetch 分发新增 `/blob/<hash>` → `handleBlob`:① 查有界 `mh-blob-v1`(Cache Storage)命中即出;② 有 server 且可达 → 网络回源(`serveBlob` resolve 本地→peer→桶)→存缓存;③ 离线/无 server/server 404(未 drain)→ `localRpc("blobBytes")` 转 DB worker;worker 从 **spool** 或挂载桶(`getBucketBlob` + 解密 + `verifyBytes`)取字节。content-type 由 URL 后缀 `inferBlobType` 定。
- **离线 compose 插图**:`api.uploadDocImage` 在 server 不可达时(replica/no-origin)用 `blobHash32`(WebCrypto,与服务端同款 32-hex)算 hash → 写 **IndexedDB spool**(`durable=0`,唯一副本、绝不淘汰)→ 立即返回 `/blob/<hash>.<ext>`,编辑器即时渲染(SW→worker→spool)。
- **drain**:origin-backed replica 由页面 `drainBlobSpool`(持 master token)在 `online`/下次上传时 `POST /api/blob`;no-origin replica 由 worker `runSync` 末尾 `drainSpoolToBuckets` 直传桶。成功后字节下放到可淘汰 `mh-blob-v1`、移出 spool。
- **配额淘汰 + pin**:
  - 浏览器侧 `mh-blob-v1` 有界(默认 200MB):`blob-store.ts` 用 IndexedDB `meta` 索引记 size/accessed/pinned,超高水位按 LRU 淘汰未 pin 项到低水位(spool 唯一副本不在此列)。
  - 节点侧 `blob_cache` 加 `pinned` 列(本地不同步,迁移走 `migrateBlobCache`);`blobMaintenance` 末尾 `evictToQuota`(`ServerConfig.blobCacheQuotaBytes`,默认 2GB,0=禁用)按 `last_access` 淘汰 `isClearable` 且未 pin 项;手动 `clearCache` 同样跳过 pinned。入口:`mh cache pin|unpin <hash>` + `mh config --blob-quota` + Settings 存储面板(配额/固定显示)+ `POST /api/blob-cache/pin`。
- **作用域**:仅对 `clientMode().hold === "replica"`(含 no-origin)有意义;轻量 window 永远在线打 server。no-origin 离线必须挂桶才能取图(浏览器唯一字节源),没桶 → 404/占位,非 bug。`teardownPwa` 降级时删 `mh-blob-v1`(可重取),保留 spool(IndexedDB)避免丢未 drain 的离线插图。

### 实现偏离记录
- **spool/缓存索引用 IndexedDB,非 OPFS**:plan 写的"OPFS spool"是泛称。改用 IndexedDB object store(`mh-blobs` 库:`spool` + `meta`)——window/worker/SW 三上下文共享同一 origin IndexedDB 且无需 OPFS sync handle(dedicated-worker-only)的笨重。字节存 Cache Storage(`mh-blob-v1`),IndexedDB 只存 spool 字节 + LRU 元数据。

## 7. 待办(下一步)
- 真桶 R2/COS 端到端 + 真浏览器 e2e(replica 离线粘图→刷新仍在→恢复 drain→清缓存尊重 pin)。
- 浏览器侧 pin 已具备底座(`setCachePinned`,LRU 跳过 `meta.pinned`),但尚无编辑器/Settings 入口(replica 的 Settings pin 走服务端 `api.pinBlob`,no-origin 无 server);如需 replica 端 pin UI 再补 worker op + 面板。

## 8. 文档媒体扩展 + 上传护栏 + CLI blob 命令(2026-06-19)

D6 的「文档插图」扩展为**五类块级媒体**(image/video/audio/file/html),字节仍一律 blob、引用仍是 doc_blocks markdown,**core/同步层零改动**(WebUI 侧设计见 07-webui §19):
- video/audio 与 image 同走 `![name](/blob/<hash>.<ext>)`,种类由扩展名区分;file 走普通链接 `[name](/blob/.. "size")`;html 走 ` ```mh-html ` 围栏。GC 锚定不变(`referencedHashes` 扫 doc_blocks 文本里的 `/blob/<hash>`,html 内 `<img src=/blob/..>` 同样被锚)。
- **content-type 正确性**:`sites-core.ts` `inferContentType` 的 MIME 表补 mp4/webm/mov/m4v/ogv、mp3/wav/ogg/m4a/aac/flac 及 zip/csv/doc(x)/xls(x) 等——`/blob/<hash>.mp4` 必须以 `video/mp4` serve,`<video>`/`<audio>` 才播(尤其 Safari 拒 octet-stream);`blob-routes.ts` `ext()` 反查同步补齐,使上传响应 URL 带正确后缀。
- **上传大小护栏**:`POST /api/blob` 先读 `content-length` 超 `MAX_BLOB_UPLOAD_BYTES`(`config.ts`,默认 100MB,`METAHUB_MAX_BLOB_UPLOAD` 可调)即拒(在 `arrayBuffer()` 前,防大文件灌爆内存),读完再校验实际字节。WebUI 另有分级软上限(图 25 / 音视频 100 / 文件 100MB)。

**CLI `mh blob`(`src/cli/commands/blob.ts`,新)** —— 让 CLI agent 与 WebUI 同样能给文档进/出料:
- `mh blob add <file> [--name]`:读字节 → `putBlob` + `recordBlob`(ct 由扩展名 `inferContentType` 推断,pending=1)→ 打印 `{hash,size,content_type,url,kind,markdown}`,human 模式直接给可嵌入的 markdown 行(媒体 `![]()` / 文件 `[]() "size"`)。
- `mh blob get <hash> [--out]`:`resolveBlob`(本地→peer→桶)→ 写文件或原始字节到 stdout(便于管道);未命中抛 `not_found`(exit 3)。
- add 后的 blob 仅在被某文档引用 `/blob/<hash>` 后才免于 GC(`mh compact`/`mh cache gc`)——尽快嵌入(SKILL.md「Media & attachments」已说明)。
- 单测:`src/cli/blob.test.ts`(spawn CLI,add→get 字节往返 + url/markdown/kind + not_found)。
