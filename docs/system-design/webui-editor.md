# WebUI 文档编辑器：前端块模型、Markdown 渲染与块间导航

本文是 WebUI 富文本编辑器（`src/webui/` 下的 Notion 式块编辑器）的**常驻参考**。目标：做 Markdown 渲染 / 块编辑 / 光标导航 / 序列化相关改动时，先读本文即可，不必从头检索代码。

与 [data-model.md](./data-model.md) 的分工：data-model 讲 **core 侧**权威存储（`doc_blocks` 扁平 CRDT、`documents.body` 是派生缓存）；本文讲 **前端侧**更丰富的逻辑块树、Markdown 往返、渲染 DOM 结构与编辑器交互。两者通过「整篇 Markdown body」对接。

> 关键心智：系统里有**两套块模型**。前端是带类型的**嵌套树**（`src/webui/blocks.ts` 的 `Block`）；core 是**扁平**的 `doc_blocks`（每块一段 text + `blank_after`）。前端**不入库**它的富字段；保存时把整棵树序列化成 Markdown body，core 再 reconcile 成 `doc_blocks`。

---

## 1. 数据流总览

```
编辑器交互 → 改 blocks 树(内存) → bump()重渲染 + scheduleSave()(防抖700ms)
  → snapshotMarkdown() = bodyFromBlocks(blocks)            [src/webui/blocks.ts]
  → api.updateDocument(docId,{title, body})                [src/webui/api.ts]
  → core updateDocument → reconcileBody(body)              [src/core/documents.ts]
  → 文本级 diff，仅对变化的块 emit doc_blocks oplog 行
  → /sync 把 doc_blocks 变更同步给其它节点
加载/远端合并: documents.body(缓存) 或 doc_blocks 重算 → blocksFromBody(body) → blocks 树
```

要点：
- **body 的同步源是 `doc_blocks`**（块级 CRDT 合并），`documents.body` 只是物化缓存、**不入 oplog**。详见 [data-model.md](./data-model.md) §documents/§doc_blocks 与记忆 `doc-body-syncs-via-doc-blocks`。
- 因此「编辑了正文但 `/sync` 只见 `col:"title"`」的根因通常是：**序列化产物没变** → reconcile 无 diff → 不 emit。**不要**靠新增 `emit(documents,…,"body")` 来"修"，那会造出与块级 CRDT 冲突的幽灵寄存器。
- 历史/检索按 `dataset='doc_blocks' AND col='doc_id'` 的局部索引找块（data-model §84）。

---

## 2. 前端块模型 `src/webui/blocks.ts`

`Block`（`blocks.ts:40-54`）：
```ts
interface Block {
  id; type: BlockType; content;           // content = 去掉 marker/fence 后的内部文本
  checked?;        // todo
  lang?;           // code
  start?;          // numbered: 一段连续有序列表的起始号(只记在该段首项)
  children?;       // 仅列表项可有子块(嵌套)
  rows?; align?;   // table
  src?; name?; width?; size?;  // image/video/audio/file void 嵌入
}
```
`BlockType`（`blocks.ts:6-36`）：`p / h1..h6 / bullet / numbered / todo / quote / code / table / divider`，块级 void 嵌入 `image/video/audio/file/html`，以及瞬态 `uploading`（仅内存、永不序列化）。

谓词/构造：
- `isListType`（`192`）= `bullet|numbered|todo`；`isHeadingType`（`196`）。
- `makeBlock(type, draft)`（`247`）+ `applyBlockDraft`（`214`，type↔字段不变式的唯一真源，`convert` 也走它）。
- `isBlankSpacer(b)`（`327`）：**空 `p`、无 children** = 用户插入的竖向间距（空行），不是真内容。**空列表项不是 spacer**——它靠 marker 保住类型。
- `isCompactCodeHost(b)`（`editor-ops.ts`，本仓新增）：**空 content 的列表项且 `children[0]` 是 code**。见 §5。

嵌套：只有列表项可带 `children`。`indent/outdent` 把块移进/移出某列表项的 `children`。普通段落理论上也能成为列表项的子块，但**纯空的嵌套块往返会丢**（见 §3）。

---

## 3. Markdown ↔ 块树往返（最易踩坑，重点）

### 3.1 解析 `blocksFromBody(body)`（`blocks.ts:307`）
- 规范化换行后 `parseContainer(lines,0,0)`（`445`）：按**缩进**递归。
  - `parseListItem`（`491`）：匹配 marker → 建列表项，子块从 `indent+2` 处 `parseContainer` 递归填入 `children`。
  - `parseLeafBlock`（`508`）：fenced code(``` / ~~~，info string 决定 `code`/`html`)、divider、media 行、heading、todo、numbered、bullet、quote、否则 `p`。
- **空行游程**：`parseContainer` 中，块间超出单空行分隔的额外空行会**在该层**物化成空 `p`（`476-477`），故**夹在两个真块之间**的空行能往返；shallower 的空行留给父层计数（`457-467`）。
- `normalizeNumbering`（`355`）：每段有序列表只在首项保留显式 `start`（且 ≤1 时删），其余靠自增（CommonMark 行为）。

### 3.2 序列化 `bodyFromBlocks(blocks)`（`blocks.ts:378`）
`serializeContainer(blocks, indent, isTop)`（`386`）：
- `isBlankSpacer` 块计为 `extraBlanks`（额外空行）；**前导 spacer 被丢**（`if(out.length) extraBlanks++`，`395`）。
- `if(!shouldPersist(b)) continue`（`398`）丢弃不可持久块。
- 块间分隔 `shouldSeparate`（`811`，两个列表项相邻则贴紧不空行）+ `extraBlanks`。
- `renderBlock`（`750`）按类型出文本；列表走 `renderListBlock`（`790`）：children 经 `serializeContainer(children, indent+2,false)` 递归——**但仅当存在 `firstReal`（非 spacer 且 shouldPersist 的子块）时才渲染整个 children 容器**（`800-806`）。
- `shouldPersist`（`816`）：divider/列表项**恒持久**（空列表项也以裸 marker 往返）；code 需有内容或 lang；table 需有非空单元；media 需 src；其余（含空 `p`）`content.trim()!==""`。

### 3.3 关键往返规则（务必记住）
- **顶层空段落** = 空行 spacer，能往返（`serializeContainer` 尾部 + `blocksFromBody:316-317` 重建末尾空行）。
- **嵌套空块**：只有**夹在真子块之间**才作为空行往返；**孤立/前导/尾随的纯空嵌套块会被丢**（`renderListBlock` 的 `firstReal` 闸门 + `serializeContainer` 丢前导）。→ 这就是「插入空子块不生效/丢失」的根因。本仓采用的对策是**修插入层级**（让退出/插入把空段落落到列表**之后的顶层**，那里能往返），而**不**为缩进空块发明 Markdown 表示。
- 有序列表起始号靠 Markdown 序号本身往返；`children` / `lang` / `start` 等富字段**不入库**，每次保存重算（见 data-model §206）。
- 行内 Markdown（粗体/链接/代码等）：`markdown.tsx` 的 `inlineToHtml`/`htmlToInline`，编辑器对 contentEditable 的 innerHTML 做语义守恒（nbsp/`<b>`/字面量定点，见提交 `151ea02`）。

---

## 4. 编辑器组件结构 `src/webui/editor.tsx`（`DocView`）

渲染 DOM（`BlockRow`，约 `1576-1737`）：
```
.doc-title           ← 标题(contentEditable, 不是 block, 无 data-bid)
.doc-meta
(每个块) .block-wrap[.nested]
           .block.b-<type>[.list-code-host][data-bid=ID]
             .gutter (+按钮/grip 拖拽)
             .marker (bullet/numbered/todo)
             .editable(contentEditable) | <CodeBlock>(.code-input textarea + .code-hl 高亮镜像)
                | .void-host(image/video/audio/file/html/uploading)
           {children}         ← 子块在此渲染，是 .block 的【兄弟】，不在其内部
```
- code 块用真 `<textarea>`（`CodeBlock`），故有**独立**键处理器 `onCodeKeyDown`；其余 contentEditable 走 `onKeyDown`；void 块走 `onVoidKey`。
- `mode==="source"` 时整篇切换成一个 `<textarea>`（`sourceTaRef`），与块树互转（`snapshotMarkdown` 在 source 模式读 textarea）。

---

## 5. compactCodeHost（列表内嵌代码块）——导航陷阱源头

用户在列表项内插入代码块时（`insertListChildFromShortcut`，`editor.tsx:767`）：列表项 `content` 清空、code `unshift` 成 `children[0]`。渲染时该列表项被判为 **compactCodeHost**（`isCompactCodeHost`），其 `.block` body 渲染为 `null`、加类 `list-code-host`，真正的 `<textarea>` 作为**兄弟** `{children}` 渲染在该 `.block` 之外。

⇒ 它**没有自己的可聚焦元素**。这导致 `focusBlock(host.id)`（只在 `.block[data-bid]` 内部找）**静默失败**——是一整类「↓/↑ 进不去/卡住」导航 bug 的根因。统一对策见 §6 的 `focusInto`。

---

## 6. 光标与块间导航（修改导航前必读）

模块级 DOM 工具（`editor.tsx` 底部）：
- `focusBlock(id, atEnd)`（约 `2340`）：`querySelector('.block[data-bid=ID] .editable, .code-input, .void-host')`；**找不到就 `if(!el) return` 静默退出**（compactCodeHost / divider 等无可聚焦元素的块会命中）。
- `focusBlockAtOffset(id, offset)`、`caretLineEdge(el)`（首/末**可视**行判定）、`captureBlockCaret/restoreBlockCaret`（结构化重渲染保住光标）。

块树遍历（`src/webui/editor-ops.ts`）：
- `findBlock(id)` → `{block,parent,index,parentBlock}`；`flattenBlocks`（DFS 前序）。
- `previousBlock`（`67`）：**首子返回父**（前序里父先被访问）。
- `nextBlock`（`85`）：扁平 DFS 的**下一个**——末子返回其**叔/兄**。
- ⚠️ 这种「首子→父、末子→叔」的**不对称是按设计、正确的**，是 ↑/↓ 在嵌套边界表现不同的原因。**不要**为"对称"去改这两个函数的语义（曾被一次审计误判为根因）。

编辑器内的导航 helper（`DocView` 闭包，本仓新增）：
- `focusInto(block, atEnd)`：导航落点若是 compactCodeHost（无 caret 行）就**潜入其 code 子块**（`while` 兼容多层叠放）。**所有"进入某块"的方向键导航都应走它**，而非裸 `focusBlock`。
- `insertTop(type)`：在 body 顶部插块并聚焦。
- `focusTitle()`：聚焦 `.doc-title`，光标置末尾。

方向键处理器现状（改导航就在这几处）：
- contentEditable `onKeyDown` 跨块（约 `1094`）：`caretLineEdge` 判首/末可视行；↑ 首行→`focusInto(prev)`，**无 prev→`focusTitle()`**；↓ 末行→`focusInto(next)`。
- `onCodeKeyDown`（约 `1170-1245`）：Enter **永远只换行不脱出**；↓ 末行脱出（`focusInto(next)`；无 next 时若在 compactCodeHost 则 `insertAfter(host.id,"p")` 落到列表**之后**而非内部）；↑ 首行脱出（本块是 host body 时跳 `previousBlock(host.id)` 越过宿主；无 prev→`focusTitle()`）；空块 Backspace 转 `p`。
- 标题 `.doc-title` 的 `onKeyDown`（约 `1505`）：Enter→正文首行建空行并落入（首块已是空段落则复用，否则 `insertTop`）；↓ 在标题末可视行→`focusInto(blocks[0])` 进正文首块。
- 标题↔正文三向打通：正文首行 ↑→标题、标题 ↓→正文首行、标题 ↵→新建空首行。

---

## 7. 块创建 / 编辑操作（`editor.tsx`）

- `insertAfter(afterId, type, draft)`（`472`）：**`afterId=null` 是 `blocks.push`（追加到文档末尾，不是开头！）**；否则 splice 进**被定位块所在的父数组**（在列表项子块上调用会插进该列表项的 `children`，易产生悬空空块）。要插到顶部用 `insertTop`。
- `insertListChildFromShortcut`（`767`）：见 §5。
- `indent/outdent`（约 `778+`）、`convert`（`487`，保光标用 capture/restore）。
- 快捷输入：`shortcutFromInput`（`blocks.ts:417`）解析 `# / > / - / 1. / - [ ] / ```lang` 等 marker；contentEditable 处理器里空格/回车触发块类型提升；`/` slash 菜单。
- IME 守卫：所有键处理器开头 `if (e.isComposing || e.keyCode === 229) return`（组合输入期不当作块操作）。

---

## 8. 保存与同步桥接

`scheduleSave`（`editor.tsx:372`，700ms 防抖）→ `save`（串行链，避免防抖与 flush 竞争）→ `doSave` → `api.updateDocument(docId,{title, body:snapshotMarkdown()})`。
- 本地 replica 路径不带 `if_match`（单本地写者不自争；远端经 `/sync` 块级合并）；HTTP 模式才有 stale/`if_match` 冲突机制（`409`）。
- core 侧 `reconcileBody`（`documents.ts:93`）对 body 做**文本级 diff**，只对变化的块 emit `doc_blocks`（text/blank_after/__deleted）。**无 `documents/body` 寄存器**（仅 title/database_id/parent_id）。
- ⇒ 见 §1 的「只 title 同步」根因与禁忌。

---

## 9. 易错点 / 维护清单（动手前过一遍）

1. **纯空嵌套块不往返**：别期望孤立空子块能保存/同步；需要它"在那儿"就让它落到能往返的位置（顶层空行）或给它真内容。
2. **`focusBlock` 对无可聚焦元素的块静默 no-op**：导航进入块一律用 `focusInto`，别裸调 `focusBlock`（尤其面对 compactCodeHost）。
3. **别改 `previousBlock/nextBlock` 的首子/末子不对称**——按设计正确。
4. **别新增 `emit(documents,…,"body")`**——body 经 `doc_blocks` 同步；body 不同步多半是序列化无 diff（上游）。
5. **`insertAfter(null)` 追加到末尾**，不是开头；要顶部用 `insertTop`。
6. **code 块内 Enter 永远只换行**；脱出靠末行 ↓ / 空块 Backspace（见记忆 `code-block-exit-design`）。
7. **IME**：键处理器先判 `isComposing/keyCode===229`。
8. **contentEditable innerHTML 守恒**：改渲染当心光标稳定性（nbsp/`<br>`/字面量定点，提交 `151ea02`）。
9. **构建**：dev（from-source）刷新即热重建；dist/编译产物需 rebuild+restart（记忆 `webui-frontend-edits-need-rebuild`）。
10. 富字段（children/lang/start…）不入库，靠 Markdown 往返；改往返规则要同时验证 `blocksFromBody`↔`bodyFromBlocks` 双向。

---

## 10. 关键文件 / 符号速查

| 关注点 | 位置 |
|---|---|
| 块模型/类型 | `src/webui/blocks.ts` `Block`/`BlockType`(40,6)、`isListType`(192)、`isBlankSpacer`(327)、`makeBlock`(247) |
| MD→树 | `blocksFromBody`(307)、`parseContainer`(445)、`parseListItem`(491)、`parseLeafBlock`(508) |
| 树→MD | `bodyFromBlocks`(378)、`serializeContainer`(386)、`renderBlock`(750)、`renderListBlock`(790)、`shouldPersist`(816)、`computeListNumbers`(338)、`normalizeNumbering`(355) |
| 行内 MD | `src/webui/markdown.tsx` `inlineToHtml`/`htmlToInline` |
| 编辑器组件/渲染 | `src/webui/editor.tsx` `DocView`、`BlockRow`(~1576)、`CodeBlock`、`.doc-title`(~1501) |
| compactCodeHost | `editor.tsx` `compactCodeHost`(~1622)、`isCompactCodeHost`(`editor-ops.ts`) |
| 导航/光标 | `editor.tsx` `focusBlock`(~2340)、`focusInto`、`focusTitle`、`insertTop`、`caretLineEdge`(~2259)；`editor-ops.ts` `findBlock`(14)、`previousBlock`(67)、`nextBlock`(85)、`flattenBlocks`(45) |
| 键处理器 | `editor.tsx` `onKeyDown`(~1030)、`onCodeKeyDown`(~1170)、`onVoidKey`、标题 `onKeyDown`(~1505) |
| 编辑操作 | `insertAfter`(472)、`insertTop`、`insertListChildFromShortcut`(767)、`indent/outdent`、`convert`(487) |
| 保存/同步 | `editor.tsx` `scheduleSave`(372)/`save`/`snapshotMarkdown`(377)；`src/webui/api.ts` `updateDocument`；`src/core/documents.ts` `updateDocument`/`reconcileBody`(93)/`liveBlocks`(42) |

相关历史文档：[02-edit-editor-selection](../impl-context/02-edit-editor-selection/)、[04-block-level-doc-crdt](../impl-context/04-block-level-doc-crdt/)、[07-webui](../impl-context/07-webui/)。
