# 25 · 信任面(数据地图 / 设备名册 / 换钥恢复码)与设置页 Notion 化

> 状态：**已实施**(2026-07,落地于 `feat/misc`)。本篇补记已落地事实与不变量,不是待做计划。
> 相关：[11-device-pairing-sync](../11-device-pairing-sync/design.md)、[17-s3-storage-sync](../17-s3-storage-sync/design.md)、[22-blob-sync](../22-blob-sync/design.md)、[19-client-topology](../19-client-topology/design.md)、[24-sites-ux-refresh](../24-sites-ux-refresh/design.md)

## 0. 一句话

把三个用户真正会问的问题——**"我的数据安全吗""谁碰得到它""设备丢了怎么办"**——各自收敛成**一份可移植的派生**,再让 CLI 与 WebUI 消费同一份;顺带把越长越乱的设置单页拆成两组六页,并把 CLI 的"工具"与"配置"分成两个命名空间。

## 1. 问题(诊断结论)

1. **"数据安全吗"没人能回答**。事实散在 `peers` 行 + 每 peer 同步状态 + `blob_cache.pending` + 同步的 `blob_policy` 四处;CLI 没有入口,设置页各处自己算一遍,结论互相打架。
2. **"谁碰得到"答不全**。设备身份分散在三处:出站 `peers`、入站 `peer_grants`、以及 **oplog 的每节点变更流**——纯靠桶加入的设备只在第三处留痕,前两处根本看不到它。于是"我以为已经踢掉了"是可能发生的。
3. **"丢了怎么办"只有半个答案**。能换密钥,但密码短语一旦忘记就没有兜底;而换钥本身也需要先能进得去。
4. **设置页是一张越滚越长的单页**,同一件事(比如缓存)在两处出现,深链只能定位到"章节 id"这种实现细节。
5. **CLI 的 `config` 是个杂物抽屉**:`config peer`、`config grant`、`config set` 三套拼写并存,日常工具(sync/status)与长期配置(挂桶/配对)混在一起。

## 2. 原则

- **派生只有一份**:任何"折算出来的结论"(数据地点、设备名册、站点渠道)都住在 core 的纯函数里,UI 只负责说人话。这条与 24 期的 `site-channels` 是同一条纪律。
- **离线优先,在线是增量**:默认视图只读本地表,零网络;需要联网才知道的事实(桶在场性、发布者心跳)必须是**显式的 refresh 动作**。
- **诚实优先于好看**:可吊销与否、有没有只在本机的附件、恢复码等于全部权限——都直说。
- **一物一家**:一个设置只出现在一个地方。

## 3. 落地内容

### 3.1 数据地图 `src/core/data-map.ts`(+ `sync/data-map-db.ts`)

纯函数、可移植(无 driver、无 `node:`/`bun:`):调用方把已有的行递进来,返回**地点列表 + 一个总状态**。

- 地点 = 本机 + 每个 `peers` 行(**房间 peer 必须由调用方排除**——房间只装一个分享的分区,不是"我的数据的一处")。
- 每处的 `freshness`:`live`(本机) / `current`(已确认) / `behind` / `stale` / `error` / `never` / `disabled`。**新鲜度只看 `last_success_at`,永不看"最近尝试"**。
- 总状态优先级:`no_backup` > `pending_blobs` > `unsynced_changes` > `peer_error` > `syncing` > 正常。
- **并发多个问题时不许遮蔽**:`mh status` 的标题点名优先级最高的那个,同时指向下面的问题清单;建议语句对症——某个目标一直失败时提示去查它的配置,而不是让用户再 `mh sync` 一遍已知坏掉的对端(`cli/commands/status.ts` 的 `statusHead` 是纯函数,可单测)。
- 消费方:`mh status`、`GET /api/sync/health`、浏览器副本的 `dataMap` op、设置页「数据与备份」顶部的一句话结论(`webui/data-map-status.ts` 是**文案**的唯一来源)。

### 3.2 设备名册 `src/core/sync/devices.ts`

把三处身份折成一份列表,每台设备给出**加入方式**、**最后活跃**与**诚实的可吊销判定**。

- **本地 oplog 就是名册**:凡是变更到达过本机的节点都有行,其最大 HLC 就是真实的最后活跃时间——所以名册**离线可列**。
- `refreshBucketPresence()` 才去查在线才知道的部分(桶里是否存在该节点的段流、发布者心跳是否还活),对应 CLI 的 `--refresh` 与设置页的刷新按钮。
- **可吊销判定不许粉饰**:纯靠桶加入的设备,删一行 peer 是没用的,名册直说"要靠换钥"(`mh config backup rotate`)。
- 本设备的人类可读名字存在 `meta.node_label`(`core/node.ts`);对端对我的称呼在**它自己**的 `peers.label` 里,两者互不覆盖。

### 3.3 换钥与恢复码 `src/core/sync/recovery.ts`

- 格式:`MH1-` + Crockford base32(K ‖ SHA-256(K) 的前 3 字节)= 35 字节 = 280 bit = **恰好 56 字符**,渲染成 14 组 4。
- 校验位抓得住任意单字符笔误(其余错漏判概率 2⁻²⁴);Crockford 字母表去掉 I/L/O/U,解码折叠 o→0、i/l→1,手抄卡片扛得住常见混淆。
- 能力:**重置密码短语**(对 `keys/main.json` 做无需解包的重新包裹),以及让**新设备在不知道短语的情况下加入**。定位是"设备全丢 + 短语忘光"的最后兜底。
- **持码 = 可读全部数据**,卡面必须明写这句话。
- 运行时无关(只用 WebCrypto),与 `e2ee.ts` 同级。

### 3.4 CLI:工具 / 配置两个命名空间

```text
工具(一次性动作,不改长期状态)   sync  status  cache  doctor  repair  compact  edge status|pull
配置(改长期状态)                 config server | device | backup | edge
```

- `mh config` 无参且在 TTY 上 = `@clack/prompts` 方向键向导;带 flag 则直配,非 TTY 永不阻塞。
- 旧拼写 `config peer` / `config grant` / `config set` **保留为隐藏别名**(脚本与既有 agent 不断),但不再出现在 help。
- `mh config --help <section>` 走 `configScopedHelp`;未知 section 是**用户错误**——stderr + exit 2,不是"成功地打印一条错误信息"。
- 实现注记:`config` 是**单命令 + 位置分派**,不用 citty 的 subCommands——父级 `run` 会与匹配到的子命令**双执行**,且 citty 会把第一个非 `-` token(包括 `config --port 7777` 里的 `7777`)当成子命令名。

### 3.5 设置页 Notion 化 `src/webui/settings/`

- **导航单一来源** `settings/nav.ts`:`GROUPS` = 设备组(外观 / 快速笔记 / 离线与缓存)+ 工作区组(数据与备份 / 设备 / 站点与发布)+ **无头组**(关于)。每页自带 `show()` 判定(快速笔记仅桌面;离线与缓存在桌面隐藏——桌面的字节是工作区存储,归「数据与备份 → 附件存储」)。
- **URL 驱动选择**:`#/settings?sec=<page>`;旧深链的章节 id 经 `LEGACY_SEC` 映射到新页。`pageLabel()` 同时供左栏、窄屏索引与页头,三处不可能漂移。
- **原语** `settings/primitives.tsx`:`SetRow`(粗标题 + 灰副标 + 右对齐控件槽,可展开详情区)、`SetSection`、`PageHeader`、`DangerZone`。**纯表现,不含数据逻辑**。
- `settings/modals.tsx` 收纳所有重型弹窗,`settings/cache-ring.tsx` 是三段式缓存环形仪表(可清 / 保留 / 已固定 + 五态中心),`settings/shared.ts` 放跨页小工具(`isDesktop()`、`fmtBytes`、副本不可用原因)。
- **不可用要给原因,不能静默隐藏**:副本开关不可用时显示具体原因(非安全上下文 / 无 OPFS),否则用户无从排查。

## 4. 不变量(勿回退)

1. 数据地点与总状态的派生只在 `core/data-map.ts` 一份;文案只在 `webui/data-map-status.ts` 一份。设备名册同理只在 `sync/devices.ts`。
2. 新鲜度只看 `last_success_at`;**房间 peer 永不计入数据地图**。
3. 默认视图零网络;联网事实必须挂在显式 refresh 上。
4. 可吊销判定诚实——桶加入的设备不许显示成"删一行就断了"。
5. 恢复码卡面必须写明"持有此码即可读取全部数据"。
6. 设置导航只在 `nav.ts` 一份,`?sec=` 是公共深链约定(与 24 期共用);新增页要同时给 `show()` 与 label。
7. CLI:凡改长期状态的命令一律进 `mh config <section>`;旧拼写只作隐藏别名,不再新增。

## 5. 已知留白

- 备份体检没有定时提醒(现在要用户自己去看 `mh status` / 设置页)。
- 恢复码没有"已打印 / 已确认"状态跟踪。
- 数据地图不含桶侧在线事实(发布者选举结果等),按设计如此;要看得跑 `--refresh`。
