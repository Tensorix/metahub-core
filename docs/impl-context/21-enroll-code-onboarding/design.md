# 接入码统一接入(CLI 免服务器接入 + 前端「添加设备」收敛)

承接 [17-s3-storage-sync](../17-s3-storage-sync/design.md)(S3 哑存储同步)、[18-no-origin-shell](../18-no-origin-shell/design.md)(手机扫码接入)、[19-client-topology](../19-client-topology/design.md)(客户端拓扑 + 发布者 + 统一同步页)。

本文把 18 的"手机扫码"升级为一份**与传输无关的接入码(enroll code)**:同一份码既能生成二维码给手机扫,也能复制成一条命令给 CLI 跑、或复制裸码在 `mh config` 向导里粘。并据此把前端散落的四个"加设备"入口收敛成**单一「添加设备」弹窗**。

> 性质:决策依据 + 实现记录。**已落地**(feat/syncv2):`bun test` 351 全过、tsc 维持基线(11 既有错,均 `dist/*` 产物缺失 + `index.ts` citty 泛型)、CLI `--enroll` 冒烟过(临时 `METAHUB_HOME`,有效码→首次同步网络层、坏码→`invalid_input`)。仍待真桶(R2/COS)端到端 + 真浏览器三 tab e2e。

---

## 1. 背景:不对等 + 入口发散

- **CLI 不对等**:18 让手机扫码即接入,但 CLI 仍要手敲 `--endpoint/--bucket/--access-key/--secret-key/--passphrase` 5~6 个参数;flag 路径连 `virtualHostedStyle`(腾讯 COS 必需)都传不了。其实 `mh config peer add --s3` 早已直连 `addAndSyncStoragePeer`(provision→持久化→首次同步),**本就免服务器**——缺的只是"把凭据一次性带过来"的对等体验。
- **入口发散**:加一台设备在前端有四个面板——桶行「在手机上打开」(enroll QR)、服务器区「添加设备」(HTTP 实时配对)、「生成配对码」、服务器登录 QR(`?token=`)。机制不同、措辞重叠,用户难分。

## 2. 关键决策

### D1 · 接入码 = 单一来源,与传输无关
- 新增 `core/sync/enroll.ts`:`encodeEnroll/decodeEnroll`,**同构**(只用 `btoa/atob`+`TextEncoder`,Bun 与浏览器都有;与 18 旧式 `escape/unescape` base64url **逐字节相同**——旧二维码仍可解)。
- payload = `S3Config` 的**访问子集**:endpoint/region/bucket/prefix/accessKeyId/secretAccessKey/encrypt/virtualHostedStyle。**永不含**口令/主钥(机密性靠口令)。
- `decodeEnroll` 兼容三种粘贴形态:裸 token、`enroll=…` 片段、整条 `#enroll=` 深链;缺字段/坏码抛 `MhError("invalid_input")`(CLI 退出码 2)。
- 一份码三种载体:二维码(手机)/ `mh config peer add --s3 --enroll <code>`(CLI)/ 复制裸码(向导粘贴)。18 的 `enrollUrl`(settings)与 `readEnrollConfig`(app)改为复用本模块,去重。

### D2 · CLI 并入 `mh config`,不新增顶层命令
与既有约定一致(server/sync 设置都在一个 `mh config`,既交互又 `--flag` 驱动)。
- **一行**:`mh config peer add --s3 --enroll <code> [--passphrase <pw>]`。显式 flag 覆盖解码值;口令单独输入(码不含口令)。
- **交互**:`mh config` 向导 → 同步设备 → 「粘贴接入码加入存储」:粘码 → 遮罩输口令 → 接入。
- **角色定位**:经 `--enroll` 接入的是**次级设备**(`publish:true, priority:10`,对齐手机副本 db-worker);手敲全参仍是**数据家**(`priority:100`)。发布者选举(19 §5)据此分级。
- **透传 `virtualHostedStyle`**:`StoragePeerSpec` 补该字段并在 `addAndSyncStoragePeer` 落到 `S3Config`,COS 接入码才正确(原 spec 漏了)。
- 复用 `addAndSyncStoragePeer` 的 fail-fast(首次同步失败回滚),CLI/WebUI 共路径不变。

### D3 · 前端收敛为单一「添加设备」弹窗
顶层只留一个「添加设备」(在「同步 → 在所有设备间同步」,与「连接存储桶」「立即同步」并列),打开三 tab 弹窗 `AddDeviceModal`:
- **手机扫码**:二维码 + 复制链接(壳域名可配 `mh_shell_base`)。
- **电脑 / 命令行**:复制 `mh config peer add --s3 --enroll <code>` 命令 + 复制接入码。
- **高级:服务器配对**(仅 origin):合并原 HTTP 配对——生成本机配对码、输入对方配对码、服务器登录 QR。
- 取桶配置 `getConfig`:`noOrigin ? replica(storagePeerConfig) : api.serverS3Config`(数据家持密钥;no-origin 时副本即家)。多桶时弹窗内选桶。
- **删除**:`QrModal`/`OriginQrModal`/`AddPeerModal`/`PairingCodeModal` 四个旧弹窗、桶行「在手机上打开」按钮;「同步设备」区降为已配对设备**列表**(新增引导到统一入口)。

### D4 · 安全边界(沿用 18)
接入码含桶访问密钥、**不含**加密口令/主钥;在前端放 URL fragment(不上送服务器/CDN 日志);弹窗统一 ⚠ 文案:"含桶访问密钥勿公开分享;不含口令,新设备需另输"。

## 3. 涉及文件
- 新增:`core/sync/enroll.ts`、`core/sync/enroll.test.ts`。
- 改 core:`sync/peers.ts`(`StoragePeerSpec.virtualHostedStyle` + 透传)。
- 改 CLI:`cli/commands/config.ts`(`--enroll` flag + `pick()` 合并 + priority 分级 + 向导「粘贴接入码加入存储」)。
- 改 WebUI:`webui/settings.tsx`(统一 `AddDeviceModal` + 子组件 `PhoneEnroll/CliEnroll/ServerPairing/PairCodeView` + 按钮/图标)、`webui/app.tsx`(`readEnrollConfig` 改用 `decodeEnroll`)、`webui/styles.css`(`.add-tabs/.add-tab/.enroll-cmd/.enroll-section/.enroll-sep`)。

## 4. 验证
- `bun test` 351 通过(含 `enroll.test.ts`:round-trip / 三种粘贴形态 / 旧码字节兼容 / 缺字段·坏码抛错);tsc 改动文件零新增错误。
- CLI 冒烟(临时 `METAHUB_HOME`,不碰真实 `~/.metahub`):有效码 → 解码正确 → 首次同步走到网络层(坏 endpoint→`network`/exit 7);坏码 → `invalid_input`/exit 2。
- **待手测**:真 R2/COS 下"WebUI 复制命令 → 另一机 `--enroll` 接入 `pulled>0`";向导粘码路径;手机扫**旧式**二维码仍可接入(印证字节兼容);三 tab 在 origin/no-origin 条件显示正确。WebUI 改动:dev 从源构建刷新即热重建,dist 编译版需重建 + 重启。
