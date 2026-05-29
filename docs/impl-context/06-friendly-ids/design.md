# 友好 ID：类型前缀 + 引用解析 + 当前库上下文 + Shell 补全 设计文档

承接 [01-init-basic-func/design.md](../01-init-basic-func/design.md)、[05-json-record-storage/design.md](../05-json-record-storage/design.md)。本文记录把「ID 的**存储**」与「ID 的**引用**」彻底分离：存储层仍是全局唯一、离线 CRDT 安全的 id；引用层给人和 AI 一套「够用就行」的短引用（类型前缀 / 唯一前缀 / 名字 / 当前库上下文 / Tab 补全）。

**底层 oplog 与 sync 协议、CRDT 收敛全部不改**——`crdt_changes.row_id`、`records.data` 的 JSON key、`crdt_changes.col` 都是不透明字符串，给 id 加类型前缀对它们零成本；快照/重放只搬运 row_id，无需特殊处理。

## 1. 背景与目标

现状(对话分析)：所有实体共用 `makeId(name) = slugify(name)-randomSuffix(6)`(`ids.ts:25`)，引用一律精确全 id 匹配——`getDatabase/getRecord/getDocument/getProperty` 均 `WHERE id = ?`(`databases.ts:23`、`records.ts:130`、`documents.ts:129`、`properties.ts:101`)，CLI 把 id 当必填 positional(`db.ts:33`、`record.ts:65` 等)。三个体验破口：

- **必须粘贴完整 id**：随机后缀无法记忆，record/block 的 id 还派生自正文(`records.ts:101`、`documents.ts:34`)可长达 32 字符 + 后缀，手输几乎不可能。
- **id 不自带类型**：`test-abc` 可能是 record / db / doc，孤立看无法分辨，认知负担重。
- **每次重复带 database id**：无「当前库」概念，`record list/create <db>` 每次都要给。

约束：离线多节点创建不能撞 id(CRDT 系统，`crdt_changes` `schema.ts:8`)——**随机后缀必须保留在存储层**，不能改自增整数或纯 slug。

目标：存储层 id 不动(全局唯一 + CRDT 安全)，在 CLI/查找边界加一个**引用解析层**，使人/AI 用类型前缀、唯一前缀、名字或当前库上下文即可定位实体，并提供真正的 Tab 补全。

## 2. 设计要点

### 2.1 类型前缀 ID(地基)

新建实体的 id 格式：

```
<kind>_<slug>-<rand>
db_tasks-a3f9   prop_status-x7p2   rec_login-bug-k2p9   doc_design-9fk3   blk_intro-m4x8
```

前缀↔数据集(dataset/表)映射：

| kind | dataset(`crdt.ts` DOMAIN) | 表 |
|------|------|-----|
| `db`   | databases | databases |
| `prop` | properties | properties |
| `rec`  | records | records |
| `doc`  | documents | documents |
| `blk`  | doc_blocks | doc_blocks |

**为什么 `_` 是安全分隔符(关键)**：`slugify` 把非字母数字全替换为 `-`(`ids.ts:17`)，`randomSuffix` 是 base36 小写(`ids.ts:6`)——**两者都不含 `_`**。故新 id 中**唯一的 `_` 就是类型分隔符**，`idKind(id)` = 取首个 `_` 之前的子串并校验白名单即可。旧 id(无任何 `_`)→ `idKind` 返回 `null`，解析器按「无类型」处理，与新 id 自然共存。

`ids.ts` 新增：

```ts
export type Kind = "db" | "prop" | "rec" | "doc" | "blk";
export function newId(kind: Kind, name: string, fallback = kind): string {
  return `${kind}_${slugify(name, fallback)}-${randomSuffix()}`;
}
export function idKind(id: string): Kind | null { /* prefix before first "_", validated */ }
```

各生成点改用 `newId`：`databases.ts`(db)、`properties.ts:88`(prop)、`records.ts`(rec，`deriveTitle` 改 `newId('rec', …)`)、`documents.ts:118`(doc)、`documents.ts:34 makeBlockId`(blk)。

**类型前缀本身就解决了 `test-abc` 歧义**：`db_test-…` / `rec_test-…` / `doc_test-…` 一眼可辨，且让解析器无需上下文即可分派类型。

### 2.2 中心引用解析器 `resolveRef`(方案 A)

新增 `src/core/resolve.ts`，导出纯查询函数(只读，不 emit)：

```ts
interface Candidate { kind: Kind; id: string; label: string }
// 把一个用户输入的引用解析成确切 row id；可约束类型与库范围
export function resolveRef(
  db: Database, ref: string,
  opts?: { kind?: Kind; databaseId?: string },
): string  // 命中唯一→id；0→throw "no such X"；多→throw 列候选
export function resolveCandidates(db, ref, opts?): Candidate[]  // 供补全/歧义提示复用
```

解析顺序(短路)：

1. **精确 id 命中** → 直接返回(保证全 id 永远可用，向后兼容)。
2. **类型分派**：`ref` 带前缀(`idKind` 非 null)→ 约束到该 kind；否则用 `opts.kind`(命令已知类型)或跨全部 kind(通用 `mh get`)。
3. **候选收集**(按 kind)：
   - 唯一 **id 前缀**：`id LIKE ref || '%'`(git 短 SHA 风格)。
   - **名字/标题**：db.name / doc.title / prop.name 大小写不敏感等值；record 无独立名字，靠 id 前缀(标题已 slug 进 id)。
   - `opts.databaseId` 给定时，rec/doc/prop 的候选**限定在该库内**(消歧主力)。
4. 唯一 → 返回；0 → `no such <kind>: <ref>`；多 → git 风格歧义错误，列出候选 `id  label  (kind)` 并提示「加长以消歧」。

解析器放在 core(可单测、API 复用)；核心 `get*` 函数仍只接受精确 id(API 语义保持精确)，由 CLI 调 `resolveRef` 后再传精确 id 进去。

### 2.3 当前数据库上下文 `mh use`(方案 B)

用已有的**本地 `meta(key,value)` 表**(`schema.ts:2`，不进 oplog、不随 sync——正是「本机上下文」该有的性质，与 `node_id`/`search_hlc` 同表 `node.ts:11`、`search.ts:46`)存 `current_db`。

新增 `src/core/context.ts`：`getCurrentDatabase(db) / setCurrentDatabase(db,id) / clearCurrentDatabase(db)`。

新增 CLI `mh use`：
- `mh use <db-ref>` → `resolveRef(kind:db)` 后写入 `current_db`，回显 `✓ current database → <name> (<id>)`。
- `mh use`(无参) → 显示当前库；`mh use --clear` → 清除。

`record`/`prop`/`doc` 命令的 `database` 位置参数**改为可选**，缺省时取 `current_db`；再缺省则 `fail("no current database; pass <db> or run \`mh use <db>\`")`。保留 `--db` 显式覆盖。

### 2.4 通用 `mh get`(类型前缀红利)

新增顶层 `mh get <ref>`：不约束 kind，调 `resolveRef`。带前缀→按前缀分派；无前缀→跨所有 kind 找，唯一即命中，跨类型歧义时报错并标注每个候选的类型。一个命令吃所有实体，AI/人都少记命令。

### 2.5 动态 Shell 补全(方案 C)

citty 无内置补全，采用 gh/kubectl 同款「外部脚本回调隐藏命令」：

- 隐藏命令 `mh __complete <kind|any> <partial>`(不在 help 展示)：调 `resolveCandidates`，逐行打印 `id`(可带 `\t label`)。当前库上下文自动生效，故只补当前库内的 rec/doc。
- `mh completion <bash|zsh|fish>`：打印对应 shell 的补全脚本(脚本内调 `mh __complete`)。用户 `eval "$(mh completion zsh)"` 或写入 rc 文件即可 `mh record get rec_<Tab>` 实时补全。

### 2.6 (可选)缩短 record/block id

record id 现派生自整段正文(`records.ts:109`)，即便有名字解析仍偏长。可选：`newId('rec', title)` 时只取标题前若干词或回退 `rec_<dbslug>-rand`。**本期不强制**，与解析层正交，可后续单独调。

## 3. 取舍

- **id 含前缀(进主键)而非仅显示装饰**：前缀必须出现在 `crdt_changes.row_id`、JSON 输出、日志里，AI/日志才能自解释、解析器才能分派——装饰化无法达成目标。代价是 id 变长 3–5 字符，由前缀解析/补全抵消。
- **不做一次性迁移**：旧 id(无 `_`)与新 id 共存；旧 id 永远可精确匹配，解析器对二者都工作。无 schema 版本、无回填，零风险。新旧风格并存是可接受的过渡代价。
- **歧义一律报错列候选(git 风格)**，不做「取最新」「交互选择」：对 AI/脚本安全(无静默误操作)、可预测；交互选择对非 TTY 不友好。
- **名字解析仅 db/doc/prop，record 靠 id 前缀**：record 无稳定唯一名字(可重名、可无标题)，标题已 slug 进 id，前缀匹配已够；避免给 record 强加「名字」语义。
- **解析放 core 但 `get*` 仍精确**：保持核心 API 精确可预测，便利层只在 CLI 边界；core 仅多出一个只读 `resolve.ts` 供复用与单测。
- **当前库存本地 `meta` 而非同步**：上下文是「这台机器此刻在看哪个库」，本就不该随 sync 跑到别的节点。
- **relation/parent 值的解析范围**：`--db`/`--parent`/`--target` 这类**显式单实体引用**走 `resolveRef`；而 `--data` JSON 里的 relation 值(可为数组、可混入任意键)本期仍要求完整 id，避免在自由 JSON 里做有歧义的猜测，后续按需再加。
- **补全用外部脚本回调**：citty 无原生补全，回调式是业界标准(gh/kubectl)，且能反映当前库上下文与实时数据；代价是每种 shell 一份脚本。

## 4. 涉及文件

- 新增：
  - `src/core/resolve.ts` — `resolveRef` / `resolveCandidates`(纯只读查询) + 测试 `resolve.test.ts`(精确/前缀/名字/歧义/跨类型/库内消歧)。
  - `src/core/context.ts` — `get/set/clearCurrentDatabase`(本地 meta)。
  - `src/cli/commands/use.ts` — `mh use [<db>] [--clear]`。
  - `src/cli/commands/get.ts` — 通用 `mh get <ref>`。
  - `src/cli/commands/completion.ts` — `mh completion <shell>` + 隐藏 `__complete`(或并入 index 隐藏子命令)。
- 修改：
  - `src/core/ids.ts` — 加 `Kind`/`newId`/`idKind`(保留 `makeId`/`slugify`/`randomSuffix`)。
  - `src/core/databases.ts`、`src/core/properties.ts`、`src/core/records.ts`、`src/core/documents.ts` — id 生成点改用 `newId(<kind>, …)`(其余逻辑、emit 不变)。
  - `src/core/index.ts` — 导出 `resolve.ts` / `context.ts`。
  - `src/cli/commands/db.ts`、`prop.ts`、`record.ts`、`doc.ts` — id/db/parent/target 参数经 `resolveRef`；`database` positional 改可选并回退 `current_db`；加 `--db` 覆盖。
  - `src/cli/index.ts` — 注册 `use`/`get`/`completion`/`__complete` 子命令。
  - 受 id 格式断言影响的测试(若有)随之更新；oplog/sync/snapshot/搜索逻辑**不改**(ids 对其不透明)。

## 5. 实现记录（与设计的偏差）

- **解析顺序**：`opts.kind`(命令已知类型)**优先于** ref 的类型前缀分派——`mh record get doc_x` 直接报 "no such record" 而非误命中文档，错误更清晰；前缀分派只在无 `opts.kind` 的通用 `mh get` 生效。
- **record/prop 的 id 解析不按当前库 scope**：保证「完整 id 跨库永远可用」（scope 会把别库的全 id 过滤掉）。当前库 scope 只用于 `list`/`create`/补全。
- **`prop add` 的库参数改为 `--db` 标志**（非位置参数）：因其后跟必填位置参数 `name`，可选前导位置参数会被 citty 错位；与 `doc create --db` 一致，并支持当前库回退。
- **`doc create --db` 不默认当前库**：文档可独立存在；补全里 doc 也不按当前库过滤（仅 rec/prop 过滤）。
- **前缀匹配上界哨兵**用 `'{'`(0x7B，紧邻 'z' 之后)，配合主键 BINARY 序做范围扫描。
