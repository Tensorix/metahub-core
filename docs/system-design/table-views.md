# 数据表视图与交互

2026-10-24 对照 `table.tsx`、`view-model.ts`、`view-bar.tsx`、`databases.ts` 与 `crdt.ts` 更新。阶段性决策保留在 [31-table-views](../impl-context/31-table-views/design.md)。

## 持久化边界

| 状态 | 存放位置 | 合并和作用域 |
| --- | --- | --- |
| 视图列表、布局、筛选、多列排序、隐藏列、计算 | `databases.meta.views` | 随 oplog 同步，整个数组是一个 `meta.views` LWW 寄存器 |
| 侧栏折叠 | `databases.meta.collapsed` | 独立 `meta.collapsed` 寄存器，不覆盖 views |
| 当前活动视图 | `localStorage mh.db.view.<dbId>` | 本设备偏好，不同步 |
| 列宽 | `properties.config.width` | 属性级，多个视图共用 |
| 列顺序 | `properties.position` | 属性级分数位置，拖拽只写移动列 |
| 手动行序 | `records.order_key` | fractional index，随 oplog 同步 |
| 表内搜索文本、当前选区、撤销栈 | 组件内存 | 临时交互，不是保存视图或全库审计 |

顶层 meta 采用 merge patch，`null` 删键、`meta: null` 删除当前可见键，未变值不 emit。这个决定解决不同功能各自写元数据的覆盖问题，但没有解决两台设备同时修改 views 数组的冲突。旧整对象 `meta` 寄存器仍被识别，混合版本不能承诺新键级行为。

视图引用属性 **ID**，不依赖可改名或重名的属性名。`normalizeViews` 在没有有效视图时生成 table/board/calendar/timeline 四个稳定 ID 默认视图，首次更改才持久化；已有配置也会做结构归一化。`table.tsx` 在 300ms 防抖后提交 `{meta:{views}}`。

## 客户端查询与布局

数据加载后依次 `applyFilter → searchRecords → applySort`，计算行基于这份结果。服务端 `listRecords` 仍只提供等值过滤、单字段排序、limit；两者不是同一查询 DSL。

- 文本/url：包含、不包含、等于、不等于、空值。
- 数值：比较与空值；日期：早于/晚于/边界比较及今天、本周、本月等范围。
- 多选：任一/全部/不包含；relation/doc：按引用 id 包含及空值。
- 规则组为平面 AND/OR；不存在嵌套组或服务端 cursor。
- 多列排序按类型比较；引用列当前按 id 数组比较，不是标题排序。
- 计算有计数、空/非空、唯一值，数值 sum/avg/median/min/max，checkbox 比例，日期 min/max。
- 看板的分组、日历的日期列、时间轴的起止列随视图保存；隐藏列、换行与列计算同样属于视图。

没有分页或虚拟滚动，因此客户端筛选并不能解决大表加载成本。列计算也不是按分类分组的服务端报表。

## 编辑与撤销

单击激活单元格，拖动超过阈值进入框选；Enter/F2/type-to-edit 复用相同入口。text 使用可增长 textarea，日期使用选择器，checkbox 直接切换，select/multi_select/relation/doc 各用类型选择器。输入法组合期间不把 Enter 当提交。

提交、清空、填充、粘贴及批量属性设置经 `applyCells` 按记录合并请求，先乐观显示，再调用 `updateRecord`；失败重新加载。一次 `applyCells` 是一个前端撤销步，但多条记录是多次写入，不是跨记录原子事务。撤销通过新的写入恢复前值，仍产生 oplog；它不等同于审计页按 txn、尊重后写的撤销。

TSV 支持带引号的多行单元格，按属性类型转换；relation/doc 粘贴跳过，select 需匹配已有选项。新建记录后直接进入标题格；拖填充柄循环源选区。列类型改变可能清空已有值，界面先确认。

## 已知边界

- 不支持每视图列宽、冻结列、嵌套筛选组、虚拟滚动、服务端高级查询与聚合。
- 复制数据库会重建属性 ID，并通过 `core/copy-views.ts` 重映射保存视图的属性引用及自关联筛选记录 ID；外部关联和未知 meta 字段保留。原缺陷及修复记录见 [复核记录](./review-2026-10-24.md)。
- 默认四布局只是无有效保存配置时的回退，不意味着数据库一定持久化了四条视图。

验证入口：`src/webui/view-model.test.ts`、`table-paste.test.ts`、`cell-select.test.ts`、`src/core/databases.test.ts`、`records.test.ts`。本轮完整测试结果见复核记录；不能把模型单测等同于全部交互的浏览器实测。
