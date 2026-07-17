# 23 · Sites 体验与分享体系 — 技术 spike 结论（§10 十项）

> 状态：**spike 完成（2026-07-16）**。对应 design.md §10 清单。
> 实验环境：Bun 1.3.14 / wrangler 4.111.0（`wrangler dev --local` 跑的是**真 workerd 二进制**，SQL 语义可信；计费/CPU 限额本地不生效）/ @cloudflare/vitest-pool-workers 0.18.5 + vitest 4.1.10。
> 实验工程在会话 scratchpad（`spike/html-import`、`spike/workerd-esm`、`spike/do-lab`），未进仓库。标注「实测」= 本地 workerd/Bun 跑出来的；「文档结论」= 仅核官方文档未实测。

## ① DO `sql.exec` 单调用多语句 — ✅ 可用，两条硬规则

**结论**：一次 `exec` 可执行分号分隔的多条语句（DDL/DML 均可）；返回的 cursor 是**末条语句**的结果。两条硬规则：

1. **仅末条语句可带绑定参数**。多语句 + 参数落在非末条 → `Error: When executing multiple SQL statements in a single call, only the last statement can have parameters.`（实测）
2. **非末位语句不要是 SELECT**。中间 SELECT 的 prepared statement 会滞留在"未消费"状态，之后再 exec 同一 SQL 文本 → `Error: A SQL prepared statement can only be executed once at a time.`（实测：`"SELECT…; SELECT…"` 第二次执行必炸；`"INSERT…; SELECT…"`（SELECT 在末位且被 toArray 消费）可反复执行）

**证据来源**：实测（do-lab `/battery` + `/probe`）。

**对设计的影响**：initSchema 整段建表 SQL 一次 exec 直接可行（无参 DDL）。DoSqlDriver 约定：多语句 exec 只用于无参 DDL/DML；SELECT 永远单条执行——镜像 wasm-driver 的 query()/exec() 分工天然满足。

## ② `transactionSync` 嵌套/SAVEPOINT — ✅ 嵌套放行且真 savepoint 粒度；显式 SQL 事务全拒

**结论**：

- `transactionSync` **可嵌套**（实测深度 5 无碍），且回滚粒度是**真 savepoint**：外层写 A → 内层写 B 后 throw（被外层 catch）→ 外层写 C → 提交后 A、C 在、B 无（实测）。
- 显式 `BEGIN` / `SAVEPOINT` / `RELEASE` SQL 语句一律被拒：`Error: To execute a transaction, please use the state.storage.transaction() or transactionSync() APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements…`（实测，transactionSync 内部执行同样拒）。
- transactionSync 内 throw 自动回滚（实测确认）。

**证据来源**：实测（do-lab `/battery` + vitest `nesting.test.ts`）。

**对设计的影响**：**design.md §6 的「transactionSync 深度守卫（不可嵌套）」前提过时，应删**——DoSqlDriver.transaction 直接递归映射 `ctx.storage.transactionSync`，与 wasm-driver 的 BEGIN/SAVEPOINT 深度计数行为等价（核内 tx 包 tx 的先例 migrate→backfill 无需特判）。wasm-driver 用 SQL 语句实现事务的方式**不能照搬**（会被 workerd 拒），必须走 transactionSync API。

## ③ PRAGMA / FTS5 可用性 — ✅ table_info 可用、FTS5 可建；user_version/journal_mode 被拒

**结论**（实测逐条）：

| 语句 | 结果 |
|---|---|
| `PRAGMA table_info(t)` | ✅（schema-init.ts:30 的 hasColumn 原样可跑） |
| `PRAGMA table_list` | ✅（含 FTS shadow 表；本地另有 `__miniflare*` 表，勿 assert 表集全等） |
| `PRAGMA foreign_keys`（读） | ✅ 恒 1（**强制 ON**，写 OFF 被静默忽略；核内 schema 无 FK，无碍） |
| `PRAGMA defer_foreign_keys` / `case_sensitive_like` / `recursive_triggers` | ✅ |
| `PRAGMA user_version`（读/写） | ❌ `not authorized: SQLITE_AUTH` |
| `PRAGMA journal_mode` | ❌ `SQLITE_AUTH`（db.ts 的 WAL 设置在 node 半区，不进房间，无碍） |
| `CREATE VIRTUAL TABLE … USING fts5` + MATCH 查询 | ✅ |
| `json_extract` 等 JSON 函数 | ✅ |

**证据来源**：实测（do-lab `/battery` + `/probe`）。

**对设计的影响**：schema-init 的列探测机制可原样移植；房间 schema 版本管理不能用 user_version（用 meta 表即可，核内本来就是 meta 表）。search 若将来进房间，FTS5 不是障碍。

## ④ DO 行大小上限 + 免费档每请求 CPU — ✅ 行 ~2MB 实测硬顶；CPU 是 30s 不是 10ms

**结论**：

- **行/值上限**：官方口径「Maximum string, BLOB or table row size: 2 MB」。实测边界：单值 2100KiB（2,150,400B）可写，2150KiB（2,201,600B）→ `SQLITE_TOOBIG`；多列合计同受限（1MiB+1MiB 过、1.5MiB+0.7MiB 炸）。**预算按 2MB 算，实测顶约 2.1MiB**。本地 workerd 真实执行该限制。
- **SQL 语句长度**：官方 100KB；实测 120KB 字面量 → `statement too long: SQLITE_TOOBIG`。
- **每请求 CPU**：**「CPU per request: 30 seconds (default)」且免费/付费不分档**（官方 DO limits 表中按档拆分的只有类数 500/100 与账号存储 无限/5GB）；「Each incoming HTTP request or WebSocket message resets the remaining available CPU time to 30 seconds」。Workers 免费档 10ms 那条是 Worker（无 DO）请求的限制。**「若 10ms 则 seed 分页重估」的担忧不成立**。免费档真正的预算约束：10 万请求/天、13,000 GB-s 时长/天、5GB 存储、100 个 DO 类。
- 顺带：每表最多 100 列（核内最大表远低于此）。

**证据来源**：行/语句上限=实测 + [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)；CPU/免费档=文档结论（[DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)、[DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)）。

**对设计的影响**：seed 分页保留（为单请求体积/内存，不为 CPU）。分区数据行天然在限内：site_files 内联行 ≤ INLINE_LIMIT 256KiB（sites-core.ts:262，超限/图片一律 blob 编码走 room_blobs 分块），guest 值 ≤ 8KiB（assertGuestPayload）——无超限风险。**100KB 语句上限提醒**：摘要对账/全量重发等批量 SQL 不要拼接大字面量，用绑定参数或分批。

## ⑤ Bun.build 产 workerd ESM — ✅ 可行，含真实 core 模块打包零泄漏

**结论**：`Bun.build({ target: "browser", format: "esm", external: ["cloudflare:workers"] })`：

- `import { DurableObject } from "cloudflare:workers"` 原样保留为产物唯一 import（实测）；
- 产物 `export { worker_default as default, MhRoom }` 形状正确（实测）；
- **强验证**：把仓库真实可移植模块（sites-core.ts + records.ts + crdt.ts 整个依赖闭包，37KB 产物）打进去，**零 `node:` / `bun:` 泄漏**（实测正则扫描产物）。

**证据来源**：实测（workerd-esm/build2.ts）。

**对设计的影响**：构建管线照设计走（dist/room-worker.js → 文本内嵌 CLI），无需兜底方案。可移植半区（db-worker 先例）对 workerd 同样成立，marker 断言照 SKILL.md 机制加即可。

## ⑥ Workers 上传 API：migration 幂等 / secret / token 粒度 — ⚠️ 建议改用声明式 `exports`；token 确认只能账号级

**结论**（均为文档结论，未实际调 API）：

- **migration 幂等**：CF 于 **2026-06-30 上线声明式 `exports` 字段**（multipart metadata 已支持），取代命令式 migrations 数组：`"exports": { "MhRoom": { "type": "durable-object", "storage": "sqlite" } }`。**「The current state of your exports map is the source of truth」——无 tag 链、重复提交同一 map 天然幂等**；新建 namespace 强制 sqlite 后端。注意单向门：一旦用 exports 部署，不能退回 legacy migrations。legacy 路径的坑（tag 链式匹配、对已存在类重复 `new_sqlite_classes` 报错——文档明示「You cannot enable a SQLite storage backend on an existing, deployed Durable Object class」）随之整体消失。
- **secret 随部署提交**：两条路都有——(a) multipart metadata 的 bindings 里内联 `{"type":"secret_text","name":…,"text":…}`，配 `keep_bindings` 保留未重传的既有 secret；(b) 专用端点 `PUT /accounts/{a}/workers/scripts/{name}/secrets`（body `{name,text,type:"secret_text"}`）。**推荐 (b)**：PUT 脚本时 `keep_bindings:["secret_text"]` 防误删，secret 单独设置，脚本重部署不必带 secret 明文。
- **token 最小粒度**：`Workers Scripts Edit` 权限组 scope = `com.cloudflare.api.account`，**账号级，不能限到单 Worker 脚本**。设计中「deploy 文案诚实标注」路线确认执行：token 可以限单账号+仅 Workers Scripts（+D1）权限，但在账号内对所有 Worker 有效，靠行为约定+开源审计兑现「只碰点名资源」。

**证据来源**：[declarative exports changelog](https://developers.cloudflare.com/changelog/post/2026-06-30-declarative-do-class-exports/)、[DO migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)（含 legacy 页）、[multipart-upload-metadata](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/)、[scripts/secrets API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/)、[API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)。

**对设计的影响**：**design.md §6「PUT script(multipart+DO binding+migration new_sqlite_classes 首次)」应改为 metadata.exports 声明式**——`mh edge deploy` 每次提交同一份 exports map 即幂等，省掉"首次才带 migration"的状态判断。edge deploy 首次上线即用 exports（新 Worker 无历史包袱，单向门无代价）。

## ⑦ 本地对 WS Hibernation 的支持 — ✅ 两条测试路径都通；真休眠只能生产验证

**结论**：

- **wrangler dev（真 workerd）**：`ctx.acceptWebSocket` / `serializeAttachment`+`deserializeAttachment` / `setWebSocketAutoResponse` / `getWebSockets` / `webSocketMessage` handler 全部可用；autoResponse 实测生效（client 发 "ping" 收 "pong"，handler 未触发——零计费保活语义本地可模拟）。
- **vitest-pool-workers 0.18.5**：`runInDurableObject(stub, (instance, state) => …)` 直接拿 `state.storage.sql` / `transactionSync` 跑契约用例可行（DoSqlDriver 与 wasm-driver 同用例的测试计划成立）；hibernation API 面在 vitest 池里同样存在。**注意 API 已改**：旧文档的 `defineWorkersConfig`（`@cloudflare/vitest-pool-workers/config` 子路径）已不存在，vitest 4 配套用法是 `import { cloudflareTest } from "@cloudflare/vitest-pool-workers"` 作为 vite plugin：`defineConfig({ plugins: [cloudflareTest({ wrangler: { configPath } })] })`。
- **限制**：本地不会真正驱逐/休眠 DO——「休眠后内存清空、唤醒重建 + attachment 幸存」的完整生命周期只能生产冒烟验证（标注进 Stage C 测试计划）。

**证据来源**：实测（do-lab `/ws` + vitest `do.test.ts`）。

**对设计的影响**：测试三层照设计走（纯 Bun 收敛测试 / vitest 契约用例 / wrangler dev e2e），无需调整;仓库引入 vitest 时按新 plugin API 写配置。P1 验收补一条「生产环境休眠唤醒后 attachment 会话仍有效」的手工冒烟。

## ⑧ workerd `Date.now` 冻结语义 — ⚠️ 生产冻结（文档），本地 dev 不冻结（实测）

**结论**：

- **生产**（官方安全模型文档，原文）：「`Date.now()` returns the time of the last I/O. It does not advance during code execution.」即同步执行期间冻结，跨 await 是否推进取决于该 await 是否发生真实 I/O（网络/存储/定时器）；纯 microtask await 不推进（文档推论）。定时器（setTimeout/scheduler.wait）属 I/O，等待归来后时钟已推进——设计中「counter>0xF000 时 scheduler.wait(1)」的前提成立（文档结论；本地实测 scheduler.wait(5) 后 Date.now +5 一致）。
- **本地 wrangler dev 不冻结**（实测）：15ms busy spin 期间 Date.now 推进了 15ms——本地跑不出「同 millis 高频写导致 counter 猛涨」的生产工况。
- 顺带实锤设计中提到的核内潜在 bug：hlc.ts `nextHlc` counter+1 无上限（hex4 定宽，溢出 0xffff 后 formatHlc padStart(4) 变 5 位破坏字典序）；`nextHlc(db, node, now = Date.now())` 的 `now` 参数可注入,便于单测模拟冻结时钟。

**证据来源**：[security model](https://developers.cloudflare.com/workers/reference/security-model/)（文档）+ 实测（do-lab `/clock`）+ 核内 hlc.ts 源码。

**对设计的影响**：HLC counter 防护照设计做,但**验证手段要改**：本地 e2e 测不出冻结工况，用注入 `now` 的单测模拟「millis 恒定 + 连续 nextHlc」断言 scheduler.wait 触发路径，生产冒烟兜底。counter 溢出定宽 bug 可单独修（钳制 0xffff + 溢出时强制 millis+1，与本工程解耦）。

## ⑨ grants-core 接口与信箱/房间消费端对齐 — ⚠️ 两个缺口，无方向性矛盾

**结论**：逐条比对 design.md §4 Batch4.5 声明面与 §5（信箱 ingest）/§6（DO 房间）消费端：

**缺口 1（必须补）**：§5 隔离校验依赖 `grants-core.checkGuestChanges`（拒 blob 型 property 防悬挂哈希），但 Batch 4.5 的声明面只有意图级原语（authorize*/guest*Record），**没有 op 级校验器**。信箱信封装的是预署 op（Change[]），形状不同。应把它列入 grants-core 首发面（Stage B 前置，Batch 4.5 实现时一并落）。

**缺口 2（一行改动）**：Batch 4.5 说「类型校验委托 records.ts coerce()」——**coerce 目前是 records.ts:62 的私有函数，未导出**，需要 export（或经薄包装导出）。

**最终接口签名清单**（Batch 4.5 实现基准）：

```ts
// src/core/grants-core.ts — portable, driver-only
export type GrantOp = "read" | "create" | "update";          // delete 永不进枚举
export interface GrantTable { db: string; ops: GrantOp[] }   // db = database id，非名字
export interface GrantSet { v: 1; tables: GrantTable[] }

export function parseGrantSet(raw: string | null | undefined): GrantSet;
//   default-deny：null/坏 JSON/未知 op/v≠1 → { v: 1, tables: [] }
export function grantAllows(set: GrantSet, dbId: string, op: GrantOp): boolean;
export function authorizeDbRef(db: DbDriver, set: GrantSet, dbRef: string, op: GrantOp): DatabaseRow;
export function authorizeRecord(db: DbDriver, set: GrantSet, recordId: string, op: GrantOp): RecordRow;
//   未授权与不存在统一 MhError("auth")，防枚举
export function assertGuestPayload(db: DbDriver, set: GrantSet, database: DatabaseRow,
  values: Record<string, unknown>): void;
//   64KiB body / 8KiB 值 / 64 cells / 表 10k 行；relation：public 拒、share 要求目标库 ∈ set
export function guestCreateRecord(db: DbDriver, set: GrantSet, guestNode: string,
  dbRef: string, values: Record<string, unknown>): RecordRow;
export function guestUpdateRecord(db: DbDriver, set: GrantSet, guestNode: string,
  recordId: string, values: Record<string, unknown>): RecordRow;
//   校验后 withNodeId(guestNode, …) 包装（crdt.ts 已导出 withNodeId ✓）
export function checkGuestChanges(db: DbDriver, set: GrantSet, guestNode: string,
  changes: Change[]): void;                                  // ← 补缺口 1
//   op 级：dataset 仅 records / 全 change node 段 === guestNode / col ∈ 授权库属性
//   / 拒 blob 型 property / 值经 coerce 校验；HLC 钳制不在此层（属 ingest/sync 层，§7 红线 6）
```

**已确认一致的项**：三消费端 guest 身份都以参数传入（公开匿名 `gp-<site8>-<node8>` 派生 / share·房间解锁铸子 id / 信箱信封 `g`+8）✓；房间 P2 写=意图 + 房间盖 HLC，直接消费 guestCreate/UpdateRecord，与 share-serve 写形状同（决策 1）✓；`shares.grants` node-local、房间 GrantSet 经 provision/sync 的 `share_state` 下发，收权随下轮同步 ✓；delete 不进枚举与 evict 不产 op 红线自洽 ✓；可移植性 ✓（依赖闭包 records/crdt/properties/databases 已被 db-worker wasm 先例覆盖 + 本次 ⑤ 打包实测零泄漏）。

**建议（非阻塞）**：`serveGrantedApi` 保持 `(req, deps)` 纯 fetch 形状、driver-only,rate-limit 与 requestIP 留宿主注入——房间 handlers 可直接复用同一实现,免得五条路由写两遍。

**证据来源**：design.md §4/§5/§6 比对 + 核内源码（records.ts / crdt.ts / hlc.ts / sites-core.ts / db-worker.ts import 面）+ ⑤ 打包实验。

## ⑩ Bun `.html` 的 `with {type:"text"}` import — ✅ 可行，无需改名 .html.txt

**结论**（实测）：

- `import tpl from "./tpl.html" with { type: "text" }`：`bun run` 与 `bun build --compile` 产物中均得到**逐字节原文字符串**（marker、`src="./missing.js"` 等引用原样保留，不触发 HTML loader 的资源打包）。
- 对照组：**不带 attribute** 时 HTML loader 接管（runtime 得 `HTMLBundle` 对象；`--compile` 下会尝试解析并打包模板内引用的 js/css，引用不存在直接构建失败）——所以 attribute 不能省。
- **TS 类型面**：bun-types 的 `declare module "*.html"`（HTMLBundle）会命中模板导入；实测更长后缀的 ambient 声明胜出——仿 skill-asset.d.ts 加 `declare module "*/site-starter.html" { const text: string; export default text; }` 即可让 `string` 类型通过 tsc（实测 tsc 通过）。

**证据来源**：实测（html-import/main.ts、main2.ts、main3.ts + tsc）；与仓库现行机制同构（scripts/compile-binaries.ts 同用 `bun build --compile`，SKILL.md 文本内嵌同用该 loader）。

**对设计的影响**：Batch 5 scaffold 模板照原案 `src/cli/site-starter.html` 命名,兜底方案（.html.txt）不需要;记得配一个 `src/types/` 下的 ambient 声明。

---

## 红旗与设计修订汇总

1. **§6 DoSqlDriver「transactionSync 深度守卫（不可嵌套）」删除**——实测可嵌套且真 savepoint 粒度,直接递归映射（②）。
2. **§6 部署改声明式 `exports`**——「migration new_sqlite_classes 首次」的状态判断整体删除,每次提交同一 exports map 天然幂等（⑥）。
3. **grants-core 首发面补 `checkGuestChanges`,records.ts 导出 `coerce`**（⑨）。
4. **CF token 只能账号级**——deploy 文案照设计诚实标注,确认无更细粒度可用（⑥）。
5. **本地 dev 时钟不冻结**——HLC counter 防护的验证改为注入时钟的单测 + 生产冒烟,本地 e2e 测不出该工况（⑧）。
6. 编码守则三条：多语句 exec 只用于无参 DDL/DML、SELECT 单独执行（①）;批量 SQL 用绑定参数防 100KB 语句上限（④）;vitest 配置用新版 `cloudflareTest` plugin API（⑦）。
7. 免费档 CPU 是 30s/请求非 10ms,seed 分页策略无需因 CPU 重估（④）。
