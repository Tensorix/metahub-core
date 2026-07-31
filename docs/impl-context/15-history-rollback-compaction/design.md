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

## 6. WebUI 历史面板(2026-07 改版后形态)

文档抽屉("…"菜单 → `.peek`,`src/webui/history.tsx` + 纯函数层 `src/webui/hist-diff.ts`):

- **diff 语义 = 该版本 vs 上一版本**(GitHub 式,"这次修订改了什么")。基准取**全量修订列表**的邻居(含 repair)——若取"显示修复"过滤后的邻居,隐藏修复时会把 repair 的变更错误归到下一条用户修订头上。初版"选中 vs 当前 HEAD"语义被否决(选最新版本 diff 恒为空)。支持任选基准:行上 pin 按钮 / Shift+点击,方向按 HLC 归一(老→新)。
- **三种模式并存,各管一类读者**:
  - **变更**(默认)= 富文本渲染 diff:按块(fence 感知 `parseDocBlocks`)LCS 对齐,未变块正常渲染(长段折叠),增/删块加绿/红水洗,配对的编辑块**渲染一次**、词级 `<del>/<ins>` 融在文中(中文按字、拉丁按词、**全角/半角标点独立成词元**——否则 `AI123，AgenticOS` 无空格粘连成单个词元,改 `AI123` 会把整串标成删改)。实现是 **PUA 哨兵注入**:U+E000-E003 包住变更段 → `renderMarkdown`(哨兵不破坏 `**` 等 inline 标记)→ 渲染后换成真标签;换之前做**标签深度平衡检查**(哨兵对深度相等且中途不下穿),不安全(链接 URL 改动、块类型 `##`→`#` 变化、表格行)则回退为上红下绿整块。直接往 markdown 源注入真标签的方案不可行(破坏 token/围栏语法)。
  - 合并是**行结构化**的(`mergeBlock`,一轮返工):初版对整块做词级合并,给多行列表追加两条时新增段横跨多个 `<li>` → 深度检查必然拒绝 → 12 条全部"划掉重写"。修正:标记**永不跨行**(天然不会跨渲染元素);列表/标题/引用的行首标记留在标记之外(否则行首是哨兵,语法不识别该行);行对齐的键 = **剥掉行首标记的正文**,中途插入一条引发的连锁重编号不算改动(邻行静默采用新序号,源码模式仍可见)。表格块直接回退 stacked(被包住的行不再解析为表格行)。
  - **源码** = git 式行级 unified diff:全行参与(含空行,行号必须真实),双行号栏 + +/− + 行内深浅双层高亮(del/add 配对取公共前后缀,公共 < 30% 视为重写不标),长未变段折叠(两侧留 3 行上下文);**围栏内的行等宽、正文行用正文字体**(逐行 fence 追踪打 mono 标)。
  - **预览** = 该版本完整渲染快照。
- 渲染复用 `core/sync/share-render.ts` 的 `renderMarkdown`(与编辑器同一套 grammar,早已进浏览器 bundle);`[[doc_id]]` 经 `docLinkTitle` 显示实时标题。
- **时间线**:修订按 今天/昨天/本周/日期 分组(sticky 组头);同设备 10 分钟内连续 ≥4 条小修订(≤2 块、非 created/deleted/标题)折叠为一条,点击选中 = **整簇净变更**(最新成员 vs 簇前一版);HEAD 永不入簇。版本状态经 `states` ref 缓存(`documentAt` 每版只拉一次,打开时用 HEAD 预填省首次请求)。
- 记录侧:RecordPeek 字段名菜单 + 修改历史字段名 → 单元格级流水弹窗(`recordFieldHistory`);「最近动态」支持按记录/设备筛选(选项从已加载 feed 派生,零额外请求)。**新增 api client 方法必须同步补 `data/local-api.ts` 同名方法**(api Proxy 按 `prop in localApi` 分发,漏了会在 replica 模式静默走 HTTP)。
- **diff 粒度教训**(两轮返工):初版沿用存储层"空行块"切分 → 整块红绿(把存储粒度误用作展示粒度);二版块级渲染 diff 仍被否决(整段标红绿,粒度还是太粗)。终版 = 行级/词级两套并存。存储与同步零改动。
- 桌面端坑:`body.desktop-mac .peek-head` 是窗口拖拽区,头部控件需 no-drag 豁免。

### 6.1 no-op 写入修复(标题噪音的根因)

现象:每条修订都标"标题",实际没人改过标题。机制链:编辑器自动保存(停笔 700ms)**总是发全量 `{title, body}`** → 旧版 `updateDocument` 对带上的字段**来者不拒地 emit**(不比对旧值)→ 每次保存追加一行同值 `documents.title` 寄存器写入(正文无此害:body 走块 reconcile,只 emit 真变化的块)→ 显示层只看"这组修订里有没有 title 写入" → 全部标"标题"。危害三层:显示噪音、oplog 膨胀(title 行数 ≈ 保存次数)、**LWW 正确性**——同值重写刷新寄存器 HLC,在线设备的无操作保存会在合并时盖掉离线设备的真实改名。

修复双管齐下(`documents.ts` + `history.ts`):

1. `updateDocument` 只 emit 值真正变化的寄存器(title/database_id 比对旧值;parent_id 原本就有此保护)。**给 core 写字段时永远先比对旧值再 emit** 是通用规则。
2. `listDocumentRevisions` 沿修订流维护 doc 寄存器运行值,`title_changed` 按**值变化**判定,纯 no-op 修订组整组丢弃——存量 oplog 里的历史噪音从列表消失,无需清数据。运行值未知(首见/压缩边缘)保守按"有变化"处理,丢修订绝不猜。

注意:存量同值行仍物理留在 `crdt_changes`(append-only),只是不再显示;要 `mh compact` 才真正删除——而 title 恰是 §5 所说压缩收益最大的"反复覆写型"寄存器。

## 7. 接口面

```bash
mh doc history <ref> | mh doc get <ref> --at <v> | mh doc revert <ref> --to <v> [--if-match]
mh record history <ref> [--field <名>] | mh record revert <ref> --to <v>
mh prop history <ref> | mh prop revert <ref> --to <v>
mh db activity [<ref>] [--limit N]                        # 表级活动流:全表记录修订聚合(含已删)
mh compact [--keep <days>] [--dry-run] [--no-vacuum]      # 默认 90 天;0 = 只留头部
```

HTTP(自动进 /docs):`GET /api/{document,record,property}/history`、`GET /api/database/activity`、`GET /api/{document,record}/at`、`GET /api/record/field-history`、`POST /api/{document,record,property}/revert`、`GET /api/nodes`。

表级活动流是只读聚合:`listDatabaseActivity` 取该库所有记录(`row_id IN (SELECT id FROM records WHERE database_id=?)`,含墓碑行使删除事件可见)的 changes,逐记录复用同一套聚簇,按 version 倒序合并 + limit。聚簇时沿变更流(旧→新)维护每记录的运行单元格状态(value null = json_remove,镜像 materialize),从而**零额外查询**地为每条修订产出 `diffs: [{prop, before?, after?}]`(键缺省 = 单元格不存在,区别于显式 null)和 `record_title` 标题快照(取第一个 live text 属性,与引用解析的 title 规则一致;**已删记录显示删除时的标题**)。压缩后窗口边缘的 before 可能因输家被删而缺失,读作"原为空",可接受。WebUI「最近动态」抽屉内联渲染值 diff(超 3 条折叠);CLI 摘要形如 `标题: 甲 → 甲改`(值截断 40 字符)。曾考虑前端逐条懒加载(expand 时取相邻两版 record/at)被否决:每条目两次请求,且 limit 截断后找不到前驱修订。

错误沿用既有契约:版本不存在 → `not_found`(exit 3),if-match 失败 → `stale`(exit 5),回滚到已删状态 → `invalid_input`(exit 2)。输出走 effect-evidence(`changed/restored/version/restored_cells/skipped_cells`)。

## 8. 验证

`src/core/history.test.ts`(18 例)+ `src/core/compact.test.ts`(7 例):任意时点重建一致、revert 后 `validateHub` 干净、双节点 sync 后历史视图与回滚结果收敛一致、txn 聚簇/kind、已删实体复活、prop revert 跳过策略、no-op 保存不产生写入/修订、存量同值写入不标 title_changed、压缩四不变量(头部不变/墓碑保留/落后 peer 收敛/rowid 单调)、blob GC、dry-run 零改动。前端纯函数 `src/webui/hist-diff.test.ts`(20 例):行级 diff 行号/围栏 mono 标记、折叠上下文、富文本 diff 词级合并/加粗内标记/URL 与块类型变化回退、时间线分组与聚簇边界。
