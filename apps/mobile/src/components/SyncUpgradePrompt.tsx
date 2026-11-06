import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, Linking, Modal, Platform, Pressable, Text, View } from "react-native";
import { useSessionCtx } from "@/lib/auth/session";
import { recoverMobileWorkspace } from "@/lib/replica/recovery";
import { dataVersionRange, knownDataVersion } from "../../../../src/core/sync/data-version";
import { storageUrl } from "../../../../src/core/sync/storage-url";
import { workspaceAccess } from "../../../../src/core/sync/workspace-access";

export function SyncUpgradePrompt() {
  const { session, connect } = useSessionCtx();
  const offered = useRef(new Set<string>());
  const [attempt, retry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const working = useRef(false);
  const subscribe = useCallback((notify: () => void) => session?.sync.onStatus(notify) ?? (() => {}), [session]);
  const lastSync = useSyncExternalStore(subscribe, () => session?.sync.status.lastSyncAt ?? null);
  const version = session?.isCurrent() ? knownDataVersion(session.replica.db)?.dataVersion ?? 2 : 2;
  const incompatible = version > dataVersionRange.maxSupportedDataVersion;
  const connectionError = error || (session?.isCurrent() ? workspaceAccess(session.replica.db).find(state => state.kind === "error")?.reason : undefined);
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
    const bucket = session.creds.bucket;
    const url = bucket ? storageUrl(bucket.endpoint, bucket.bucket, bucket.prefix) : session.creds.baseUrl;
    const access = workspaceAccess(session.replica.db).find(state => state.url === url);
    if (!access || access.kind === "ready" || access.kind === "checking" || working.current) return;
    if (access.kind === "error") return;
    const automatic = access.kind === "initializing";
    const title = access.kind === "rebuild" ? "更新本地副本" : "升级工作区同步";
    async function recover() {
      if (!session?.isCurrent() || working.current) return;
      working.current = true; setBusy(true); setError("");
      try {
        const result = await recoverMobileWorkspace(session, () => connect(session.creds), () => {}, undefined, automatic);
        if (result.pending) Alert.alert("本地副本已更新", `有 ${result.pending} 项编辑需要核对，可在设置中查看。`);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally { working.current = false; setBusy(false); }
    }
    if (automatic) { void recover(); return; }
    if (access.kind !== "migration" && access.kind !== "rebuild") return;
    const key = session.workspaceId;
    if (offered.current.has(key)) return;
    offered.current.add(key);
    Alert.alert(title, "应用会备份本机编辑并更新本地副本。期间请保持应用打开，编辑会短暂停用。", [
      { text: "稍后", style: "cancel" },
      { text: title === "更新本地副本" ? "立即更新" : "立即升级", onPress: () => void recover() },
    ]);
  }, [session, connect, lastSync, attempt, incompatible, version, openUpdate, updateMessage]);
  if (incompatible) return <Pressable accessibilityRole="button" onPress={openUpdate}><Text>{updateMessage} 更新应用</Text></Pressable>;
  return <>{connectionError && <Pressable accessibilityRole="button" onPress={() => { offered.current.clear(); setError(""); retry(n => n + 1); void session?.syncNow(); }}><Text>{connectionError} · 重试</Text></Pressable>}<Modal visible={busy} transparent animationType="fade" onRequestClose={() => {}}>
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0009", gap: 12 }}>
      <ActivityIndicator color="white" />
      <Text style={{ color: "white" }}>正在连接工作区并校验本地数据…</Text>
    </View>
  </Modal></>;
}
