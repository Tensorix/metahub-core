# 文档独立窗口

## Direction contract

THESIS: 主窗口负责浏览资料库，独立窗口负责编辑一篇文档。独立打开不复制内容，同一文档重复打开聚焦已有窗口。

OWN-WORLD: 延续现有 WebUI 的颜色变量、字体、Icon、MenuItem、DocView、历史面板和分享弹窗。窗口原生边框遵循现有 macOS hiddenInset、Windows/Linux 标准边框策略。

STORY: 从文档右键菜单、顶部更多菜单或命令面板打开，在独立窗口写作，看到明确保存状态，一键返回主窗口。

FIRST VIEWPORT: 48px 标题栏、48px 面包屑及操作栏、居中现有编辑器、30px 底栏。右上为返回主窗口，工具栏为保存状态、分享、更多；窄窗口折叠路径和保存状态文字，保留有名称的图标按钮。

FORM: 已批准的独立文档窗口效果图，沿用现有组件而非重新绘制编辑器。seed: none (unavailable)。上下文加载器不可用，本次以源码、现有截图和用户批准的效果图为依据。

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

本功能扩展现有界面，不变更全局设计系统、不引入产品用位图。效果图是设计参考，文档正文及标题以用户实际数据为准。

## 实现

- `apps/desktop/src/document-windows.ts` 管理原生文档窗口和文档关闭握手。窗口按文档 ID 去重，同一桌面进程共用同一资料库；位置保存在桌面 userData 的 `document-windows.json`，最多保留 80 项，显示器变动时回收至可见区域。
- Preload 的 `documents.initialId` 是独立窗口身份；hash 仍是标准文档链接。主进程校验 IPC 来源、主 frame 和文档 ID，不接受任意 URL 或文件路径。
- `src/webui/document-window.tsx` 是轻量外壳。复用 `DocView`、目录、字数、分享和历史。内部文档链接打开目标独立窗口，数据库链接定位主窗口，原窗口不换文档。
- `document-save.ts` 串行保存快照、记录已落盘的编辑 revision。保存请求期间的新输入仍然 dirty；冲突阻止自动重试；显式覆盖才跳过 `if_match`。
- HTTP 窗口共用现有 `/api/changes` 实时通知。只有干净且未被更新编辑/保存超越的读取可以替换正文。冲突保留草稿，可确认后载入最新、另存草稿或覆盖。
- `document-refresh.ts` 合并读取期间的通知，并在当前读取完成后继续处理最后一次通知；即使当前响应因编辑或保存而过期，也不能丢掉后续刷新。卸载后停止后续读取。外壳的目录和面包屑刷新另以 80ms 防抖及请求序号避免旧响应覆盖新列表。
- `document-lifecycle.ts` 汇总当前 renderer 的文档保存任务（含嵌入编辑器）。关闭时冻结交互、flush、回报主进程；失败或超时显示重试/取消/放弃，取消恢复交互。
- 编辑器卸载时，尚未保存的标题、正文、版本和错误保留在 renderer 的 detached 注册表中，继续参与关闭及退出保存。失败提示提供「查看草稿」；取消关闭也可导航回失败草稿。重新打开时先尝试 flush；仍失败则通过 `claimDocumentDraft` 返回快照和 `accept()`，只有仍挂载的接收编辑器确认接管才移除原注册项。接收者若在等待期间离开，草稿仍可再次领取。恢复的草稿保持冲突状态，等待用户处理，不盲目自动覆盖。
- 整应用退出先确认文档和磁盘文件的保存，再退出并停止 sidecar。快速笔记关闭仍为隐藏，退出时参与文档保存。

草稿保留是当前 renderer 生命周期内的保护，不是磁盘上的崩溃恢复日志；强制结束进程或明确放弃修改不在恢复保证内。

## 设计系统对照

本次是既有界面的普通扩展。独立窗口复用 `Icon`、`MenuItem`、`DocView`、`UiHost`、历史及分享组件，颜色沿用 `src/core/ui-theme.ts`，字体、字号、圆角与焦点样式沿用 `src/webui/styles.css`。外壳只增加局部布局：48px 标题栏、至少 48px 工具栏、30px 底栏；720px 以下隐藏路径及保存状态文字，但保存按钮仍有可访问名称和提示，文档标题允许断行。

浅色、深色及系统外观变化使用既有主题解析；保存成功、失败和冲突使用已有 success/danger 语义颜色。没有新增全局 token、替换视觉身份或随产品发布的位图。

根目录没有 `PRODUCT.md` 或 `DESIGN.md`。现有 `website/DESIGN.md` 描述营销网站，其 Manrope 字体和网站配色不适用于 WebUI 的 Hanken Grotesk 与主题变量；这是既有表面范围差异，不作为本次待修复漂移。该文件保持不变，本记录承接独立窗口方向契约，不将局部布局升格为全局规范。

## 验证

最终聚焦测试为 9 个文件、113 项通过、0 项失败、270 次断言。覆盖请求期间继续输入、并发 flush、冲突、失败重试、过期读取、过期保存响应、干净文档不写回，以及 ID 校验和窗口坐标恢复。新增回归覆盖过期读取后仍处理后续通知、卸载后停止刷新，以及领取者放弃接管后标题和正文仍可恢复。

`bun run build:main` 和前端 `bun build` 均成功，`git diff --check` 无问题。完整类型检查仍有与本次无关的既有错误，不能据此声称全仓类型检查通过。

使用 `/tmp` 下独立的 `METAHUB_HOME` 和 `MH_TEST_USER_DATA` 进行 macOS Electron 验证，不使用真实资料库。已验证打开及窗口复用、标题和正文双向同步、冲突草稿保留、PATCH 失败后取消关闭及重试、立即关闭保存，以及整应用退出前标题和正文落盘。隔离进程在断开测试 inspector 后以退出码 0 结束。Windows/Linux 尚未实机验证。

视觉检查证据为 `/tmp/mh-document-test/light.png`、`dark.png` 和 `narrow.png`（540px）。这些是隔离测试的运行截图，不是生成或随产品发布的素材。检查覆盖浅色、深色、窄窗口和现有组件一致性。

最终复核结论：在已列出发现的范围内可交付；原三项发现及草稿接管竞态均已解决。此结论不扩大为未测试平台或全仓问题的保证。
