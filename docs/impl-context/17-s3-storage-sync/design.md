# S3 哑存储同步(免公网 IP 的多设备同步)设计文档

承接 [11-device-pairing-sync](../11-device-pairing-sync/design.md)(CRDT 推/拉 + 配对鉴权)与 [16-pwa-offline](../16-pwa-offline/design.md)(浏览器成为一等 CRDT 节点)。本文记录给同步加上**第二种传输**:把 S3 兼容对象存储当作哑 store-and-forward 中转,使手机与电脑**无需任何一台拥有公网 IP / 常驻服务器、也无需同时在线**即可双向同步。

**核心立场:对象存储只做 list/get/put/del 四件事,不跑任何 metahub 代码、看不到明文。** 同步的本质是交换 CRDT oplog 增量,而 oplog 天然可存储转发——于是"哑存储"这条通道完全复用既有复制原语(oplog + HLC LWW + 顺序游标),core 一行不改,只在 `peers` 体系外挂一条按 `kind` 分发的搬运通道。被否决的备选:WebRTC P2P(仍需信令/TURN + 双端同时在线)、AWS SDK(浏览器 bundle ~100+ 传递包,严重过重)。研究全文见 hub 文档 `doc_ip-s3-vmcr3l`。

## 1. 背景与目标

现状(11/16):`syncWithPeer()` POST 到对端 HTTP 服务器,出局域网即需公网 IP + 受信 TLS;手机 PWA 无后台同步,等于要求"打开手机那一刻电脑恰好在线可达"。这对普通用户成本过高。

目标:用户注册一个**免费托管桶**(如 Cloudflare R2 免费 10GB)+ 一个加密口令,电脑与手机各自把自产 oplog 段加密上传、拉取对方的段本地合并。电脑关机时手机照常读写本地副本并落桶,电脑开机后收敛。负担从"运维有状态服务器"降级为"注册一个网盘账号"。

**v1 范围**:S3 兼容存储传输 + E2EE(默认开)+ `peers.kind` 分发 + `mh config`/WebUI 入口 + 浏览器直连 + 快照/截断(桶有界、新设备秒水合)。不做:只读分享、协作正式化、spaces、静态壳托管、实时协同(见 §10)。

## 2. 桶布局

```
<prefix>/spaces/default/keys/main.json          E2EE 引导:口令包裹的主密钥
<prefix>/spaces/default/snapshot/<hlc>.snap      winners-only 基线(任一节点发布)
<prefix>/spaces/default/oplog/<node>/HEAD        最新段键(廉价"有无新东西"轮询)
<prefix>/spaces/default/oplog/<node>/<seq>.seg   该节点自产 ops:JSONL→gzip→AES-GCM
```

`spaces/default/` 这一层现在就预留,将来 spaces 细粒度共享不需迁移存储。段文件**只含自产 ops**(`node_id = self`):每个节点前缀恰好是它的完整变更流,无重复、无回声(掐掉了 HTTP 协议里"把拉来的 ops 推回去"靠 INSERT-OR-IGNORE 去重的行为——付费存储不该有冗余写)。段键名 = 批次末 rowid 零填充(16 位),字典序 = 时间序。

## 3. 三条载荷性质(方案成立的根基,均已对照代码核实)

1. `ingest()`(`crdt.ts`)**顺序无关且幂等**(`applyChange` = INSERT OR IGNORE + 全 oplog 重算 winner)——段乱序到达 / 重复下载都无害。
2. 自产 ops 的 **rowid 序 = 追加序 = HLC 序**——推送游标用一个 rowid 数字即可,复用 `peers.push_cursor`。
3. **compaction 兼容**(`compact.ts`):只删被同寄存器更高 HLC 覆盖的行,自产胜者 rowid 必然更大——"未上传即被 compact"的行其胜者必被上传,LWW 照样收敛。

## 4. 段编解码 + E2EE(`core/sync/e2ee.ts`)

段 = `Change[]` → JSONL → gzip(`CompressionStream`,Bun/浏览器通用)→ AES-GCM(明文模式则跳过加密)。E2EE 用 WebCrypto,两运行时通用:

- 主密钥 K:随机 256-bit,本地以 base64 存 `peers.config`(local-only,同 token 信任模型)。
- KEK:`PBKDF2-SHA256(口令, salt, 60万轮)`;`keys/main.json` = `AES-GCM 包裹的 K`(**非 AES-KW**——AES-GCM+PBKDF2 跨运行时都在,AES-KW 支持不齐)。新设备只需 桶凭据 + 口令 即可解出 K,无需设备间传密钥。
- `--no-encrypt`:K=null,段仅 gzip 明文,仅限完全可信存储,配置时显著告警。

## 5. 一轮同步 `syncWithStorage`(`core/sync/storage.ts`)

- **push**:`changesAfterSeq(db, push_cursor, { onlyNode: self })`(`onlyNode` 是为此新增的过滤)→ 非空则编码上传 `oplog/<self>/<pad(endSeq)>.seg` + 更新 `HEAD` → 推进 `push_cursor`。
- **pull**:先 `pullSnapshot`(最新快照比已消费的新才 ingest,游标 `storage_cursors(peer,'__snapshot__')`);再对每个外节点前缀:读 `HEAD` 与本地 `storage_cursors(peer,node)` 比对,无新则跳过(省一次 LIST),有新则 `list(startAfter=cursor)` 增量段 → get+解密+gunzip+ingest → 写回 last_key。
- 返回 `{ pushed, pulled }`,与 `SyncResult` 同形,使 `peers.ts` 状态回写零改动。
- 拉取游标是 per-(peer, 远端 node) 的"已消费文件名",存新表 `storage_cursors`。

## 6. 快照 + 截断(`publishSnapshot`,对照 compact.ts 不变量)

节点自身段数超阈值(默认 200)时:取每个寄存器的 winner(`MAX(hlc)` 行)序列化为快照 → 上传 `snapshot/<maxHlc>.snap` → **删自己前缀下的旧 segment**(此刻所有自产 ops 都已在 oplog 里、被快照取代,完全低于水位故可删,安全性同 compact 不变量①)。各删各的、零协调;两节点并发发快照都合法(各自 as-of 胜者全集)。新设备 = 1 份快照 + 各节点水位后尾段(几次 GET,比 HTTP 分页水合还快);老设备游标已越过被删键,无感。

## 7. kind 分发 + schema(`core/sync/peers.ts`、`core/schema*.ts`)

- `peers` 加 `kind`('http'|'s3')与 `config`(JSON);新增 `storage_cursors(peer_url, node_id, last_key)`。`migratePeers` 用 `hasColumn` 守卫幂等补列,存量游标保留。`config` 含密钥但 `peers` 本就 local-only、永不进 CRDT。
- `syncPeer` 读 peer 行,`kind==='s3'` → `storageClientFor(config)` + `syncWithStorage`,否则 `syncWithPeer`。`syncAllPeers`、自动同步定时器、状态回写全部不动。`addStoragePeer` 写合成 `url = s3://<bucket>/<prefix>`(使既有 rm/enable/disable/sync by-url 全复用)。

## 8. 运行时客户端注入(core 不绑死任一运行时)

`storage.ts` 定义 `StorageClient` 接口 + `setStorageClientFactory()` 注册表(同 `startServer` 的 `ui` 注入思路),`syncWithStorage` 只吃接口。两实现:

- **Bun 侧** `core/sync/storage-s3-bun.ts`:内置 `Bun.S3Client`,零依赖。在 `cli/index.ts` 与 `core/sync/server.ts` 顶部 side-effect import 完成注册(覆盖 CLI 与桌面 sidecar)。
- **浏览器侧** `webui/data/storage-s3-browser.ts`:**aws4fetch**(0 传递依赖、~2.6KB gzip)负责 SigV4 签名,我们只保留 list/get/put/del 包装 + ListObjectsV2 的 XML 正则解析。被 `db-worker.ts` side-effect import(随 db-worker.js 打包,无新增 asset 条目)。
  - **决策**:浏览器侧曾手写 SigV4(~百行),后切到 aws4fetch——把易错的签名(URI/query 规范化、签名头、S3 单次编码 + UNSIGNED-PAYLOAD)交给久经考验的库,消除"自写签名正确性"风险;代价仅 +1 个零传递依赖、~2.6KB。"用成熟库"特指 aws4fetch,**不是** `@aws-sdk/client-s3`(~100+ 传递包、bundle 150–250KB+,对 4 个操作过重)。

## 9. 入口:CLI 与 WebUI

- **CLI**(`cli/commands/config.ts`):`mh config peer add --s3 --endpoint --bucket --access-key --secret-key [--prefix --region --passphrase --no-encrypt]`(flag 路径),与「同步设备」向导里的"添加同步存储 (S3/R2)"(口令用 `p.password`,`--no-encrypt` 带告警);加完立即 `syncPeer` 跑一轮做连通性/凭据 fail-fast。`--no-encrypt` 走 citty 的 `encrypt` 布尔取反。
- **WebUI**(`webui/settings.tsx`):「同步存储」区块,真 Modal、无 alert/prompt。**存储 peer 存在浏览器副本的 worker OPFS 库里**,故该区块**要求先启用「离线副本」**;走 worker ops(`addStorageReplica`/`removeStorageReplica`/`listStoragePeers`,经 `data/replica.ts` 的 `call`)。CORS 失败时显示"给桶配 CORS"的明确指引(`looksLikeCors` 启发式)。
- **浏览器同步循环**(`db-worker.ts` `runSync`):改为 origin http(分页水合,失败不阻断)+ 遍历 enabled s3 peers 走 `syncPeer` 分发;`hasSyncTarget` 让 origin 离线时存储同步照跑。

## 10. 安全模型与已知限制

**安全**:桶凭据守**可用性**(拿到也只看密文/删文件),加密口令守**机密性**(PBKDF2 包裹);均经 HTTPS。桶被攻破 = 同步瘫痪 + 密文泄露,与"网盘被黑"同级。弱口令可离线爆破(桶里同时有包裹的 K 与密文)——文档明示、口令强度检查。静态壳托管下"壳发布者进入信任链",列为未来工作的前提。

**已知限制(更新于 2026-06-14;Phase A 修复见 §13,移动端无 origin 见 [18-no-origin-shell](../18-no-origin-shell/design.md))**:
- ~~首次安装仍需服务器~~ → **已解决**:静态壳托管(免服务器安装),见 doc 18。
- ~~手机接入需手敲凭据~~ → **已解决**:扫码深链 `#enroll`(电脑显示 QR、手机扫 + 输口令),见 doc 18。
- ~~旧快照不回收 / 推送无攒批阈值~~ → **已修**(§13:快照 GC + 攒批 ≥N 条/≥T 秒)。
- ~~空闲轮询 LIST 是请求地板 / 每出新快照整库重下(非增量)~~ → **已收敛**,见 [20-storage-sync-efficiency](../20-storage-sync-efficiency/design.md)(push/pull 拆分 + 反应式副本按需 + daemon 退避 + log-structured 快照:frontier 跳过 + 段保留 + delta 触发)。
- ~~无真实桶集成测试~~ → **已对真实腾讯云 COS 端到端验证**(§13);R2/MinIO 走同一代码路径,未单独跑。
- **仍开放**:E2EE 无换钥/改口令;`exclude_datasets` 部分副本对存储 peer 未接;blob 站点文件(>256KB 二进制)不进 oplog、经桶不同步(浏览器侧 authoring 也只支持 utf8/base64);**存储传输信任模型弱于 HTTP**——对称信任、无逐节点真实性、表达不了只读分享,GCM 仅保 per-object 完整性(挡不住存储侧删段/扣段/重放)。
- **未来阶段**:只读分享 → 整库协作正式化(node→显示名)→ spaces 细粒度共享 → 实时在场感。

## 11. 涉及文件

- 新增:`core/sync/storage.ts`、`core/sync/e2ee.ts`、`core/sync/storage-s3-bun.ts`、`webui/data/storage-s3-browser.ts`(+ `e2ee.test.ts`、`storage.test.ts`、`schema-init.test.ts`,及 `crdt.test.ts` 的 onlyNode 用例)。
- 改动:`core/crdt.ts`(`onlyNode`)、`core/schema.ts` + `core/schema-init.ts`(迁移)、`core/sync/peers.ts`(kind 分发 + addStoragePeer)、`core/sync/server.ts` + `cli/index.ts`(注册 Bun 客户端)、`cli/commands/config.ts`、`webui/data/db-worker.ts`、`webui/settings.tsx` + `webui/styles.css`。
- 依赖:`aws4fetch`(浏览器签名,唯一新增运行时依赖,0 传递依赖)。

## 12. 验证记录

- **单测**(`bun test`,312 全过):e2ee 包裹/解包(错口令拒绝)+ 段加解密 + 防篡改;`changesAfterSeq onlyNode` 只返自产 + 游标单调;迁移幂等;`storage.test.ts` 用内存版 FakeStorageClient 覆盖——两节点**不同时在线**经桶收敛、幂等重同步、明文模式、快照+截断后新设备仅凭"快照+尾段"水合到字节一致、阈值触发自动快照。
- **类型/打包**:新文件 tsc 干净(仓库总错误维持既有基线);`bun build --target browser` 对 app.tsx 与 db-worker.ts 成功,aws4fetch 进 bundle、无 Node-only 依赖泄漏。
- **已完成(2026-06-14)**:对真实**腾讯云 COS** 桶端到端验证通过(集成测试 2/2 + 真浏览器全流程),并据此修了若干正确性/兼容性问题,见 §13。

## 13. Phase A 硬化 + virtual-hosted + 真桶验证(2026-06-14,feat/syncv2)

第二轮 review + 真桶验证驱动,修了 v1 几处**会静默丢数据/抬成本**的隐患,并新增 COS 兼容。测试 325 全过、tsc 维持基线 12、浏览器 bundle 干净。

**正确性(逐条对照代码核实)**:
- **A0-1 push 游标 VACUUM 免疫(最高危)**:`crdt_changes` 加 `seq INTEGER PRIMARY KEY AUTOINCREMENT` + `UNIQUE(dataset,row_id,col,hlc)`;`migrateCrdtChangesSeq` 建表迁移(`rowid→seq` 保留 + 重置 peers 游标做一次性重同步)。根因:compaction 的默认 `VACUUM` 会重排无 INTEGER PK 表的 rowid,而 push 游标是 rowid + `changesAfterSeq` 的「绝不回退」→ 新写 rowid 落到旧游标之下 → **永久不推**。HTTP 同步同享此修。
- **A0-2 主密钥首配竞态**:`provisionMasterKey` 改条件写(浏览器真 `If-None-Match`;Bun `exists()` 预检兜底,`Bun.S3Client` 无原子 CAS),防两台新设备并发初始化互相覆盖主密钥。
- **A0-3 HEAD 崩溃窗口**:push **先写 HEAD 再写 seg**(崩在中间只让消费者多 LIST 一次、不漏段;原顺序会让 HEAD 滞后于已写段而被廉价跳过误跳)。
- **A0-4 快照键唯一性**:`<maxHlc>~<hash>.snap`(内容寻址)+ 消费改**集合游标**,防同 maxHlc 不同内容的并发快照互相覆盖/被跳过。

**成本/带宽**:
- **A1 推送攒批**:`StorageSyncOpts` 加 `minPushChanges`/`maxPushAgeMs`/`forcePush`;db-worker ≥25 条 或 ≥10s 才产段,显式 sync / 切后台 `force` 兜底——消除碎对象(R2/COS 按**请求数**计费)。
- **A2 快照 GC**:`publishSnapshot` 删严格更旧的快照(保住 max-HLC 前沿),桶有界。
- **A2.5 LIST 成本**:`StorageClient.list` 加 `delimiter` 取 CommonPrefixes 拿节点名;段计数 LIST 只在 push 后跑。

**virtual-hosted 寻址(真桶验证逼出来的)**:`S3Config.virtualHostedStyle`(显式)+ `isVirtualHostedStyle`(自动:endpoint 主机名以 `<bucket>.` 开头即启用)。**腾讯云 COS 禁止 path-style**(`PathStyleDomainForbidden`),必须 virtual-hosted(`<bucket>.cos.<region>.myqcloud.com/<key>`);R2/MinIO/S3 仍走 path-style。
- ⚠️ **COS 配置坑**:bucket 字段必须填**完整桶 id `<名>-<APPID>`**(如 `metahub-1252110546`)。填短名会让自动探测落回 path-style → COS 把 `<bucket-host>/<bucket>` 当对象 → `404 NoSuchKey`(看着像"桶里没数据")。

**A3 真桶验证**:`core/sync/storage-s3.integration.test.ts`(env `METAHUB_TEST_S3_*` 守卫,默认 skip)对真实 COS 跑 list/get/put/del 往返 + 两节点收敛 + provision 创建/复用/错口令拒绝;真浏览器(no-origin)全流程见 [18-no-origin-shell](../18-no-origin-shell/design.md)。

**涉及文件(Phase A 增量)**:`core/schema.ts`+`schema-init.ts`(seq 迁移)、`core/crdt.ts`/`compact.ts`(注释)、`core/sync/storage.ts`(攒批/GC/快照键/provision/`delimiter`/`isVirtualHostedStyle`)、`storage-s3-bun.ts`/`storage-s3-browser.ts`(条件写 + delimiter + vhost)、新增 `storage-s3.integration.test.ts`。
