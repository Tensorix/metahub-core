# 关联属性与文档属性:标题化的引用列(0.5.0)

## 1. 背景

`relation` 类型早就存在,但它一直停在「能存,不好用」:

- 单元格里显示的是 `rec_xxx-ab12` 这种裸 id,人读不懂,AI 也看不出指的是哪一行。
- WebUI 只能拿自由文本编辑关联值(输入名字 → core 在目标库解析),没有选择器,打错就是一次失败请求。
- 新建列时**根本选不了** relation:它需要 `config.database`,而快速加列没有第二步,只能退回 CLI。
- 导出 CSV 时关联格是 JSON 数组,导回来能往返,但人无法在 Excel 里读或改。

同时缺一类很常见的列:**这一行关联哪篇文档**(任务 → 需求文档、客户 → 会议纪要)。用 relation 表达不了——文档不属于任何数据库,没有「目标库」可填。

## 2. 决策

### 2.1 新增 `doc` 属性类型(core)

- `PropType` 增加 `"doc"`,值形状与 relation 一致(目标 id 数组),但**不需要 config**:文档是全局的,没有目标可挑(`properties.ts validateConfig` 显式注明)。
- 新建时和 relation 一样默认进索引(`opts.type === "relation" || opts.type === "doc"`)。
- 写入解析走 `documents` 范围的引用解析(id / 前缀 / 标题),与 relation 在目标库内解析对称。

### 2.2 标题解析规则只有一条

记录的显示标题 = **按 position 排序的第一个 text 属性的值**(`resolve.ts titlePropId`)。`records.ts recordTitleMap(db, databaseId)` 是它的批量形态,被 CLI、CSV 导出、分享 SSR、WebUI 三面共用。

这条规则是**可逆的**:胶囊上显示的字符串,原样打回去也能解析回同一行。(peek 与看板表头用 `props[0]`,不限类型——这处分叉是刻意的,它们展示的是「这一行长什么样」,不是「怎么引用这一行」。)

### 2.3 前端:同步标题表,按目标库分桶

`src/webui/relation-titles.ts`,与 `doc-titles.ts` 同一套写法,但**按目标库分桶**——一列指向一个库,某个目标库挂了不能污染其他列。

- 胶囊在网格 / 看板 / peek 里同步渲染,所以查表必须同步:内存 `Map`,失效后**继续提供旧标题**(不闪烁),后台刷新完成且标题真的变了才通知订阅者。
- 失效源:副本路径靠 `SYNCED_EVENT`,window(HTTP)模式靠 `REC_INVALIDATE`(同标签页自身写入,没有 sync 事件)。
- 加载失败的桶停在 `error`(胶囊退回显示 id),**不按渲染重试**——目标库被删不能变成请求风暴。

### 2.4 编辑=选择器,不再是自由文本

- 单元格点开是**记录选择器**:搜索 / 新建 / 多选,替代原来的逗号分隔输入。
- 建列时选中 relation 会进入**第二步:挑目标库**(`DbTargetList`,可搜索、键盘导航、滚动上限;自引用单独标注),列头菜单里也能看见/改当前目标。
- `#/db/<db>/<rec>` 是记录 peek 的深链,胶囊点击即跳转,hash 与 peek 双向同步。

### 2.5 CSV:标题列表,带引号逃生阀

`src/core/relation-cells.ts` 是**唯一**的关联格编解码器(WebUI 导出与 `mh sync` 文件导出共用):

- 编码:`", "` 连接目标标题(取不到标题的元素退回裸 id)。只有普通连接无法还原的元素才加引号——含 `,` 或 `"`、以 `[`/`{` 开头(会触发导入端的 JSON 嗅探)、或首尾带空白。
- 解码:先按整格 JSON 数组尝试(旧导出格式 + 手写 id 的逃生阀),否则走引号感知的 `", "` 切分,逐元素交给 core 的引用解析。
- 外层 CSV 自己的引号与这一层互不干扰(两层独立,组合无歧义)。id 不含上述任何字符,所以 id 回退形态与不加引号的标题长得一模一样。

### 2.6 分享页的标题解析要跟着授权走

`share-serve.ts` 只在**目标库就是分享自身**或**目标库在这个分享的 grants 里**时才解析标题,否则原样显示 id——镜像写入侧策略(`grants-core.assertRelationAllowed`)。跨库关联在分享页显示裸 id 是**安全默认值,不是 bug**。

`doc` 列在分享页**永远**显示裸 id:grants 的粒度是「表 × 操作」,没法表达「这篇文档也一起分享」。

### 2.7 访客写入策略

`assertRelationAllowed`(`grants-core.ts`)对引用类型的写入:

- 匿名主体(`public`)一律拒绝写 relation / doc。
- `doc` 类型对任何分享主体都拒绝——grants 无法给文档划范围。
- relation 要求目标库在本分享的 grants 内。
- 清空(`null` / `[]`)永远放行:`isLiveRefValue` 只把「真的链上了东西」当作需要授权的写入。

### 2.8 完整性:`dead_cell_ref`

新增一类可自动修的完整性问题(`integrity.ts`):relation / doc 单元格里指向**已墓碑**目标的元素会被剔除,整格元素全死则修成 `[]`。

遵守既有两条铁律:只针对 `__deleted=1`(缺失=可能是在途的前向引用,容忍),修复是收敛态的纯函数、经 `emit()` 复制,各节点独立跑到同一个不动点。

### 2.9 整库复制的自引用重映射

`duplicateDatabase` 里,指向**源库自身**的 relation 列改指副本(保持自引用),指向别的库则保留原目标;自引用单元格因为目标行 id 在第一遍还不存在,走**两遍**——先建行拿到 id 映射,再回写这些格。

### 2.10 select 选项可编辑(同期落地)

- `PATCH /api/property` 的 `config` 变成**键级合并 patch**(不再整体替换),这样只改 options 不会把 relation 的 `database` 抹掉。
- 改名 / 删除选项走 `POST /api/property/option/rename|remove`,**core 级联重写**所有用旧值的单元格,不留孤儿值。

## 3. CLI / 输出契约

- `mh prop add --type doc`(无需 `--target`);relation 仍需 `--target <目标库>`。
- `mh record list/get` 的 **TTY 人读输出**把 relation / doc 值渲染成 `", "` 连接的标题;**JSON 输出保持裸 id**——机器面不做标题化(标题会变,id 不会)。

## 4. 涉及文件

core:`properties.ts`(`doc` 类型)、`records.ts`(`recordTitleMap`)、`resolve.ts`(`titlePropId`)、`relation-cells.ts`、`integrity.ts`(`dead_cell_ref`)、`databases.ts`(自引用重映射)、`grants-core.ts`(访客策略)、`sync/share-serve.ts`(标题解析门禁)。

WebUI:`relation-titles.ts`、`cells.tsx`、`table.tsx`(`DbTargetList`、记录选择器、列头目标展示)、`export.ts`、`view.ts`(`#/db/<db>/<rec>`)。

CLI:`commands/prop.ts`、`commands/record.ts`(`titleize`)。
