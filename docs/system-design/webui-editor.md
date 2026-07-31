# WebUI 文档编辑器：CodeMirror 6 架构、派生块模型与 Markdown 往返

本文是 WebUI 文档编辑器（`src/webui/` 下的富文本编辑器)的**常驻参考**。目标:做 Markdown 渲染 / 块装饰 / 结构编辑 / 光标导航 / 序列化相关改动时,先读本文即可,不必从头检索代码。

> **关键心智:文档就是一份 Markdown 文本。** 编辑器是一个 **CodeMirror 6**(`@codemirror/*`)的单文档 `EditorView`,它的 doc **就是文档的原始 Markdown body**。所谓"块"是从这份文本**派生出来的扁平、按偏移索引的展示层**(`cm6/blockmodel.ts` 的 `scanDoc`),用来驱动装饰、void 组件与结构键;它不是编辑器要维护的独立状态。所见即所得靠**光标感知的装饰**(reveal-to-edit):光标不在某块上时隐藏 `# `/`> `/marker 等标记、渲染成块样式,光标进入则标记复现、编辑真实文本。

与 [data-model.md](./data-model.md) 的分工:data-model 讲 **core 侧**权威存储(`doc_blocks` 扁平 CRDT、`documents.body` 是派生缓存);本文讲 **前端侧** CM6 编辑器、派生块模型、Markdown 往返与交互。两者通过「整篇 Markdown body」对接。

> ⚠️ 历史:0.3.x 之前是一套自研 Preact 嵌套块树 + contentEditable 编辑器(`editor-ops.ts`、`BlockRow`、`focusBlock`/`focusInto`、compactCodeHost…),**已整体删除**。若在旧代码/旧文档里见到这些符号,一律作废。

---

## 0. 三层表示 + 一个共享分类器

| 层 | 位置 | 角色 |
|---|---|---|
| **CM6 Markdown 文本** | `cm6/CmDocBody.tsx` 的 `EditorView.state.doc` | 编辑器的**唯一真相**,`getDoc()` 即整篇 body |
| **派生扁平块模型 `DocModel`** | `cm6/blockmodel.ts` `scanDoc`/`patchScan`;经 `cm6/doc-model.ts` 的 `docModelField` 存进 state | 每行的 role + 偏移、void 区间、标题;喂给装饰/void/结构键 |
| **嵌套块树 `Block[]`** | `src/webui/blocks.ts` | **仅**保存/加载解析器 + 序列化器 + 共享行谓词 re-export;**不是**编辑器活模型 |
| core 扁平 `doc_blocks` | `src/core/documents.ts` | 权威存储(见 data-model) |

**共享分类器(唯一真源)** `src/core/md/`:
- `grammar.ts`:唯一的**行级**语法——`RE` 表、`matchListLine` / `matchQuoteLine` / `matchMediaEmbed`、`safeUrl`(URL scheme 白名单)、`HTML_FENCE`、fence/table/indent 助手。
- `inline.ts`:唯一的**行内** tokenizer `tokenizeInline`。
- `heal.ts`:读边界 `healLegacyMarkdown`(修旧序列化器的宽松形式)。

CM6 编辑器扫描(`blockmodel.ts`)、保存解析器(`blocks.ts` 直接 re-export `grammar.ts`)、分享渲染(`core/sync/share-render.ts`)**三面共用同一套谓词**,故**同一份字节在任何面都分类成同一种块**——由 `cm6/grammar-parity.test.ts` 钉死。**STRICT 规则**:每个 marker(含 `>`)都要有尾随空白才成块(`> ` 是空引用行、裸 `>` 与 `>foo` 是段落);旧的宽松形式(`- [ ]`、多段引用里的裸 `>`)在**读边界** heal,不改语法本身。

### CM6 扩展栈与派生(一张图看懂）

```text
              ┌─────────────────────────────────────────────────────────┐
              │   one EditorView.state.doc  =  raw Markdown body  ← 真相  │
              └───────────────────────────┬─────────────────────────────┘
                            每次 doc change │  (patchScan 只重扫受损行窗口)
                                            ▼
                 docModelField ──► DocModel { lines[] · voids[] · headings[] }   派生·扁平·带偏移
                                            │   装饰/结构键都经 docModel(state) 读同一份
        ┌──────────────┬──────────────┬────┴───────────┬────────────────┬──────────────┐
        ▼              ▼              ▼                ▼                ▼              ▼
   block-deco       inline        void-field       structure         keymap         chrome
   块装饰(reveal)  行内预览      widgets(原子/     文本 transaction   (最高 Prec)   slash/find/
   headings/quote/ bold/link/     reveal:图/表/    enter/backspace/   委托 structure  format-bar/
   list/todo/hr    code/strike    代码/html)       indent/convert     命令            toc/word-count/gutter
        └──────── richCompartment(rich 装饰层) ────────┘                              copy-rich/upload
                                            │
              source 模式 = richCompartment.reconfigure(sourceLayer)  → 丢装饰,纯 Markdown 文本
                                            │
                        getDoc() ── 700ms 防抖 ──► PATCH /api/document {title, body}
                                            │
                         core reconcileBody(文本级 diff) ─► doc_blocks emit ─► /sync
   加载/远端合并 ◄── setDoc(norm(body)) ◄── SYNCED_EVENT / 首次加载   (norm = heal ∘ stripStaleUpload)
```

三面共享分类器(横切):`blockmodel` 扫描、`blocks.ts` 保存解析、`share-render` 分享渲染都调 `core/md/{grammar,inline}` 的同一套谓词。

---

## 1. 数据流总览

```
键入/结构键 → CM6 文本 transaction(改的就是这一份 Markdown doc)
  → docModelField.patchScan 只重扫受损行窗口,更新派生 DocModel
  → 装饰层(block-deco / inline / voids)按新模型重画;onChange → scheduleSave(700ms 防抖)
  → snapshotMarkdown() = cmRef.getDoc()   ← 恒等,doc 本身即 Markdown(不再 bodyFromBlocks)
  → api.updateDocument(docId, {title, body})            [src/webui/api.ts]
  → core updateDocument → reconcileBody(body)           [src/core/documents.ts]
  → 文本级 diff,仅对变化的块 emit doc_blocks oplog 行
  → /sync 把 doc_blocks 变更同步给其它节点
加载/远端合并: documents.body → cmRef.setDoc(norm(body)),CM 用最小 diff 映射光标
             norm = healLegacyMarkdown ∘ stripStaleUploadLines(换行规范化)
```

要点:
- **body 的同步源是 `doc_blocks`**(块级 CRDT 合并),`documents.body` 只是物化缓存、**不入 oplog**。详见 [data-model.md](./data-model.md) §documents/§doc_blocks 与记忆 `doc-body-syncs-via-doc-blocks`。
- 「编辑了正文但 `/sync` 只见 `col:"title"`」的根因通常是:**序列化产物没变** → reconcile 无 diff → 不 emit。**不要**靠新增 `emit(documents,…,"body")` 来"修",那会造出与块级 CRDT 冲突的幽灵寄存器。
- 远端合并经 `SYNCED_EVENT` → `cmRef.setDoc(d.body)`(`editor.tsx`),`setDoc` 用共享前后缀最小替换,CM 把光标映射过小改动。
- 保存链是串行的(`editor.tsx` 的 `saveChainRef`),避免防抖 flush 与手动保存竞争。

---

## 2. 派生块模型 `cm6/blockmodel.ts`(编辑器的活模型)

`scanDoc(src) → DocModel`(`blockmodel.ts` `scanDoc`),把整篇文本走一遍,产出:
- `lines[]`:每行一个 `LineInfo`——`role`(`LineRole`)+ 装饰要用的**字符偏移**(前导缩进区间、marker 区间、`contentFrom` 内容起点)+ `level`(缩进级)。
- `voids[]`:块级嵌入的**源区间** `VoidRange`(`VoidKind = code|html|image|video|audio|file|table`),连同为组件解析好的 `Block`。
- `headings[]`:h1–h6 行(偏移 + 原文),供 TOC 等消费。

关键 API:`patchScan(prev, edits, src)`(增量:只重扫受损行窗口再拼接,**每次击键成本正比于改动而非全文**)、`voidAt`/`voidInterior`/`quoteRunAt`/`correctNumberAtLevel`/`hiddenIndentChars`/`isListRole`、常量 `MAX_NEST=8`(缩进级上限,`editor-theme.ts` 从这里 import,别再各写一份)。

`cm6/doc-model.ts`:`docModelField`(把 `DocModel` 存进 CM state,doc 变化时 `patchScan` 增量更新)+ 访问器 `docModel(state)`。**所有装饰层、void、结构键都通过它读同一份偏移准确的模型**;纯选区变化不重扫(位置未变,reveal 层自行按缓存模型重算)。

> 缩进在这里是**字面文本**,不是树嵌套:嵌套列表 = 行首的字面缩进列。自由(非列表)块的缩进级在往返时挂到 `Block.indent`(`blocks.ts`)。

---

## 3. 块装饰与行内实时预览(所见即所得)

### 3.1 块级 `cm6/block-deco.ts`
`blockDecorations`(ViewPlugin)把每可见行的 role 变成 Notion 式块样式,**全程光标感知**:标题给字号类并折叠 `# `、引用给竖线并折叠 `> `、divider 渲成 `<hr>`、列表隐藏前导空白 + 按级 padding 缩进、bullet 出字形、有序项出**字面序号**(源码权威,编辑器**从不**给已有项重编号)、todo 出可点复选框。光标落到某行,其原始 marker 复现以便编辑真实文本。全部是 line/mark/inline-replace 装饰(**绝不** `block:true`),故来自 ViewPlugin;空文档占位符 `PLACEHOLDER`。

### 3.2 行内 `cm6/inline.ts`
`inlineDecorations` 渲染 `**b**`/`__b__`、`*i*`/`_i_`、`` `code` ``、`~~del~~`、`[t](u)`、行内 `![alt](u)`、以及**内链** `[[doc_x]]`:给内容上样式并**折叠定界符**,光标进入该 span 则标记复现(reveal-to-edit 的行内版)。viewport 作用域、**IME 合成期不重建**(合成中把装饰 `map` 过 change 保持偏移诚实、事后 `stale` 重建,见提交 `b39d301`)。语法来自 `webui/inline-tokens.ts`(= `core/md/inline.ts` `tokenizeInline` 的 re-export,和表格桥/TOC 共用),单层无嵌套、转义感知(`\*x\*` 保持字面)。`linkClicks` 打开链接前过 `safeUrl`(挡 `javascript:`/`data:text/html`)。

### 3.3 文档内链 `[[doc_id]]`

> 设计与决策全文见 [26-doc-internal-links](../impl-context/26-doc-internal-links/design.md)。

**语法在 core**(`core/md/inline.ts` 的 `doclink` token,与其它行内标记同一套贪心选择):

- 形状 `[[(doc|db)_<slug>-<rand>]]`,可带 `|别名`。id 形状**钉死为 `newId()` 的产物**,所以任意 `[[普通文本]]` 仍是字面散文——不会把用户的双方括号笔记吃掉。
- **优先级高于 link**:两者都以 `[` 开头,`[[id]](x)` 必须读成"内链 + 字面 `(x)`"。
- 内容跨度取"显示成的纯文本"(有别名取别名、否则取 id),于是 `stripInlineTokens`(TOC/搜索/摘要)不用特判就能把内链摊平。

**编辑器侧**三块:

- `webui/doc-titles.ts` —— **同步**的 id→标题表(CM6 装饰必须同步构建,不能等网络)。`App.reloadNav()` 顺手用它已经取到的导航列表 `primeDocTitles` 喂进来;没有完整应用外壳的场景(快速笔记窗口、测试)首次查找时惰性自刷新。`NAV_INVALIDATE`(任何成功变更,含改名)只把表标记为 stale——**stale 期间继续供旧标题**(自动保存时不闪),真的变了才通知订阅者。
- `cm6/chrome/doclink-suggest.tsx` —— 输入 `[[` 弹出的选择器,结构对齐 `slash-menu.tsx`(`.pop` 挂 document.body + **捕获阶段** keydown 拦截导航键,菜单开着时结构 keymap 收不到)。触发判定:最后一个 `[[` 与光标之间没有闭合/嵌套括号;打了 `|` 就退出(此后是在写别名,不是在搜标题)。插入的永远是**规范 id**。
- `cm6/inline.ts` 的渲染 —— 折叠态是显示实时标题的胶囊(`.cm-doclink`,`data-doclink=<id>`),目标不存在时 `.cm-doclink-missing`;光标进入则露出 `[[id|alias]]` 源码(定界符变灰)。点击经 hash 路由**应用内跳转**,缺失目标不跳。标题在装饰构建时解析,故标题表变化要触发重建。

**其它面**:`webui/markdown.tsx`(表格单元格桥)渲染成带 `data-doclink` 的应用内 `<a>`,DOM→Markdown 回写时还原成**原样的** `[[id]]`/`[[id|alias]]`(无损往返);分享渲染器 `share-render.ts` 把内链渲成**惰性 `<span>`**——自动链到目标的分享页会泄露没被分享的东西,所以只留文字。粘贴站内链接时 `upload-paste.tsx` 经 `view.ts` 的 `doclinkFromUrl` 把它转成内链——内链**不带 origin**,所以换设备/换域名后依然有效。

---

## 4. void 组件(图片/视频/音频/文件/表格/代码/HTML)`cm6/voids/void-field.tsx`

一个 `StateField` 把每个 void 源区间变成块级 `Decoration.replace` widget(宿主是现有 Preact 组件),并把 atomic 的登记进 `EditorView.atomicRanges`(块 replace 装饰**必须**来自 StateField,CM6 禁止 ViewPlugin 出块级 replace)。两种交互:
- **ATOMIC**(media / table / code):光标永不落进区间内部。media「选中」= CM 选区覆盖整段(出缩放柄);表格在原地 contenteditable 岛内编辑;代码在 `CodeIsland` 的 textarea 内编辑(高亮 + focus 时显 ``` 围栏行,永不退回裸源码)。
- **REVEAL-TO-EDIT**(仅 html):非 atomic,选区触及即丢 widget、露出原始 Markdown 编辑;`源码` 按钮派发一个选区进去触发露出。

写回:宿主组件改块(图片缩放、代码 lang、表格单元格)→ `blockToText`(`blocks.ts`)序列化 → `min-diff` 最小替换 dispatch 回文档 → 下一次扫描重建模型。远端合并按 **generation** 判失效重建;表格单元格/代码有 **IME `composing` 守卫**(合成期不逐字提交,`compositionend` 一次提交),否则中/日文候选会逐键写入并推同步。

---

## 5. 结构编辑与"转换" `cm6/structure.ts` + `cm6/convert.ts`

结构动作**都是普通文本 transaction**——没有块树可改、没有 focus 要交接,下一次改动由行语法重新派生模型,原生 CM6 history 负责撤销。每个函数是 CM6 `Command`((view)=>boolean):干活并 dispatch 返 true,否则返 false 让默认 keymap 接手。

- `enterCommand`:列表项续行(带出下一 marker,有序自增)、空列表项 Enter **退出构造**(剥缩进+marker)、未闭合围栏行 Enter **补全成代码块**(严格:整行仅 `\`\`\`` + 纯 lang 才触发,`\`\`\`not code` 这种散文不误转)。
- `backspaceCommand`:行首 Backspace 分级 outdent / 删 marker 转 `p`。
- `indentCommand`/`outdentCommand`(Tab/Shift-Tab):行首 ±2 列缩进(tab-byte 安全);多行选区按级步进。
- `smartHome`、`makeVoidExit(dir)`(方向键跨 void)、`makeArrowIntoCode`、`fenceContinuation`、`focusNewCodeVoid`、`enterDocTop`(文档开头是 void 时先开一空行)、`makeExitTop`(正文首行再上 → 回标题)。
- `cm6/keymap.ts` `structureKeymap`:最高 `Prec`,逐一委托上面命令,false 即穿透到默认/history keymap。

**转换** `cm6/convert.ts`:块的类型**就是它的行前缀**,所以「turn into」= 重写前缀——把 `[缩进, contentFrom)` 之间的旧 marker 换成新 marker,整段在**一次** transaction(`userEvent:"input.convert"`)里改,撤销一步还原。核心 `turnIntoChanges` 是对扫描模型的纯函数(可用 `scanDoc` fixture 单测);`turnInto` 是 gutter 菜单调的薄封装。

---

## 6. 编辑器外壳与 chrome

- **宿主** `cm6/CmDocBody.tsx`:Preact 组件,持一个 `EditorView`(doc = Markdown body),对外暴露小的命令式句柄 `CmHandle`(`getDoc`/`setDoc`/`focus`/`setSource`);view 只在 mount 建一次、unmount 拆,回调走 ref 读、无 per-render 抖动。
- **扩展装配** `cm6/editor-view.ts`:`baseExtensions` + `richCompartment`;`richLayer()`(派生模型 field + 光标感知装饰 + 结构 keymap)与 `sourceLayer()`(丢掉这些 → 纯 Markdown 文本编辑器)放在 Compartment 后,**source 模式 = 同一 view reconfig 到 `sourceLayer`**(非另起 textarea)。原生选区(无 `drawSelection`)、`history()` 原生撤销、source 模式 `indentWithTab`。主题 `cm6/editor-theme.ts`。
- **chrome**(`cm6/chrome/`,都是 CM 扩展/组件):`slash-menu.tsx`(`/` 唤起块菜单)、`find.tsx`(⌘F、装饰式查找,活动匹配按身份追踪 `remapMatches`)、`format-bar.tsx`(选区浮动格式条)、`toc.tsx`(目录 + 滚动高亮)、`word-count.tsx`(右下字数 pill,纯客户端、走 DocModel、CJK 按字/拉丁按词)、`gutter.tsx`(悬停 +/grip 拖拽 → turnInto/重排,一步撤销)、`copy-rich.ts`(富剪贴板复制)、`upload-paste.tsx` + `upload-field.ts`(粘贴/拖拽上传成 media void + `stripStaleUploadLines`)、`preview-anchor.ts`(预览锚点路由)。
- **代码块一键格式化**:见 [architecture.md](./architecture.md) 的 fmt 子系统(`src/webui/fmt/*`,懒加载 prettier + per-language wasm),CodeIsland 里 `格式化` 按钮触发,`applyTaEdit` 写回保 undo 一步。

---

## 7. 标题与保存桥接 `src/webui/editor.tsx`（`DocView`,~489 行)

渲染:`<div class="doc">` → `.doc-title`(contentEditable) + `.doc-meta`(`<SyncStamp/>` + 已分享徽标) + `<CmDocBody>`。
- **标题是 contentEditable、不是块、无 data-bid**。它经 effect 用 `el.textContent = titleRef.current` **播种**(`titleElRef`,依赖 `[version]`——加载/远端合并才 bump);**写 textContent 不是 innerHTML**,故同步来的标题永不注入 HTML(消除存储型 XSS),打字也不触发重渲染重置光标。
- **保存**:`scheduleSave`(700ms 防抖)→ 串行 `save` 链 → `doSave` → `api.updateDocument(docId,{title, body:snapshotMarkdown()})`;`snapshotMarkdown()` = `cmRef.getDoc()`。
- **标题↔正文导航**:`focusTitle(offset?)`;`enterBody()`→ `enterDocTop(view)`(文档以 void 开头时先开空行);标题 `onKeyDown` 里 Enter/↓ 末行 → `enterBody`;正文首行再上 → `onExitTop`=`focusTitle`(CmDocBody 的 `structureKeymap({onExitTop})`)。`caretLineEdge` 现在**只**服务标题的首/末行判定。
- **正文首行 Backspace 并入标题**(`onMergeTop`→`mergeIntoTitle`):文档最开头按 Backspace 时,"上一个块"就是标题——首行文本接到标题末尾,光标停在**接缝处**(`focusTitle(seam)`)。实现要点:一律经 `titleElRef` 拿元素(**不用全局 `.doc-title` 查询**——快速笔记窗口里也嵌着同一套组件);插入走 `insertPlainText` 以触发 `onInput`(顺带完成扁平化 + `titleRef` + 保存);Range 兜底路径不发 input 事件,所以要手动同步 `titleRef.current`。没挂标题时返回 false,让 CM 自己处理这个键。
- **标题只吃纯文本**(`webui/plain-edit.ts`):标题类可编辑宿主(文档标题、数据库名、记录 peek 标题)存的是纯字符串,但裸 contentEditable 会把剪贴板的 `text/html` 原样插进来——Word/Excel/Numbers 带来的 `<span style="font-size:11pt">`/`<font>` 内联样式会盖过宿主的类选择器(inline style 赢、font-size 还继承),标题当场变小;更糟的是某些 flavor 携带 `<style>` 元素,一旦落进页面就是**全文档**生效。对策是根本不让 markup 进来:取 `text/plain`、按文本插入,单行宿主再把换行折成空格。
- **IME**:标题处理器仍 `if (e.isComposing || e.keyCode===229) return`;正文侧 IME 在 CM 层(inline 装饰跨合成 remap、表格/代码 void 的 composing 守卫)。拼写替换/扩展/自动填充这类**不发 input 事件**的外部改写,靠播种 effect 里的一致性检查兜回 `titleRef`。

**core 侧**:`reconcileBody`(`documents.ts`)对 body 做**文本级 diff**,只对变化块 emit `doc_blocks`(text/blank_after/__deleted);**无 `documents/body` 寄存器**。本地 replica 路径不带 `if_match`(单本地写者;远端经 `/sync` 块级合并),HTTP 模式才有 stale/`409`。

---

## 8. 保存解析器 / 序列化器 `src/webui/blocks.ts`（现在的角色)

`blocks.ts` 不再是编辑器活模型,而是**整篇 Markdown ↔ `Block[]` 嵌套树**的往返 + 共享谓词 re-export。往返仍是最易踩坑处:

- **解析** `blocksFromBody(body)`:`parseContainer`(按缩进递归)→ `parseListItem` / `parseTableBlock` / `parseLeafBlock`(fenced code/html、divider、media 行、heading、todo、numbered、bullet、quote,否则 `p`;逐行按自身缩进分类,**和 CM6 扫描 `classifyLine` 同规则**)。**故意不 heal**(`- [ ]` 在打字中途歧义)——heal 只在读边界(`CmDocBody` 的 `norm` / 分享渲染)做。
- **序列化** `bodyFromBlocks(blocks)`:`serializeContainer` → `renderBlock` / `renderListBlock`;`shouldPersist` 决定可持久块(divider/列表项恒持久、空列表项以裸 marker 往返;code 需内容或 lang;table 需非空单元;media 需 src;其余含空 `p` 需 `content.trim()!==""`)。代码/HTML 围栏用 `fenceFor`(按内容最长反引号串 `max(3, longest+1)` 加长,含 ``` 的代码也能完整往返)。
- **谓词/构造**:`isListType` / `isHeadingType` / `isBlankSpacer`(空 `p`、无 children = 竖向间距空行,不是内容)、`makeBlock` / `applyBlockDraft`(type↔字段不变式唯一真源)、`shortcutFromInput`、`matchMediaLine`(委托 `core/md/grammar.ts` `matchMediaEmbed`)、`blockToText`(void 写回用)。`Block` 含 `indent?`(自由块自由缩进级)。
- **往返红线**:顶层空段 = 空行 spacer 能往返;**纯空的嵌套块会被丢**(对策:让空段落落到能往返的位置,不为缩进空块发明表示);有序起始号靠 Markdown 序号本身往返;`children`/`lang`/`start`/`indent` 等富字段**不入库**,每次保存重算。空行是相邻块的 `blank_after` 间距属性、不是独立块(见 data-model §doc_blocks)。

---

## 9. 易错点 / 维护清单(动手前过一遍)

1. **文档就是 Markdown**:改「渲染」= 改**装饰**(block-deco/inline),不是改一棵块树;改「结构键」= 写**文本 transaction**(structure.ts)。
2. **别新增 `emit(documents,…,"body")`**——body 经 `doc_blocks` 同步;body 不同步多半是序列化无 diff(上游)。
3. **三面一致靠共享分类器**:任何行/行内判定都走 `core/md/{grammar,inline}`,别在编辑器/保存/分享任一面手搓一份,否则重新引入跨面漂移(有 `grammar-parity.test.ts` 兜底)。
4. **heal 只在读边界**(load/setDoc、分享渲染),`blocksFromBody` **故意不 heal**;别把 heal 塞进保存解析器。
5. **有序列表序号源码权威**,编辑器从不给已有项重编号。
6. **代码块含 ``` 要靠 `fenceFor` 加长围栏**;别写死 3 反引号。
7. **IME**:标题判 `isComposing/keyCode===229`;正文的行内装饰跨合成 remap、表格/代码 void 用 `composing` 守卫(别逐键提交)。
8. **标题用 `textContent` 播种**,永不 `innerHTML`(XSS + 光标稳定)。
9. **URL 一律过 `safeUrl`** 再进 `href`/`window.open`(编辑器 `inline.ts` 与分享渲染都要;HTML 属性上下文还需 `escapeHtml`)。
10. **纯空嵌套块不往返**、富字段不入库——改往返规则要同时验证 `blocksFromBody`↔`bodyFromBlocks` 双向 + `grammar-parity.test.ts`。
11. **构建**:dev(from-source)刷新即热重建;dist/编译产物需 rebuild+restart(记忆 `webui-frontend-edits-need-rebuild`)。
12. **标题类宿主一律走 `plain-edit.ts`**(粘贴/拖放只取 `text/plain`);新加一个 contentEditable 标题就得接上,否则外部样式会渗进来。
13. **内链只认 id 形状**——放宽 `[[…]]` 的匹配等于把用户的普通方括号笔记变成断链;要改先想清楚 `stripInlineTokens` 与分享页惰性渲染两处的连带影响。
14. **`[[` 选择器读的是本地标题表**(`doc-titles.ts`),不是网络:装饰是同步构建的,任何"顺手加一次 fetch"都会闪。

---

## 10. 关键文件 / 符号速查

| 关注点 | 位置 |
|---|---|
| 编辑器宿主 / 句柄 | `cm6/CmDocBody.tsx` `CmDocBody`/`CmHandle`;扩展装配 `cm6/editor-view.ts` `baseExtensions`/`richLayer`/`sourceLayer`/`richCompartment` |
| 派生块模型 | `cm6/blockmodel.ts` `scanDoc`/`patchScan`/`DocModel`/`LineInfo`/`LineRole`/`VoidRange`/`MAX_NEST`;`cm6/doc-model.ts` `docModelField`/`docModel(state)` |
| 块装饰 / 行内预览 | `cm6/block-deco.ts` `blockDecorations`;`cm6/inline.ts` `inlineDecorations`+`linkClicks`;主题 `cm6/editor-theme.ts` |
| void 组件 | `cm6/voids/void-field.tsx`(StateField + atomicRanges);写回 `blockToText`(blocks.ts)+ `cm6/min-diff.ts` |
| 结构编辑 / 转换 / keymap | `cm6/structure.ts`(`enterCommand`/`backspaceCommand`/`indentCommand`/`outdentCommand`/`smartHome`/`makeVoidExit`/`enterDocTop`)、`cm6/convert.ts`(`turnInto`/`turnIntoChanges`)、`cm6/keymap.ts`(`structureKeymap`) |
| chrome | `cm6/chrome/` slash-menu / find / format-bar / toc / word-count / gutter / copy-rich / upload-paste / upload-field / preview-anchor / **doclink-suggest** |
| 文档内链 | 语法 `core/md/inline.ts`(`doclink` token);标题表 `webui/doc-titles.ts`(`primeDocTitles`/`allDocTitles`/`onDocTitleChange`);选择器 `cm6/chrome/doclink-suggest.tsx`;渲染 `cm6/inline.ts` `.cm-doclink`;粘贴转换 `view.ts` `doclinkFromUrl`;分享页惰性渲染 `core/sync/share-render.ts` |
| 标题纯文本纪律 | `src/webui/plain-edit.ts`(`plainTextFrom`/`insertPlainText`),文档标题/数据库名/记录 peek 标题共用 |
| 共享语法(core) | `src/core/md/grammar.ts`(`RE`/`matchListLine`/`matchQuoteLine`/`matchMediaEmbed`/`safeUrl`/`HTML_FENCE`)、`src/core/md/inline.ts`(`tokenizeInline`)、`src/core/md/heal.ts`(`healLegacyMarkdown`);parity `cm6/grammar-parity.test.ts` |
| 保存解析器 / 序列化 | `src/webui/blocks.ts` `blocksFromBody`/`bodyFromBlocks`/`parseLeafBlock`/`parseTableBlock`/`renderBlock`/`renderListBlock`/`shouldPersist`/`startsLeafBlock`/`fenceFor`/`blockToText`;行内桥 `src/webui/markdown.tsx`(现仅表格单元格 contenteditable 用) |
| 编辑器外壳 / 保存 | `src/webui/editor.tsx` `DocView`、`.doc-title`(textContent 播种)、`scheduleSave`/`save`/`snapshotMarkdown`(=getDoc)、`focusTitle`/`enterBody`;`src/webui/api.ts` `updateDocument`;`src/core/documents.ts` `updateDocument`/`reconcileBody`/`liveBlocks` |

相关历史文档:[02-edit-editor-selection](../impl-context/02-edit-editor-selection/)、[04-block-level-doc-crdt](../impl-context/04-block-level-doc-crdt/)、[07-webui](../impl-context/07-webui/)(均为 CM6 重写前的阶段性记录,仅作历史参考)。
