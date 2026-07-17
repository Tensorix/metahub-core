# 23 · Sites 体验与分享体系

> 状态：**已实施**（2026-07-17，Stage A/B/C 全部落地；bun test 1015 pass；DoSqlDriver 已在真 workerd 实测，生产 CF 冒烟与 P3 打磨项见 §6 实施状态）。来源：多轮设计讨论（对标 ChatGPT Sites 2026-07-09）+ 四份并行设计规格（批次 1-6 / grants / 写信箱 / DO 房间），锚点核实基线 `dev@0ca695e`。
> 范围：**全部纳入本期**——Stage A（server 档地基，批 1-6 + 4.5）→ Stage B（写信箱）→ Stage C（DO 房间）。
> 决策日志全文见会话计划文件；本文是可执行的整理版。

## 0. 一句话

sites 是 agent 给用户造 UI 的通道（静态页 + 同源 `/api/*` 直读写 hub）。本期把这条链路两端补齐：Agent 侧的发现链/发布语义/scaffold，用户侧的缓存/公开访问/按表授权/异步公众写/受信实时协作——并保持一条铁律：**云端永远只见密文；所有明文计算面要么是用户自己的设备，要么是用户显式授权公开的分区**。

## 1. 档位模型（按人选档）

判据：**选档看"读写的人是谁"，不看"要不要实时"；实时 = 有在线计算面**（物理边界）。

| 谁在读写 | 档位 | 实时性 | 依赖 |
|---|---|---|---|
| 自己（多设备） | private site（现状原生能力） | 实时 + 离线（副本+SW 接管） | 无 |
| 受信少数人 | share 链接 + share-scoped grants | server 在线时实时；guest 归属可回滚 | server 在线（本机 / 家里盒子 / **CF Tunnel+Access recipe**——免费 50 用户身份登录，零代码） |
| 受信少数人·无常开硬件 | **DO 房间**（share 的托管方式，非独立名词） | 实时（WS 推送） | 用户自己的 CF 账号 |
| 匿名公众·异步 | visibility:public + **写信箱** | 写即确认+乐观回显自己的；读别人分钟级（≈"评论审核中"） | server serve（读）+ 任意信箱宿主（写） |
| 匿名公众·实时 | visibility:public + server grants | 实时 | server 在线 |

- 桶-only 拓扑下受信档降级为"异步档+保密性"（读=s3 share E2EE 快照、写=信箱）；理论终局（分区密钥层级+受信者作分区副本节点）与"多用户工作区"同属未来议题，本期不做。
- 记账类"自己人共写"应用永远路由到 private/房间/server 档，不落信箱档；创建分享时 UI 按需求引导，勾"允许写+要实时"直接推荐房间。

## 2. 最终三决策（用户批准）

1. **guest 写格式并存**：信箱=预署 op（密封+oplog UNIQUE 重放去重，无可替代）；房间=意图+房间盖 HLC（时钟权威、复用 share-serve 写形状）。SDK 按上下文自动选格式，站点作者统一写 `api.createRecord(...)`。
2. **guest 身份粒度=每访客一个**：信箱=页面铸 `g`+8 存 localStorage；房间/share=解锁时铸子 id 存会话；公开匿名端点例外，保持 `gp-<site8>-<node8>` 按（站点×服务节点）派生（无会话，且两台 server 共用 guest id 会因 HLC 撞车触发 UNIQUE 静默丢值——数据丢失级 bug，派生式规避并保留 `LIKE 'gp-<site8>-%'` 批量回滚）。
3. **房间生命周期绑定 share，数据生命周期走 CRDT**：删 share/删被分享站点 → 房间自毁（destroy+deleteAll）；删某张授权表 → 不动房间，墓碑正常流动。

## 3. CLI 面（语义修订后定稿）

| 命令组 | 命令 |
|---|---|
| `mh site` | `scaffold <dir> [--force]`、`update <site> [--visibility public\|private] [--spa\|--no-spa] [--title]`、`grant <site> <db>:read,create[,update]` / `--revoke` / `--clear`、`grants <site>`；既有 flag：`publish --prune`、`create --public` |
| `mh share` | `create <site> --grant tasks:read,create [--password] [--room]`（--room=建分享+provision 房间+注册 peer+首次 seed，输出房间 URL）、`ls`（托管列 server/room/s3）、`revoke`（联动销毁房间） |
| `mh edge` | `deploy` / `status` / `pull` / `rotate [--purge-retired]` / `connect --endpoint <url> --token`（非 CF 宿主/官方中继）——**统一 worker**（信箱+房间同一脚本，`/v1/inbox/*` + `/r/<slug>/*` 两命名空间，D1+DO 双绑定；BYO 开通=一个 Worker+一个 D1+一个 token；收件密钥对随 deploy/首用自动生成） |

### 3.1 操作面归置（2026-07-16 用户定稿）

归组检验标准一句话：**动作作用于谁，就住在谁的命令组里**。用户视角只有四个落点，全部是现有界面加一两项，没有新页面、没有新名词：

| 落点 | 操作 | CLI | WebUI |
|---|---|---|---|
| **站点卡片菜单** | 公开开关 / SPA / 数据授权+反滥用旋钮 / 标题 / 改地址 / 删除 / 文件 | `mh site update --visibility/--spa/--title`、`mh site grant/grants` | 菜单开关 +「公开数据授权…」弹窗（勾库×勾操作 + Turnstile/口令） |
| **分享弹窗与列表** | 建带授权分享（±房间）/ 查看 / 撤销；房间**无独立操作面**（状态在托管列，撤销即销毁） | `mh share create --grant [--password] [--room]`、`mh share ls / revoke` | 分享弹窗加「数据授权」+「始终在线托管（房间）」两栏；列表加托管列 |
| **数据表格** | 看访客提交（=普通记录，**有意不做独立收件界面**）/ 按 guest 来源筛选与批量回滚 | `mh record list <db>`、`mh db activity` | 现有表格/历史视图 |
| **设置页 Edge 面板** | 部署 / 状况 / 运维 | `mh edge`（见下） | 设置→同步与云端→Edge 面板（与桶配置同区——同属"工作区级后端、设备持凭据加入"模式）；只读展示 + 版本过期提示条（不做一键部署按钮：多步 CF API 调用出错要看输出） |

`mh edge` 全家福（这四个动作作用对象都是边缘组件本身，故归此组）：

```bash
mh edge deploy     # 部署/升级统一 worker 到用户 CF（收件密钥对首次自动生成）
mh edge status     # worker 版本对齐、各站点表单积压/配额、各房间概况（CLI + WebUI 面板双面）
mh edge pull       # 手动收一轮提交（调试用；平时 auto-sync 自动拉）——CLI only
mh edge rotate     # 收件密钥轮换（旧钥保留到在途信封排空）——CLI only
mh edge connect --endpoint <url> --token <t>   # 不用 CF 时接别的宿主（官方中继等）——CLI only
```

**信箱零暴露原则（2026-07-16 用户定稿，取代早先 `mh inbox`/`mh forms` 独立组方案）**：写信箱是**传输管道，不是用户概念**——用户已有的语义载体是 grants：`mh site grant guestbook comments:create [--turnstile <key>] [--password <pw>]` 即完整表达"这张表公开可写"；反滥用旋钮（Turnstile/口令验证子）挂在 **grant 上**（server 实时端点与信箱两条传输同一套闸门）。**自动接线**：站点有 create grant 且 edge 已配置 → publish 时自动发布 mh-drop.json（公钥+端点）→ SDK 页面自动选路（server 可达=实时端点，否则=密封投递）；`mh site grant` 输出明说传输方式（"提交将经 edge 异步入账（约 1 分钟可见）/ 经本机 server 实时入账"）。积压/配额看 `mh edge status`；收到的提交=普通记录（`mh record list` 直接看）。协议/内部文件名保留 write drop。`mh room` 组同理取消（房间=share 的托管方式）。**文档/示例一律用英文标识符**（site slug 经 normalizeSiteName 仅允许 a-z0-9-，中文站名本就非法；数据库名虽支持中文，示例统一英文防 shell 编码问题）。新错误码 `rate_limited` → HTTP 429 / exit 8。所有命令遵守：JSON/人读双输出、effect-evidence 无 ok 信封、MhError 码、**绝不创建用户未点名的远程资源**（资源不存在响亮 not_found，不给 --create）。

## 4. Stage A：批次 1-6 + 4.5

### Batch 1 · Agent 发现链（纯文案+一处类型）
- SKILL.md:291-295 site 条目重写：补 bash 示例块（scaffold/publish --create/--prune）、SDK import 与方法名、`GET /docs.json` 指引。
- publish 输出（site.ts:82-85）：JSON 加 `url/uploaded/unchanged/pruned/api{rest,sdk,docs}`（保留 files/paths 兼容）；人读加 `site:` URL 行 + `data:` 提示行。create 输出加 url + `next:` 行。新建 `src/cli/local-base.ts`（从 cli/commands/share.ts:34-38 抽 localServerBase，Database→DbDriver）。
- help.ts **:85** publish 描述是错的（"creates the site"）→ 改 `--create to create; --prune mirrors deletes`；SITE DATA 块（123-128）补 SDK+docs.json 两行；EXAMPLES **:182-184** `# auto-creates` 注释同错改掉。site.ts:156 父描述补 `/metahub-sdk.js`。
- site.ts:2,91 `Database`(bun:sqlite)→`DbDriver`；更新 08-agent-sites/api-discovery-status.md 两处过时结论。

### Batch 2 · 访问基础（无 schema 变更）
- **ETag+304**：blob 行 content 字段即内容 hash 直接做 ETag；utf8/base64 用 `Bun.hash(encoding+":"+content)`；统一弱 ETag。**If-None-Match 命中在 resolveBlob 之前判定**（省最坏 5s）。`src/core/sites.ts` 加 `getFileMetaForServe`（etag 留 node 半区）；auth.ts withShim 开头加 304/301 早退。
- **Cache-Control** `siteCacheControl(ct, encoding, isPublic)`：HTML `no-cache`、内联 css/js `max-age=300, stale-while-revalidate=3600`、blob `max-age=3600`；前缀 private/public 由 Batch 4 的 visibility 接通；**share 路径恒 private**（slug 是 capability）。
- **404**：`resolveSiteFileRow(db,siteId,path,{spa?})`（sites-core，可移植，status 200|404 + 404.html 回落 + index.html 解析）——sites-serve / share-serve / db-worker siteFile 三处共用；内置美化 404 页（对齐 share-serve pageShell，no-store）。
- 收敛三份重复：新 `src/core/inject-runtime.ts`（injectRuntimeTag：auth.ts:355/sw.ts:328/runtime.ts:145 改引）；sites-core 导出 bytesToBase64+新增 base64ToBytes（sites.ts:76 弃 Buffer）；sites.tsx:259-263 内联 slugify 改 import normalizeSiteName。
- `fileCounts(db)` 一条 GROUP BY 修 sites-routes.ts:62-64 与 db-worker listSites 的 N+1。

### Batch 3 · publish 语义
- `writeFileRow` 返回 `{...row, changed:boolean}`：live 且三元组全等跳过全部 emit（防 oplog 膨胀）；已删行同字节重传仍 un-delete。
- `publishDirectory(db,siteId,dir,{prune?,concurrency?=8})` 下沉 core（Bun.Glob 从 CLI 迁入；emit 段同步不交错）；prune=live paths−本地集，输出完整删除清单；CLI `--prune` 显式 opt-in。上传路由响应加 `changed`。

### Batch 4 · visibility+SPA+注入规则+blob 接线（唯一动 schema/crdt 批次）
- sites 表加 `visibility TEXT`、`spa INTEGER NOT NULL DEFAULT 0`（+4.5 的 `public_grants TEXT` 同一迁移窗口）；crdt 白名单同步加；`isSitePublic()`=严格 `==="public"` default-deny 唯一入口（列可被不受信 peer 写乱值；ingest 对未知列单条跳过已核实 crdt.ts:197-198，老 peer 前向兼容安全）。
- serve 链路：`/sites/` 进 server.ts exempt（:166-176），`serveSite(req,ctx,auth)` 自治。防枚举顺序：①301；②public → serve（public 缓存头，**不注入 runtime**）；③否则无 token → HTML=unlock 页(x-mh-unlock)/非 HTML=401——私有与不存在不可区分；④有 token → 404 或 serve+注入。
- **注入统一规则**：public → 任何环境任何路径不注入（"预览即真相"）。三实施点：sites-serve public 分支；sw.ts siteFileResponse（RPC 结果加 `public` 字段）；runtime.ts offline bootstrap 同字段。
- SPA：`resolveSiteFileRow` miss 且 spa 且末段无扩展名 → index.html(200)，三端自动同享。
- **blob 缺口接线**：db-worker.ts:718 放行 blob 行；sw.ts 把 handleBlob 链抽成 `resolveBlobBytesFor`（cacheGet→网络→localRpc spool/桶→verify+cachePut），siteFileResponse blob 分支走它——官方壳/离线下站点图片不再 404。
- WebUI 开关文案两点：任何人可读、页内 /api 默认调不通；桌面端补"公开后任何运行 server 的已配对设备都公开 serve"（visibility 是数据属性，可达性取决于哪个节点有公网面）。

### Batch 4.5 · grants 授权原语
- **`src/core/grants-core.ts`（可移植 driver-only，信箱 ingest/DO 房间复用同一模块）**：`GrantOp=read|create|update`（delete 永不进枚举）、`GrantSet{v:1,tables:[{db:<id>,ops}]}`；`parseGrantSet` default-deny（null/坏JSON/未知op/v≠1→空集）；`authorizeDbRef/authorizeRecord` 未授权与不存在统一 auth 错误防枚举；`assertGuestPayload`（64KiB body/8KiB 值/64 cells/表 10k 行；relation 属性 public 拒、share 仅目标库也在 set——防跨库枚举 oracle）；类型校验委托 records.ts coerce()；`guestCreateRecord/guestUpdateRecord`=校验后 withNodeId 包装。
- 存储：public 主体→`sites.public_grants`（进 oplog，迁移仿 migrateDatabases 含 oplog 回填）；share 主体→`shares.grants`（node-local 随 share 生灭）。
- 端点：`core/sync/grants-routes.ts serveGrantedApi` 单一实现（core 层，headless 可用）；五条路由 GET records/record/properties + POST records + PATCH record；响应 shape 与主 API 一致。挂载：`/sites/<name>/api/*`（token→进程内改写转发主 API；public→受限面；否则 401）+ `/share/<slug>/api/*`（口令会话 gate 天然覆盖，每请求查活行=收权即时）。裸 `/api/public/*` 不做。
- 限流：`core/sync/rate-limit.ts` 内存固定窗口（public 写 20/min/IP/站、读 120、share 240/会话）；server.ts fetch 取 requestIP。
- SDK：页面相对路径 `api/...`；`detectBase()` 从 location.pathname 匹配 `/(sites|share)/<x>`；`/metahub-sdk.js` 进 exempt；**sw.ts:486 缺口随本批修**（`/sites/<n>/api/*` 剥前缀走 mapApiRequest，主人 PWA 离线不断）。
- update grant=授权表内任意行（对齐 share edit，家庭要改彼此的行）；公开端点不进 OpenAPI v1。

### Batch 5 · scaffold / Batch 6 · WebUI
- `mh site scaffold`：模板 `src/cli/site-starter.html` 构建期文本内嵌（同 agent-skill.ts；**spike 验证 .html 的 type:"text" 与 Bun HTML loader 交互**，兜底改名 .html.txt）；单文件模板=SDK import+全方法签名注释+可运行示例+按 e.code 分派；防漂移测试：模板 `api.<name>` ⊆ `Object.keys(createClient())`。
- WebUI：目录拖拽发布（webkitGetAsEntry 递归+webkitdirectory 兜底，并发≤4）；slug 重命名（updateSite 已支持）；文件大小 SQL 派生不加列（utf8 LENGTH(CAST)、base64 (LENGTH/4)*3、blob LEFT JOIN blob_cache.size，null 显"—"）。

## 5. Stage B：写信箱（inbox；协议名 write drop）

**定性**：与桶对偶的哑基础设施——桶=数据盲存/读面，信箱=数据盲写面。**不是同步源**：设备永远不从信箱读数据；信封在 ingest 前是"邮件"不是"数据"。单向流：访客投递→暂存→唯一拉取节点（发布者租约）解密校验 ingest→op 推进桶→全设备既有通道收到。

- **信封** `{v:1, envelope_id, drop_id, enc:"sealed-p256", key_id, sealed, created_at}`；payload=`{v, guest_node, changes:Change[]（预署 op）, meta?}`；txn 强制改写 `"drop:"+envelope_id`。
- **密封 MH-SEAL-P256**（`src/core/sync/seal.ts` ~70 行纯 WebCrypto：ECDH P-256 临时钥+HKDF(info 绑 epk+收件钥 hash)+AES-GCM）；enc 字段留 X25519 敏捷位；否决第三方 crypto 依赖。share 场景同样走 sealed box（不补存 share content key）。
- **密钥**：独立生成存 `keys/drop.json`（WebCrypto 无法从种子派生 P-256 公钥，"从 master key 派生"技术不成立）；私钥 master key 包裹，桶权威+本地 meta 缓存；轮换=追加+retired 保留开在途+排空 purge。公钥经站点文件 `mh-drop.json`（`mh inbox bind` 发布）随 oplog 到所有 serve 面。
- **安全硬规则**：`ingest()` 每条 change 无条件 `observeHlc` → **ingest 前钳制 hlc.millis ≤ now+5min，超拒整封**（防恶意未来时间戳永久污染本地时钟；整封拒=表单原子性）。
- **API v1**：PUT/DELETE `/v1/inbox/:drop_id`（owner 注册投递口；未注册 404）；POST `.../envelopes` 公开（尺寸 64KB/413→Turnstile→口令验证子→容量满 429 drop_full→INSERT OR IGNORE 重复 200）；GET `envelopes?after_id=&limit=`+批量 DELETE(ack)+stats——owner Bearer=独立 `drt_` secret。
- **生命周期**：ack-delete=op 入本地 oplog **且推进桶**后；无效信封记日志立即删；容量上限必须有（默认 2000 封/20MB/64KB，满 429）；有效信封**无硬 TTL**（信箱是有界收件盒不是档案库）。
- **拉取**：peers 表新 kind（复用状态机/tick/退避，默认 60s 空轮退避 5min）；有桶搭 `isElectedPublisher` 便车；**双拉无害是硬保证**（UNIQUE 幂等，租约仅省流量）；隔离校验=guest_node 形状+node 段一致+HLC 钳制+`grants-core.checkGuestChanges`（拒 blob 型 property 防悬挂哈希）；零游标状态表（未 ack 重拉→inserted:0→补 ack）。
- **SDK**（`src/sdk/drop.ts`）：`initDrop("mh-drop.json")` 自发现；mini-HLC（server_time 校钟）；乐观回显 `pending/merge`（localStorage 已投递记录，serverRows 含 row_id 即 reconcile，`_pending:true` 渲染"稍后对所有人可见"）。
- **新鲜度契约**：写=立即确认+乐观回显自己的；读别人=分钟级（拉取周期+快照重发布周期）；"pending 尾巴"（页面拉 pending 客户端合并）记远期可选项——绕过 ingest 隔离，垃圾先露脸。所有设备长期离线时公开站数据冻结在最后一次发布（与桶同步前提一致）。
- CF 宿主存储选 **D1**（容量原子判定+自增游标）；官方中继=同协议多租户实现（数据盲→立场兼容），商业化时的运营决定。

## 6. Stage C：DO 房间

**定性**：1 房间 = 1 次分享（slug=房间号=能力凭证=收权粒度）；房间间不互通，owner 设备是枢纽。房间**零出站凭据**：不持 master key/桶凭据/永不外呼；最大损失=授权分区明文（consent 边界）。`mh --server` 上不了 DO（Bun 二进制 vs V8 isolate）；全移植=档 B（四检验已毙）；Containers 跑真 mh 要持 master key（红线）——房间的本质是范围刻意小。

- **分区**=share 授权闭包五段：databases(row∈granted)、properties/records(database_id∈granted，含墓碑；**改 database_id 才是离区**)、sites(row=siteId)、site_files(site_id=siteId)；排除 documents/doc_blocks/meta/node-local。
- **谓词=混合方案**：owner 侧 node-local 影子表 `room_rows(peer_url,dataset,row_id)`；每轮事务内按谓词算成员集 M（现状表=真相源）→ EXCEPT 差分 entered/left → room_rows:=M → 增量过滤 `JOIN room_rows`。
- **协议** `POST /r/<slug>/owner/sync`（Bearer ownerSecret）：请求 `{protocol,node_id,since,changes(增量∪入区单行 winners 基线),evict[],digest?}` → 响应 `{changes(onlyNode=guest),cursor,need_baseline[],need_blobs[],digest?,share_state}`；游标复用 peers 行（kind room）。收敛论证：事务内快照 seq=C 切分窗口无缝隙、重叠靠房间 oplog UNIQUE、LWW 序独立；边界案例（挪进挪出/离线窗口/两设备并发挪/丢响应重试）全表已过。
- **evict=局部物理删除绝不产 op**（打墓碑会流回 owner=替 owner 删数据，红线）；guest oplog 行延迟 GC 到 owner ack（防 evict 吞未送达 guest op）。
- **自愈两层**：need_baseline（残行→owner 按当下成员关系重判基线或 evict）+ 分区摘要 anti-entropy（每 16 轮/grants 变更后；不合→全量 winners+成员键集对账）——多设备影子分裂的收敛押自愈不押影子。
- **DoSqlDriver**（镜像 wasm-driver ~60 行）：sql.exec 适配；transactionSync 深度守卫；绑定归一；**HLC counter 防护**（workerd 请求内时钟冻结；counter>0xF000 时 scheduler.wait(1)；counter 溢出 0xffff 破坏定宽序是顺带发现的核内潜在 bug，可单独修）；guest 写房间盖 HLC。
- **worker**：与信箱合一（edge-worker）；MhRoom DO：owner 面 provision/sync/blob(分块)/destroy；guest 面 unlock(移植 share 口令会话)/站点直出(sites-core)/受限 api(grants-core)/WS(Hibernation+serializeAttachment+autoResponse ping-pong 零计费保活)；broadcast=poke；alarm 仅 expires_at 自毁。
- **owner 集成**：peers kind room→syncWithRoom；auto-sync tick+退避（backoffNext 泛化 s3/room 共用，上限 2.5min）；`mh share create --room`=provision+addPeer+首轮 seed（M 全量=entered，limit 分页）；PROTOCOL_VERSION 双向校验，major 不合 409 upgrade_required→提示 `mh edge deploy`。
- **分期**：P1 只读房间（实时家庭看板即成立）→ P2 开写（意图写+每访客子 id+pull 半程+evict 延迟 GC+SDK onUpdate）→ P3（presence/单推 lease/摘要调参）。
- **测试**：handlers 可移植→纯 Bun 同进程双向收敛测试（两设备 hub+房间引擎三个 bun:sqlite；边界全表+随机化几百轮，终态断言 roomWinners==partitionProjection）；DoSqlDriver 用 vitest-pool-workers 跑 wasm-driver 同契约用例；e2e=wrangler dev。

**实施状态（2026-07-17，C2 收官）**：P1+P2 已落地——房间引擎（room-protocol/room-client/partition，C1）+ DO 集成与部署（C2）：`DoSqlDriver`（src/room/do-driver.ts，transaction 直接递归映射 transactionSync——spike ② 推翻深度守卫）、可移植房间 HTTP 面 `room-serve.ts`（owner provision/sync/blob 分块/destroy + guest unlock/站点直出/受限 api/WS 写意图；会话件抽成共享 guest-session.ts）、`MhRoom` DO 壳（src/workers/room.ts，普通类不 import cloudflare:workers 以保 bun test 可导入；Hibernation WS+autoResponse ping/pong+expires alarm）、edge-worker `/r/<slug>/*` 路由（版本 bump 2）、cf-api 声明式 exports+DO binding、owner 集成（room-peer.ts：HTTP transport/409→conflict、need_blobs 推送、share 生命周期联动；server tick 统一空转退避 Map 上限 2.5min）、CLI（`mh share create --room`/`share ls` 托管列/`edge status` 房间概况）、SDK `api.onUpdate`（房间挂载 WS poke，他处可选轮询）。**DoSqlDriver workerd 实测**：test/workerd/（独立小包，vitest-pool-workers 新 plugin API）在真 workerd 上全绿（13 条契约用例 + initSchema/房间引擎 guest 写集成用例）；生产 CF 端到端（真实 deploy + 休眠唤醒 attachment 存活）尚未冒烟。P3（presence/单推 lease/摘要调参）为后续项；guest pull 分页、全量对账 winners 分页维持 C1 的从简结论未做。

## 7. 安全不变量汇总（实施红线）

1. 公开/分享响应**永不携带 master-token runtime**；公开页 `/api` 默认 401 是特性，例外只经 grants 白名单。
2. 桶只有持 master key 的 owner 设备读写；信箱/房间**都不碰桶**。
3. 信箱边缘全程只见密文；一切语义校验在 owner ingest 端（隔离层，垃圾不进 oplog）。
4. 房间零出站凭据；evict 绝不产 op；owner secret 独立于 master token；`drt_` inbox token 同理。
5. default-deny 三处：`isSitePublic` 严格全等、`parseGrantSet` 坏值→空集、授权失败与不存在不可区分（防枚举）。
6. HLC 入口钳制（信箱 ingest +5min；房间盖章制天然免疫）。
7. mh 永不创建用户未点名的远程资源；自动配置仅限"往用户资源内部写内容"（先例：S3 自动 CORS）。

## 8. 明确不做

版本/回滚（sites 行已在 oplog，将来可借 history）；share s3 transport 支持 site；多用户"工作区"档；分区密钥层级/受信者分区副本节点；桶收件箱（被 CF 方案支配）；官方代管完整托管（数据盲信箱中继除外）；"pending 尾巴"准实时互见（每站点开关，再议）；通用 blob 基建归 22-blob-sync（本期只做 siteFile→blobBytes 接线）。

## 9. 实施顺序与验证

顺序：spike（§10）→ Batch 1→2→3→4(+4.5 同迁移窗口)→5→6 → Stage B → Stage C（P1→P2→P3）。批 1-3 无 schema 变更可独立发布；批 4/4.5 需双节点 sync 冒烟。

全局验证：每批 `bun test` 全绿；各批测试清单见上文；端到端基线——`mh site scaffold /tmp/x && mh site publish demo /tmp/x --create` 输出 URL 页面 `api.listDatabases()` 可用；`--prune` 清单；`mh site update demo --visibility public` 后无痕免登录可访问且源码无 mh-runtime；grants 三挂载点同一份页面代码；信箱 e2e（投递→乐观回显→拉取入账→guest 归属→重放零重复）；房间收敛测试全绿 + wrangler dev 冒烟。

## 10. 实施第 0 步：技术 spike 清单

① DO sql.exec 单调用多语句；② transactionSync 嵌套/SAVEPOINT 放行；③ PRAGMA table_info/FTS5 可用性；④ DO 行大小上限+免费档每请求 CPU 上限（若 10ms 则 seed 分页策略重估）；⑤ Bun.build 产 workerd ESM（cloudflare:workers external、无 node: 泄漏）；⑥ Workers 上传 API migration 幂等+secret 随 PUT 提交+**CF token 最小粒度**（可能仅账号级→deploy 文案诚实标注）；⑦ vitest-pool-workers/wrangler dev 对 WS Hibernation 本地支持；⑧ workerd Date.now 冻结精确语义（跨 await 是否推进）；⑨ grants-core 最终接口与房间/信箱消费端对齐；⑩ Bun `.html` 的 `with {type:"text"}` import 在 `bun build --compile` 下的行为。
