# iOS 首次存储桶同步超时修复

2026-11-04，Asia/Shanghai。基线 `feat/mobile` / `331e58b`，原安装包为 `fa82bf0` 普通 Release。用户授权接入现有加密存储桶后，密码验证与连接保存成功，但首次同步反复报 `sync request aborted`，本地内容为空。

## 根因与证据

只读核对发现移动端自身 4 条初始化变更已上传，push cursor 为 4；首次下载尚未完成。使用已配置的本机客户端只读下载同一快照，HTTP 200，密文 1,407,396 bytes，下载约 233ms；解密解压后约 9.85MB、44,695 条变更。没有输出凭据、对象键或正文。

`syncWithStorage` 对整个 `decodeSegment` 设置 30 秒预算，而移动端使用 `ingestBatchSize: 25`，解析每 25 条就 `setTimeout(0)` 让出线程，一份快照需要约 1,787 次调度。带临时阶段标记的原生包在设置页复现：

```
Storage decode (parse 44150): sync request aborted
```

因此已确认中断发生于快照解析，且已接近完成；不是密码错误、桶不可达或本地写库失败。整份解码超时后没有任何这份快照的变更进入 ingest，重试再次从头解析。

## 修复

`src/core/sync/storage.ts`：

- 移除包裹整份快照解析的统一 30 秒截止时间。
- 下载请求预算保持原样；解密、解压分别保留 30 秒预算与父级取消信号。
- JSONL 解析按批检查取消信号，但仅在累计工作时间达到 8ms 时才让出线程，减少大量小批次的调度等待。
- 解析循环有限且每批前进；工作区切换仍可取消，写入事务不跨 await。
- 临时诊断阶段代码已移除。

## 验证

新增 `storage.test.ts` 回归以缩短的请求预算、模拟慢原生 timer 和强制时间切片，验证大型快照可以持续解析，并验证取消时尚未写入文档。该测试在修复前代码上失败（`sync request timed out`），恢复修复后通过。

- `bun test src/core/sync/storage.test.ts`：27 pass，0 fail。
- 移动端 typecheck、lint 通过；`git diff --check` 通过。
- 两次全仓 `bun test`：2,009 pass、3 skip、1 fail。唯一失败均为 `drop-wire.test.ts` 的 `wire: knobs` 测试在 5 秒超时；该测试单独运行 9 pass、0 fail。它使用默认 Turnstile 校验路径，本次没有修改这部分代码，不能把全仓结果报告为全绿。

同一 iOS 27.0 / iPhone 18 Pro 模拟器、同一已保存连接，在修复包中完成初始化与增量追赶，设置页显示：

- 本地保存：本地副本可离线编辑。
- 数据同步：数据同步完成。
- 附件传输：待上传 0 项，附件异常 0 项。

只读 SQLite 复核 `replica_sync_state.hydrated = 1`；原始表行数为 documents 309、records 123、databases 9（包括表内可能保留的 tombstone，不等价于 UI 有效对象数量）。未编辑用户正文、记录或桶密钥；应用正常同步会登记设备初始化变更。

## 安装包与边界

为快速定位，复用 `fa82bf0` 的原生二进制，使用当前源码及修复，通过 Expo `export:embed --dev false --bytecode` 重新生成 Hermes bundle，重新 adhoc 签名并保留数据安装。依赖与同步相关原生配置没有变化。这是本地验证包，不是重新执行完整 CNG/Xcode 构建的正式候选，不扩大 Android、真机、附件全量下载或性能验收范围。

本地验证包：`/tmp/metahub-sync-diagnosis-20261104/Metahub.app`。模拟器：`Metahub Preview`，`89211314-4AB1-4E35-8A34-28A8A238AF96`。

日志：`/tmp/metahub-sync-regression.log`、`/tmp/metahub-sync-before-fix-regression.log`、`/tmp/metahub-sync-full-tests-final-20261104.log`、`/tmp/metahub-sync-drop-wire-recheck.log`。日志与验证包在临时目录，未提交。后续正式候选仍需重新构建并复核。
