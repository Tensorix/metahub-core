# 操作审计:全局变更流 + AI 归因 + 按 txn 回滚(0.5.0)

## 1. 背景

已有的历史能力是**实体粒度**的:一篇文档、一条记录、一列的修订列表。缺的是**工作区粒度**的那一问:

> 刚才这一小时,谁在我的库里改了什么?那个 agent 到底动了哪些东西?能不能一键撤掉它那一批?

在 AI agent 直接驱动 CLI 写库的场景里,这不是审计洁癖,是**基本的可控性**。

## 2. 决策

### 2.1 审计流是 oplog 的纯读侧派生

与 `history.ts` 同一套哲学:oplog 是 append-only 的真相,回滚是**正向写入**,一切从 oplog 内容推导——于是**所有同步节点看到同一份流**。深度受压缩窗口约束(`compact.ts` 窗口外的条目已被折叠,也就无法再回滚)。

`listAuditEntries` 按 `txn`(`crdt.ts` 的 `grouped()` 给每次逻辑变更盖的分组 id)聚簇,新→旧;`auditEntryDetail` 展开成逐字段 before→after;两者与 revert 共用同一个 `changesOfTxn` 取数。

### 2.2 actor 是 txn id 的一个独立段

`crdt.ts` 的 txn 形如 `ai/xxxxxxxx`、`ai/revert:xxxxxxxx`:**actor 段与 kind 段正交**。

- `setActorTag(tag)` 设置本进程之后铸造的所有 txn 的 actor;标签受 `ACTOR_TAG_RE`(`^[a-z0-9_-]{1,16}$`)约束——不能含 `/` 或 `:`,那是段分隔符。
- CLI 的判定(`src/cli/index.ts`):`MH_ACTOR` 优先(`""` / `"human"` = 不打标);否则 **stdout 非 TTY 即 `ai`**——这正是切 JSON 输出的同一个信号,而 SKILL.md 早就把「JSON 模式就是 agent 接口」写成契约。
- **只在直接子命令分支打标**:`--server` 分支必须保持未标记,否则桌面边车(非 TTY)会把每一次 WebUI 编辑都错记成 `ai`。

### 2.3 排除集来自表层级注册表,不手写

`oplogExclude()` 排除两类数据集:`OPLOG_ONLY_DATASETS`(协议态,如 guest intent 的回执)与 `SYSTEM_DATASETS`(`tables.ts` 的 system 层:站点渠道、附件策略、设备名册)。它们既不列出、不展开,也不回滚。

模块里**每一处 oplog 读取都走这个过滤器**,新增一张 system 表不需要回来改 audit。

### 2.4 回滚以 txn 为单位,且尊重后来的写入

`revertChangeGroup(db, txn)`(kind = `revert`,自身也可再回滚):

- **逐寄存器**:重新 emit 该组之前的胜者——但**仅当当前胜者仍属于这个 txn**。此后被别人覆盖过的寄存器是他人的后续意图,保留并计入 `skipped_registers`。
- **该组新建的行**:整行墓碑化;但只要有**任何来自其他 txn 的后续写入**碰过它,整行保留(`skipped_rows`)。
- **删除的回滚**:只写 `__deleted = 0`——各字段的旧值仍然是各自寄存器的胜者,行会完整复活。
- 同 txn 下铸出的协议行(分享访客意图的回执)被排除:回滚它等于给一个没有删除语义、且生命周期长于业务行的复制状态打墓碑。
- 结果带**效果证据**:`restored_registers` / `removed_rows` / `skipped_*` / `changed`;`changed === false` 时明说「已收敛,无可回滚」。

### 2.5 三个面

- **CLI**:`mh audit`(裸命令即列表)、`mh audit list --limit --actor --before`、`mh audit show <txn>`、`mh audit revert <txn>`。分页按**整 txn** 走(游标落在 txn 中间时会补齐该组)。
- **HTTP**:`GET /api/audit`、`GET /api/audit/entry`、`POST /api/audit/revert`。
- **WebUI**:设置 → 工作区 → **操作审计**页(`settings/audit-page.tsx`),Notion 式活动列表 + actor 过滤(全部 / AI / 本设备 / 其他设备)+ 逐条展开 + 一键回滚;回滚后主动失效相关 UI 缓存。

## 3. 复盘修正(9c5714c)

首版落地后的四处修正:

- 详情与回滚同样要走排除集——否则 oplog-only 数据集会出现在展开里。
- actor 过滤要作用到范围查询,而不是只过滤当前页。
- 分页按整 txn,不能把一个逻辑变更劈成两页。
- 回滚要失效 UI 侧缓存,否则页面还显示旧值。

## 4. 涉及文件

core:`audit.ts`(+ `audit.test.ts`)、`crdt.ts`(`setActorTag` / `actorTag` / `ACTOR_TAG_RE`)、`tables.ts`(`SYSTEM_DATASETS`)、`history.ts`(共用聚簇/解析)。

CLI:`src/cli/commands/audit.ts`、`src/cli/index.ts`(actor 判定)。

WebUI:`settings/audit-page.tsx`、`settings/nav.ts`、`server/routes.ts`(三条路由)。
