# 文档/数据表 与文件互导（sync src/dst）设计文档

承接 [04-block-level-doc-crdt/design.md](../04-block-level-doc-crdt/design.md)、[05-json-record-storage/design.md](../05-json-record-storage/design.md)、[06-friendly-ids/design.md](../06-friendly-ids/design.md)。本文记录给 `mh sync` 增加的第二种形态：把**单个文档或数据表**在库内实体与**本地文件**之间双向搬运——文档↔markdown、数据表↔CSV。

**关键定位：复用既有 `sync` 命令名，按参数个数分流；底层 core / oplog / sync 协议不改。** 导入走既有 `updateDocument`/`createRecord`/`updateRecord`，照常进 CRDT，可再随 `mh sync <url>` 复制。

## 1. 背景与目标

现状：`mh sync <url>`（`src/cli/commands/sync.ts` → `syncWithPeer`）只做对等节点的 CRDT 推/拉。把单篇文档或单张表交给外部编辑器 / 表格工具、或从导出文件回灌，此前没有入口。

目标：

- `mh sync <src> <dst>`（双参数）在「文档/数据表」与「文件」间导出/导入；`mh sync <url>`（单参数）行为不变。
- 方向自动判别：哪一侧能解析成库内实体，另一侧即文件路径；实体在左 ⇒ 导出，实体在右 ⇒ 导入。
- 格式按实体类型固定：文档→markdown，数据表→CSV（扩展名只是文件名，不参与选格式）。
- 一次一个实体；不引入新依赖、不动 schema / oplog。

## 2. 设计要点

### 2.1 命令分流（`commands/sync.ts`）

两个 positional：`src`（必填）、`dst`（选填）。citty 按顺序填充 positional（见 `node_modules/citty`，逐个 `shift`），故 `sync a b` 落到 `src`/`dst`。`dst == null` 时仍走原 `syncWithPeer(db, src)`；否则交给 `syncFiles(db, src, dst)`。输出沿用 `print(data, prettifier)`：人读时打印 `export doc <id> → <path>` / `import db <id> ← <path>`，管道下出 JSON。

### 2.2 方向判别（`src/core/sync/files.ts`）

```ts
tryResolve(db, ref): Candidate | null   // 包 resolveEntity：命中返回；"no such" 返 null；"ambiguous" 重新抛出
```

- 先 `tryResolve(src)`：命中 ⇒ 导出（`src`=实体、`dst`=输出文件）。
- 否则 `tryResolve(dst)`：命中 ⇒ 导入（`src`=输入文件、`dst`=实体）。
- 都不命中 ⇒ 抛 `neither "<src>" nor "<dst>" is a metahub document or data table`。
- **歧义重新抛出**是关键：歧义 ref 不该被静默当成文件路径，要让用户看到候选列表（沿用 `resolveEntity` 的 git 风格报错）。
- 实体 `kind` 限定 `doc`/`db`，`rec`/`prop` 明确拒绝。

### 2.3 格式（按类型固定，复用 core）

- **文档 → markdown**：`Bun.write(path, getDocument(db,id)!.body ?? "")`。`body` 本就是块重算出的 markdown 物化缓存，逐字写出。
- **markdown → 文档**：`updateDocument(db, id, { body: await Bun.file(path).text() })`，走块级 reconcile，与 `doc update --body` 同一路径。
- **数据表 → CSV**：列序取 `listProperties`（按 `position`），表头 `["id", ...属性名]`，每行 `[rec.id, ...]`；`listRecords(...).values` 以**属性名**为键，正好对上表头。单元格编码 `cellToString`：null→`""`、boolean→`"true"/"false"`、数组/对象→`JSON.stringify`、其余 `String(v)`（与 `commands/record.ts` 的 `flatten` 一致）。
- **CSV → 数据表**：`parseCsv` 后首行为表头；逐行构造 `{属性名: 值}`，空单元格跳过（不覆盖）。单元格以 `[`/`{` 开头者 `JSON.parse`（失败回退原文）以还原 multi_select/relation 数组，其余留作字符串交给 core `coerce` 还原。有 `id` 列且该记录存在 ⇒ `updateRecord`，否则 `createRecord` —— 故导出再导入按 id **upsert**，不产生重复行。

### 2.4 CSV 工具（`src/core/csv.ts`，无依赖）

项目只有 citty/preact/zod，无 CSV 库，自带极简 RFC-4180：

- `toCsv(rows: string[][])`：仅当含 `,`/`"`/换行才加引号，内嵌 `"` 翻倍；单元格以 `,` 连、行以 `\n` 连。
- `parseCsv(text)`：状态机处理引号字段、字段内逗号/换行、`""` 转义；容忍 `\r\n` 与单个末尾换行；空输入返 `[]`。

## 3. 取舍与未实现

- **导入只更新已解析到的现有实体**：导入侧 `dst` 必须先能 `resolveEntity` 命中，故从文件凭空新建文档/数据表不在 v1 内。
- **一次一个实体**：不做整库 / 整目录批量导出。
- **文档只写正文**：不带标题 / front-matter，换取 markdown 往返无损（标题仍由 doc 属性维护）。
- 关系/多选数组靠 JSON 编码往返，对人手写 CSV 不算最友好，但保证机器往返一致。

## 4. 影响面

- 新增：`src/core/csv.ts`、`src/core/sync/files.ts`（+ 同名 `*.test.ts`）。
- 改动：`src/cli/commands/sync.ts`（双 positional 分流）、`src/cli/help.ts`（指南行 + 示例）。
- 复用、未改：`resolve.ts`、`documents.ts`、`properties.ts`、`records.ts`。schema / crdt / sync 协议零改动。
