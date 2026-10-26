# Android 原生 UI 验收记录（2026-10-26）

## 环境与范围

- Android 16，Pixel 9 Pro，`emulator-5554`；应用 `com.tensorix.metahub`。
- Release 正常应用，使用 embedded bundle；源码由 dirty `2786b9b` 工作状态派生。构建与安装由主任务协调，本轮未构建、安装或修改代码。
- 隔离本地服务端口 `8991`，模拟器连接 `http://10.0.2.2:8991`。仅使用一次性验收内容，不记录令牌。
- 所有设备 UI 输入、导航、截图均使用 CUA。未使用 adb input、uiautomator，未修改 OS 偏好。
- 首页有两份同名 `Native Acceptance 20261026` 数据库；第一份为空，第二份包含 `Native sample record 样板` 和关联 `Native sample document 样板`。

## 实测步骤与结果

| 用例 | 可见结果及交叉证据 | 结论 |
| --- | --- | --- |
| 连接服务 | 显示首页、样本文档和数据库，底部 首页／搜索／设置 可见 | 通过 |
| 打开数据库和记录 | 第二份数据库显示样本记录；记录页 Title、Status、Document 字段可见 | 通过 |
| Title 编辑后立即打开 Document | 全选并输入 Title，未手动失焦，直接点击第一个 Document 按钮；关联文档打开，无可见崩溃 | 导航通过；精确标题验收受输入污染，不能通过 |
| 文档编辑与保存 | 切换 Markdown 模式，正文末尾追加 `Android native document saved 20261026` 一次；完整文本可见，保存中… 变为 已保存 | UI 保存观察通过；服务端正文 API 结果由主任务另行补充 |
| 返回并确认记录标题持久化 | CUA 返回操作受阻，未获得记录页回访画面 | 未通过／工具阻塞 |
| 按钮文字 | 首页分页、数据库动作、记录 Document 动作的多个填充按钮没有可见文字 | 未通过，实际标签缺陷 |
| 键盘／可访问性 | 字段能点击输入；AX 只有模拟器 dialog，没有 Android 字段语义；未验证软键盘遮挡和读屏 | 未完成 |
| 错误／重试 | 编辑中曾短暂显示 有未保存的修改、保存 / 重试；未执行受控断网失败后的重试 | 未完成 |

## API 交叉确认与输入污染

最初一次 Title `typeText` 后，截图仅呈现 `Android native saved 2`。执行者误判瞬时或裁切视图为输入截断，又输入剩余字符。主任务随后以服务端只读 API 确认 Title 为 `Android native saved 2026102602626`。额外后缀是验收输入污染，不是确认的应用输入丢失；精确标题用例需重跑。API 证据说明记录曾持久化，但不能替代原生 UI 返回验证。

初始地址输入也曾只显示 `http:`；最终通过 `typeText('http:')`、两个 slash 按键和地址余段输入，完整 URL 可见且连接成功。没有独立证据证明应用丢失输入。CUA paste 与模拟器客体剪贴板不一致，后续停止粘贴；未提交非验收内容。

## 截图证据

截图位于本次对话 CUA 工具输出中，未导出磁盘；不提供虚构图片路径。按工具标题定位：

1. **Verify connection result**：首页、服务器地址、资源、底部导航。
2. **Inspect second database records**：样本记录及无文字动作按钮。
3. **Open sample record**：记录字段及无文字 Document 按钮。
4. **Edit record title**：编辑中 Title 和 保存 / 重试；不能作为完整输入值证据。
5. **Read full document screen**：关联文档原正文及已保存状态。
6. **Append document acceptance text**：完整追加文本及 保存中…。
7. **Verify document saved indicator**：完整追加文本及 已保存。
8. **Refresh navigation viewport**：最终文档保存画面，随后返回操作被 CUA 拒绝。

## 阻塞与验证边界

重新选择应用、读取 AX、Raise 和截图成功后，坐标点击或手势仍多次返回 `noWindowsAvailable`。Escape、左侧返回手势、可见模拟器工具栏 Back 均未产生可验证的返回结果。停止 UI 操作，未重启模拟器或修改系统设置。

本轮不能声明完整端到端通过：返回记录、精确标题、可访问性和错误重试未完成；无文字标签明确未通过。低层单元测试、类型检查、构建或 API 成功均不能替代这些原生验收。本轮未运行低层检查；其他检查应单独记录。
