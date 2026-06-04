# 数据完整性 invariant 实现文档

配套设计见 [design.md](./design.md)。本文是代码级实现说明。承接 [03-snapshot-restore/implementation.md](../03-snapshot-restore/implementation.md)(restore 接入点)。

## 1. 改动文件

| 文件 | 改动 |
|------|------|
| `src/core/integrity.ts` | 新增:全部逻辑。`validateHub` / `repairHub` + `Issue` / `IntegrityReport` / `RepairResult` 类型 |
| `src/core/databases.ts` | `deleteDatabase` 增级联:tombstone properties/records、detach documents(新增 `liveChildren` 助手) |
| `src/core/properties.ts` | `removeProperty` 增孤儿单元格清理(`emit(undefined)` → json_remove) |
| `src/core/documents.ts` | `deleteDocument` 增级联:tombstone 自身 blocks、unparent 子文档(新增 `liveChildIds` 助手) |
| `src/core/snapshot.ts` | `restoreSnapshot` 两条路径(merge+reset)末尾调 `repairHub`;`RestoreResult` 加 `repaired` |
| `src/cli/commands/doctor.ts` | 新增:`mh doctor`(只读体检) |
| `src/cli/commands/repair.ts` | 新增:`mh repair [--dry-run]` |
| `src/cli/index.ts` | 注册 `doctor` / `repair` 子命令 |
| `src/cli/commands/restore.ts` | 输出加 `repairs` 计数 |
| `src/core/integrity.test.ts` | 新增:13 例(乱序前向引用、tombstone 触发、级联、孤儿 cell、发散收敛、不动点、环、去重分级、报告项) |

逻辑下沉到 `src/core/integrity.ts`,命令层只接线(与既有 `snapshot.ts`/`restore.ts` 一致)。

## 2. 核心(`src/core/integrity.ts`)

### 2.1 弱引用检测(`broken_ref`)

每条规则一个 `{srcTable, fk, tgtTable, fix}`,用一条 JOIN 同时表达「源 live、目标存在且 tombstone」——这正是铁律 3.1(只对 tombstone 动手):

```sql
SELECT s.id, s.<fk> FROM <srcTable> s
JOIN <tgtTable> t ON t.id = s.<fk> AND t.__deleted = 1
WHERE s.__deleted = 0 AND s.<fk> IS NOT NULL
```

`fix`:`tombstone-src` → `emit(srcTable, id, "__deleted", 1)`;`null-fk` → `emit(srcTable, id, fk, null)`。`srcTable` 同时是 emit 的 dataset 名。

### 2.2 孤儿单元格(`orphan_cell`)

`json_each` 展开记录 data,JOIN 已 tombstone 的属性:

```sql
SELECT r.id AS rec, j.key AS prop
FROM records r, json_each(coalesce(r.data,'{}')) j
JOIN properties p ON p.id = j.key AND p.__deleted = 1
WHERE r.__deleted = 0
```

修复 `emit(db, "records", rec, prop, undefined)` —— **必须 `undefined`** 才物化为 `json_remove` 真正删 key;若用 `null` 会把单元格设成 JSON null(key 仍在),`json_each` 仍命中,**破坏不动点**。属性仅 absent(未 tombstone)的 key 容忍不动(可能是前向引用)。

### 2.3 重复文件路径(`dup_path`)

`ORDER BY site_id, path, created_hlc, id` 后分组,组内**首个**是 winner(= 读侧 `getFileForServe`/`fileIdFor` 的 `created_hlc LIMIT 1`),其余 loser `emit __deleted=1`。

### 2.4 文档父子环(`parent_cycle`)

只取 **live 且父也 live** 的边(父被删归 `broken_ref`,父 absent 不成环),走经典访问标记找环;每个环在 `(created_hlc, id)` 最大成员处 `emit parent_id=null` 断开(确定性,与遍历顺序无关)。

### 2.5 仅报告(`dup_name` / `bad_config`)

`GROUP BY ... HAVING count>1` 找同库重名 property / 重名 database;`bad_config` 复用 `properties.ts:validateConfig` 同规则的非抛错版。二者 `fixable=false`,不修。

### 2.6 入口

```ts
export function validateHub(db): IntegrityReport      // 跑全部 detect,归类计数,只读
export function repairHub(db): RepairResult           // 循环 repairPass 到不动点,再 validate 取 remaining
```

`repairHub` 循环上限 20 次:一次修复可能暴露后续(如 tombstone 属性后其单元格成孤儿),迭代到 `applied===0` 收敛;返回 `{applied, fixed(按类计数), remaining}`。

## 3. 写时级联(对齐既有 `deleteSite`)

```ts
// databases.ts:deleteDatabase —— 删除节点一次性 emit
emit("databases", id, "__deleted", 1);
for (p of liveChildren(db,"properties","database_id",id)) emit("properties", p, "__deleted", 1);
for (r of liveChildren(db,"records","database_id",id))    emit("records", r, "__deleted", 1);
for (d of liveChildren(db,"documents","database_id",id))  emit("documents", d, "database_id", null); // detach

// properties.ts:removeProperty —— 清理该属性单元格
emit("properties", id, "__deleted", 1);
for (r of recordsWithCell(db, prop.database_id, id)) emit("records", r, id, undefined); // json_remove

// documents.ts:deleteDocument —— tombstone blocks + unparent 子文档
emit("documents", id, "__deleted", 1);
for (b of liveChildIds(db,"doc_blocks","doc_id",id)) emit("doc_blocks", b, "__deleted", 1);
for (c of liveChildIds(db,"documents","parent_id",id)) emit("documents", c, "parent_id", null);
```

每种处理与 `repairHub` 对应规则**一致**(删库 detach 文档、删父 unparent 子),故级联与兜底结果相同。

## 4. restore 接入(`src/core/snapshot.ts`)

merge 与 reset 两条路径在 `rebuildDeclaredIndexes` 之后各调一次 `repairHub(db).applied`,计入新增的 `RestoreResult.repaired`:

```ts
const repaired = repairHub(db).applied;   // merge 分支
...
rebuildDeclaredIndexes(db);
const repaired = repairHub(db).applied;   // reset 分支(tx 之后)
```

## 5. 命令接线

```ts
// doctor.ts —— 只读
const report = validateHub(openMetahub());
print(report, () => report.ok ? "No integrity issues found." : `${report.total} issue(s): ...\n` + table(...));

// repair.ts —— --dry-run 走 validateHub,否则 repairHub
if (args["dry-run"]) { print(validateHub(db)); return; }
const result = repairHub(db);
print(result, () => `Applied ${result.applied} repair(s): ...` + 列出 remaining 报告项);
```

`src/cli/index.ts` 在 `subCommands` 加 `doctor, repair`。

## 6. 用法

```sh
mh doctor                 # 只读体检,列出 category/entity/id/fix/detail
mh repair --dry-run       # 仅报告将修复什么(等价 doctor)
mh repair                 # 确定性修复,改动随 oplog 复制
mh restore x.mhpack       # merge 后自动跑 repair,输出含 repairs 计数
```

## 7. 测试与验证

- `bun test src/core/integrity.test.ts`(13 例):乱序前向引用不被误删;仅 tombstone 才触发;deleteDatabase/removeProperty/deleteDocument 级联;孤儿 cell 清理;**两发散节点(A 删库 / B 并发建记录)各自 repair 后 `fullSnapshot` 相等且 `validateHub.ok`**;不动点(二次 repair = 0);post-sync 父子环被确定性打断;`dup_path` 去重而 `dup_name` 仅报告;`bad_config` 报告;健康库 repair = no-op。
- `bun test`:全量 179 例通过(166 原有 + 13 新增)。
- `bunx tsc --noEmit`:新代码 0 新增错误(仅 `index.ts`/`sites-serve.ts` 两处**预先存在**的 citty/BodyInit 报错,已用 `git stash` 在 clean HEAD 复现确认)。
- CLI 端到端手验(临时 `METAHUB_HOME`):建库/属性/记录 → `doctor` 干净 → 直接 tombstone 属性造孤儿 cell → `doctor` 报 `orphan_cell=1` → `repair --dry-run` 预览 → `repair` 修复 → `doctor` 复检干净。
