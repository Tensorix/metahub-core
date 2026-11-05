import { approveRetentionReport } from "../../../../src/core/sync/v2-maintenance";
import { useState } from "react";
import { Stack } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { ScrollView } from "react-native";
import { Button, Column, FieldGroup, Text } from "@expo/ui";
import { NativeHost } from "@/components/native/NativeHost";
import { useSession, useSessionCtx } from "@/lib/auth/session";
import { recoverMobileWorkspace } from "@/lib/replica/recovery";
import { readReplicaGeneration } from "../../../../src/core/sync/retention-protocol";
import { recoveryItems, resolveRecoveryItem, type RecoveryPhase } from "../../../../src/core/sync/recovery-v2";
import { inspectRetention, type RetentionReport } from "../../../../src/core/sync/retention-executor";
import { storageClientFor } from "../../../../src/core/sync/storage";

const phases: Record<RecoveryPhase, string> = {
  saving: "正在保存本地编辑", protecting: "正在校验保护副本和附件", downloading: "正在下载当前内容",
  verifying: "正在检查待恢复编辑", swapping: "正在更新本地副本", pending: "本地副本已更新",
};
export default function SyncRecoveryScreen() {
  const session = useSession(), { connect } = useSessionCtx();
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<string | null>(null);
  const [revision, setRevision] = useState(0), [report, setReport] = useState<RetentionReport | null>(null);
  const [page, setPage] = useState(0);
  const generation = readReplicaGeneration(session.replica.db);
  const items = recoveryItems(session.replica.db);
  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setMessage(null);
    try { await fn(); setRevision(revision + 1); }
    catch (error) { setMessage(error instanceof Error ? error.message : "操作未完成，原数据和恢复包均已保留"); }
    finally { setBusy(false); }
  };
  return <SafeAreaView style={{ flex: 1 }} edges={["bottom"]}>
    <Stack.Screen options={{ title: "同步与恢复", gestureEnabled: !busy, headerBackVisible: !busy }} />
    <ScrollView><NativeHost matchContents><FieldGroup>
      <FieldGroup.Section title="本地副本">
        <Text>{generation ? "已使用新版同步" : "可升级同步格式"}</Text>
        <Text>升级或重新下载前，先保全本地数据库、草稿和未上传附件。尚未处理的恢复包不会自动过期。</Text>
        <Button label={busy ? "正在处理…" : generation ? "保全编辑并重新下载" : "升级同步格式"}
          disabled={busy || !session.creds.bucket} onPress={() => void act(async () => {
            const result = await recoverMobileWorkspace(session, () => connect(session.creds), value => setMessage(phases[value]));
            setMessage(result.pending ? `有 ${result.pending} 项编辑待恢复` : "本地副本已更新；等待云端同步确认");
          })} />
        {message && <Text>{message}</Text>}
      </FieldGroup.Section>
      <FieldGroup.Section title={`待恢复编辑 · ${items.length}`}>
        {!items.length && <Text>没有待处理的恢复事项</Text>}
        {items.slice(page * 10, page * 10 + 10).map(item => {
          const local = JSON.parse(item.local), remote = item.remote ? JSON.parse(item.remote) : null;
          return <Column key={item.id}>
            <Text>{local.title ?? item.target}</Text>
            <Text>{`本地内容：${local.body ?? JSON.stringify(local)}`}</Text>
            <Text>{`云端内容：${remote?.body ?? (remote ? JSON.stringify(remote) : "原位置已删除或没有共同基线")}`}</Text>
            <Button label="创建恢复副本" disabled={busy} onPress={() => void act(async () => {
              resolveRecoveryItem(session.replica.db, item.id, "copy"); session.sync.requestSync();
            })} />
            <Button label="丢弃此项本地编辑" disabled={busy} onPress={() => void act(async () => {
              resolveRecoveryItem(session.replica.db, item.id, "discard");
            })} />
          </Column>;
        })}
        {page > 0 && <Button label="上一页" onPress={() => setPage(page - 1)} />}
        {(page + 1) * 10 < items.length && <Button label="下一页" onPress={() => setPage(page + 1)} />}
      </FieldGroup.Section>
      <FieldGroup.Section title="存储回收预览">
        <Text>删除保护期 30 天，历史保留 90 天。当前有效内容不按年龄回收。</Text>
        <Button label="检查可回收内容" disabled={busy || !generation} onPress={() => void act(async () => {
          const config = session.creds.bucket!;
          setReport(await inspectRetention(session.replica.db, storageClientFor(config), config));
        })} />
        {report && <Text>{`${report.candidates.length} 个候选块；当前 ${report.currentFields} 个字段，预计保留 ${report.projectedFields} 个字段。${report.reason ?? "条件满足，等待回收报告审阅"}`}</Text>}
        {report && <Button label="已核对报告，启用此工作区的定期回收" disabled={busy} onPress={() => void act(async () => {
          approveRetentionReport(session.replica.db, report); session.sync.requestSync();
          setMessage("已启用定期回收；仍会等待同步、设备封口和保护期满足后执行");
        })} />}
      </FieldGroup.Section>
    </FieldGroup></NativeHost></ScrollView>
  </SafeAreaView>;
}
