# 交接文档 · S3 哑存储同步

> 用途:新开会话时,先读这一篇即可同步进度与 context。配套读物见末尾「恢复 context 的读物」。
> 最近更新:2026-06-15。

## 一句话现状

"免公网 IP 的多设备同步" **v1 + Phase A 硬化 + Phase B 移动端成形 + 自动 CORS + 官方壳 CI/CD + 客户端拓扑统一(A–G)+ 副本接桶(H)+ 重输密钥激活本设备直连/单桶状态 UI(I)均已实现**:用 S3 兼容桶(R2/MinIO/S3/**COS**)作哑 store-and-forward 中转,手机/电脑无需公网 IP、无需同时在线即可经桶双向同步。**已对真实腾讯云 COS 端到端验证(集成测试 + 真浏览器全流程 + `PutBucketCors`)。** Phase A(正确性/成本硬化)见 [design.md §13](./design.md);Phase B(无 origin 静态壳 + 扫码接入 + 离线站点)+ 自动 CORS + 官方壳发布(CF Pages + GitHub Actions)+ homelab(origin + 桶兜底)见 [18-no-origin-shell](../18-no-origin-shell/design.md) §9-11;**客户端拓扑/发布者模型 + 统一同步页 + 心跳选举(A–G)+ 副本接桶/homelab 在外兜底(H)+ 重输密钥激活/单桶状态 UI(I)见 [19-client-topology](../19-client-topology/design.md)**(真浏览器 e2e + 真桶多 server 待测)。

## 分支与提交状态

- 分支:`feat/syncv2`
- 已提交里程碑:S3 v1(`24cb273`)→ aws4fetch(`c8b2415`)→ virt-host(`b29bedd`)→ Phase B(`478b305`/`a251d95`)→ 自动 CORS(`0b2bd1f`)→ 壳 CI/CD(`f2e7ae8`)→ 客户端拓扑 A–G(`d4129fa` + 文档 `34e78c0`)→ 副本接桶 H(`4eb64f5`:`peers-routes.ts`/`storage-s3-bun.ts`/`api.ts`/`settings.tsx` + `storage-s3-cors.test.ts`)。
- **未提交**(工作区改动):**I — 重输密钥激活本设备直连 + 服务器非密钥配置下发 + 单桶状态 UI**(`peers-routes.ts`/`api.ts`/`settings.tsx`/`styles.css`)+ 本次文档同步(doc 19 §6/§8/§9 加 I、§10 ⑨;本 HANDOFF)。
- ⚠️ **用户手动提交**:不要自己跑 `git commit`(有交互式 hook)。给提交信息、等用户提交。

## 已完成(v1,6 个任务)

1. **基础层**:`crdt.ts` 加 `changesAfterSeq({onlyNode})`;`schema.ts`/`schema-init.ts` 加 `peers.kind/config` + `storage_cursors`(幂等迁移);`core/sync/e2ee.ts`(WebCrypto E2EE)。
2. **传输内核** `core/sync/storage.ts`:`StorageClient` 接口、段编解码(JSONL→gzip→AES-GCM)、`syncWithStorage` push/pull、`publishSnapshot`+截断、工厂注入。
3. **分发 + Bun 客户端**:`peers.ts` 按 kind 分发 + `addStoragePeer`;`storage-s3-bun.ts`(`Bun.S3Client`),在 `cli/index.ts`、`server.ts` 注册。
4. **CLI**:`mh config peer add --s3 ...`(flag + 向导)。
5. **浏览器**:`storage-s3-browser.ts`(aws4fetch 签名);`db-worker.ts` `runSync` 多 peer 分发 + `addStorageReplica`/`removeStorageReplica`/`listStoragePeers` ops。
6. **WebUI**:`settings.tsx`「同步存储」区块(需先启用离线副本;CORS 失败提示)。

## 验证状态(更新 2026-06-15:含 Phase A/B + 客户端拓扑 A–G)

- ✅ `bun test` **331 pass + 3 skip**(共 334;3 skip = 真桶集成测试);tsc 维持基线 12;`bun build --target browser`(app/sw/db-worker)成功无 Node-only 泄漏;`bun run build:shell` 产出 ~2.76MB 静态壳。
- ✅ **客户端拓扑 A–G**(doc 19):发布者快照(空桶坑回归单测)、`POST /api/peer/s3`、统一同步页(拓扑图 + 窗口/副本 + 模式感知桶 + 两种二维码)、心跳选举(选举单测)、`clientMode()` —— 单测 + tsc + 浏览器包/`build:shell` 全过。
- ✅ **副本接桶 H**(doc 19 §9 H):origin 模式下浏览器副本以 `publish:false` 直连同一桶(在外/server 离线兜底);加桶时 server 经 `POST /api/peer/s3` 的 `corsOrigins` 为浏览器 origin 开 CORS,副本再接入;`putBucketCors` 加 `merge`(并集)+ 纯函数 `buildCorsXml` 6 单测全过。**传输层零改动**(`publish:false` peer 被原语天然支持,且段数阈值收口也不会写整库快照)。**待测**:真浏览器 e2e + 真桶(R2/MinIO/多 server),含停 server 模拟在外、桶里不应出现副本写的快照。
- ✅ **重输密钥激活 I**(doc 19 §9 I):把 H 从"加桶当场才能接桶"解耦为"对 server 任一桶随时重输密钥激活"。`s3PeerViews`/`S3PeerSchema` 扩展非密钥配置(`region`/`prefix`/`accessKeyId`/`encrypt`/`virtualHostedStyle` + 完整 `endpoint`,**永不含** secret/口令),`api.ts` `S3Peer` 同步;`SyncStorage` 改状态感知统一列表(按 url 合并 server/副本)+ 单桶徽章(`服务器后端`/`本设备已直连`/`在本设备启用直连`/窗口 `开启副本可直连`)+ 教学三步条 + 新 `ActivateBucketOnDeviceModal`(只重输 secret);`SyncTopology`「本设备⇢桶」边反映真实直连态;窗口模式也只读显示 server 桶(取消「高级」折叠);no-origin 单主体不变。tsc 维持基线、`bun test`(storage/e2ee/cors)绿;新增 `.peer-tag`/`.bucket-flow`/`.activate-id`。**待测**:真浏览器 e2e(激活 → 停 server 经桶兜底)。
- ✅ **真实腾讯云 COS 端到端验证**:集成测试 `storage-s3.integration.test.ts` 2/2(往返 + 两节点收敛 + provision);**真浏览器(Playwright,no-origin 静态壳)**:扫码深链 enroll → 从 COS 水合 → 写回桶(双向)→ 离线建站/传文件 → `/sites/<name>/` 经 SW 副本 serve → 他端 Bun 节点拉到内容一致。
- ✅ **自动 CORS** 对真实 COS 验证:集成测试 `putBucketCors sets/merges/reads…` 通过(`PutBucketCors` 接受 Content-MD5 + XML;GET-merge-PUT 不重复;收尾恢复 `*`)。
- 验证中**抓到并修了真实兼容性问题**:COS 禁 path-style → 加 virtual-hosted(见 design.md §13);COS 桶名须含 APPID(短名会静默退化 path-style → 404 NoSuchKey)。
- 仍未单独跑:R2 / MinIO 真桶(同一代码路径,COS 已覆盖签名/XML/分页/条件写/CORS)。

## 关键决策速查(及理由)

- **哑存储而非 P2P/中心服务**:oplog 可存储转发,桶只需 list/get/put/del、不跑 metahub 代码、E2EE 后只见密文。设备无需同时在线。
- **每节点只上传自产 ops**(`onlyNode`):各前缀是一条干净变更流,无回声;掐掉 HTTP 协议的回推去重。
- **段名 = 末 rowid 零填充**;拉取游标 per-(peer,node) 存 `storage_cursors`;`HEAD` 文件做廉价"有无新东西"判断。
- **快照/截断**对照 `compact.ts` 不变量:winners-only 基线 + 删自己已被覆盖的旧段,新设备秒水合、桶有界。
- **E2EE 用 AES-GCM 包裹主密钥**(非 AES-KW,跨运行时可移植);口令派生 KEK,新设备凭 桶凭据+口令 解钥。
- **浏览器签名用 aws4fetch**(0 传递依赖、~2.6KB),不手写 SigV4、更不引 AWS SDK。Bun 侧用内置 `Bun.S3Client`。
- **存储 peer 存浏览器副本的 worker OPFS 库**,故 WebUI 加存储要求先启用离线副本。

## 下一步

- **① 真浏览器 e2e + 真桶实测客户端拓扑 A–I**(推荐先做):origin 窗口↔副本切换、配桶走 `/api/peer/s3` 灌满桶、`?token` 二维码扫码即进;**I 重输密钥激活**:对已在 server 配好的桶点「在本设备启用直连」只输 secret 即接桶;**H 在外兜底**:停掉/隔离 server 后,副本仍能经桶 push 自产 edit + pull 他端写入(双向),恢复后 HTTP 与桶两路收敛无重复,且桶里不出现副本写的整库快照;两台 server 并发发布(心跳选举 + HA);R2/MinIO 真桶。对 `mh.tensorix.org` + COS 跑。
- **② 把 api/sw/app 也迁到 `clientMode()`**(doc 19 §10 ⑤,降熵收尾)。
- **③ H 在家时副本对桶的冗余轮询优化**(doc 19 §10 ⑥,可按"server 不可达才走桶"收敛)。
- **④ 只读分享 / 协作 / spaces**:更大愿景,见研究文档落地顺序。

(A–I 已实现,见 [19-client-topology](../19-client-topology/design.md) §9。)

## 关键代码位置地图

- 传输/快照/接口:`src/core/sync/storage.ts`
- 加密:`src/core/sync/e2ee.ts`
- 两个 wire 客户端:`src/core/sync/storage-s3-bun.ts`(Bun)、`src/webui/data/storage-s3-browser.ts`(浏览器/aws4fetch)
- 分发:`src/core/sync/peers.ts`(`syncPeer`/`addStoragePeer`);oplog 过滤:`src/core/crdt.ts`(`changesAfterSeq`)
- CLI:`src/cli/commands/config.ts`;浏览器循环:`src/webui/data/db-worker.ts`;UI:`src/webui/settings.tsx`
- 迁移:`src/core/schema.ts` + `src/core/schema-init.ts`

## 项目约束/陷阱(新会话必读)

- 中文回复;用 Bun(非 node/npm)。
- 前端改动:dev 从源码服务会热重建;dist/编译产物需 `bun run build` 重建。
- WebUI 必须真 Modal/confirmDialog,禁 alert/prompt。
- `CORE_SCHEMA` 是反引号模板串——SQL 注释里禁用反引号(会截断模板,踩过)。
- TS 5.7 把 `Uint8Array` 视作 `<ArrayBufferLike>`,传 WebCrypto/Response 需小心(项目不 gate tsc,但新文件保持 clean)。

## 恢复 context 的读物

1. 本设计文档:`docs/impl-context/17-s3-storage-sync/design.md`(完整设计 + 决策 + 涉及文件)。
2. 路线图/缺口盘点:`~/.claude/plans/rosy-forging-wren.md`(Tier 1/2/3)。
3. 调研全文:hub 文档 `doc_ip-s3-vmcr3l`(`mh doc read ip-s3`)——含方案对比、分享/协作展望、E2EE 密钥分发双轨制。
4. 记忆:`s3-storage-sync-status`(状态 + 开放风险)及 `MEMORY.md` 索引(用户习惯/UI 规范等)。
