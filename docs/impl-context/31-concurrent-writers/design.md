# 31 · 并发写入:单机多进程、多机同段语义、时钟偏差

承接 [04-block-level-doc-crdt](../04-block-level-doc-crdt/design.md)、[13-data-integrity](../13-data-integrity/design.md)。本文记录把「多个 agent 同时改数据」从"多机靠 CRDT 收敛、单机碰运气"收口为三条可验证保证的过程。

## 1. 起因:实测

`mh` CLI 每次调用是独立进程;桌面 sidecar / `mh --server` 也是独立进程;它们共用一个 SQLite 文件。用临时库并发跑 24 个 `record create` + 24 个 `doc append`(2026-09-30):

| 指标 | 修前 | 修后 |
|---|---|---|
| `database is locked` 失败 | 21 / 48 | 0 / 48(三轮) |
| 失败输出 | `{"error":"database is locked"}`,无 `code`,exit 1 | `code:"busy"`,exit 9 |
| 半截记录(有 database_id、无 order_key) | 2 | 0 |
| 孤儿块(doc_blocks 无 doc_id) | 1 | 0 |
| 两进程铸出相同 HLC | 1 组 | 0 |

三个根因:

1. `openMetahub` 只设 WAL,没有 `busy_timeout`。`bun:sqlite` 默认 0,第二个写者 0ms 即失败(独立两进程实验证实)。
2. `grouped()` / `withChangeGroup` 只给 op 打 txn 标签,**不是数据库事务**。一条 `createRecord` 是 4 条以上各自自动提交的 `emit`,中途撞锁就停在半路。
3. `nextHlc` 是「读 meta → 写 meta」两条语句,跨进程可读到同一个 last 值;同寄存器撞上时第二条被 `INSERT OR IGNORE` 静默丢弃。

多机层面 CRDT 收敛本身正确,但两端模拟(`ingest` 互灌)暴露两处语义问题:同一动作"改一段"在 CLI `doc edit`(同块 text 寄存器 LWW,早者静默丢)和 WebUI 整篇保存(reconcile 删旧插新,双方并存)下结果不同;HLC 对远端未来时间戳没有上限,一台时钟跑到未来的设备会永久赢下所有 LWW,并经 `observeHlc` 把全网时钟拖过去。

## 2. 决策

### 2.1 `busy_timeout` + 变更组 = `BEGIN IMMEDIATE` 事务

- `openMetahub`:`PRAGMA busy_timeout = 5000`,设在 `journal_mode` 之前(唯一的磁盘库打开点,server / sidecar / CLI 都经它)。
- `src/core/driver.ts` 新增 `writeTx(db, fn)`:`db.transaction(fn).immediate()`,驱动没有 `immediate`(wasm / DO)时退回普通事务。`DbDriver.transaction` 返回类型放宽为 `TxFn`(带可选 `immediate`)。
- `withChangeGroup(db, label, fn)` / `withTxnId(db, txn, fn)` 增加 `db` 首参,最外层组用 `writeTx` 包住;`grouped()` 对 `(db, ...args)` 变更器自动完成;裸 `emit` 不在组内时自己开一个 `writeTx`。
- 其余"先读后写"的内部事务(`ingest`、snapshot 重放、search 建索引、site-channel、guest-intent、room-client、drop-pull、peers、schema 迁移、`rematerializeDataset`、room 分块上传)一律改 `writeTx`。

**为什么必须 IMMEDIATE 而不是 busy_timeout 单独够用**:WAL 下 deferred 事务先读(`getDocument`)后写(`emit`),若读与写之间另一进程提交了,升级写锁直接返回 `SQLITE_BUSY_SNAPSHOT`,busy handler 不会被调用——等待对快照失效无济于事。core 几乎每个变更器都是这个形状。IMMEDIATE 在事务开头就拿写锁,后来者在 busy_timeout 内排队。

**附带收益**:一次命令的 oplog 写入变成一次 fsync(更快);`--if-match` 的检查与写入在本机原子;`editDocumentBatch` 注释里"NOT a DB transaction"的告诫不再成立。

### 2.2 错误码 `busy`

`asMhError(e)`(`src/core/errors.ts`)把 `SQLITE_BUSY*` / `SQLITE_LOCKED*` / `"database is locked"` 归一为 `MhError("busy")`;`errorCode()` 经它判别,CLI `guard` 与 HTTP `errorResponse` 自动拾取:exit 9 / HTTP 503 + `Retry-After: 1`。语义写进 SKILL.md:**什么都没写,原样重试即可**(2.1 保证了这一点)。WebUI `authFetch` 收到 503+busy 等 300ms 重试一次。

### 2.3 同段并发统一为「都保留」

删除 `editDocument` 的快路径,所有编辑路径都走 `reconcileBody`。两端并发改同一段 → 各自墓碑旧块、插入自己的新块 → 合并后两个版本相邻出现、两端一致;不同段落的并发编辑行为不变。选"都保留"而非"同块 LWW":对 AI 编辑而言不丢内容比不出重复段重要,且与 04 号文档"块级 CRDT 保证并发不丢数据"的口径一致。代价:单块编辑也换块 id、每次多 4 条 op;历史视图本就是行级 diff,不受影响。

### 2.4 HLC 偏差上限与修复

- `HLC_MAX_SKEW_MS = 5 分钟`(`src/core/hlc.ts`;drop-protocol / guest-intent 原各自的 5 分钟常量改为引用它)。
- **远端边界**:`ingestDetailed` 对 `hlc > hlcSkewBound(now)` 的 change 直接跳过(不进 oplog、不观察时钟),按作者节点计数返回 `skewed`;`ingest` 仍返回 received 作薄包装。`/sync` 响应带可选 `skewed_rejected`,`syncWithPeer` / `syncWithStorage` 把两个方向的拒收都写进 `SyncResult.warnings`,`mh sync` 打印。**游标照常前进**(与 poison change 同策略):不让一台坏设备卡死整条同步,它修好时钟后用新 seq 重推。
- **本机守卫**:`nextHlc` 发现持久化时钟超前系统时间 5 分钟以上即抛 `clock_skew`(exit 10 / HTTP 409)。标准 HLC 单调递增意味着一次时钟事故会让该设备永远铸未来时间戳、永远赢、永远被别人拒收——必须在它本机响亮失败。`observeHlc` 对超前的远端值直接忽略,作为第二道防线。
- **修复**:`repairClock(db, now)`(`src/core/integrity.ts`;`mh repair --clock`、`POST /api/repair/clock`,副本 op `repairClock`)。一个 `writeTx` 内:按 `hlc, seq` 升序取出所有未来行,逐条删除后用本机时钟重铸 HLC(保留原 node_id / txn / value,相对顺序不变)并 `applyChange` 写回(新 seq → peer 重拉);持久化时钟重置为 now;对每个被触及的寄存器按 `MAX(hlc)` 重算胜者并物化。即使没有未来行、只是持久化时钟被拖前,也重置时钟。各节点独立执行后状态收敛(同 value 不同 hlc 只在历史里多一行)。`validateHub` 新增 report-only 类别 `clock_skew`(按节点计未来行 + 本机时钟超前),`mh doctor` 可见。
- **为什么 5 分钟**:与 drop 协议既有阈值一致、与 Kerberos 等常见容忍度同级;NTP 同步的设备远在此内,超过即视为事故而非抖动。

## 3. 测试

- `src/cli/concurrency.test.ts`:16+16 个真实 `mh` 子进程并发写一个临时库,断言零失败、无半截记录 / 孤儿块 / 重复 HLC、`record list` 计数准确。
- `crdt.test.ts`:变更组中途抛错不留任何行;`ingestDetailed` 拒收超前 change 并按节点上报、游标与时钟不受影响。
- `hlc.test.ts`:守卫抛错、`observeHlc` 不被拖动、`isSkewedHlc` 边界。
- `integrity.test.ts`:`repairClock` 重盖后值不变、seq 更大、时钟可用、`doctor` 转绿;仅时钟被拖前的情形也修复。
- `documents.test.ts`:单块编辑换块 id、邻居保持;两节点并发改同段双方并存且一致。
- 既有用 `999999999999999` 作"最大 HLC"哨兵的测试(room-sync、storage)改为 now+60s,因为哨兵现在会被当作时钟偏差拒收。

## 4. 已知边界

- 升级前已把未来 op 同步出去的旧库:对端若已升级会拒收后续推送并给出 warning;本机 `mh repair --clock` 后以新 seq 重推,对端若此前接收过旧的未来版本,则该寄存器在对端仍由旧未来值胜出,直到对端也跑一次 `repair --clock`。
- 桶同步只发布本节点的 op(`onlyNode`),`repairClock` 重盖的外来节点行不会经桶转发,只经 HTTP peer 重推。
- 设置页尚无「修复时钟」按钮,WebUI 当前通过错误提示里的命令引导;API 路由已就绪。
