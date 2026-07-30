# 站点同源信任边界：本轮决策记录

背景：`/sites/<name>/` 与管理 WebUI 同源同端口（`server.ts` 单一 `Bun.serve`）。
同源站点脚本因此存在三条访问 owner 凭据的路径：
① `localStorage.getItem("mh_token")` 直读；② `mh_token` cookie（`path=/`）随
同源 `fetch("/api/*")` 自动携带（ambient authority）；③ `?token=` query 可能进入
地址栏 / Referer / 日志。信任模型见 `16-pwa-offline/design.md`（"任何已发布站点
等于持有完整 hub 读写权限；源隔离列为未来工作"）。

## 本轮已做（缓解，不改变安全边界）

1. **受信边界提示**：发布确认框（PublicPublishForm）、私密链接表单、
   `mh site upload` / `mh site access public` 输出，都明示「站点脚本可以以你的
   身份读写整个工作区，只发布你信任的代码」。
2. **Referer/地址栏泄露**：全部 HTML 响应带 `Referrer-Policy: same-origin`
   （auth.ts `HTML_HEADERS` + `withShim` + sites-serve 文件响应）；`?token=`
   HTML 导航持久化 cookie 后 302 剥离 token（`tokenStripRedirect`）。
3. **cookie 只读化**：`/api/*` 的非 GET 请求拒绝 cookie 认证、必须显式携带
   Bearer/query token（`cookieMutationRejection`）。WebUI XHR 全走 Bearer；
   cookie 存在的理由（img、EventSource 等无法带 header 的子资源）全是 GET，
   不受影响。效果：站点脚本无法凭浏览器自动携带的 cookie 做写操作。

   两个必须一起成立的配套点（缺任一条都会变成「破坏合法会话但没堵住洞」）：
   - **`/sites/<name>/api/*` 同规则**：该前缀在 server.ts 的 token 豁免表上，
     由 `forwardApi` 在进程内直接派发，不会再过顶层闸门 → 规则必须在
     sites-serve.ts 里同样执行。cookie-only 的写不是错误：它落到公开
     grant 受限面（或 401），即「站点自己的权限」，而不是 owner 全权。
   - **cookie → localStorage 领养**：`?token=` 二维码登录的会话凭据只在
     cookie 里（服务端 302 剥离了 URL），而 XHR 只发 localStorage 里的
     Bearer。api.ts / runtime.ts 读 token 时领养 cookie，否则手机扫码进来
     的页面会静默变成只读。

## 明确不做（及理由）

- **子域源隔离**（`sites.example.com`）：localhost / 自托管场景没有泛域名与
  证书，成本结构性过高。列为后续专项；这是唯一能堵住 ①（localStorage 同源
  直读）的方案。
- **Referer 路径黑名单式 cookie 拒绝**：站点页一行
  `<meta name="referrer" content="no-referrer">` 即可绕过，纯装饰，不给虚假
  安全感。
- **改变 ① 的信任模型**：同源 localStorage 可读是既有显式声明的受信代码
  边界；本轮以提示文案 + 本记录重申，不宣称站点被沙箱化。
