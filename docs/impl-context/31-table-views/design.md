# 31 · 数据表 Notion-like 交互与保存视图

2026-10-01 落地。计划文件 `~/.claude/plans/review-notion-like-nested-dove.md`（含对照 Notion 的现状 review）。

## 1. 目标

把数据表页从「选格再双击」的 Airtable 式交互改成 Notion 的手感：新建即打字、单击即编辑、拖动即框选、键盘走完录入闭环；并补上整理能力——筛选 / 多列排序 / 隐藏列 / 表内搜索 / 计算行，以「保存视图」为载体随库同步。

## 2. 单元格交互（`table.tsx`）

- **单击即编辑**：td `pointerdown` 启动 `startPointerDrag`，`onEnd(_, active)` 未越过 4px 阈值且非 Shift、非 `pointercancel` → `activateCell(r, c)`。`activateCell` 按类型分派：text/number/url 开行内编辑器，select/multi_select/relation/doc/date 在单元格矩形上开选择器，checkbox 直接切换。键盘 Enter/F2/Space(checkbox)/type-to-edit 走同一入口，`seed` 预填编辑器或选择器搜索框。
- **编辑器**：`InlineEditInput` 对 text 用 auto-grow `<textarea>`（Enter 提交、Shift+Enter 换行），number 用 `inputmode=decimal` 文本框并在 `coerceInput` 转 Number；浮层 `.celledit` 向下长出、行高不变。
- **日期**：`date-picker.tsx`（输入框 + 月网格 + 今天/清除；↑↓ 换日、Shift 换周、PageUp/Down 换月）。表格、peek、筛选值共用。
- **新建即编辑**：`createRecordWith(values, edit)` 成功后 `pendingEdit` → 下一次渲染在该行标题格 `startEditAt`。
- **所有写入经 `applyCells(patches)`**：按记录合并成一个 `updateRecord`、乐观更新、失败 reload；一次调用 = 一个撤销步（`undoRef` 前值栈，⌘Z/⌘⇧Z 本地回写，不走审计）。`commit`、填充、清空、粘贴、批量设属性都走它。
- **粘贴**：`table-paste.ts` 解析 TSV（含引号多行单元格），`pasteValueFor` 按列类型转换（select 必须匹配现有选项，relation/doc 跳过），单值粘贴平铺到整个选区，跳过数 toast 提示。
- **填充拖柄**：选区右下角 `.cell-fill-handle`，向下拖按源块循环填充。
- **行选 vs 格选互斥**；复选框 Shift 范围选；选行浮条新增「打开」「设置属性…」（选属性 → 复用对应选择器 → `applyCells`）。
- 快捷键登记在 `shortcuts.ts` 的 `table` 组（Enter / ⌘Enter / ⇧Space / ⌘A / ⌘C / ⌘V / ⌘D / Del / ⌘Z / ⌘⇧Z），全局 keydown 用 `pressed()` 匹配并守 `defaultPrevented`/`imeGhost`。

## 3. 保存视图

### 3.1 持久化：`db.meta.views`

core `databases.meta` 从整对象 LWW 改成 **per-key 寄存器**：`updateDatabase(db, id, { meta })` 是合并 patch，每个键 `emit("databases", id, "meta.<key>", v)`，`null` 删键、`meta: null` 清全部、值未变不 emit；`crdt.ts materialize` 对 `meta.*` 做 `json_set/json_remove`。两台设备分别写 `collapsed` 与 `views` 合并后两者都在（`databases.test.ts`）。HTTP/CLI 接口形状不变。

### 3.2 模型：`view-model.ts`

```ts
ViewDef { id, name, layout: table|board|calendar|timeline, sort: SortRule[], filter: { op: and|or, rules: FilterRule[] },
          hidden: propId[], group?, dateProp?, start?, end?, wrap?, calc?: Record<propId, CalcKind> }
```

- `normalizeViews(raw)` 校验持久化值，坏数据回退默认四视图（id 固定 `v_table/v_board/v_calendar/v_timeline`，`?view=board` 深链按 layout 找视图）。无 `views` 键时内存合成默认视图，首次修改才写入。
- 筛选条件按类型定义在 `condsFor()`，全部客户端求值（`applyFilter`），服务端 DSL 等 P1 查询落地后再下推；排序 `applySort` 多列、按类型比较；搜索 `searchRecords` 对 `cellText` 做 includes；计算 `computeCalc`。
- 活动视图 id 存 `localStorage mh.db.view.<dbId>`（设备偏好，不同步）。列宽仍在 `prop.config.width`（schema 级），与 Notion 的 per-view 列宽是已知差异。

### 3.3 UI：`view-bar.tsx`

视图 tab（点活动 tab 开菜单：重命名/复制/删除；`+` 新建选布局再命名）、工具栏 `[筛选 n] [排序 n] [属性 n] [🔍]`、规则 chip 行（点 chip 原位编辑，`×` 移除，多条时 `满足全部/任一` 切换）、筛选规则编辑器（条件 pill + 按类型的值控件，relation/doc 通过 `pickRefs` 回调借用 table.tsx 的选择器）、多列排序弹层（拖排序）、属性弹层（眼睛开关 + 拖排序，标题列不可隐藏）。看板/日历/时间轴的字段选择改为受控 props 写回视图。

## 4. 列头菜单（`ColMenu`）

一级是动作列表：改名输入框 / 类型 › / 升序 / 降序 / 筛选此列 / 隐藏 / 左、右插入列 / 复制列 / 换行文本 / 删除。「类型 ›」进二级面板（九宫格 + 选项/关联目标）；列有非空单元格时改类型先 `confirmDialog({ aboveMenus })` 提示将清空 N 格。插入位置用相邻 `position` 中点（`positionNear`），列拖拽也改为只写被移动列的分数 position。

## 5. 其他

- Peek：按视图 `hidden` 折叠「还有 N 个隐藏的属性」；头部 ↑/↓ 上一条/下一条（⌘↑/⌘↓），菜单加「复制链接」。
- 计算行：`tfoot` 每列一格，`view.calc` 持久化，悬停页脚才显示「计算」占位。
- 视觉：表格去外框阴影、表头去底色改 `--muted` 500 字重、仅行 hover；页脚显示「显示 m / n 条记录」与隐藏列数；进库用真实网格骨架（`useSkeletonRows("table")`）。
- 非目标：服务端筛选 DSL、游标分页、冻结列、每视图列宽、嵌套筛选组、全页记录视图、虚拟滚动。
