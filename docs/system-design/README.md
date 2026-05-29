# Metahub 当前系统设计

本文档集是 Metahub 的实时系统设计整理文档,目标是和当前实现保持对齐,同时标明它距离产品目标还有哪些差距。

旧的 `docs/impl-context/*` 仍保留为阶段性设计和实现记录;本目录作为当前状态的总览入口,后续实现发生变化时优先更新这里。

## 项目定位

Metahub 当前是一个基于 Bun + SQLite 的本地知识库 CLI,同时面向 AI Agent 和人类用户:

- 用类型化数据表承载结构化数据,例如记账流水、IM 消息、任务、联系人。
- 用 Markdown 文档承载长文本知识,并提供适合 AI 的增量编辑命令。
- 通过 CRDT oplog 支持多节点最终一致同步。
- 提供 CLI、库入口和独立二进制三种分发形态。
- 实体 id 带类型前缀且可用前缀/名字引用,配合当前库上下文(`mh use`)与 Tab 补全,降低人/AI 的 id 心智负担。

当前系统已经具备基础 typed table、Markdown 文档、全文检索、快照恢复和一轮同步能力。对于记账和 IM 历史消息场景,目前还处于“可手动建表 + 基础查询”的 MVP 状态,尚未形成领域化模板、批量导入、聚合、上下文检索等完整流程。

## 文档地图

- [architecture.md](./architecture.md): 当前架构、模块边界、读写路径、同步和快照。
- [data-model.md](./data-model.md): SQLite schema、CRDT oplog、记录 JSON 存储、文档 block 存储。
- [capabilities.md](./capabilities.md): 当前 CLI 和 core 已实现功能清单。
- [usage-flows.md](./usage-flows.md): 当前已有能力下的记账、IM、文档、同步使用流程。
- [gaps-and-priorities.md](./gaps-and-priorities.md): 和目标体验之间的差距及用户体验优先级。

## 状态标记

本文档使用以下状态词:

- 已实现: 代码中已有可用实现。
- 部分实现: 基础能力存在,但离目标体验还有明显缺口。
- 未实现: 当前代码没有对应能力。
- 暂缓: 已知问题,但当前复盘阶段不作为优先讨论对象。

## 更新规则

每次新增或改变核心行为时,需要同步更新本目录:

1. 改 schema、存储语义、CRDT 语义时更新 `data-model.md`。
2. 改命令、输出、用户流程时更新 `capabilities.md` 和 `usage-flows.md`。
3. 改模块边界、同步、快照、构建方式时更新 `architecture.md`。
4. 完成或新增目标差距时更新 `gaps-and-priorities.md`。

