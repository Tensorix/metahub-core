# 修改历史与回滚 + oplog 压缩 设计文档

承接 [01-init-basic-func/design.md](../01-init-basic-func/design.md)(CRDT oplog 为真相源、字段级 LWW)、[04-block-level-doc-crdt/design.md](../04-block-level-doc-crdt/design.md)(文档按块存储)、[13-data-integrity/design.md](../13-data-integrity/design.md)(tombstone 语义与 repair)。本文记录:**文档/记录/属性的修订历史与回滚**(`src/core/history.ts`)、**txn 修订分组**(`crdt.ts`)、**oplog 保留窗口压缩**(`src/core/compact.ts`),以及 WebUI 历史面板。

## 1. 核心判断:oplog 即历史,不建快照表

`crdt_changes` 是 append-only 的字段级写入日志(`INSERT OR IGNORE`,旧版本永不覆盖),LWW 规则下**任意时点 T 的状态 = 每个寄存器取 hlc ≤ T 的最大值**——与 `materialize()` 在头部应用的是同一条规则。因此历史是纯读侧能力:

- `documentAtVersion` / `recordAtVersion` / `propertyAtVersion`:按截止 HLC 重建寄存器状态;文档复用 `serializeDocBlocks` 逐字节还原正文(块化前的 legacy `documents.body` 寄存器按 `isBlockManaged` 同款规则回退)。
- 否决了"另建 record_history 快照表"的方案:双写一致性风险,且 oplog 已含全部信息;物化缓存留给实测出现性能瓶颈时再考虑。
- 辅助局部索引 `idx_changes_docref`(`value` 列,`WHERE dataset='doc_blocks' AND col='doc_id'`)服务"按文档找曾属块";做成局部是为了避免给携带大 value 的 site_files 行建索引。

## 2. 回滚 = 正向写入(revert is a new revision)

oplog 是 sync 的真相源(peer 按 rowid 游标增量拉取),**绝不删改历史条目**。回滚的实现:重建目标时点状态 → 与当前 diff → 把旧值作为**新的 emit** 写回:

- `revertDocument` 直接调 `updateDocument`(复用块 reconcile + `if-match`/`stale` 乐观锁,几乎零新写路径);支持复活已墓碑文档(先 emit `__deleted=0`,块从空集 reconcile 重建;删除时被解除父子关系的子文档不恢复)。
- `revertRecord` 逐字段 diff 后 emit;只触碰当前存活 property 的单元格(不重造 orphan cell,守 repair 不变量);可复活已删记录。
- 回滚本身成为历史顶部的新修订(kind=revert),可以"回滚这次回滚"——**任何版本永远可从历史找回**是对用户的核心承诺。
- 回滚到"已删除状态"被拒绝(`invalid_input`,该用 delete);CLI 对已删实体提供完整 id 直通(`resolveRef` 只匹配存活行)。

多机语义:revert 走普通 emit,收敛由现有 LWW+HLC 保证,不引入新冲突机制。离线并发时逐寄存器合并(revert 只 emit 有差异的寄存器,对方改的不相干块/字段必然保留);`if-match` 只能拦服务端已知的并发,拦不住未 sync 的离线编辑——UX 文案承诺"可找回"而非"恢复后即终态"。

## 3. txn 修订分组与 kind 标注

一次保存 emit 多条 change,oplog 原本没有分组概念。方案:

- `crdt_changes` 加可空 `txn` 列(存量库 `migrateOplog` ALTER 迁移);`withChangeGroup(label, fn)` + `grouped()` 包裹全部公开变更函数(嵌套保持外层 id,一次 revert 调 updateDocument 仍是一个修订)。async 的 `putFile` 不能整体包(await 后的 emit 会逃出组),改为内部包同步 emit 尾段。
- **txn 随 sync 协议复制**(protocol zod 加可选字段):修订聚簇是 oplog 内容的纯函数,各端历史视图逐条一致。旧版本 peer 剥掉该字段 → 退化为时间聚簇,过渡可接受。
- 聚簇规则:两条变更 txn 均非空 → 按 txn 分组;否则退回 (node_id + 1.5s 间隙) 启发式(兼容存量数据)。
- `kind = user | repair | revert`:从 txn label 前缀(`repair:`/`revert:`)推导。core 不过滤(展示层职责);CLI 摘要标 `[repair]`/`[revert]`,WebUI 默认隐藏 repair、留"显示全部"开关。

## 4. schema 级联回滚(prop revert)的跳过策略

`updateProperty` 改类型 / `removeProperty` 会级联清全表单元格。`revertProperty` 要同时恢复列定义和被清的数据,关键是**不覆盖用户后来手填的值**:

- 级联写入靠共享 txn 识别(与该 property 自身 post-target 变更同组的 records 写入)。
- 单元格仅当**当前胜者就是级联(或 repair)写入**时才恢复;恢复目标取"被级联覆盖前的最后一个非级联值"(而非 to 时点值——这样列创建后才填的数据也能救回,且 to 之后、级联之前的用户编辑被保留)。胜者是用户写入 → 跳过并计入 `skipped_cells`。
- 无 txn 的存量写入无法归因,一律按用户写入对待(保守不动)。
- 列定义直接 emit 寄存器恢复,**不走 `updateProperty`**(它的改类型级联会把刚恢复的单元格再清一遍)。恢复的旧值对恢复的旧 type/config 天然合法(本就配套)。

## 5. oplog 压缩(`mh compact`):保留窗口

历史无限增长的解法,语义 = 窗口内历史完整,窗口外坍缩为基线。一条 SQL:删除「hlc ≤ cutoff 且存在同寄存器、hlc 更大但仍 ≤ cutoff 的变更」。

安全不变量(每条都承重,详见 `src/core/compact.ts` 头注):

1. 只删被取代的 LWW 输家 → 头部物化状态逐字节不变,任何 peer 拿到幸存者即收敛。
2. 墓碑胜者必存活 → 已删行不会在新 peer 上复活。
3. **`rowid <> MAX(rowid)` 保护不可省**:SQLite 新 rowid = max+1,删掉最大行会导致 rowid 复用,使 peer 游标静默跳过新变更。
4. 纯本地操作(不 emit、不同步),各节点独立清理;压缩后的快照/初次配对全量同步反而更小。

配套:blob GC(引用集 = 剩余 oplog 中 site_files.content 的 value ∪ 物化行;只删 sha256 命名文件)+ `VACUUM`(失败降级为仅报告);`mh doctor` 报告 oplog 行数/可压缩量/库大小。cutoff 用 `counter=0xffff, node="~"` 构造,使同毫秒变更全部落入窗口内侧。

注意一个非直觉事实:块级文档的历史多为"新寄存器插入+墓碑"(单写寄存器),压缩只能删**被覆盖**的值,所以正文历史常比预期保留得久;真正坍缩的是反复覆写的寄存器(title、记录单元格)。

**明确不做**:自动定时压缩(将来归 `mh config`);"彻底抹除已删数据"(需全 peer 墓碑确认,另立特性)。

## 6. WebUI 历史面板与 diff 粒度教训

- 文档:"…"菜单 → 右侧抽屉(复用 `.peek` + `useDrawerTransition`),修订列表 + 只读预览 + "对比当前" diff;恢复带 `if_match`,`stale` → toast + 刷新(复用编辑器冲突处理模式);打开前 `flushSave`,恢复后 `DocViewHandle.reload()`。记录:RecordPeek 内切历史视图,逐修订字段 diff(相邻两版 `recordAt` 对比)。设备名经 `GET /api/nodes`(本机 + peers label)。
- **diff 粒度教训**(一轮返工):初版 diff 沿用存储层"空行块"切分 + 精确匹配 LCS → 连续列表改一行整块红绿。根因是**把存储粒度误用作展示粒度**——存储要的是块身份(精确匹配正确),展示要的是人的阅读单位。修正为 git 式行级 LCS(代码围栏内同样按行,空行不参与匹配)+ GitHub 式行内深浅双层高亮(del/add 行配对取公共前缀/后缀,中段深色;公共部分 < 行长 30% 视为整行重写不标)。存储与同步零改动。
- 桌面端坑:`body.desktop-mac .peek-head` 是窗口拖拽区,新增的 `.hist-toggle` 复选框需加入 no-drag 豁免。

## 7. 接口面

```bash
mh doc history <ref> | mh doc get <ref> --at <v> | mh doc revert <ref> --to <v> [--if-match]
mh record history <ref> [--field <名>] | mh record revert <ref> --to <v>
mh prop history <ref> | mh prop revert <ref> --to <v>
mh compact [--keep <days>] [--dry-run] [--no-vacuum]      # 默认 90 天;0 = 只留头部
```

HTTP(自动进 /docs):`GET /api/{document,record,property}/history`、`GET /api/{document,record}/at`、`GET /api/record/field-history`、`POST /api/{document,record,property}/revert`、`GET /api/nodes`。

错误沿用既有契约:版本不存在 → `not_found`(exit 3),if-match 失败 → `stale`(exit 5),回滚到已删状态 → `invalid_input`(exit 2)。输出走 effect-evidence(`changed/restored/version/restored_cells/skipped_cells`)。

## 8. 验证

`src/core/history.test.ts`(16 例)+ `src/core/compact.test.ts`(7 例):任意时点重建一致、revert 后 `validateHub` 干净、双节点 sync 后历史视图与回滚结果收敛一致、txn 聚簇/kind、已删实体复活、prop revert 跳过策略、压缩四不变量(头部不变/墓碑保留/落后 peer 收敛/rowid 单调)、blob GC、dry-run 零改动。
