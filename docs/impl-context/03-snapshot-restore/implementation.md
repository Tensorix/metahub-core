# Snapshot/Restore 数据打包与恢复 实现文档

配套设计见 [design.md](./design.md)。本文是代码级实现说明。承接 [01-init-basic-func/implementation.md](../01-init-basic-func/implementation.md) §6 CLI。

## 1. 改动文件

| 文件 | 改动 |
|------|------|
| `src/core/snapshot.ts` | 新增：全部逻辑。`createSnapshot` / `writeSnapshot` / `readSnapshot` / `restoreSnapshot` + `SnapshotPackage` 等类型 |
| `src/cli/commands/snapshot.ts` | 新增：`mh snapshot <out>` 命令 |
| `src/cli/commands/restore.ts` | 新增：`mh restore <file> [--reset] [--force]` 命令 |
| `src/cli/index.ts` | 注册 `snapshot` / `restore` 两个子命令 |
| `src/core/snapshot.test.ts` | 新增：round-trip / merge / reset / `--force` 守卫单测 |

逻辑全部下沉到 `src/core/snapshot.ts`，命令层只做接线（与既有 `sync.ts` 一致）。

## 2. 快照核心（`src/core/snapshot.ts`）

### 2.1 采集（`createSnapshot`）

复用既有原语，不新增导出逻辑：

```ts
export async function createSnapshot(db: Database): Promise<SnapshotPackage> {
  const changes = changesAfterSeq(db, 0).changes;          // 整条 oplog（复用 crdt.ts）
  const node_id = readMeta(db, "node_id");
  const hlc = readMeta(db, "hlc");
  const peers = db.query("SELECT url, pull_cursor, push_cursor FROM peers").all();
  const blobs = await readBlobs();                          // readdirSync(cacheDir()) → base64
  return { format, version, createdAt, source:{node_id,hlc},
           counts:{changes:changes.length, blobs:Object.keys(blobs).length},
           meta:{node_id,hlc}, peers, changes, blobs };
}
```

| 函数 | 作用 |
|------|------|
| `createSnapshot(db) -> Promise<SnapshotPackage>` | 采集 oplog + meta + peers + blob，组装成包对象 |
| `writeSnapshot(pkg, path) -> {counts, bytes}` | `Bun.gzipSync(encode(JSON))` 写文件 |
| `readSnapshot(path) -> Promise<SnapshotPackage>` | gunzip + parse + 校验 `format`/`version`（不合法即 `throw`，由 `guard` 转成 `{error}`） |
| `restoreSnapshot(db, pkg, {reset,force}) -> RestoreResult` | 见 §2.2 |

blob 读写：文件名即 sha256（复用 `cache.ts` 的 `blobPath`、`paths.ts` 的 `cacheDir`），bytes ↔ base64。

### 2.2 恢复（`restoreSnapshot`）

```ts
// merge（默认）：回放 oplog，幂等，本地身份/peers 不动
if (!opts.reset) {
  const applied = ingest(db, pkg.changes);
  const blobs = await writeBlobs(pkg.blobs);   // 内容寻址，已存在则跳过
  return { mode: "merge", applied, blobs };
}

// reset：破坏性，先存安全快照，再清空重建
if (!opts.force) throw new Error("refusing to replace local data without --force ...");
const safetyPath = join(metahubHome(), `.pre-restore-${Date.now()}.mhpack`);
await writeSnapshot(await createSnapshot(db), safetyPath);

const tx = db.transaction(() => {
  for (const t of ["crdt_changes","databases","properties","records",
                   "record_values","documents","peers"]) db.query(`DELETE FROM ${t}`).run();
  db.query("DELETE FROM meta WHERE key = 'search_hlc'").run();
  if (ftsAvailable(db)) db.query("DELETE FROM search_fts").run();
  // 先把 node_id/hlc 设回包里的值，再 ingest（getNodeId/observeHlc 即用恢复后的身份）
  setMeta.run("node_id", pkg.meta.node_id); setMeta.run("hlc", pkg.meta.hlc);
  applied = ingest(db, pkg.changes);          // 嵌套 savepoint，OK
  for (const p of pkg.peers) /* INSERT INTO peers */;
});
tx();
const blobs = await writeBlobs(pkg.blobs);
return { mode: "reset", applied, blobs, safetyPath };
```

要点：

- **merge 不碰本地 `meta`/`peers`**：`ingest` 内部 `observeHlc` 会推进本地时钟越过传入 HLC，避免后续写入碰撞。
- **reset 在一个事务内**清表 + 写回 meta + `ingest` + 写回 peers；`ingest` 自带的 `db.transaction` 以 savepoint 嵌套，无碍。
- **先设 `node_id`/`hlc` 再 ingest**：`getNodeId(db)` 因而返回包里的身份，恢复后库与包**完全一致**（含身份）。
- **删 `search_hlc` + 清 `search_fts`**：让 FTS 下次查询时懒重建。
- **孤儿 blob 不删**：内容寻址、无害（见 design §3）。

## 3. 命令接线

`src/cli/commands/snapshot.ts`：

```ts
args: { out: { type: "positional", required: true, description: "Output path, e.g. backup.mhpack" } },
run: guard(async (args) => {
  const info = await writeSnapshot(await createSnapshot(openMetahub()), args.out);
  print({ ok:true, path:args.out, ...info.counts, bytes:info.bytes },
        () => `Snapshot -> ${args.out} (${info.counts.changes} changes, ${info.counts.blobs} blobs, ${info.bytes} bytes)`);
}),
```

`src/cli/commands/restore.ts`：

```ts
args: { file:{type:"positional",required:true}, reset:{type:"boolean"}, force:{type:"boolean"} },
run: guard(async (args) => {
  const pkg = await readSnapshot(args.file);
  const r = await restoreSnapshot(openMetahub(), pkg, { reset:!!args.reset, force:!!args.force });
  print(r, () => r.mode==="reset"
    ? `Restored (reset) from ${args.file}: ${r.applied} changes, ${r.blobs} blobs. Safety snapshot: ${r.safetyPath}`
    : `Merged ${args.file}: ${r.applied} new changes, ${r.blobs} blobs`);
}),
```

输出/异常仍走 `print` / `guard`（见 01 §6），未改。`src/cli/index.ts` 在 `subCommands` 里加 `snapshot, restore`。

## 4. 用法

```sh
mh snapshot ./backup.mhpack                   # 打包整库到单文件
mh restore  ./backup.mhpack                   # merge（安全，幂等）
mh restore  ./backup.mhpack --reset --force   # replace 回滚（先存安全快照）
mh restore  ./backup.mhpack --reset           # 缺 --force → 拒绝，exit 1
```

## 5. 测试与验证

- `bun test src/core/snapshot.test.ts`（4 例）：① gzip 文件 round-trip + counts；② merge 到全新库后域表/blob 字节回来；③ reset 替换（旧数据消失、包数据在、`node_id` 与包一致、安全快照文件存在）；④ `--reset` 缺 `--force` 抛错。
- `bun test`：全量 13 例通过。
- `bunx tsc --noEmit`：类型检查通过。
- CLI 端到端手验（临时 `METAHUB_HOME`）：`snapshot` → 340B `.mhpack`；新库 `restore`（merge）后 `db list` 见 `Tasks`、`search world` 命中（FTS 懒重建）；`--reset --force` 替换且写出 `.pre-restore-*.mhpack`；`--reset` 无 `--force` 被拒、exit 1。

## 6. 命令清单更新

01 实现文档 §6 命令清单追加两行：

| 命令 | 关键参数 |
|------|----------|
| `mh snapshot <out>` | 打包整库（oplog+meta+peers+blob）成单个 gzip `.mhpack` |
| `mh restore <file> [--reset] [--force]` | 默认 merge 回放；`--reset` 清空重建（破坏性，先存安全快照，需 `--force`） |
