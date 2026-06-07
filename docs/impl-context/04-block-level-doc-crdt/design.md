# 块级文档 CRDT + AI 增量编辑 设计文档

承接 [01-init-basic-func/design.md](../01-init-basic-func/design.md)。本文记录把 markdown 文档正文从「整 body 一个 register」升级为 **block 级 CRDT**,并新增对标 Claude Code `Read/Edit/Write` 的 AI 编辑命令。

## 1. 背景与目标

原先文档正文存成 `documents.body` 的**单个 CRDT register**(整 body 按字段 LWW)。两个痛点:

- **AI 编辑体验差**:改一句话也要回传整篇正文(token/IO 浪费),没有「先读再改」的安全锚定。
- **并发合并粒度粗**:两台机器改同一篇文档的不同段落,sync 时整篇互相覆盖,一方改动整篇丢失(记录因按 cell LWW 无此问题)。

目标:正文拆块、每块独立合并;给 AI 一组只传增量、且天然「先读再改」的命令。**底层 oplog 与 sync 协议不改**——sync 是 dataset-agnostic 的(`changesAfterSeq` 直接搬运整个 oplog),新增一个 `doc_blocks` dataset 即自动随同步复制。

## 2. 设计要点

### 2.1 数据模型:doc_blocks

新表 `doc_blocks(id, doc_id, text, order_key, blank_after, __deleted)`,每个字段是独立 CRDT register(复用现有 `emit/applyChange/ingest`,只在 `crdt.ts` 的 `DOMAIN` 白名单里登记)。正文 = 该文档未删块按 `ORDER BY order_key, id` 拼接、以 `\n\n` 连接,并按各块 `blank_after` 补回额外空行(见 §2.7)。

### 2.2 排序:分数索引(fractional index)

`src/core/fracdex.ts` 的 `keyBetween(a,b)` 生成严格介于两个 key 之间的字符串(base62,ASCII 序 == digit 序,SQLite BINARY collation 直接可排)。插入新块只需在左右邻居 key 之间取一个新 key,**无需移动其它块**。并发在同一位置插入产生相同/相近 key 时,由 `id` tie-break,保证收敛确定。

### 2.3 正文是物化缓存,块是权威(关键)

`documents.body` 降级为**由块重算的缓存列**(非 register)。`crdt.ts/materialize` 在任何 `doc_blocks` 变更落地后重算该文档 body;`getDocument` / 全文检索(FTS 读 `documents.body`)因此**无需改动**。

兼容:`documents.body` 这个 register 仍保留在白名单里(老数据 / snapshot 重放 / 现有测试要用),但一旦文档有任何块(`isBlockManaged`),legacy body 写入被忽略——块权威。无论 sync 到达顺序如何,最终 body 都是块状态的确定函数,故收敛。

### 2.4 read-before-edit 由 `--old` 结构性强制(对标 Edit 工具)

参考 Claude Code 的 Edit 工具:它并非靠传版本号保证「先读再改」,而是靠**必须提供 `old_string`(当前确切文本)**——你不读就写不出正确的 `old`,内容漂移则匹配失败。

故 `mh doc edit --old --new` 把 `--old`(精确、唯一,否则需 `--replace-all`)作为主守卫:不读拿不到 `--old`,漂移则报 `anchor not found` 逼重读。`--if-match <version>`(version 来自 `documentVersion`)是**可选**陈旧兜底,不强制——因为块级 CRDT 已保证并发不丢数据,守卫只是「别基于陈旧内容编辑」的礼貌检查。

### 2.5 三条写路径

- **`createDocument(body)` / `appendDocument` / `prependDocument`**:parse → 在边界 key 间 `keysBetween` → emit 新块。
- **`updateDocument(body)`(整篇覆盖)**:对块文本做 LCS,**完全未变的块保留 id + order_key**,gap 内删旧块、插新块(order_key 落在两侧保留块之间)。要逐块保身份请用 `doc edit`。
- **`editDocument(old,new)`(锚定增量,AI 主路径)**:
  - 快路径:`old` 不跨块且替换后单块仍非空、不引入 `\n\n` → 直接改命中块的 `text` register(**保留块 id,合并最优**)。
  - 通用路径:跨块 / 分裂 / 合并 → 在整 body 上 replace 后走 `updateDocument` 的 reconcile。

### 2.6 懒迁移

老文档(只有 body register、无块)在首次 `edit`/`update` 时 `ensureBlocks` 按当前 body 切块,之后即块管理。无需一次性迁移脚本。

### 2.7 空行作为块间距(blank_after)(2026-06-07 增补)

块模型最初只存非空段落、块间恒以单个空行连接,故用户在段落之间或文末刻意留的**多个空行**在 save/reload 后被规整掉。这不是 Markdown 限制(连续空行是合法 Markdown,只是渲染时折叠),而是块列表模型缺少「空行」的表示。

权衡过三条路:(A) 让空段落成为一等块——但空块文本都相等,基于文本相等的 `reconcile` LCS 无法区分,会在每次保存时抖动块身份/order_key/CRDT op;(B) 改存原始 body 文本——会丢掉 per-block 合并(并发改同文档退化为整 body LWW 丢数据);(C) **把空行表示成相邻块上的间距元数据**。选 C。

`doc_blocks` 增列 `blank_after`(整数,独立 CRDT register,默认 0):记录该块后面超出标准单空行分隔的**额外**空行数(最后一块则是末尾留白行数)。要点:

- **精确幂等**:整数计数无歧义。`parseDocBlocks`/`serializeDocBlocks`(`src/core/blocks.ts`)是逆运算——1 个空行=分隔符,多出的计入前块 `blank_after`,末尾计入最后块;前导空行丢弃。
- **不动块身份**:`reconcile` 仍只按文本做 LCS;`blank_after` 像 `text` 一样随保留/插入的块走。**仅间距变化(文本不变)时,只更新被保留块的 `blank_after` register,块身份零抖动**(`reconcileBody`)。
- **迁移安全**:旧库 `blank_after` 默认 0 = 现状的单空行分隔,`serializeDocBlocks` 在全 0 时输出与旧 `serializeBlocks` 逐字节相同,既有文档不变(`migrateDocBlocks` 幂等补列)。
- `parseBlocks`/`serializeBlocks`(纯文本块切分)签名保持不变,仅新增 gap 感知的 `parseDocBlocks`/`serializeDocBlocks`,文档正文层(`reconcileBody`/`recomputeDocBody`/`editDocument`)改用后者。

## 3. 取舍

- **块粒度 = 段落级**(空行切分,fenced code 整块):Notion 风格、可预测、round-trip 稳定。不做行级/字符级 CRDT(并发粒度更细但复杂度爆炸,YAGNI)。
- **`doc update --body` 只保未变块身份**:被改块按 delete+insert(新 id)。这是「整篇 Write」的合理代价;需要保身份的增量编辑走 `doc edit`。
- **每个胜出块变更触发一次 body 重算**:批量 create N 块为 O(N²),N 在百级内可接受;必要时再优化。
- **同机多 agent 共享 hub** 时 `--if-match` 可能漏判:但块级 CRDT 不丢数据,守卫非正确性必需,可接受。
- **`mh doc edit` 与顶层 `mh edit` 并存**:前者给 AI(锚定增量、输出 JSON),后者给人(`$EDITOR` 交互);受众 + 命名空间区分,强化「人得到编辑器、AI 得到 JSON/锚定」的分工。

## 4. 涉及文件

- 新增:`src/core/fracdex.ts`、`src/core/blocks.ts`(纯函数)及各自测试;`src/core/documents.test.ts`(含并发收敛 payoff 测试)。
- 修改:`src/core/schema.ts`(建 `doc_blocks`)、`src/core/crdt.ts`(登记 dataset + body 重算 + legacy 门控)、`src/core/documents.ts`(重写 + `editDocument/append/prepend/documentVersion`)、`src/cli/commands/doc.ts`(`read/edit/append/prepend`)、`src/core/index.ts`(导出)、`src/core/snapshot.ts`(reset 清单加 `doc_blocks`)。
- §2.7 空行间距(2026-06-07):`src/core/schema.ts`(`doc_blocks` 加 `blank_after`)、`src/core/db.ts`(`migrateDocBlocks` 幂等补列)、`src/core/blocks.ts`(新增 `DocBlock`/`parseDocBlocks`/`serializeDocBlocks`)、`src/core/documents.ts`(块助手携带 `blankAfter`)、`src/core/crdt.ts`(`DOMAIN` 加列 + `recomputeDocBody` 按 gap 序列化);测试 `src/core/blocks.test.ts`、`src/core/documents.test.ts`。
