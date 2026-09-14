# 实时变更推送(live change feed):CLI 写入自动刷新打开的视图(0.5.0)

## 1. 背景

一个 agent 在终端跑 `mh record update`,用户正开着 WebUI 看同一张表——表不动。必须手动刷新。

原因是**进程边界**:CLI 和 `mh --server` 是两个进程,共享同一个 SQLite 文件(WAL)。服务器进程里没有任何钩子能观察到 CLI 的写入。

浏览器副本模式没有这个问题(db-worker 每轮同步后自己发 `synced` 事件),缺的只是 **window(HTTP)模式**——也就是桌面端和普通浏览器直连服务器的那条路。

## 2. 决策:服务端轮询 oplog 高水位 + SSE 广播

`GET /api/changes` 挂住一条 SSE 流(`src/webui/server/changes-route.ts`)。

- **一个 DB 一个轮询器**(`WeakMap<db, Poller>`,并行测试服务器天然隔离;最后一个订阅者断开即拆掉定时器)。
- 每秒查一次 `SELECT MAX(seq) FROM crdt_changes`——rowid 别名主键上的 `MAX()`,微秒级;**只有水位真的动了**才去 `changesAfterSeq` 取差量。
- 事件载荷是 `{datasets, rowIds, cursor, truncated}`:**丢掉变更体**,只留数据集名和(上限 500 条的)行 id,所以无论积压多大,载荷都是有界的,循环取尽是安全的。
- **心跳 8s**:必须低于 `Bun.serve` 默认的 `idleTimeout`(10s),否则套接字会被当空闲回收(`ERR_INCOMPLETE_CHUNKED_ENCODING`),客户端每 10 秒烧一次重连。
- `broadcast(db, datasets)` 是给**不在 oplog 里的状态**留的合成推送口(目前唯一使用者:远端分享清单缓存刷新后推一条 `shares`)。

## 3. 客户端:复用既有的 SYNCED_EVENT 契约

`src/webui/live.ts`:

- **不用 `EventSource`**。它发不了 `Authorization` 头,而且按规范非 200(例如 token 轮换后的 401)会直接杀掉连接且不重试。改用 `authFetch` + 手写读取循环,拿到无感续期,并自带**带游标重连**(`?since=<cursor>`,断线期间漏掉的变更由服务端补齐)。
- 收到的推送**扇出到既有事件**:`SYNCED_EVENT`(表格 / 编辑器 / 关联标题表已经订阅)、`NAV_INVALIDATE`(侧栏与快速笔记列表)、`SHARES_CHANGED`。所以接入这套推送,**订阅方零改动**。
- **150ms 去抖**:CLI 里一个 for 循环写 N 条记录,落成一次刷新。
- **可见性**:浏览器标签页隐藏超过 60s 断流,回来再带游标重连;桌面窗口**保持连接**——回环免费,而一个隐藏但活着的小窗必须在被唤起的瞬间就是新的。
- 只在 window 模式启动:副本模式已有 `synced`,no-origin 壳没有服务器可连。

## 4. 踩到的坑

- **Service Worker 必须豁免 `/api/changes`**(`sw.ts`):`handleApi` 会 `cache.put(res.clone())`,而这是一条**永不结束**的流——等于把流无限缓冲进内存。
- **纯回执尾巴**:游标推进了但 `datasets` 为空(例如只有 receipt 行)时不发事件,避免无意义的刷新。

## 5. 消费方

- 主窗口:表格 / 文档 / 侧栏在 agent 写入后 1~2 秒内自动跟上。
- **快速笔记**小窗:打开的笔记与笔记列表跟随。
- **快速看板**小窗:这是它存在的全部意义——agent 跑 `mh record update` 时卡片自己会动。
- `LIVE_STATUS_EVENT` 暴露连接状态,快速看板渲染成一颗呼吸的 live 点。

## 6. 涉及文件

`src/webui/server/changes-route.ts`(+ `.test.ts`)、`src/webui/live.ts`(+ `.test.ts`)、`src/webui/sw.ts`(豁免)、`src/webui/server/routes.ts`(`onRemoteSharesChanged` → `broadcast`)、`src/webui/app.tsx`(`ensureLive()` 接入点)。
