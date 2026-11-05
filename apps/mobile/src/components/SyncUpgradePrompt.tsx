import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, Linking, Modal, Platform, Pressable, Text, View } from "react-native";
import { useSessionCtx } from "@/lib/auth/session";
import { recoverMobileWorkspace } from "@/lib/replica/recovery";
import { dataVersionRange, knownDataVersion } from "../../../../src/core/sync/data-version";
import { storageUrl } from "../../../../src/core/sync/storage-url";
import { needsBucketUpgrade } from "../../../../src/core/sync/retention-protocol";

export function SyncUpgradePrompt() {
  const { session, connect } = useSessionCtx();
  const offered = useRef(new Set<string>());
  const [attempt, retry] = useState(0);
  const [busy, setBusy] = useState(false);
  const subscribe = useCallback((notify: () => void) => session?.sync.onStatus(notify) ?? (() => {}), [session]);
  const lastSync = useSyncExternalStore(subscribe, () => session?.sync.status.lastSyncAt ?? null);
  const version = session?.isCurrent() ? knownDataVersion(session.replica.db)?.dataVersion ?? 2 : 2;
  const incompatible = version > dataVersionRange.maxSupportedDataVersion;
  const updateMessage = `工作区数据版本为 ${version}，本客户端最高支持 ${dataVersionRange.maxSupportedDataVersion}。本地内容可查看和导出。`;
  const openUpdate = useCallback(() => {
    const url = Platform.OS === "ios" ? process.env.EXPO_PUBLIC_IOS_UPDATE_URL : process.env.EXPO_PUBLIC_ANDROID_UPDATE_URL;
    if (url?.startsWith("https://")) void Linking.openURL(url).catch(() => Alert.alert("更新应用", "请从原安装渠道获取新版客户端。"));
    else Alert.alert("更新应用", "请从原安装渠道获取新版客户端。此工作区将保持只读。");
  }, []);
  useEffect(() => {
    if (!session?.isCurrent()) return;
    if (incompatible) {
      const key = `${session.workspaceId}:update:${version}`;
      if (offered.current.has(key)) return;
      offered.current.add(key);
      Alert.alert("需要更新客户端", updateMessage, [{ text: "只读查看" }, { text: "更新应用", onPress: openUpdate }]);
      return;
    }
    if (!session.creds.bucket) return;
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
  }, [session, connect, lastSync, attempt, incompatible, version, openUpdate, updateMessage]);
  if (incompatible) return <Pressable accessibilityRole="button" onPress={openUpdate}><Text>{updateMessage} 更新应用</Text></Pressable>;
  return <Modal visible={busy} transparent animationType="fade" onRequestClose={() => {}}>
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0009", gap: 12 }}>
      <ActivityIndicator color="white" />
      <Text style={{ color: "white" }}>正在备份编辑并升级同步…</Text>
    </View>
  </Modal>;
}
