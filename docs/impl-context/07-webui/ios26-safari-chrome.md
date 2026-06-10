# iOS 26 Safari 浏览器 chrome 适配：机制、踩坑与最终架构

记录移动端 WebUI 适配 iOS 26 Safari（Liquid Glass）浏览器顶/底栏着色的完整过程：5 轮失败假设、最终确认的渲染机制、以及由此确定的移动端布局架构。**这是结构性约束，今后改动移动端布局/吸顶元素前必读。**

## 1. 症状

iOS 26.x Safari 上（用户实测 26.5）：

- 切主题（light/dark）后，浏览器顶部状态栏和底部工具栏颜色不跟随，必须刷新页面才正确；
- 首页 ↔ 文档页导航，顶部颜色不随当前表面切换；
- 底部工具栏像"盒子"一样压在页面外面——内容不会从半透明工具栏下面透出（正常网站如 google.com 都有这个透视效果）。

## 2. 机制（多轮调研 + 真机验证后确认）

iOS 26 Safari **完全忽略 `<meta name="theme-color">`**（该 meta 仅对 Android Chrome 有效）。chrome 的着色按页面结构分两种模式：

### 模式 A：实时液态玻璃（想要的）

工具栏/状态栏实时合成（模糊）**文档画布**滚到它们下方的像素。颜色天然跟随内容与主题、内容透视可见、零维护。

**触发条件**：对应边缘没有贴边（≤3–4px）的 `position:fixed|sticky` 元素，且页面像普通网站一样**文档流滚动**——玻璃只合成"文档画布"的像素，**fixed 全屏面板 + 内部滚动条永远不会在底部工具栏下方画出任何像素**。

### 模式 B：实色扩展（要避开的）

只要某条边有贴边 fixed/sticky 元素，Safari 就为那条边画一条不透明的"实色扩展"（WebKit bug 301756，Wenson Hsieh 确认是设计行为，目的是滚动时不露缝）。规则：

- 取色读元素**自身的** `background-color`——背景画在子元素或 `::before` 上**采不到**，透明背景回退成白色（"white bars"）；
- 颜色**一次采样、之后冻结**：原地改 CSS 变量 / class / style **永不重采样**；
- 重采样只在 fixed/sticky 元素**真正进出渲染树**时发生（`display:none↔block` 切换、节点跨帧插拔）。同一 task 内同步 remove+insert 不经过渲染提交，**触发不了**；
- `opacity:0`、`pointer-events:none` 的隐藏覆盖层**仍参与采样**，只有 `display:none` 才排除——所以弹层关闭态必须 `display:none`；
- 采样几何条件：距边 ≤3–4px、宽 ≥80%、高 ≥3px。

无贴边元素时的着色 fallback 来源是 **html/body 的 background-color**（同样要求不透明，同样原地改不重采样）。

## 3. 失败过的假设（按时间顺序，都在真机上证伪）

1. **"theme-color 是 rgb() 格式所以失效"** → 改 hex 无效。iOS 26 根本不读这个 meta。
2. **"补上 color-scheme + 不透明背景就够了"** → 刷新后正确，但运行时切换全部失效（实色扩展冻结）。
3. **"加一个隐形贴边采样条引导取色"** → 用户否决（不接受 decoy hack），且依然解决不了冻结问题。
4. **"同步 remove+insert 面板触发重采样"** → 无效：没有跨帧提交，Safari 观察不到。
5. **"面板透明 + ::before 画背景能恢复玻璃"** → 部分错误：底部因此失去取色来源回退白色。透明化只对"让该边没有贴边元素"有意义，**前提是那条边有文档画布像素可合成**——盒装布局下底部没有任何像素。

根教训：**盒装 App 壳（`body{overflow:hidden}` + fixed 全屏面板 + 内部滚动）在 iOS 26 Safari 上永远拿不到玻璃透视和实时变色**，换任何触发技巧都没用。google.com 之所以正常，是因为它是普通文档流滚动页面。

## 4. 最终架构（已落地，真机验证通过）

移动端（`@media (max-width:768px) and (pointer:coarse)`）放弃双 fixed 面板滑动，改为**文档流滚动**：

| 部件 | 做法 | 原因 |
|------|------|------|
| 布局 | `body{overflow:auto}`、`#app{display:block;height:auto}`；活动视图（首页 `.sidebar` / 内容 `.main`，由 `body.mobile-content` 切换）在正常流中 `min-height:100dvh`，document 自己滚动；非活动视图 `display:none` | 玻璃只合成文档画布像素；底部无贴边元素 → 模式 A，透视 + 实时 |
| 内部滚动器 | `.sb-scroll`、`.content` 在移动端 `overflow:visible; flex:none` | 滚动交给 document |
| 吸顶返回栏 | `.topbar{position:sticky;top:0;background:var(--bg)}`——背景必须在 sticky 盒子**自身**上 | 顶边有 sticky → 模式 B，取色读自身背景；透明会回退白色 |
| 顶部颜色随导航切换 | 天然成立：首页↔内容切换是 `display:none↔flex`，属于真实渲染树进出 → 每次导航重采样 | 模式 B 的唯一可靠重采样触发 |
| 画布颜色 | `html:has(body.mobile), body.mobile { background:var(--sidebar) }`；`html:has(body.mobile-content), body.mobile-content { background:var(--bg) }` | 无贴边元素的边（首页顶部、所有底部）从 html/body 背景取色；overscroll 区域也得跟随表面 |
| 页面切换动画 | 双面板 fixed 滑动与文档流不兼容，改为进入视图的 `page-in`（28px 右侧滑入+淡入 0.22s） | 取舍：保留过渡感，放弃双面板编排 |
| 滚动位置交接 | app.tsx：进内容页记 `window.scrollY`，回首页恢复，打开新视图归零（`display:none` 会丢 document 滚动位置） | 两个视图共享同一个 document 滚动 |
| theme-color meta | `syncThemeColor()` 保留（hex 写入） | 仅为 Android Chrome |

桌面端布局完全不受影响（以上全部限定在移动端 MQ 与 `body.mobile` 类内）。

## 5. 今后改动的检查清单

- 移动端**不要**新增贴边的 fixed/sticky 全屏面板或工具条；浮动元素离边 >4px（如 `.selbar` 的 `bottom:16px+inset`）不会触发实色扩展，安全。
- 吸顶元素的背景**写在元素自身**，不要拆到伪元素/子元素。
- 弹层/scrim 的关闭态必须 `display:none`（`opacity:0` 仍会被采样污染顶/底栏颜色）。
- 新增表面色时，记得 html/body 背景的跟随规则（§4 画布颜色行）。
- 运行时换肤后若发现 chrome 颜色滞后：先检查是不是引入了贴边元素掉回模式 B，不要先去找"触发重采样"的 hack。
- 平台 chrome 行为按**当前 OS 版本**调研（iOS 26 改过、26.x 点版本又改过），不要凭旧经验。

## 6. 参考

- WebKit bug 301756 —— Wenson Hsieh 对实色扩展机制的官方说明
- 1ar.io/updates/safari-26-liquid-glass-web —— Safari 26 适配坑实测合集（透明回退白、display:none 规则、html/body 要求）
- jahir.dev/blog/safari-toolbar —— 采样几何条件（贴边 ≤3–4px、宽 ≥80%、高 ≥3px）
- benfrain.com/ios26-safari-theme-color-tab-tinting-with-fixed-position-elements —— popover/dialog 出现即重着色（渲染树进出触发）
- nasedk.in/blog/ios26-safari-toolbar-colors —— 原地改色永不重采样，设计如此
