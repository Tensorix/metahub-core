# 桶同步的请求数与带宽收敛(不回退持久性/收敛性)设计文档

承接 [17-s3-storage-sync](../17-s3-storage-sync/design.md)(把 S3 兼容桶当哑 store-and-forward 中转)与 [19-client-topology](../19-client-topology/design.md)(节点=storage+传输、桶=Hub 后端+自动发布者租约)。17 把同步跑通了,但它的请求形态是"**每节点每轮无条件 2 个 LIST + 每远端 1 个 GET、与有无变化无关**",且发布者每 ~60s 出一次整库快照、消费端**每出一次新快照就整库重下**。本文记录在 **不回退持久性与收敛性** 的前提下,把 homelab 常态下的桶**请求数**与**带宽**都降下来。

**核心立场:省请求不能省掉任何一条独立持久化路径。** 多 agent 报告提的 4 条优化里只有"origin 可达就完全不碰桶"被否决——它会砍掉浏览器编辑的独立持久化路径,在 server 掉数据时造成**静默分叉**(§2)。其余按"谁是真正的轮询者"重新定位后落地。

---

## 1. 背景:两类成本

桶按请求计数计费 / 有免费额度(R2 免费层 100 万 Class A/月),成本分两类,本轮都要降:

- **请求数**:空闲轮询的 LIST 是地板。浏览器副本每 15s、sidecar 每 30s 对桶 2 个无条件 LIST(`snapshot/` + `oplog/`)+ 每远端 GET HEAD,**零编辑也照付**。两台设备纯空闲就 ~78 万次/月,逼近 R2 免费 Class A。
- **带宽(更要命)**:发布者每 ~60s 出整库 winners 快照并**删光自己所有段**(`storage.ts` `publishSnapshot`);消费端 `pullSnapshots` 只按 consumed-key 去重、**无 frontier 跳过**——新编辑→新内容 hash→新 key→**整库 GET**。连已追平的客户端也每出一次新快照就重下整库。对大 hub 是灾难。

> **已核实(grep)**:快照节流默认 60s(`snapshotMinIntervalMs ?? 60_000`),且**全仓无生产代码覆盖它** → 实际就是 60s,段寿命 ≤60s。按需消费者(同步间隔常 >60s)于是"每次同步都相当于下载整库"。

## 2. 必须守住的不变量:两条独立持久化路径

一条浏览器编辑 X 到桶有两条路:

- **Path A(中转)**:`B --http--> S(server) --整库快照--> 桶`。受制于 S 存活 + 快照节流。
- **Path B(直推)**:`B --自己的段--> oplog/B/`。只受制于"B 碰一次桶"。

`push_cursor` 是 per-peer 的(`peers` 行),http 推给 origin **不会**推进桶的游标;`publishSnapshot` 只 truncate 本节点自己的段。故 B 的段是桶里一份**独立副本**。

**被否决的强方案①(origin 可达就完全不碰桶)** 只剩 Path A:当 S 在快照落桶前丢盘 / `reset local replica` / 从旧备份恢复时,X 只剩在 B 本地,且所有游标显示"已追平" → **集群静默分叉、不可自愈、无告警**(最坏故障类)。现状靠 Path B 自愈(恢复的 S' 从桶 re-hydrate 读到 `oplog/B/` 拿回 X)。

**∴ PUSH 必须始终保留;只省 LIST-重的 PULL。** 这条贯穿全部改动。

## 3. 改动总览

| 项 | 一句话 | 文件 |
|---|---|---|
| **①** push/pull 拆分 | origin 可达 ⇒ 桶 push-only(跳 PULL),PUSH 永不跳 | `storage.ts` `syncWithStorage`、`db-worker.ts` `runSync` |
| **②** 轮询模型 | 反应式副本取消后台轮询(纯事件驱动);daemon/无-origin PWA 自适应退避(cap 2.5min) | `db-worker.ts`、`server.ts` |
| **②b** ensureFresh | 非反应式消费者(CLI 读、PWA 服务的 site 页)陈旧才阻塞重拉 | `peers.ts`、`cli/fresh.ts`、`get/search.ts`、`db-worker.ts` `siteFile` |
| **④** lease GC | 当选 publisher 顺手删过期满一个 TTL 的 lease | `publisher-lease.ts` |
| **⑤** log-structured 快照 | 段=增量日志、快照=压缩检查点:解耦 force/publish + 消费端 frontier 跳过 + 段保留窗口 + delta-体积触发 | `storage.ts` |
| **⑥** in-flight guard | 同一 peer 同时只跑一轮 sync,避免 HEAD/cursor/snapshot 切面重叠 | `peers.ts`、`server.ts` |

执行顺序:① → ⑤ → ② → ④。③(降 server per-round LIST)经评估**转后续**(§7)。

## 4. ① push/pull 拆分

`syncWithStorage` 加 `opts.pull?: boolean`(默认 true)。`pull=false` 跳过整个 PULL 块(`snapshot/` LIST + `pullSnapshots` + `oplog/` 节点发现 + 段 GET),保留 PUSH 与 200-段阈值截断。PUSH 本身**纯 PUT、零 LIST**。

`db-worker.ts` `runSync`:记录本轮 origin(http)同步是否成功;对每个 s3 peer:

- **origin 成功 且 非 force 且 非该 peer 首轮** → `pull:false`(push-only,只为 Path B 持久性写段)。
- **origin 不可达 / force(含用户主动刷新·查询)/ 该 peer 首轮**(hydration + 校验 creds/CORS + 满足"立即看最新")→ 完整轮次。

首轮用 worker 会话内存的"已做过初始完整同步"Set(**不要**用 `push_cursor==0`——从不推自有 op 的节点 cursor 恒 0 会被误判)。

> 关键现状:origin-backed 浏览器副本**本就**用 `publish:false` 挂桶(`settings.tsx`),它不发快照、不写 lease。所以①对它就是"origin 可达跳 PULL、PUSH 照旧",publish/选举/lease 顾虑天然消失。

## 5. ② 轮询模型:按"有没有 revalidate"分,不是按 publisher 分

**门控**:一个节点**可完全不后台轮询**,当且仅当它是**反应式 WebUI 副本**(db-worker,有 `synced` 事件可在同步落地后更新视图)**且背后没有 CLI**。

- **反应式 origin-backed 副本(db-worker)→ 取消 15s 后台轮询,事件驱动 + 明确保存态**:写 → `schedulePush`(去抖)→ 桶 push-only;online/visibilitychange/手动刷新 → 页面 `sync` RPC(force,完整轮次,已在 `replica.ts` 接好)。storage push 若因 `minPushChanges/maxPushAgeMs` 延迟,worker 保持 `bucketDirty` 并安排一条短延迟 force flush;右上角“分享”按钮动画变成“保存”,用户点击会先 flush 编辑器再强制落桶。收敛性锚在持续轮询的 publisher;副本"被观测时收敛",用户一交互即追平。**已拍板纯按需**:可见但用户不操作时也不前台轮询,挂机请求归零;但本机自产小尾巴最迟一个攒批窗口落桶。
- **publisher(sidecar `server.ts`;无-origin PWA db-worker)→ 保留后台轮询 + 空闲退避**:必须持续拉远端编辑 + 发布,不可消除。sidecar 用 per-peer "next-due" 时间戳;base 30s → 退到 ≤ `TTL_MS/2`(2.5min,与 publisher-lease 一致性对齐)。**用全局"hub 是否推进"(`MAX(seq)` 变化)决定是否跳过 backed-off 的 s3 peer**——本地编辑或远端拉取都即时复位,纯空闲才退避。db-worker 无-origin PWA 同理自适应。

> **为什么 daemon 必须保留轮询**:CLI 读命令(`get`/`search`/`doc`/`record`)只 `openMetahub()` 读本地 DB、**无 revalidate、无 pre-sync**;DB 不被后台喂新 CLI 就读到旧数据且无提示。所以"无后台轮询"只适用于反应式副本,任何 CLI 背后的 daemon 都要轮询(带退避)。

### 上限统一 `TTL_MS/2`(2.5min)的理由

publisher 的 lease/心跳只在"快照该出时"刷新(`due && isElectedPublisher`)。退避若逼近 5min TTL,一个 fallback 下可能成为活 publisher 的节点会让自己的 lease 过期。cap 在 TTL/2 保证两种模式都安全。注意:**这≠快照节流,两个不同 timer。**

## 6. ⑤ log-structured 快照(治"每次都整库下载")

目标形态:**段=增量日志,快照=压缩检查点**。四个子改动:

- **(a) 解耦 force-push 与 publish**:`due` 里去掉 `forcePush`。force 只强制刷段(编辑不滞留),**绝不强制 PUBLISH**——护栏,防②的"用户刷新→force"落到 publisher 触发整库快照风暴。
- **(b) 消费端优先段 + frontier 跳过**:发布快照时算 **per-node HLC frontier** `F[n]=快照内 n 所 author winner 的 max HLC`,存为**小伴生对象** `<snapKey>.vc`(`StorageClient` 只有 list/get/put/del、无 head/metadata 读,故用伴生对象而非 metadata;gzip+AES-GCM 同段编码)。`pullSnapshots` 先 GET `.vc`:**本地 frontier 支配 F ⟹ 跳过整库 body GET**;只有真落后才下整库。`.vc` 还带 `ownSegHigh`(发布者发布时自己最高段键),消费端**真下了**快照后据此把游标推过保留段,避免重拉。
- **(c) 段保留窗口**:`publishSnapshot` **只删超出保留窗口的旧段**(`retainSegments`,默认 40),不删光。落后 < 窗口的消费者继续拉段增量、不被打回整库。桶仍有界(窗口 + 快照 GC)。`snapshotEverySegments` 触发的段收口也是 **publisher-only**: `publish:false` 副本只推 own segments,绝不写 whole-hub snapshot;非 publisher 段 GC 需另设安全机制,不能借整库快照实现。
- **(d) 快照按 delta-体积触发**:`due` 从 60s 定时器改成 `delta >= max(snapshotMinDelta, hub_size × snapshotDeltaRatio)`(delta = `COUNT(hlc > newest_snapshot_hlc)`,纯本地查询)+ 宽松时间上限(`snapshotMaxIntervalMs`,默认 30min)。小 hub→频繁但整库便宜;大 hub→段长寿走增量。

**净效果**:稳态走段(增量),快照退回"新/远落后节点基线 + 收口段体积"本职;只有离线很久者整库下载(那种情况整库本就比重放更省)。

### 6.1 关键实现取舍:pullSnapshots 必须 snapshots-first

`pullSnapshots` 在段循环**之前**跑(快照优先)。**这是正确性所需,不能反过来**:若段优先,一个落后/新消费者会拉到**截断后的"后缀段"**(非前缀)→ 本地按 node 的 max-HLC 升高但缺中间 op → frontier 支配判断**误判**→ 跳过本该下载的快照 → **丢数据**。

snapshots-first 下,增量收益依然成立:**常态连接的消费者在快照发布前就已通过段拉到数据**(配合⑤d 快照不频繁),轮到快照出现时它已支配 → 跳过 body。回归测试按此真实时序验证(先 push 段、消费者拉、再 publish 快照、消费者跳过)。

### 6.2 frontier 支配的正确性

**命题**:本地 per-node frontier 支配快照 frontier ⟹ 本地已含快照所有 winner,跳过安全。

**论证**:winner 的 HLC 每寄存器单调(LWW 无回退);整库 winners 快照是一致切面;消费者对每个 node 的知识或来自 **gap-free 段前缀**(顺序游标),或来自 **整库快照**(给出该 node 截至某 frontier 的所有 winner)——两者都满足"`maxHLC[N]=F` ⟹ 对每个寄存器 R 都已含其截至 F 的值"。故 `∀n: local[n] ≥ F[n]` ⟹ 每寄存器本地值 ≥ 快照值,ingest 该快照零增量。`.vc` 不可读(旧快照/解密失败)→ 回退整库 GET(安全)。

## 7. ②b 非反应式消费者的新鲜度:`ensureFresh`

**统一原则**:非反应式消费者(CLI 输出、PWA 服务的 site 页——渲染完不会 revalidate)用 **staleness-bounded 阻塞同步再出**;反应式 WebUI 视图才用 local-first + revalidate。

`peers.ts` 加 `ensureFresh(db, opts?)`:`age = now - max(peers.last_success_at)`;无 enabled peer → no-op;`age ≤ 阈值`(默认 3min)→ 直接读本地;`age > 阈值` → 读前阻塞同步一轮(`syncAllPeers`,带 8s 超时,超时/失败回退本地)。`last_sync_at` 只表示最近尝试,失败也会更新;失败不会更新 `last_success_at`,所以"刚失败过"不会被误判为新鲜。有 daemon 且同步成功时 age 恒小、恒 no-op,对 agent 批量命令零开销;只在**无 daemon / daemon 掉线且隔了一段时间**才真正触发。env:`MH_OFFLINE`/`MH_FRESH`/`MH_SYNC_MAX_AGE`。

- **CLI**:`cli/fresh.ts` 暴露 `FRESH_ARGS`(`--offline`/`--fresh`)+ `freshDb(args)`,接入纯读路径:`get`/`search`,`db list|get|activity`,`doc list|get|read|history`,`record list|get|history`,`prop list|history`,`site list|files`。写命令不做隐式 pre-sync,避免改变写入延迟模型。
- **PWA siteFile**(`sw.ts` 无-origin 分支 → worker `siteFile` op):服务前按陈旧度 `await runSync(true)`。`runSync` 的在途 promise 已合并,故**一次导航的多子资源只触发一次同步**。

### Site 链路已核实(`sites-core.ts`/`sw.ts`)

- 内联 site 内容(text/小二进制 base64)= 普通 CRDT 数据,走 oplog/snapshot,①②③④⑤**自动覆盖**,无独立 site 桶请求路径。大 `blob` 是 server-only,不进桶(已知限制)。
- 服务 site:server 端从本地 DB 直出(不触发 per-request 同步);有 server 的 PWA network-first(daemon-fresh);**无-origin PWA replica-first 直读本地 DB → 纯按需下会陈旧**,且服务出去的静态 HTML 渲染完非反应式 → 故接 `ensureFresh`。

## 8. ④ 清理 stale publisher lease

`isElectedPublisher` 选举遍历里,当选 publisher 顺手 `del` 掉 `expiresAt < now - TTL_MS` 的 lease(带一个完整 TTL 的 grace,时钟偏移 >TTL 才会误删活节点,且误删仅下次重建、幂等无损)。只由当选者删,避免每个 reader 都 del 造成写放大。

## 9. 配置参数(均有默认,可调)

| 参数 | 默认 | 含义 |
|---|---|---|
| `pull` | true | ① false=push-only 轮次 |
| `snapshotRetainSegments` | 40 | ⑤c 段保留窗口 |
| `snapshotMinDelta` | 200 | ⑤d 触发的最小 delta ops |
| `snapshotDeltaRatio` | 0.5 | ⑤d delta ≥ hub×ratio 触发 |
| `snapshotMaxIntervalMs` | 30min | ⑤d 时间上限 |
| 退避 cap | 2.5min(=TTL/2) | ② sidecar/PWA 空闲退避上限 |
| `ensureFresh` 阈值 | 3min | ②b 陈旧门槛(`MH_SYNC_MAX_AGE`) |
| PWA bucket save delay | 10s | 直连桶副本有未落桶小改动时的自动 force flush 窗口,同 `maxPushAgeMs` |

## 10. 验证

`storage.test.ts` 扩展(`bun test` 全绿;本轮相关浏览器 bundle 通过,全仓 tsc 维持既有 dist/CLI 基线错误):

- **①** push-only 轮次不做 `snapshot/`、`oplog/` 根 LIST,但仍写段。
- **①b** push batching 延迟小批量时返回 pending,force flush 后清零;worker 用它和本地 cursor 驱动“保存”按钮。
- **⑥** 同 peer 并发 `syncPeer` 合并成一轮;server auto-sync 上一 tick 未结束时跳过下一 tick。
- **Path B** 持久性:一条编辑仅经作者自己的段就让全新节点水合(无快照)。
- **⑤b 跳过**:已追平消费者对新快照只读 `.vc`、**零整库 body GET**,仍收敛。
- **⑤b 不丢**:落后消费者仍整库下载并收敛(支配判断不误跳)。
- **⑤ 增量**:连接消费者跨多次发布者快照只拉段、零整库重下。
- **⑤c 保留**:发布后保留窗内段仍在(对照 `retainSegments:0` 的全截断)+ `.snap`/`.vc` 并存。
- **④** 当选者收割过期满 TTL 的 lease、保留活 lease。

## 11. 未做 / 后续

- **③ 降 server per-round LIST(节点表低频缓存 + snapshot LIST 降频)**:实测确认根本矛盾——节点表低频缓存会让新节点在 TTL 内不被发现,而收敛测试在毫秒级验证"出现即拉取";在②已把 server 空闲轮次降到 2.5min 之后属边际优化且碰正确性。**转独立后续**(需把刷新间隔做成可注入并更新收敛测试)。`snapshot/HEAD` 共享可变指针**明确排除**:并发 publisher 覆写会指向非 max-HLC/已 GC 的 key → 漏读最新快照。
- **内联 site 资源进每一次整库快照(体积)**:`winnersSnapshot` 含所有 `site_files.content` winners → 每次 publish 重新序列化上传、每个 puller 重新下载。后续候选:把内联 blob 也内容寻址为独立桶对象、快照只引用 hash(upload-once),对齐 server-only blob store 思路。
- **大 `blob` server-only、不进桶**(正交持久性缺口):不备份、副本拿不到。
