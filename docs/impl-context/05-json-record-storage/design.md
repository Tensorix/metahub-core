# 记录存储 EAV → JSON 行 + 按需自动索引 设计文档

承接 [01-init-basic-func/design.md](../01-init-basic-func/design.md)。本文记录把记录(record)的物化层从 **EAV(`record_values` 每字段一行)** 升级为 **一条记录一行 + JSON `data` 列**,并引入**由查询自动推导、对用户透明**的索引机制。目标是让同一套「灵活定义、存任意数据」的通用表,既能装 Notion 式结构化数据,又能高效承载 IM 消息、账单、数据洞察这类高频、需翻页/聚合的数据。

**底层 oplog 与 sync 协议不改**——`crdt_changes` 仍按字段(`dataset/row_id/col`)记录,`applyChange` 的 LWW 选胜(`MAX(hlc)`)不变。只改「胜出字段往哪里物化」和「查询怎么编译」。

## 1. 背景与目标

现状:记录走 EAV——`records(id, database_id, created_hlc, __deleted)` + `record_values(record_id, property_id, value)`,每个单元格一行。痛点(详见对话分析):

- **查询慢且不可扩展**:`listRecords` 把整张表加载进内存,每条记录再单独查一次 `record_values`(N+1),`filter` 在 JS 层做,`limit` 加载完才 `slice`(`records.ts:129`)。「取会话最新 50 条」要扫该 database 全部记录。
- **无法下推条件**:没有 SQL 级 `WHERE/ORDER BY/LIMIT`,没有值索引。
- **形态僵化的误解**:曾考虑为高频数据另开「原生表」存储策略,但那会分裂出两套机制,违背「一张通用表承载所有数据」的初衷。

目标:**保持单一通用表与单一心智模型**,通过更优的物理布局(JSON 行)+ 透明索引把性能补齐;字段级 CRDT 收敛、同步、快照全部不受影响。

### 实测依据(为何 JSON 可行)

在本机 `bun:sqlite`(SQLite 3.51)实测(20 万行):

- JSON 路径**可以建索引**(表达式索引 `data ->> 'k'` 或生成列),查询计划确认走索引。
- **索引点查**(IM 取会话最新 50 条):JSON 0.004ms vs 原生列 0.005ms,**打平**——索引里存的是抽取后的值,查询不解析 JSON。
- **非索引全表扫描/聚合**:JSON 比原生列慢 5–6×(每行解析 JSON),存储大 1.33×。
- 结论:走索引的查询零损失;重度聚合字段可「提成生成列」抹平差距。本地单用户规模(几十万行)完全够用。

## 2. 设计要点

### 2.1 数据模型:records 加 `data` JSON 列,`record_values` 退役

```sql
CREATE TABLE records (
  id          TEXT PRIMARY KEY,
  database_id TEXT,
  created_hlc TEXT,
  data        TEXT NOT NULL DEFAULT '{}',   -- 整条记录字段都在这,key = property_id
  __deleted   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_records_db ON records(database_id, created_hlc);  -- 列表/翻页基础索引
```

- `data` 的 key 用 **property_id**(非 name),保持「改属性名不重写数据」语义;`readRecord` 再映射回 name。
- `database_id / created_hlc / __deleted` 仍是真实列(RECORD_META),不进 JSON。

### 2.2 物化:`crdt.ts/materialize` records 分支改写 JSON

胜出字段从「插入/更新/删除一行 `record_values`」改为折叠进 `data`(其余分支与 `applyChange` 不动):

```ts
// RECORD_META(database_id/created_hlc/__deleted)→ 仍写真实列,逻辑不变
// 其它 col(property_id):
//   value === null → json_remove(data, '$."'||col||'"')      删除单元格
//   否则           → json_set(coalesce(data,'{}'), '$."'||col||'"', json(valueJson))
```

`json(valueJson)` 保证按 JSON 类型嵌入(数字/数组/对象不被当字符串)。LWW 选胜不变,只是写入目标从 EAV 行变成 JSON 内一个 key,字段级并发合并语义保持。

### 2.3 读取:`readRecord` 单查询,消灭 N+1

`SELECT data FROM records WHERE id = ?` → `JSON.parse` → 按 property_id 映射回 name,跳过已删属性(`records.ts:73` 重写)。

### 2.4 查询:`listRecords` 编译成 SQL,条件/排序/分页下推

filter 编译为 `data ->> '<property_id>' = ?`(命中表达式索引),排序默认 `created_hlc`(支持 `--sort`/`-字段` 降序),`limit` 进 SQL `LIMIT`。IM「会话最新 50 条」= `filter:{conversation:x}, sort:-created, limit:50`,走索引 O(log n)。

### 2.5 索引对用户完全透明,由命令的 filter/sort 自动推导(关键)

目标用户是 **AI Agent** 与**直接敲 CLI 的人**,两者都不会、也不该声明索引。索引信号来自命令里**显式写明的 `--filter`/`--sort` 字段**:

```
listRecords 编译 SQL 前,对每个被 filter/sort 的字段调用 maybeAutoIndex:
  已有索引 → 跳过
  type === 'relation' → 建(几乎必然用于关联,成本低,建表即可建)
  否则 该 database 记录数 < 阈值(2000) → 不建(小表全扫已够快,免拖慢写入)
  否则 → 后台一次性建表达式索引(按 database 部分索引)
```

```sql
CREATE INDEX IF NOT EXISTS "idx_rec_<db>_<propid>"
  ON records (data ->> '<propid>', created_hlc)
  WHERE database_id = '<db>' AND __deleted = 0;
```

- **行数阈值**把索引成本花在确有收益处:小表(笔记/任务等绝大多数)永不建索引;大表(IM/账单/洞察)在「确实变大 + 第一次按某字段查」时才建。
- **`indexed: true`** 保留为面向内置功能的**可选底层提示**(`PropertyRow`/`addProperty`):开发某高频功能的人若明确知道是热点表可一步预建;不传则由上述自动推导兜底。**它不是终端产品功能**,不出现在 CLI 命令/输出/文档面向用户的部分。

### 2.6 重度聚合字段的升级路径(暂不实现,留接口)

对需频繁全表聚合的字段(如账单金额求和),表达式索引帮不上(仍逐行解析)。升级为 `STORED` 生成列拿原生扫描速度:

```sql
ALTER TABLE records ADD COLUMN "p_<propid>" <affinity>
  GENERATED ALWAYS AS (data ->> '<propid>') STORED;
```

本期不做,仅在 `maybeAutoIndex` 预留判断位;触发条件(如检测到聚合查询)后续再定。

### 2.7 迁移与快照

- **一次性迁移**(`openMetahub` 内做幂等 schema 版本检查):给 `records` 加 `data` 列 → 把每条记录的 `record_values` 行聚合成 `{property_id: value}` 写入 `data` → 验证后 `DROP TABLE record_values`。
- **快照 reset**(`snapshot.ts:154`):wipe 清单移除 `record_values`;reset 通过重放 oplog 经新 `materialize` 重建 `data`,无需特殊处理。**注意**:自动索引由查询派生,reset 后不重建(下次查询惰性补回);`indexed:true` 声明的索引需在 restore 后扫描 `properties` 重新 `ensurePropIndex`(幂等 `IF NOT EXISTS`)。

## 3. 取舍

- **单一 JSON 表 vs 多存储策略**:选单一表,守住「一张通用表 + 单一心智模型」初衷;性能靠透明索引补,而非分裂出原生表策略。
- **JSON 慢 5–6× / 大 1.33×**:仅发生在**未索引字段的全表扫描**上;走索引零损失,热点字段可提生成列。本地单用户规模可接受。纯 OLAP 重分析(百万级、复杂多表聚合)超出本地通用层定位,真要做时另建分析表。
- **表达式索引 vs 生成列**:默认用表达式索引——查询编译器恒定发 `data ->> 'propid'`,与索引表达式天然匹配,且无需改表结构。生成列留作聚合升级路径。
- **所有 database 共用一张 `records` 表**:索引按 `database_id` 做**部分索引**,互不干扰;代价是热点属性多时 `records` 列(若用生成列)会增多,受 SQLite 列数上限约束——本期主用表达式索引,无此问题。
- **oplog 仍无 GC**:高频数据下 `crdt_changes` 持续增长是已知问题,但属独立议题(快照 + 水位线裁剪),**不在本期范围**,后续单独设计。
- **阈值 2000 写死**:简单可预测;未来可配置。

## 4. 涉及文件

- 修改:
  - `src/core/schema.ts` — `records` 加 `data` 列、`idx_records_db` 改 `(database_id, created_hlc)`、移除 `record_values` 建表(迁移后)。
  - `src/core/crdt.ts` — `materialize` records 分支改 `json_set`/`json_remove`(`DOMAIN`/`RECORD_META`/`applyChange` 不变)。
  - `src/core/records.ts` — `readRecord` 单查询;`listRecords` 编译 SQL(filter/sort/limit 下推)+ 调 `maybeAutoIndex`;`createRecord`/`updateRecord` 的 `emit` 不变。
  - `src/core/properties.ts` — `addProperty` opts 加可选 `indexed`(持久化进 `config.indexed` 以便随同步复制/快照重建);对 `relation`/`indexed` 调 `ensurePropIndex`。
  - `src/core/search.ts` — `ensureIndex` 与 `likeSearch` 两处 `JOIN record_values` 改为 `json_each(records.data)`(删表后必须改,否则记录搜索失效)。
  - `src/core/db.ts` — `openMetahub` 内加幂等迁移(EAV → JSON,drop `record_values`)。
  - `src/core/snapshot.ts` — reset wipe 清单移除 `record_values`;restore 后重建声明索引。
  - `src/cli/commands/record.ts` — `list` 加 `--sort <字段>` + `--desc`(布尔)。注:core 用 `-字段` 表降序,但 CLI 裸 `-字段` 值会被参数解析吞掉,故用独立 `--desc` 合成,`--sort=-字段` 亦可。
- 新增:
  - `src/core/indexing.ts` — `hasIndex` / `ensurePropIndex` / `maybeAutoIndex`(纯 SQL 辅助)。
  - `src/core/records.test.ts` — 单元(读写/删单元格/filter-sort-limit)、收敛(并发改不同字段不互覆盖)、性能冒烟(大表走索引)。
