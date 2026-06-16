# 客户端拓扑 + 发布者模型 + 前端交互(统一心智)

承接 [16-pwa-offline](../16-pwa-offline/design.md)(浏览器=一等 CRDT 节点)、[17-s3-storage-sync](../17-s3-storage-sync/design.md)(S3 哑存储同步)、[18-no-origin-shell](../18-no-origin-shell/design.md)(无 origin 静态壳)。

本文把"看起来有 5 种 client 形态"收敛成**一套不打架的心智模型**,并定义桶的**发布者角色**与各形态的**前端交互**。

> 性质:架构 + 决策依据 + 实现记录。**A–K 已落地**(feat/syncv2;见 §8/§9)——发布者快照、配桶定位数据家、窗口/副本、统一同步页、心跳选举、`clientMode()`、副本接桶(homelab 在外兜底)、**重输密钥激活本设备直连 + 服务器非密钥配置下发 + 单桶状态 UI(I)**、**直连桶 PWA 的“分享→保存”落桶状态(J)**、**添加桶首次验证 fail-fast(K)**均已实现;仍待真浏览器 e2e + 真桶(R2/MinIO/多 server)实测。

---

## 1. 背景:为什么要这篇

实测中暴露三类"乱":

- **空桶坑**:在"浏览器副本"里配桶,推送 0、桶只剩 `keys/main.json`——因为副本是水合来的镜像,`onlyNode` 下无自产 ops 可推,而真正持有全量的 server 没连桶。
- **窗口 / 副本 / 桶配置混淆**:"看一眼"和"留离线副本"被搅在一起;配桶配到了错误的节点。
- **形态发散**:CLI / 浏览器连 server / 自建壳 PWA / 官方壳 PWA / Electron 像 5 套独立体系,难推理。

根因:把"这台客户端怎么拿数据"和"整个 Hub 怎么存"两件正交的事混为一谈。

## 2. 核心模型:节点 = storage + 传输

只有一个一等概念:**节点 = 你数据的一份副本(各自一个库)**。CLI / server / 浏览器 / PWA / Electron 都只是"跑节点 / 看节点的外壳"。

关键澄清:**CLI 和 server 是同一个节点**——`mh` 与 `mh --server` 操作同一个本地库,server 只是把它开到网上让别人连。

节点其实只两类:

- **机器节点**:有真文件系统、直接跑核心 —— 电脑上的 `mh`、Electron 内的 sidecar。可被浏览器当窗口连。
- **浏览器节点**:活在 OPFS —— 开了离线副本的网页 / PWA。

(借鉴 automerge-repo:一个节点 = 1 个 Storage + N 个 Network adapter;"sync server"只是带 storage 的 peer。参考 Tonsky《Local, first, forever》、`crdt-over-fs`:哑存储 + 每节点只写自己的分区 + CRDT 合并,是业内公认解——**原语不动**。)

## 3. 两个正交的选择轴

### 轴 1 · 这台客户端怎么拿数据(每台设备各选)

| | **窗口**(只看) | **副本**(留一份) |
|---|---|---|
| 本地存 | 不存,实时读 | 存完整一份 |
| 前提 | 要能连到 server | 要 https(OPFS) |
| 离线 | ✗ | ✓ |
| 成本 | 秒开、不下载全量 | 首次下载 + 占空间 |
| 适合 | 瞄一眼 / 手机只看 / 数据大 / 同机看 | 主力设备 / 要离线 |

### 轴 2 · 整个 Hub 怎么存与同步(全局一次性)

- **server**:有全量的 host 节点,能被"窗口"实时查。
- **桶**:云端共享副本,**必须有个"发布者"放全量**(见 §5)。

### 主矩阵 · 客户端 × 连什么

| 客户端 | 连 server | 连桶 | = 什么 |
|---|---|---|---|
| 窗口 | ✓ | — | **瘦客户端**:在线看,零下载 |
| 窗口 | — | ✓ | ❌ 无效(桶不能被查询) |
| 副本 | ✓ | — | **离线副本**:本地优先,在家走 HTTP |
| 副本 | — | ✓ | **纯桶副本**:no-origin,免公网 IP |
| 副本 | ✓ | ✓ | **homelab 最佳**:在家 HTTP、在外桶、回家收敛 |

## 4. 五形态 → 落到模型哪里

| 形态 | 其实是 |
|---|---|
| 1. server 的 mh CLI | **host 节点本身**(轴2 的 server);不是 client。本机想看 → 开个窗口连本机 |
| 2. 浏览器访问 server | **窗口**(默认)或 **副本**(显式开"离线副本") |
| 3. 自建壳 PWA(no-origin) | **副本 + 桶**;若也连 server = homelab |
| 4. 官方壳 PWA | 同 3,仅壳谁托管不同(行为完全一样;信任代价见 doc 18 §12) |
| 5. Electron | 内置 **host 节点(sidecar=server)** + 自带一个**窗口**看它(数据在 sidecar,不双存) |

→ 5 个塌成:**host 节点(放数据)** + **窗口/副本(看数据的两种方式)**。

## 5. 桶 = Hub 云后端 + 发布者

### 5.1 为什么必须有发布者(只要用桶就需要)

桶里若只有"每节点自产增量小段",两个问题任何拓扑都躲不过:① 段无限涨 + 新设备从头重放(要有人发**快照**做压缩/秒水合);② 某些副本自己没连桶 → 它们的数据不在桶里(不完整)。

### 5.2 关键洞察:快照本身就是"全库镜像"

`onlyNode` 只约束**增量段**;而 `publishSnapshot` 的 winners-only 基线 = **整库当前态,与作者无关**。所以**只要"数据家"那个节点连桶并发快照,桶里立刻有完整一份**(它的库已收齐所有人经 HTTP 同步进来的数据)——不需要额外造"替别人转推"的机制。

> 发布者 = **数据家那个节点,连桶时负责发整库快照。** 不是新形态,是"用桶"这个选择的必要配件。

### 5.3 谁是发布者:自动,不让用户手选

手选设备又脆(选的设备丢了→桶烂)又多余。规则:

- **有 server** → server 自动当发布者(常开、库最全)。
- **没 server(纯 PWA)** → **租约值班**(见 5.4),在线副本轮流当;全关了就暂不发(数据仍在各自 outbox,下次有人开再补发)。
- 可留**高级覆盖**(如 homelab 钉死某盒子),但非必经选择。

### 5.4 正确性底座 + 值班规则

**底座(最重要)**:**正确性永不依赖"只有一个发布者"。** CRDT + 内容寻址快照(`<maxHlc>~<hash>.snap`,见 17 §A0-4)让并发发布幂等无害:同状态→同 key→同对象;不同→GC 留最新。**零协调也不会错**;租约只为省重复 PUT/带宽。

**值班(在哑桶上用条件写做租约,复用 provision 的 `If-None-Match`/`If-Match`)**:

| 规则 | 内容 |
|---|---|
| 资格 | 有全量 + 主钥 + 能写桶的节点(副本/server);**窗口无资格** |
| 优先级 | 节点自报权重:server > 桌面 > 笔记本 > 手机(可覆盖) |
| 抢占 | 租约空了/过期了才抢;**条件写**抢防并发 |
| 错峰退避 | 高优先级立刻抢,低优先级等正比于"优先级差"的退避 → 常开 server 几乎总当班 |
| 续租 | 值班者按 TTL(如 5min)周期续写;不续=下台 |
| 故障转移 | 值班者掉线→租约过期→别人接手(延迟 ≈ TTL + 退避) |
| 安全网 | 即便短暂双值班,靠底座幂等无害 |

### 5.5 多 server = 高可用,不是问题

多个 server = 多个有全量的可发布节点,和"多个 PWA"同类。底座保证并发发布安全;租约让它们轮流值班、互为故障转移。**多 server 反而白送 HA**(一个挂了另一个顶上,桶常新)。

## 6. 前端交互

前端只有两块积木:**①首开/连接流** + **②一张自适应「同步」设置页**。五场景是这两块的不同填法。

### 6.1 逐场景

| 场景 | 首屏/入口 | 默认形态 | 连接输什么 | 离线 |
|---|---|---|---|---|
| 1. server CLI | 无 GUI(终端);它 serve 的网页=场景 2 | 数据家本身 | 无(本机所有者) | 本地库永远可用 |
| 2. 浏览器连 server | 开 server 域名 → 新浏览器过一次 server token(扫带 `?token=` 的码可免输)→ 进 | **窗口** | server token(一次) | 窗口✗ / 副本✓ |
| 3. 自建壳 PWA | 开壳 → Enroll(扫码/填桶)→ 输**加密口令** → 水合 | **只能副本** | 加密口令(一次) | 本地优先,完整可用 |
| 4. 官方壳 PWA | 同 3 + "此壳由官方托管"提示 | 同 3 | 同 3 | 同 3 |
| 5. Electron | 启动即进(内置 sidecar,localhost 自动鉴权) | 对自带 sidecar 是**窗口**(不双存) | 无(localhost) | 永远可用(server 在本地) |

**三个把"乱"按住的 UX 决定**:
1. 能连 server 默认**窗口**(秒开、零下载);"留离线副本"是**显式开关**,绝不自动下全量。
2. **配桶永远配到"数据家"那个节点**(场景 2/5→server/sidecar;3/4→本机);这是自然结果(你看的就是那个数据家),不是偷偷重路由。origin 下 server 是桶配置真源,浏览器(含窗口模式)只读镜像其桶列表;副本想直连某桶在外兜底,**只需对该桶重输一次密钥**(密钥永不下发,见 §9 I)。
3. **发布者全自动**(租约),前端基本不露,顶多只读状态一行。

### 6.2 自适应「同步」页(一个页面,按场景换内容)

```
┌ 同步 ─────────────────────────────────┐
│ 数据家:  〔这台 server / 本设备 / 本应用〕    │
│ 这台设备: ◉ 窗口(只看)  ○ 留离线副本        │  ← 仅"能连 server"可切;no-origin 锁副本
│           (副本+server:加桶时自动也接入桶,在外兜底) │  ← 已实现为自动(H),非勾选
│ 云端副本(桶):                             │
│   状态:已接入 / 未接入                      │
│   发布者:server(自动) / 轮值中…(只读)      │
│   [配置桶…] → 配到"数据家"那个节点           │
│ 设备/线路: [在手机上打开 ▣QR] [配对设备…]      │  ← QR 随场景:窗口=`server/?token=`;no-origin=`壳/#enroll=桶`
└───────────────────────────────────────┘
```

- 场景 2(窗口):数据家=这台 server;设备切换可见;配桶→server;QR=`server/?token=` 链(扫码即进)。
- 场景 2(开了离线副本):新建桶时副本随手以非发布者(`publish:false`)接入(密钥在手);对已在 server 配好的桶,则点该桶的「在本设备启用直连」**只重输密钥**激活(见 §9 H/I)。在外/server 离线时经桶兜底。每个 server 桶一行,徽章标 `服务器后端` / `本设备已直连` / `在本设备启用直连`(窗口模式则 `开启副本可直连`)。
- 场景 3/4(no-origin):数据家=本设备;设备切换锁死副本;桶=后端;QR=`壳/#enroll=桶` 链 + 对方输口令。
- 场景 5(Electron):数据家=本应用;配桶→sidecar;加设备走 QR/配对。
- 场景 1(CLI)等价物:`mh config peer add --s3`(配桶+自动当发布者)、`mh config peer list/sync`。

## 7. 硬约束(物理限制,绕不过)

- **窗口必须有能连的 server**(桶给不了"在线看")。
- **只有桶 → 只能副本**(要看就得下载重建)。
- **副本要 https**(OPFS/SW/WebCrypto);窗口纯在线**裸 HTTP 也行**(见 18:secure context 要求)。
- 故"手机只想轻量看大数据"需要一台能连的 server;纯桶给不了。这也是 server 除"快"之外的独立价值。

## 8. 实现状态(2026-06,A–K 已落地)

整套 A–G + H(副本接桶)+ I(重输密钥激活 + 非密钥配置下发 + 单桶状态 UI)+ J(分享→保存落桶状态)+ K(添加桶首次验证 fail-fast)已实现(`bun test` 全绿、tsc 维持基线、浏览器包 + `build:shell` 干净)。仍待真浏览器 e2e + 真桶(R2/MinIO/多 server)实测。

## 9. 清单(已完成)

- [x] **A. 发布者快照**:`storage.ts` `StorageSyncOpts.publish`/`snapshotMinIntervalMs`;`syncWithStorage` 在 publish 时按"桶无快照 / 数据超最新快照 frontier 且超最小间隔 / forcePush"发整库 `publishSnapshot`,与自产段数解耦。**空桶坑回归单测**(发布者无自产 ops 也发整库快照)。
- [x] **B. 配桶定位数据家**:`peers.ts` 抽 `addAndSyncStoragePeer`(CLI + HTTP 共用),`S3Config` 加 `publish`/`priority`,`syncPeer` 透传;新增 `POST /api/peer/s3` + `GET /api/peers/s3`(`peers-routes.ts`,无密钥外泄);`api.ts` `addServerS3Peer`/`listServerS3Peers`。**安全网**:浏览器副本 `addStorageReplica` 默认 `publish:true`(priority 10),即便配错地方也不空桶。
- [x] **C. 统一「同步」页**:`settings.tsx` `SyncTopology`(拓扑小图)+ 这台设备(窗口/副本卡片,= D)+ 云端副本(桶,按模式定位 server/本机)+ origin 的「在手机上打开」(= E);origin-only 显示 HTTP 配对 + 已授权设备;`styles.css` 加 `.sync-topo/.sync-chip/.sync-link/.sync-pub/.sync-holds`。
- [x] **D. 窗口 vs 副本显式开关**:`.theme-card` 两卡;no-origin/裸 HTTP 走禁用+解释;Electron 隐藏。
- [x] **E. origin `?token=` 二维码**:`originEnrollUrl` + `OriginQrModal`(`currentToken()` from api.ts,服务器地址可配 `mh_server_base`)。
- [x] **F. 发布者协调**:`publisher-lease.ts` —— **改用"心跳选举"而非 CAS/`If-Match`**(每候选写自己的 `publisher/<node>.lease` 心跳 + TTL,读全体取确定性赢家=最高优先级、tie 比 node id;过期即故障转移)。正确性靠内容寻址快照幂等兜底,故无需条件写,**比原计划的 ifMatch 更简单**。优先级:server/CLI=100、浏览器=10。多 server 即 HA。**选举单测**(高优先级胜出 + 过期故障转移)。
- [x] **G. `clientMode()` 收敛**:`replica.ts` 加 `clientMode(){dataHome,hold}`,新同步页统一读它(保留窗口模式);api/sw/app 的底层 primitives 不变,可后续增量迁移。
- [x] **H. 副本接桶(homelab 在外兜底)**:origin 模式下「副本 + server + 桶」打通——浏览器离线副本以**非发布者**(`publish:false`)直连同一个桶(推自产增量、拉他人段/快照,**不写整库快照**,发布权仍归 server)。加桶时 server 先配(发布者)并经 `POST /api/peer/s3` 的新入参 `corsOrigins` 为浏览器 origin **best-effort 开 CORS**,副本再 `addStorageReplica({...,publish:false})` 接同一桶;移除/立即同步两侧联动(`settings.tsx`)。`putBucketCors` 加 `merge` 选项(并集,防同桶多 origin 互清),抽纯函数 `buildCorsXml` + 6 个无网络单测。**传输层零改动**:`storage.ts` 的推/拉本就无条件,快照发布和 `snapshotEverySegments` 段收口都受 `publish` 门控,故 `publish:false` peer 天然就是"参与同步但不镜像全库"。约束:桶凭据永不下发浏览器,故副本接桶须用户当场输入凭据+口令——新建桶当场即接,已在 server 配好的桶则经 I 的「在本设备启用直连」**只重输密钥**激活(加桶幂等,重输即"补接")。

- [x] **I. 重输密钥激活本设备直连 + 服务器非密钥配置下发 + 单桶状态 UI**:把 H「副本接桶」从"加桶当场"解耦成"对 server 任一桶随时激活",并把桶的**归属**显式画给用户。
  - **后端(唯一服务端改动)**:`s3PeerViews`/`S3PeerSchema`(`peers-routes.ts`)新增返回非密钥配置 `region`/`prefix`/`accessKeyId`/`encrypt`/`virtualHostedStyle` + 完整 `endpoint`(原仅 host),**永不返回** `secretAccessKey`/加密口令;`api.ts` `S3Peer` 同步。`accessKeyId` 视为非密钥半边可下发(请求头本就携带),secret 仍只存 server。
  - **前端**:`SyncStorage` 改为**状态感知统一列表**——origin 按 `url` 合并 server 桶列表(`listServerS3Peers`)与副本本地列表(`listStoragePeers`);每行徽章 `服务器后端` / `本设备已直连`(绿)/ 行内 `在本设备启用直连` / 窗口 `开启副本可直连`;顶部「教学三步条」(配置在服务器 → 浏览器同步显示 → 副本重输密钥可直连,第③步窗口模式置灰)。新增 `ActivateBucketOnDeviceModal`:只读展示桶身份(endpoint/bucket/掩码 accessKeyId)+ **只重输 secret**(加密再输口令)→ 用非密钥视图组装 `S3Config` 调 `addStorageReplica({...,publish:false})`。
  - **可见性**:取消窗口模式把桶区藏进「高级」折叠 —— server 桶在窗口模式也只读可见(配置真源就是 server);块名 `工作区同步`→`工作区后端`。
  - **拓扑**:`SyncTopology` 的「本设备⇢桶」边反映**真实直连态**——实线 `直连·兜底` 仅当本设备副本确有已激活桶,否则虚线 `经服务器`;no-origin 恒实线 `直连`。
  - **no-origin 不打架**:仍单主体(`本设备发布`),不渲染任何 server/归属/教学元素;`ActivateBucketOnDeviceModal`、`服务器后端` 等均 `noOrigin` 门控为 origin-only。
  - 校验:tsc 维持基线、`bun test`(storage/e2ee/cors)绿。新增 `.peer-tag`/`.bucket-flow`/`.activate-id`(`styles.css`,全走 CSS 变量 + `color-mix`,兼容 dark)。**待测**:真浏览器 e2e(重输密钥激活 → 停 server 经桶兜底)。

- [x] **J. 直连桶 PWA 的“分享→保存”落桶状态**:把“本地已写入、尚未推到直连桶”的状态从 worker 暴露为 `bucketDirty/bucketSyncing/bucketError`;storage push batching 延迟时保持 dirty 并安排短延迟 force flush,页面隐藏/用户点击立即 flush。主界面右上角原“分享”按钮在 dirty 时动画变为“保存”,点击先 flush 当前文档编辑器再强制同步;成功短暂显示“已保存”后回到“分享”,失败保留保存按钮并提示错误。server/sidecar 继续攒批,窗口模式无直连桶时仍只显示分享。

- [x] **K. 添加桶首次验证 fail-fast**:CLI/WebUI 添加 S3/R2 peer 时,首次 sync 失败即抛错并回滚 peer 配置,避免“已连接”但之后一直失败。已有同 URL peer 更新失败时恢复旧配置;手动 sync 仍只返回 `{ok:false}` 供状态页展示。

**与原计划的偏差**:F 用心跳选举替代 `If-Match` 条件写(更简单、零新 client 表面;正确性已被快照幂等保证)。I 把 H 的"加桶当场才能接桶"约束放宽为"对 server 任一桶随时重输密钥激活",并把 server 桶在浏览器侧只读镜像(原窗口模式藏在折叠里)。

## 10. 与 16/17/18 的关系 / 开放问题

- 16=浏览器节点与离线副本;17=桶同步内核与快照;18=无 origin 壳与 Enroll。本文是**把它们统一到一个心智**并补"发布者"与"前端形态"两块。
- 开放:① 真浏览器 e2e + 真桶(R2/MinIO/多 server)实测(含 H 在外兜底:停掉 server 后副本仍经桶双向同步、桶里不出现副本写的快照);② 纯 PWA 全离线时的"无人值班"窗口可接受度;③ 过期 lease 心跳的 GC(目前忽略不删,数量极少);④ 窗口模式下站点(sites)/大 blob 仍走 server(无回归);⑤ G 把 api/sw/app 也迁到 `clientMode()`;⑥ H 在家时副本对桶的冗余轮询优化(可按"server 不可达才走桶"收敛);⑦ 发布者优先级权重暴露(自动判定 vs 用户可调);⑧ B/H 的 server 端点鉴权与 grant 模型;⑨ I 的 `accessKeyId` 下发取舍(当前视为非密钥半边随只读视图下发,以兑现"只重输 secret";若需更严格,激活弹窗可改为同时重输 `accessKeyId`+`secret`,则不暴露 `accessKeyId`)。
