# 持久化 + 轮换的服务器鉴权 token 设计文档

承接 [08-agent-sites/design.md](../08-agent-sites/design.md)。08 引入了 `mh --server` 的**单 token 解锁鉴权**,但 token **每次启动都新生成**(`randomSuffix(24)`)、只在内存、永不过期。本文记录把它改为:**持久化到 `~/.metahub`、带 TTL 到期才轮换、并支持浏览器用旧 token 无感换取新 token**。

**关键定位:token 是托管在 `meta` 表里的服务器密钥,以 DB 为 source of truth。** 运行中的 server 每次请求从 DB 读状态,因此独立进程的 `mh token refresh` 立即生效、过期轮换在下一请求惰性发生——不改 core / oplog / sync 协议。

## 1. 背景与目标

现状(08):`startServer` 里 `token: opts.debug ? null : (opts.token ?? randomSuffix(24))`——内存态、每次启动变、无过期。痛点:每次重启都让浏览器/agent 已缓存的 token 失效,所有人重新解锁。

目标:

- **持久化**:无 `--token`/`METAHUB_TOKEN` 时,token 存 `~/.metahub` 的 `meta` 表,重启复用。
- **过期 + 轮换**:token 带 TTL(默认 30 天)。只在 (a) `mh token refresh` 手动、或 (b) 过期 时重新生成,否则稳定不变。
- **浏览器无感续期**:轮换后,持有*旧* token 的浏览器在**宽限窗口**(默认 7 天)内不需用户重输即换到*新* token。
- `--token`/`METAHUB_TOKEN` 保持**静态覆盖**语义:固定、不持久化、不过期(脚本场景)。`--debug` 仍整体关闭鉴权。
- 维持 08 的约束:对 CLI 启动零开销(serve/auth 路径不变其懒加载结构)。

## 2. 设计要点

### 2.1 存储模型(`meta` 表四键,与 `node_id` 同套路)

复用既有 `meta(key PRIMARY KEY, value)`,新增四键(`src/core/sync/token.ts`):

```text
auth_token          当前 token
auth_token_exp      当前 token 过期时刻(epoch ms)→ 到点惰性轮换
auth_token_prev     上一次轮换前的 token(单代)
auth_token_prev_exp prev 可被交换的截止时刻(= 轮换时刻 + grace)
```

`token.ts` API:`readState` / `rotate(db,ttl,grace)` / `loadOrRotate(db,ttl,grace)`(缺失或过期则 rotate)。写用 `INSERT ... ON CONFLICT(key) DO UPDATE`,全部同步,fetch handler 的 check-then-rotate 无交错。TTL/grace 经 `parseDuration` 从 `METAHUB_TOKEN_TTL`/`METAHUB_TOKEN_GRACE` 读(接受 `30d`/`7d`/`24h`/裸秒),默认 30d / 7d。

### 2.2 惰性轮换:触发者总能续上

轮换 = `prev ← current`(`prev_exp = now+grace`)、`current ← randomSuffix(24)`、`exp = now+ttl`。只发生在手动 refresh 与「请求到达且 `now > exp`」两处。**关键性质:触发轮换的那个客户端,其旧 token 此刻正好成为 `prev`,故它当场就能换到新 token**——单/主客户端永远无感,哪怕离线 45 天回来也是它自己触发轮换。7 天宽限是给*其他*持旧 token、轮换时离线的设备/agent 的回来窗口。

### 2.3 门禁感知 token 状态(`src/core/sync/auth.ts`)

`AuthConfig` 由静态 `{debug, token}` 改为三态:

```ts
interface AuthConfig { debug: boolean; staticToken: string|null; db: Database|null; ttlMs: number; graceMs: number; }
```

- `activeToken(cfg)`:debug→null;`staticToken`→`{token, exp:Infinity}`;否则 `loadOrRotate` →`{token,exp}`。
- `authActive(cfg)` = `!debug && (staticToken||db)`;`hasValidToken` 与 `withShim` 都据此(后者据 `authActive` 决定是否注入套壳)。
- `renewToken(req,url,cfg)`(仅托管模式):presented===current→返回 current;presented===prev 且未过宽限→返回 current;否则 null。

### 2.4 交换端点 `GET /auth/token`(`RENEW_PATH`,豁免门禁)

加入 `exempt` 集合(同 `/sync`、`/health`),使持过期/旧 token 者仍能到达。逻辑即 `renewToken`:成功 `200 {token, exp}`,否则 `401`。**这是无感续期的服务端支点**:谁持有「宽限内的前一代 token」,谁就能换到当前 token。

### 2.5 浏览器两条无感路径

- **页内 `fetch`(注入的 SHIM)**:在原「附 Bearer 头」基础上增加——同源响应 `401` 且未重试过 → `GET /auth/token`(带存的 token);成功则把新 token 写回 localStorage+cookie 并**重试一次**原请求;失败放行原 401。用户无感,仅一次透明往返。
- **顶层导航(解锁页)**:整页加载无法被 JS「重试」,故解锁页自身变成「续期感知」:加载时若 localStorage 有 token,先 `GET /auth/token` 静默续期,成功 save+`reload`(无需输入),失败才显示密码表单(保留「token rejected」提示)。

## 3. 取舍

- **DB 为 source of truth + 每请求读**:让独立的 `mh token refresh` 无需与运行中的 server 协调即生效,过期轮换也自然惰性化;代价是每请求一次 SQLite 读(本地、微秒级,可接受)。
- **只接受前一代 `prev` 交换**:轮换两次(如连按 refresh)会让落后两代的客户端必须重输;换来实现简单、暴露面有界。
- **交换以明文返回当前 token**:这是「无感」的固有代价——持宽限内旧 token 者能拉到当前 token,故宽限**有界**(默认 7 天)以保留轮换的安全意义。偏安全的部署可经 env 调短 TTL/grace。
- **`--token`/env 保持静态、不持久化**:保留脚本/CI 的可预期固定 token 行为;托管模式只在「未显式给 token」时启用。
- **30d TTL / 7d grace 默认**:本工具的 token 实为「会话/刷新型」单密钥(浏览器存 cookie 一年、长跑 agent 持有),按业内会话凭证实践取「周级 TTL + 足够回来窗口」;均可 env 覆盖。

## 4. 涉及文件

- 新增:
  - `src/core/sync/token.ts` — `meta` 四键的托管 token 存储:`parseDuration`、`readState`、`rotate`、`loadOrRotate`、默认 `TTL`/`GRACE`。
  - `src/cli/commands/token.ts` — `mh token`(`show`/`refresh`,无子命令时默认 show)。
  - `src/core/sync/token.test.ts` — 持久化/轮换/过期/交换的单测。
- 修改:
  - `src/core/sync/auth.ts` — `AuthConfig` 三态;`activeToken`/`authActive`/`renewToken`;`hasValidToken`/`withShim` 改据 `authActive`;SHIM 加 401→换取→重试;解锁页加静默续期。
  - `src/core/sync/protocol.ts` — 新增 `RENEW_PATH = "/auth/token"`。
  - `src/core/sync/server.ts` — `AuthConfig` 三态构造;`RENEW_PATH` 豁免 + 处理;`RunningServer` 加 `exp`,启动报持久化 token + 过期时间。
  - `src/cli/index.ts` — 注册 `token` 子命令;启动输出附带过期时间。
  - `src/cli/help.ts` — `mh token` 命令 / `/auth/token` 端点说明 + EXAMPLES。

## 5. 实现记录（与设计的偏差 / 验证）

- **CLI 不用 citty subCommands**:citty 在匹配到子命令时**仍会执行父命令的 `run`**,导致 `mh token show` 双跑(实测父 `run` 与子命令各打印一次)。改为**单命令 + 可选 `action` positional**(`mh token` / `mh token show` / `mh token refresh`),单次执行、默认 show。`token.ts` CLI 因此无 subCommands。
- **server 启动读持久化 token**:`RunningServer` 增 `exp`;`token` 由 `activeToken(auth)?.token` 报告(静态模式 `exp=Infinity`→JSON 序列化为 `null`、不打印 expiry;debug 模式两者皆 null)。
- **端到端已验证**(隔离 `METAHUB_HOME`):
  - `mh token show` 跨调用稳定(持久化);`mh token refresh` 轮换并打印新 token + `old token still swappable until`;`mh token bogus` 干净报错退出 1。
  - 运行中的 server:`/health` 豁免;`/api/*` 无 token→401、带 token→200;`/auth/token` 带当前 token→回显当前。
  - **无感续期**:另一进程 `mh token refresh` 后,运行中的 server 立即生效(每请求读 DB)——旧 token 普通请求→401,但 `/auth/token` 带旧(宽限内 prev)token→返回新 token;Bearer / cookie / `?token=` 三种传输皆可;未知 token→401。
  - 浏览器:无 token 导航→解锁页(含 `/auth/token` 静默续期 + 密码表单兜底);带 token 导航→真实 WebUI 且注入了含 `401→换取→重试` 的 fetch 套壳。
  - 静态 `--token`:固定 token→200、错→401、`/auth/token`→401(静态不轮换);启动行无 expiry。
- `bun test` 106 通过(新增 `token.test.ts` 9 例:`parseDuration`、持久化、轮换 current→prev、过期触发轮换、`renewToken` 接受 current/宽限内 prev、拒绝过宽限 prev、静态/ debug 模式),零回归。`bunx tsc --noEmit` 无新增类型错误(仅既有的 `index.ts` showUsage 与 `sites-serve.ts` BodyInit 两处基线告警)。
