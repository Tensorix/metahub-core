# 交接文档 · S3 哑存储同步

> 用途:新开会话时,先读这一篇即可同步进度与 context。配套读物见末尾「恢复 context 的读物」。
> 最近更新:2026-06-14。

## 一句话现状

"免公网 IP 的多设备同步"v1 **已实现、312 测试全过**:用 S3 兼容桶(R2/MinIO/S3)作哑 store-and-forward 中转,手机/电脑无需公网 IP、无需同时在线即可经桶双向同步。**唯一关键缺口:尚未对真实桶做端到端验证。**

## 分支与提交状态

- 分支:`feat/syncv2`
- **已提交** `24cb273` ✨ feat(sync): S3 dumb-storage sync — 即 v1 六个任务的全部实现。
- **未提交**(工作区改动):aws4fetch 切换 = `package.json`、`bun.lock`、`src/webui/data/storage-s3-browser.ts`。待提交信息:
  ```
  🔧 refactor(sync): swap hand-rolled browser SigV4 for aws4fetch (0 transitive deps, retires unverified-signing risk)
  ```
- ⚠️ **用户手动提交**:不要自己跑 `git commit`(有交互式 hook)。每完成一块停下、给一行提交信息、等用户提交。

## 已完成(v1,6 个任务)

1. **基础层**:`crdt.ts` 加 `changesAfterSeq({onlyNode})`;`schema.ts`/`schema-init.ts` 加 `peers.kind/config` + `storage_cursors`(幂等迁移);`core/sync/e2ee.ts`(WebCrypto E2EE)。
2. **传输内核** `core/sync/storage.ts`:`StorageClient` 接口、段编解码(JSONL→gzip→AES-GCM)、`syncWithStorage` push/pull、`publishSnapshot`+截断、工厂注入。
3. **分发 + Bun 客户端**:`peers.ts` 按 kind 分发 + `addStoragePeer`;`storage-s3-bun.ts`(`Bun.S3Client`),在 `cli/index.ts`、`server.ts` 注册。
4. **CLI**:`mh config peer add --s3 ...`(flag + 向导)。
5. **浏览器**:`storage-s3-browser.ts`(aws4fetch 签名);`db-worker.ts` `runSync` 多 peer 分发 + `addStorageReplica`/`removeStorageReplica`/`listStoragePeers` ops。
6. **WebUI**:`settings.tsx`「同步存储」区块(需先启用离线副本;CORS 失败提示)。

## 验证状态

- ✅ `bun test` 312/312;新文件 tsc 干净(仓库总错误维持基线 12,全是历史遗留);`bun build --target browser`(app.tsx / db-worker.ts)成功、aws4fetch 进 bundle 无 Node-only 泄漏。
- ❌ **真实桶端到端未验证**——只跑过内存版 FakeBucket。下一步首选:对真实 R2 / 本地 MinIO 跑 `mh config peer add --s3 ...` + 手机 PWA 直连(配好 CORS),验 list/get/put/del 往返 + 跨设备收敛。

## 关键决策速查(及理由)

- **哑存储而非 P2P/中心服务**:oplog 可存储转发,桶只需 list/get/put/del、不跑 metahub 代码、E2EE 后只见密文。设备无需同时在线。
- **每节点只上传自产 ops**(`onlyNode`):各前缀是一条干净变更流,无回声;掐掉 HTTP 协议的回推去重。
- **段名 = 末 rowid 零填充**;拉取游标 per-(peer,node) 存 `storage_cursors`;`HEAD` 文件做廉价"有无新东西"判断。
- **快照/截断**对照 `compact.ts` 不变量:winners-only 基线 + 删自己已被覆盖的旧段,新设备秒水合、桶有界。
- **E2EE 用 AES-GCM 包裹主密钥**(非 AES-KW,跨运行时可移植);口令派生 KEK,新设备凭 桶凭据+口令 解钥。
- **浏览器签名用 aws4fetch**(0 传递依赖、~2.6KB),不手写 SigV4、更不引 AWS SDK。Bun 侧用内置 `Bun.S3Client`。
- **存储 peer 存浏览器副本的 worker OPFS 库**,故 WebUI 加存储要求先启用离线副本。

## 下一步候选(详见路线图 `~/.claude/plans/rosy-forging-wren.md`)

按"距最终目标"分层,Tier 1 是 v1 还没完整兑现原始目标的硬缺口:
- **① 真实桶验证 + 补缺陷**(推荐先做):端到端验证 + 快照 GC(旧快照不回收)+ 推送攒批阈值。
- **② 手机二维码接入**:电脑显示配置二维码、手机扫 + 输口令,免手敲(补"优雅")。
- **③ 静态壳托管**:壳发 GitHub/CF Pages,彻底免服务器(同时解决"首次安装仍需服务器")。
- **④ 只读分享 / 协作 / spaces**:更大愿景,见研究文档落地顺序。

(用户上一轮在"选哪个方向展开"处暂停去澄清,方向尚未敲定。)

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
