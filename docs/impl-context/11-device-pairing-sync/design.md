# 多设备配对 + 自动同步设计文档

承接 [09-file-sync/design.md](../09-file-sync/design.md)（CRDT 推/拉同步协议）与 [10-persistent-token/design.md](../10-persistent-token/design.md)（持久化服务器 token）。

09 的同步是**手动**的（`mh sync <url>`），且 `/sync` 端点对所有人开放（信任对等模型，不校验任何 token）。本文记录把它升级为:**设备间通过一次性配对码建立互信、交换长期凭据后由服务器后台自动双向同步**,并把 `/sync` 纳入鉴权。配置统一收进 `mh config`(交互式 + `--flag` 两用)。

**关键定位**:配对凭据(per-peer grant)是服务器签发、托管在本地 DB 的 bearer 凭据,与 10 的主 token 并列作为 `/sync` 的有效身份。配对码只用于一次性引导,用完即废。整个机制不改 core / oplog,只在 `/sync` 协议外加一层身份与编排。

## 1. 背景与目标

现状(09):`/sync` 在 server 的 token 门禁里被**豁免**,任何人都能推/拉全量数据;`peers` 表只有 `url/pull_cursor/push_cursor`;同步要人手敲 `mh sync`。

目标:

- **`/sync` 强制鉴权**(非 `--debug`):无有效身份的同步被拒。
- **一次性配对码引导 + 交换证书**:A 生成短期单次配对码 → B 填码 → 双方**互相签发长期 per-peer 凭据**,主 token 不外泄。
- **自动同步**:server 内置定时器,周期性对每个启用的 peer 跑一轮推/拉。
- **双向**:配对自动在两端互相登记,任一方都能发起。
- **统一配置入口 `mh config`**:同一命令既能交互式向导(Bun 全局 `prompt()`),也能 `--flag` 直配;WebUi 设置页是其 GUI 镜像。
- **可撤销**:删 peer 连带吊销签发出去的凭据;另有列出/吊销凭据的命令兜底单向配对产生的无主凭据。

## 2. 配对与鉴权流程

```
A: mh config peer code            → 一次性码 CODE(随机 12 位 base36,默认 10min,单次)
B: mh config peer add --url <A> --code CODE [--self-url <B>]
   1. B 生成 grantB→A(B 签发给 A 的长期凭据),存入 B.peer_grants(B 将接受 A 持此凭据)
   2. B → POST {A}/api/pair  body={code, node_id:B, grant:grantB→A, self_url?:B}
A 的 /api/pair:
   3. 原子兑换 CODE(UPDATE ... WHERE used=0 AND 未过期,changes>0 才算成功)
   4. 生成 grantA→B,存入 A.peer_grants(A 将接受 B 持此凭据)
   5. 若带 self_url:把 B 登记进 A.peers(token=grantB→A)
   6. 返回 {node_id:A, grant:grantA→B}
B:
   7. 把 A 登记进 B.peers(token=grantA→B)
   8. 立即同步一轮
```

结果:B→A 出示 `grantA→B`(在 A.peer_grants 中→接受);A→B 出示 `grantB→A`(在 B.peer_grants 中→接受)。主 token 从不在配对中传输,一次性码用完即废。**两个方向签发的凭据,其 `peer_grants.peer_url` 都等于对端 URL**——这是后面按 URL 撤销的依据。

B 无入站网络时省略 `--self-url`:仅 B 单向登记 A,但单次同步轮回(一次 POST `/sync`)本就同时推与拉,数据仍双向。(此时 A 侧那条 grant 的 `peer_url` 为 null,见 §6。)

## 3. 数据模型(`src/core/schema.ts` + `src/core/db.ts`)

扩展 `peers`(出站:我要同步去的对端;`token` = 对端签发给我、我出站时出示的凭据):

```text
peers: url PK, pull_cursor, push_cursor,
       token, label, node_id, enabled,
       last_sync_at, last_status, last_error
```

老库经 `migratePeers(db)` 用 `hasColumn` 守卫的 `ALTER TABLE` 幂等补列(参考既有 `migrateRecords`),不删表、保留游标。

新表:

```text
peer_grants:   token PK, peer_url, node_id, created_at   -- 入站:我签发、我在 /sync 接受的凭据
pairing_codes: code PK, exp, used, created_at            -- 一次性配对码
```

## 4. 鉴权:`/sync` 接受主 token 或任一 grant

`src/core/sync/auth.ts` 新增 `acceptsSyncToken(req, url, cfg, db)`:`--debug` 全放行;否则 presented 必须等于当前主 token,或命中 `peer_grants`(`isAcceptedGrant`)。`server.ts` 的门禁改为:`/sync` 走 `acceptsSyncToken`;`/health`、`/auth/token`、`/api/pair` 豁免主 token 门禁(`/api/pair` 在 handler 内用一次性码自鉴权);其余 `/api/*`、WebUI、`/docs`、`/sites` 仍按 10 的主 token 门禁。

`src/core/sync/client.ts` 的 `syncWithPeer(db, url, token?)`:token 缺省时从 `peers.token` 取,非空则附 `Authorization: Bearer`。

## 5. 自动同步定时器

`startServer` 内 `setInterval(() => syncAllPeers(db), interval)`(`peers.ts:syncAllPeers` 遍历 `enabled` peer 调 `syncPeer`,回写 `last_sync_at/status/error`)。默认 30s,`opts.syncIntervalMs` / `--sync-interval` / `METAHUB_SYNC_INTERVAL` / 持久化 config / `--no-auto-sync` 控制;`RunningServer.stop()` 清定时器 + 关 server。**DB 是 source of truth**:独立进程 `mh config` 改的 peer,下一 tick 自动生效,无需重启。`timer.unref()` 不挡进程退出。

## 6. 配置入口 `mh config`(`src/cli/commands/config.ts`)

单命令、positional 分发(不用 citty subCommands,避父子 `run` 双执行,见 `token.ts` 注释)。无参数 + TTY → 交互向导(Bun `prompt()`);有 flag → 直配;非 TTY 无参 → 打印当前配置。

```
mh config                                   # 交互向导(服务器设置 / 同步设备)
mh config --host --port --sync-interval --auto-sync   # 直接写入持久化 config
mh config show [--json]                      # 当前配置 + peer 状态
mh config peer add --url <url> --code <code> [--self-url <url>]
mh config peer code | list | rm --url | enable --url | disable --url | sync [--url]
mh config grant list                         # 列出本机签发的凭据(token 脱敏)
mh config grant revoke --token <token或前缀> # 按精确 token 或前缀吊销
```

服务器级设置(`src/core/config.ts`)持久化在 `meta`(`cfg_host/cfg_port/cfg_sync_interval/cfg_auto_sync`)。`--server` 解析优先级:**CLI flag > 持久化 config > 内置默认**。

**撤销**(`peers.ts:removePeer`,事务):删 `peers` 行(停出站)+ 删 `peer_grants WHERE peer_url=url`(停对端入站)。单向配对产生的 `peer_url=null` 凭据 `removePeer` 够不着,用 `grant revoke`(`pairing.ts:revokeGrant`,`token = ? OR token LIKE ?||'%'`,支持脱敏前缀)兜底。

WebUI(`src/webui/settings.tsx`)是镜像:「同步设备」(生成配对码带倒计时 / 添加设备 / peer 列表与状态 / 立即同步·启停·移除)+「已授权设备」(列出 + 吊销 grant)。走相同 `/api/*` 路由,真实 Modal/`confirmDialog`,无 alert/prompt。改 tsx 需 `bun run build` 重建 `dist/webui.js`。

## 7. `mh sync` 的优雅令牌流程

`/sync` 收紧后,旧的无 token `mh sync <url>` 会 401。改 `sync.ts`:先按已存凭据直连;若 401 且在 TTY → `prompt()` 让用户输入 token、重试、并 `addPeer` 保存(下次直连);非 TTY → 明确报错并提示 `--token`。输入的 token 可以是对端主 token(`acceptsSyncToken` 也接受),即无需完整配对也能一次性手动同步并记住。

## 8. 安全考量与威胁模型(诚实记录)

已处理:

- **配对码**:`crypto.getRandomValues` 的 12 位 base36(≈62 bit);默认 10min TTL;**原子单次兑换**(单条 `UPDATE ... WHERE used=0 AND 未过期`,杜绝 TOCTOU 双兑换);生成时清理过期/已用码。
- **凭据熵**:grant 为 32 位 base36(≈165 bit)。
- **可撤销**:删 peer 连带吊销;`grant revoke` 覆盖无主凭据。

**残留风险 / 使用约束(需在部署侧承担)**:

- **明文 HTTP、无 TLS**:配对码、grant、主 token 以 Bearer 明文传输。server 默认仅绑 `127.0.0.1`;`--host 0.0.0.0` 对外时**务必置于可信网络内,或前置 TLS/反代**。这是最大现实约束。
- **bearer = 全量访问**:任一有效 grant/token 即可读写**整个工作区**(同步无按 peer 的数据隔离,本就是设计如此)。凭据泄露 → 需手动 `grant revoke` / `peer rm`。
- **凭据永不过期**:per-peer grant 当前无 TTL(刻意:一次配对长期自动同步)。靠撤销而非过期管理生命周期。
- **`self_url` 受限 SSRF**:配对方(须持有效一次性码)可让 A 把 `self_url` 登记为 peer,A 的定时器会向其 POST `/sync`。仅限固定路径 + JSON、且攻击者已通过一次性码门槛,风险有限;但暴露在不可信网络时应留意。
- **配对码无速率限制**:`/api/pair` 不限频。62 bit + 10min + 单次使得在线爆破不现实,但生产暴露场景下加限频更稳妥(未做)。
- **DB 即密钥库**:主 token、grant、保存的 peer token 在 `~/.metahub/metahub.db` 明文(与 10 的主 token 一致)。靠 OS 文件权限保护该目录。

结论:在**可信网络/本机回环**的预期用法下无已知可利用漏洞;对外暴露请加 TLS + 限频,并把凭据撤销当作主要的生命周期手段。

## 9. 涉及文件

- 新增:`core/config.ts`、`core/sync/pairing.ts`、`core/sync/peers.ts`、`core/sync/peers-routes.ts`、`cli/commands/config.ts`、`core/sync/pairing.test.ts`
- 改动:`core/schema.ts` + `core/db.ts`(迁移)、`core/sync/client.ts`、`core/sync/auth.ts`、`core/sync/server.ts`、`core/sync/protocol.ts`、`core/sync/routes.ts`、`cli/index.ts`、`cli/commands/sync.ts`、`webui/settings.tsx` + `webui/api.ts` + `core/sync/webui.ts`(CSS)
