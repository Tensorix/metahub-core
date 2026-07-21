# 24 · Sites 发布体验重构（受众优先）

> 状态：**已实施**（2026-07-21，全四阶段落地于 feat/re_sites，待评审）。承接 23-sites-experience：功能面不变，重构用户心智面。

## 0. 问题（诊断结论）

23 期落地后，发布链路功能完整但心智负担重，根因：**设计原则是"按人选档"，UI 暴露的却是机制轴**（访问 × 托管 × 设备 × 权限 × 授权 × 高级的笛卡尔积）。具体症状：

1. "发布"一词三义（上传文件 / visibility=public / 跨设备上架）；
2. 同一站点三条曝光路径（/sites/ 公开、/share/ 链接、Edge 房间），无一处统一回答"现在谁能访问、依赖什么在线"；
3. "桶"字三义（同步后端 / 桶模式 gating / 分享传输），且 `isNoOrigin()` 在同步设置与发布对话框之间是隐形耦合；
4. 状态散落四store（visibility 同步寄存器 / SitePublishState / shares 行 / room peer lifecycle），卡片文案"公网未发布"折叠了不同真相，provisioning 完全不可见；
5. 报错是死胡同（提交时抛"请先去设置配置 Edge"）；
6. 非法组合矩阵（s3⇒只读⇒非站点…）靠散落 throw 试错学习。

## 1. 原则

**WebUI 问意图（谁可以访问），机制自动推导；CLI 保持机制面**（CLI 用户是 agent，机制轴对 agent 友好）。派生逻辑与状态优先级只允许存在一份（core），所有表面共用。

## 2. 落地内容（四阶段）

### 阶段 1 · 术语收敛 + 死胡同变引导
- "桶模式"从全部用户可见文案移除，改为讲事实（"此设备把数据存放在云端存储桶、不常驻在线…"）并链接到来源设置（隐形耦合显式化）。
- WebUI 里"发布"只保留"让别人能访问"一义；上传文案改"上传"；"命名文件桶"改"一组网页文件"。
- CLI：`mh site upload` = `publish` 别名；publish 人读输出 published→uploaded；help "named bucket of files"→"named set of files"。
- 发布对话框：托管不可用时提交前显示内联引导块（黄边，含出路按钮），主按钮禁用；`#/settings?sec=<id>` 深链（view.ts + SettingsView.focusSec）支持从任意处跳转设置章节。

### 阶段 2 · core 派生层
- **`src/core/site-channels.ts`**（纯函数、可移植）：`siteChannels(input)` 把四 store 折成渠道列表（audience anyone|link × hosting device|room × status ready|syncing|unverified|provisioning|rollback_pending|cleanup_pending|expired）；`siteState()` 给出全局唯一优先级（rollback>cleanup>provisioning>room_live>device_live>device_syncing>public_unverified>link_only>private）。测试 `site-channels.test.ts`。
- **`src/core/sync/site-reachability.ts`**：db 便捷包装（getSite + publish states + rollbacks + `listServerSharesLocal`）。
- `listServerSharesLocal` 从 `listSharesLocal` 抽出（同步、无桶扫描——站点不进桶，本地派生不等 S3）。
- **`assertShareCombo`**：非法组合矩阵单点声明（share-actions），CLI/WebUI/远端同路径；room 前置检查提前到建行前（消除 create-then-delete）；CLI --room preflight 去重。
- `mh site list` 增加 `state` 列（复用 siteReachability）。
- AccessPolicy 保持读门面现状（存储迁移仍属后续 stage，本期不动）。

### 阶段 3 · 访问渠道统一视图
- **`src/webui/site-status.ts`**：状态→文案唯一来源（SITE_STATE_LABEL / CHANNEL_STATUS_LABEL / audience/hosting 标签 / `siteChannelInput` 组装器）。
- 站点卡片副标题 = `siteState` 一句话（"已上线 · Edge 始终在线"/"已设公开 · 入口未验证"…），provisioning 不再不可见；"公网未发布"歧义拆开。
- SitePeek 抽屉新增"访问渠道"区块：每行 = 受众徽章 + 托管 + 状态 + URL + 复制/打开（只读，管理动作集中在发布对话框）。

### 阶段 4 · 发布对话框受众优先
- 站点分支第一屏只问 **"谁可以访问？"**：三张 radio 卡（有链接的人 / 任何人 / 仅自己），每张一行后果说明。
- **托管为派生摘要行**："Edge 始终在线 — 你的设备离线也能访问 · 更改"；推导 = Edge 可用→Edge，否则可用设备（server 入口已验证优先），否则回 Edge（引导块指向通用解）。"更改"展开原 托管/设备 select。
- 数据授权折叠为"高级：数据授权（让页面读写数据）…"，展开文案改为后果优先；已选表数回显在折叠标题。
- "已有分享"→"**访问渠道**"：public 渠道行（公开徽章 + 状态 + 复制/打开/停止公开）与 ShareRows 合并呈现——public 只是一种渠道（用户裁决采纳）。
- 首次发布决策数：5-6 → 1（受众）+ 0 必填。

## 3. 不变量（勿回退）

1. 渠道派生与状态优先级只在 `core/site-channels.ts` 一份；UI 文案只在 `webui/site-status.ts` 一份。
2. 组合合法性只在 `assertShareCombo` 一份；新增组合约束先改它。
3. 用户可见文案不出现"桶模式"；对"此设备为何不能托管"必须给出路（内联引导 + settings 深链），不许提交时才抛。
4. 托管默认自动推导（Edge 优先）；手动选择是 opt-out（更改按钮），不是第一决策。
5. `#/settings?sec=<SEC id>` 是公共深链约定。

## 4. 已知留白

- shares-view（全局分享列表）未并入渠道概念（仍按对象×transport 列）；
- doc/db 分享对话框保持原四字段（本就 0 必填）；
- AccessPolicy 存储迁移、grants 三 store 合一仍是后续 stage；
- `mh site publish` 动词未改名（别名过渡）。
