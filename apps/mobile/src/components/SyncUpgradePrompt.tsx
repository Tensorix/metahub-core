import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, Modal, Text, View } from "react-native";
import { useSessionCtx } from "@/lib/auth/session";
import { recoverMobileWorkspace } from "@/lib/replica/recovery";
import { storageUrl } from "../../../../src/core/sync/storage-url";
import { needsBucketUpgrade } from "../../../../src/core/sync/retention-protocol";

export function SyncUpgradePrompt() {
  const { session, connect } = useSessionCtx();
  const offered = useRef(new Set<string>());
  const [attempt, retry] = useState(0);
  const [busy, setBusy] = useState(false);
  const subscribe = useCallback((notify: () => void) => session?.sync.onStatus(notify) ?? (() => {}), [session]);
  const lastSync = useSyncExternalStore(subscribe, () => session?.sync.status.lastSyncAt ?? null);
  useEffect(() => {
    if (!session?.creds.bucket || !session.isCurrent()) return;
    const bucket = session.creds.bucket;
    if (!needsBucketUpgrade(session.replica.db, storageUrl(bucket.endpoint, bucket.bucket, bucket.prefix))) return;
    const key = session.workspaceId;
    if (offered.current.has(key)) return;
    offered.current.add(key);
    Alert.alert("升级工作区同步", "应用会备份本机编辑并更新同步格式。升级期间请保持应用打开，编辑会短暂停用。", [
      { text: "稍后", style: "cancel" },
      { text: "立即升级", onPress: async () => {
        if (!session.isCurrent()) return;
        setBusy(true);
        try {
          const result = await recoverMobileWorkspace(session, () => connect(session.creds), () => {});
          if (result.pending) Alert.alert("同步已升级", `有 ${result.pending} 项编辑需要核对，可在设置的“同步升级与编辑恢复”中查看。`);
        } catch (error) {
          Alert.alert("升级未完成", error instanceof Error ? error.message : String(error), [
            { text: "稍后", style: "cancel" },
            { text: "重新打开升级提示", onPress: () => { offered.current.delete(key); retry(n => n + 1); } },
          ]);
        } finally { setBusy(false); }
      } },
    ]);
  }, [session, connect, lastSync, attempt]);
  return <Modal visible={busy} transparent animationType="fade" onRequestClose={() => {}}>
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0009", gap: 12 }}>
      <ActivityIndicator color="white" />
      <Text style={{ color: "white" }}>正在备份编辑并升级同步…</Text>
    </View>
  </Modal>;
}
