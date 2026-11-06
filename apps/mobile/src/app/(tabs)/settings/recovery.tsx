import { approveRetentionReport } from "../../../../../../src/core/sync/v2-maintenance";
import { useState } from "react";
import { Stack } from "expo-router";
import { SettingsForm } from "@/components/settings/SettingsForm";
import { Button, Column, FieldGroup, Text } from "@expo/ui";
import { NativeHost } from "@/components/native/NativeHost";
import { useSession } from "@/lib/auth/session";
import { readReplicaGeneration } from "../../../../../../src/core/sync/retention-protocol";
import { recoveryItems, resolveRecoveryItem } from "../../../../../../src/core/sync/recovery-v2";
import { inspectRetention, type RetentionReport } from "../../../../../../src/core/sync/retention-executor";
import { storageClientFor } from "../../../../../../src/core/sync/storage";

export default function SyncRecoveryScreen() {
  const session = useSession();
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
  return <>
    <Stack.Screen options={{ title: "同步与恢复", gestureEnabled: !busy, headerBackVisible: !busy }} />
    <NativeHost style={{ flex: 1 }}><SettingsForm>
      <FieldGroup.Section title="本地副本">
        <Text>{generation ? "已使用新版同步" : "可升级同步格式"}</Text>
        {message && <Text>{message}</Text>}
      </FieldGroup.Section>
      <FieldGroup.Section title={`待恢复编辑 · ${items.length}`}>
        {!items.length && <Text>没有待处理的恢复事项</Text>}
        {items.slice(page * 10, page * 10 + 10).map(item => {
          const local = JSON.parse(item.local), remote = item.remote ? JSON.parse(item.remote) : null;
          return <Column key={item.id}>
            <Text>{local.title ?? item.target}</Text>
            <Text>{`待恢复内容：${local.body ?? JSON.stringify(local)}`}</Text>
            <Text>{`另一份内容：${remote?.body ?? (remote ? JSON.stringify(remote) : "原位置已删除或没有共同基线")}`}</Text>
            <Button label="创建恢复副本" disabled={busy} onPress={() => void act(async () => {
              resolveRecoveryItem(session.replica.db, item.id, "copy"); session.sync.requestSync();
            })} />
            <Button label="丢弃此项编辑" disabled={busy} onPress={() => void act(async () => {
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
    </SettingsForm></NativeHost>
  </>;
}
