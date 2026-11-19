import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, Linking, Modal, Platform, Pressable, Text } from "react-native";
import { useSessionCtx } from "@/lib/auth/session";
import { recoverMobileWorkspace } from "@/lib/replica/recovery";
import { dataVersionRange, knownDataVersion } from "../../../../src/core/sync/data-version";
import { storageUrl } from "../../../../src/core/sync/storage-url";
import { workspaceAccess } from "../../../../src/core/sync/workspace-access";

import { WorkspacePreparation } from "./WorkspacePreparation";
import type { PreparationMode } from "./workspace-preparation";
import type { RecoveryPhase } from "../../../../src/core/sync/recovery-v2";

export function SyncUpgradePrompt() {
  const { session, connect, openingBucket } = useSessionCtx();
  const offered = useRef(new Set<string>());
  const [attempt, retry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<RecoveryPhase | null>(null);
  const [mode, setMode] = useState<PreparationMode>("initializing");
  const working = useRef(false);
  const subscribe = useCallback((notify: () => void) => session?.sync.onStatus(notify) ?? (() => {}), [session]);
  const lastSync = useSyncExternalStore(subscribe, () => session?.sync.status.lastSyncAt ?? null);
  const version = session?.isCurrent() ? knownDataVersion(session.replica.db)?.dataVersion ?? 2 : 2;
  const bucket = session?.creds.bucket;
  const targetUrl = bucket ? storageUrl(bucket.endpoint, bucket.bucket, bucket.prefix) : session?.creds.baseUrl;
  const access = session?.isCurrent()
    ? workspaceAccess(session.replica.db).find(state => state.url === targetUrl)
    : undefined;
  // Only a replica awaiting its initial version check needs a blocking progress view.
  const pendingJoin = Boolean(session?.creds.bucket && session.isCurrent() &&
    session.replica.db.query("SELECT 1 FROM meta WHERE key='sync_version_pending_join' AND value=?").get(targetUrl!));
  const checking = openingBucket !== null || (pendingJoin && lastSync === null) ||
    (access?.kind === "initializing" && !error);
  const incompatible = version > dataVersionRange.maxSupportedDataVersion;
  const connectionError = error || (access?.kind === "error" ? access.reason : undefined);
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
    const kind = access?.kind;
    if (!kind || kind === "ready" || kind === "checking" || kind === "error" || working.current) return;
    const automatic = kind === "initializing";
    const title = kind === "rebuild" ? "更新本地副本" : "升级工作区同步";
    async function recover() {
      if (!session?.isCurrent() || working.current) return;
      setPhase(null);
      setMode(kind === "migration" || kind === "rebuild" ? kind : "initializing");
      working.current = true; setBusy(true); setError("");
      try {
        const result = await recoverMobileWorkspace(session, () => connect(session.creds), setPhase, undefined, automatic);
        if (result.pending) Alert.alert("本地副本已更新", `有 ${result.pending} 项编辑需要核对，可在设置中查看。`);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally { working.current = false; setBusy(false); }
    }
    if (automatic) { void recover(); return; }
    if (kind !== "migration" && kind !== "rebuild") return;
    const key = session.workspaceId;
    if (offered.current.has(key)) return;
    offered.current.add(key);
    Alert.alert(title, "应用会备份本机编辑并更新本地副本。期间请保持应用打开，编辑会短暂停用。", [
      {
        text: "稍后",
        style: "cancel",
        onPress: () => {
          setTimeout(() => {
            offered.current.delete(key);
            retry((n) => n + 1);
          }, 60_000);
        },
      },
      { text: title === "更新本地副本" ? "立即更新" : "立即升级", onPress: () => void recover() },
    ]);
  }, [session, connect, lastSync, access?.kind, attempt, incompatible, version, openUpdate, updateMessage]);
  if (incompatible && !openingBucket) return <Pressable accessibilityRole="button" onPress={openUpdate}><Text>{updateMessage} 更新应用</Text></Pressable>;
  return <>{connectionError && <Pressable accessibilityRole="button" onPress={() => { offered.current.clear(); setError(""); retry(n => n + 1); void session?.syncNow(); }}><Text>{connectionError} · 重试</Text></Pressable>}{(checking || busy) && <Modal animationType="none" presentationStyle="fullScreen" statusBarTranslucent onRequestClose={() => {}}>
    <WorkspacePreparation phase={checking && !busy ? null : phase} bucket={openingBucket ?? session?.creds.bucket?.bucket} mode={checking && !busy ? "initializing" : mode} />
  </Modal>}</>;
}
