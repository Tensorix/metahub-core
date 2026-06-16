# Blob 同步:按需字节传输 + 缓存可清账本 + 文档插图

承接 [09-file-sync](../09-file-sync/design.md)(站点文件 / `cache.ts` 内容寻址)、[17-s3-storage-sync](../17-s3-storage-sync/design.md)(S3 哑存储 + master key 加密)、[19-client-topology](../19-client-topology/design.md)(节点=存储+传输、窗口vs副本、桶=工作区后端、发布者租约)、[04-block-level-doc-crdt](../04-block-level-doc-crdt/design.md)(`doc_blocks` 块级 CRDT)、[16-pwa-offline](../16-pwa-offline/design.md)(replica + Service Worker 网关)。

本文把"大资源 blob(文档图片 / 大文件)"从**只同步 hash、字节困在产出机**,升级为**字节按需在节点间流动**:oplog 仍只搬 hash,字节经一个与传输无关的 resolver(本地 cache → HTTP peer → 桶)惰性取回;并据此让用户**安全清理本地缓存省空间**(以一台"全量 blob 设备"为锚),同时新增**文档拖拽/粘贴插图**。

> 性质:决策依据 + 实现记录。**已落地**(feat/syncv2):A(账本/判定/清理)提交于 `acd0e7e`+`1d90ca4`,B(传输)+C(插图)待提交;`bun test` 375 全过(新增 blob 判定 + 图片渲染用例),tsc 维持基线(11 既有错,均 `dist/*` 产物缺失 + `index.ts` citty 泛型),`bun run build` 前端打包过。冒烟:双节点 HTTP 回源(A 传图→B 同步只拿 hash→`GET B/blob/<hash>` 字节匹配、B 缓存回填)、文档插图往返(`POST /api/blob`→嵌入文档→经 `doc_blocks` 往返完好→serve 200)。**待办**:真桶(R2/COS)端到端、浏览器侧离线取图/插图(见 §7)。

---

## 1. 背景:两块空白

- **账本空白**:`cache.ts` 把 ≥256KB 二进制写成 `cache/<sha256>` 裸文件,**无任何 DB 记录**(无 size/refcount/last_access/持有信息);唯一关联是 `site_files.content=<hash>`。
- **传输空白**:oplog 只有 hash,字节从不复制 → 别的设备拿到 hash 取不到字节;浏览器 replica 连解码都做不到(`getFileRow` 注释明写 blob 不 replicate)。

目标(用户诉求):① blob 别在同步网里**急切扩散**,各节点**按需**取;② 本地放 cache、**用户可清掉省空间**但保留访问权;③ 别把 blob 塞满 PWA/浏览器 DB;④ **文档支持上传图片(拖拽+粘贴)**。

## 2. 关键决策

### D1 · 字节内容寻址,规范 hash = sha256 截短 32 hex(128-bit)
- 字节**仅按 hash 寻址**(`cache/<hash>`),传输/presence/cache/清理全部 source-agnostic。
- `putBlob` 的 digest 截短到 **32 hex**(`cache.ts` `BLOB_HASH_HEX`/`blobHash`):缩短 doc markdown `![](/blob/<hash>.png)` 的噪声,碰撞概率 ~N²/2¹²⁹ 可忽略。
- `getBlob`/`resolveBlob` 按"引用里携带的字符串"寻址 ⇒ **长度无关**,旧 64-hex 引用继续可解,仅新 `putBlob` 输出 32-hex。校验用 `verifyBlobBytes`(`sha256Hex(bytes).slice(0, hash.length)===hash`,兼容两种长度)。

### D2 · 引用是并集,不是单一来源
- `referencedHashes(db)` = `site_files`(encoding=blob)的 content ∪ `doc_blocks.text` 里 `/blob/<hash>` 的提取(`blobRefsIn`)。驱动 GC 与全量设备的字节获取。
- **同步修了既有 `compact.ts/gcBlobs`**:原来只认 64-hex 文件名、且只扫 `site_files.content`——截短 hash 会让它漏删、文档插图会被压缩误删。现 gcBlobs 认 32|64-hex 且补扫 doc_blocks 的 `/blob/` 引用。

### D3 · 传输 resolver:本地 → HTTP peer(`?local=1` 防递归)→ 桶
- `resolveBlob(db, hash)`(`blobs.ts`):本地 `getBlob` → 各启用 HTTP peer `GET /blob/<hash>?local=1`(带 peer.token)→ 各 s3 peer 的桶 `blobs/<hash>`。取到必 `verifyBlobBytes`,按引用 hash `putBlobAt` 落盘 + `recordBlob`。
- **serve 两态**(`blob-routes.ts` `serveBlob`):默认 resolve(浏览器 `<img>`/远端按需回源);**`?local=1` 只查本地、不再 resolve**——peer 间取用此参,杜绝 A→B→A 取回环。
- 桶读写(`storage.ts` `putBucketBlob`/`getBucketBlob`):`<base>/blobs/<hash>`,复用 master key `encryptBytes`/`decryptBytes`,`ifNoneMatch` 去重;与 oplog 段/快照同桶但**独立 namespace,sync 轮次从不 list**。

### D4 · 可清安全锚:指定 1~N 台"全量 blob 设备" + 同步 presence 表
- 清理安全的前提是一条不变量:**只清已在指定全量设备上持有、之后还能回源的 blob;唯一副本绝不清。**
- `blob_policy`(同步,单行)记 `full_nodes`(1~N 台)+ `redundancy`(`all`/`any`);`blob_presence`(同步)**仅全量设备署名**其持有。普通设备 `isClearable` = 纯本地、**可离线**判定。
- **为何"记几台指定全量设备"而非"记所有缓存持有者"**:后者与本功能目标(人人清缓存)反相关——presence 随淘汰反复翻转、刷屏复制 oplog、且 snapshot 压不掉 churn;前者作者集有界稳定、snapshot 一压一个 cell。冗余靠"指定 2 台 + `all`"获得,而非追踪全网持有者。
- 风险正视:presence 是**信任声明**,全量设备真丢字节而别处已清 = 真丢;故全量设备只在**持久落库后**署名、不 GC 仍被引用的 blob。

### D5 · 图片一律 blob(不再 base64 inline 进 oplog)
- `image/*`(svg 除外,svg 当文本)**不论大小**都走 `putBlob`、只同步 hash(`sites.ts` 调整判定 + 新 `isImageType`)。保持 oplog/每台 OPFS 精简,契合"别撑爆浏览器"。代价:小图离线也得靠 cache 命中(由 §7 浏览器侧补)。

### D6 · 文档插图 = markdown `/blob` 进 doc_blocks,零 core schema 改动
- 插图 = 普通 `doc_block`,文本 `![原文件名](/blob/<hash>.<ext>)`(`alt` 写文件名→Agent 读 alt 即懂语义,不必读 hash)。`parseDocBlocks/serializeDocBlocks` 当普通块,随 `doc_blocks` 正常同步、同图去重——**core 不动**。
- URL 用真实路径 `/blob/<hash>.<ext>`(**非** `blob://`:`blob:` 是浏览器 Object URL 保留 scheme,`<img>` 不认且不可移植);serve 的 content-type 由 URL 后缀 `inferContentType` 定。
- 上传走**新 `POST /api/blob`**(`blob-routes.ts`),区别于 `/api/site/file`:**只存内容寻址字节、不建 `site_files` 引用行**——引用只在 doc markdown,避免双重引用(与"不加引用表"一致)。
- 渲染:`markdown.tsx` `inlineToHtml` 加 `![alt](url)`→`<img class="doc-img">`、`htmlToInline` 回写 `<img>`→`![alt](src)`;编辑器 `editor.tsx` 粘贴(`clipboardData.items` 图片)/拖拽(`.editable` 上的 `dataTransfer.files` 图片)→ `api.uploadDocImage` → 插入图片块。`.doc-img` CSS 限宽圆角。

### D7 · 清理手动为主 + 全量设备后台维护
- 清理触发**手动为主**(Settings「存储」面板 + `mh cache`),不做自动 LRU、暂不做 pin。
- 全量设备的字节获取/上桶/署名在 server **sync-tick 节流跑**(`blobMaintenance`,60s 一次):拉全缺失的被引用 blob(经 resolver)→ 幂等 `announcePresence`;把持有的被引用 blob 上桶(`ifNoneMatch` 去重)。NAT 后生产者若挂桶也机会性自传,使全量设备可从桶拉到。

## 3. 实现落点

| 层 | 文件 | 内容 |
|---|---|---|
| schema | `src/core/schema.ts` | `blob_cache`(本地) / `blob_presence` / `blob_policy`(同步)|
| oplog | `src/core/crdt.ts` | `DOMAIN` 注册 `blob_presence`/`blob_policy` |
| 字节 | `src/core/cache.ts` | `sha256Hex`/`blobHash`(截短)/`verifyBlobBytes`/`putBlobAt`/`deleteBlob` |
| 账本/判定/传输 | `src/core/blobs-core.ts`(可移植) | policy、presence(幂等)、`isClearable`、`referencedHashes`/`blobRefsIn`、`blob_cache` 账本、`knownNodes` |
| ↑ node 半 | `src/core/blobs.ts` | `resolveBlob`、`blobMaintenance`、`clearCache`/`gcOrphans`/`reconcileCache`、`announceLocalCache` |
| 桶 | `src/core/sync/storage.ts` | `putBucketBlob`/`getBucketBlob`(`blobs/<hash>`)|
| 路由 | `src/core/sync/blob-routes.ts`(新) | `GET /blob/:hash`(resolve;`?local=1` 仅本地)、`POST /api/blob` |
| 服务器 | `src/core/sync/server.ts` | `/blob/` 鉴权用 `acceptsSyncToken` + 前缀分发 + tick 节流 `blobMaintenance` |
| 站点 | `src/core/sites.ts` / `sites-core.ts` | 图片一律 blob + `isImageType` + serve 刷 last_access |
| 压缩 | `src/core/compact.ts` | `gcBlobs` 认 32\|64-hex + 补扫 doc `/blob/` 引用 |
| CLI | `src/cli/commands/cache.ts`(新) | `mh cache status\|clear\|gc\|full-device\|redundancy` |
| WebUI | `src/webui/server/routes.ts` | `GET /api/blob-cache`、`POST /api/blob-cache/clear`、`POST /api/blob-policy` |
| WebUI | `src/webui/api.ts` / `settings.tsx` | `blobCache`/`clearBlobCache`/`setBlobPolicy`/`uploadDocImage` + 「存储」面板 |
| WebUI | `src/webui/editor.tsx` / `markdown.tsx` / `styles.css` | 插图粘贴/拖拽 + `<img>` 渲染/回写 + `.doc-img` |

**鉴权**:`/blob/<hash>` 像 `/sync` 一样走 `acceptsSyncToken`(master token 或 per-peer grant),故已配对 peer 凭 grant 即可取字节;`POST /api/blob` 走 master-token 门(浏览器上传)。serve 用 `cache-control: immutable`(内容寻址 URL 永不变)。

## 4. 数据流

- **写(产出)**:`putFile`/`POST /api/blob` → `putBlob`(32-hex)→ `cache/<hash>` + `recordBlob`(blob_cache);若本机是全量设备则 `announcePresence`。引用:site 走 `site_files.content=hash`,文档走块内 `![](/blob/<hash>)`。
- **读(消费)**:`<img src="/blob/<hash>.png">` → server `serveBlob` resolve(本地→peer→桶,回填本地)→ 字节 + content-type。peer 间取用 `?local=1` 只查本地。
- **可清**:全量设备经 `blobMaintenance` 拉全字节并 `announcePresence` → 其他设备 `isClearable` 转真 → 用户在 Settings/`mh cache` 清理,字节释放、引用与 hash 留存、再浏览自动回源。

## 5. 验证
- 单测(`bun test`):`blobs.test.ts`(`isClearable` all/any×单多全量×空×本机即全量、presence 经 `ingest` 跨库收敛、`referencedHashes` 并集、`cacheStats`);`markdown.test.ts`(图片渲染/不吞链接);`sites.test.ts`(图片一律 blob,临时 home 隔离);`compact.test.ts`(gcBlobs 认截短 hash + 不误删 doc 图)。
- 端到端冒烟见顶部「性质」。

## 6. 当前离线体验(replica)
- **结构化数据全可用**(文档/记录/表,OPFS,离线可读写);utf8 + 小号非图片 base64 站点文件可 serve。
- **图片离线全裂**:`sw.ts` 的 fetch 分发**没拦 `/blob/`** → 离线/server 不可达时走默认网络失败 = 裂图;站点 blob 图同理(replica 只有 hash、`siteFileResponse` 误把 hash 当 base64)。数据不丢(hash+markdown 已同步),恢复网络即加载。no-origin 纯桶拓扑下图片在线也不显示(无 server resolve)。

## 7. 待办(下一步)
- **浏览器离线取图**:SW 拦 `/blob/<hash>` → 浏览器侧 resolver(aws4fetch 读桶 `blobs/<hash>` + 解密)→ 写入**有界 Cache Storage LRU**(新 `mh-blob-*` 缓存,不进 OPFS,按配额淘汰);在线优先网络回退。
- **离线 compose 插图**:OPFS **blob spool** 暂存离线产出的字节(浏览器算同款截短 hash)→ `uploadDocImage` 改 spool-first 即时渲染 → 联网/桶可达时 drain 到 `POST /api/blob` 或直传桶 → durable 后下放到可淘汰缓存。spool 即浏览器版"唯一副本/pending",受保护不淘汰。
- 自动配额 LRU 淘汰、pin(离线保留)。真桶 R2/COS 端到端。
