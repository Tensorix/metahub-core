import { NativeDataText } from "@/components/native/NativeDataText";
import {
  Button,
  Column,
  FieldGroup,
  ListItem,
  Picker,
  RNHostView,
  Switch,
  Text,
} from "@expo/ui";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Alert, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { BucketForm } from "@/components/BucketForm";
import { ServerForm } from "@/components/ServerForm";
import { NativeHost } from "@/components/native/NativeHost";
import { useApiData } from "@/lib/api/hooks";
import { listServers } from "@/lib/auth/credentials";
import { useSession, useSessionCtx } from "@/lib/auth/session";
import { useTheme, type ThemePref } from "@/lib/theme";

const PAGE_SIZE = 12;
const STATES = {
  queued: "等待上传",
  checking: "正在校验",
  uploading: "正在上传",
  downloading: "正在下载",
  ready: "已缓存",
  error: "需要处理",
};
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export default function SettingsScreen() {
  const router = useRouter();
  const { creds, api, sync, authInvalid, syncNow, attachments } = useSession();
  const {
    disconnect,
    switchServer,
    connect,
    error: sessionError,
  } = useSessionCtx();
  const {
    tokens,
    pref,
    setPref,
    dynamicAvailable,
    materialYou,
    setMaterialYou,
  } = useTheme();
  const [syncState, setSyncState] = useState(sync.status);
  const [files, setFiles] = useState(() => attachments.status());
  const [usage, setUsage] = useState(() => attachments.usage());
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  useEffect(() => sync.onStatus(setSyncState), [sync]);
  useEffect(() => {
    const refresh = () => {
      setFiles(attachments.status());
      setUsage(attachments.usage());
    };
    refresh();
    return attachments.subscribe(refresh);
  }, [attachments]);
  const fetchVersion = useCallback(() => api.version(), [api]);
  const { data: version, error: versionError } = useApiData(fetchVersion);
  const fetchServers = useCallback(() => listServers(), []);
  const { data: servers, refetch: refetchServers } = useApiData(fetchServers);
  useFocusEffect(
    useCallback(() => {
      void refetchServers();
    }, [refetchServers]),
  );

  const run = async (action: () => Promise<unknown> | unknown) => {
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      await action();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "操作失败，请重试");
    } finally {
      setBusy(false);
    }
  };
  const retry = () =>
    run(async () => {
      const report = await attachments.retryPending();
      setFeedback(
        report.failed || report.pending
          ? `附件上传 ${report.uploaded} 项，失败 ${report.failed} 项，仍有 ${report.pending} 项待上传。请查看下方原因。`
          : `附件上传完成（${report.uploaded} 项）`,
      );
    });
  const confirmDisconnect = () =>
    Alert.alert(
      "断开连接",
      "移除连接并切换其他工作区。本地数据库和未同步内容会保留，重新连接相同地址可继续使用。",
      [
        { text: "取消", style: "cancel" },
        {
          text: "断开",
          style: "destructive",
          onPress: () => void run(disconnect),
        },
      ],
    );
  const clear = () =>
    Alert.alert(
      "清理已下载附件",
      "只移除未固定的已下载副本。待上传附件与固定的离线附件会保留；清理后需联网重新下载。",
      [
        { text: "取消", style: "cancel" },
        {
          text: "清理",
          onPress: () => void run(() => attachments.clearDownloaded()),
        },
      ],
    );
  // Put failures first, then pending uploads and fixed offline copies. Bound native rows.
  const ordered = [...files].sort(
    (a, b) =>
      Number(b.state === "error") - Number(a.state === "error") ||
      b.pending - a.pending ||
      b.pinned - a.pinned,
  );
  const lastPage = Math.max(0, Math.ceil(ordered.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const visible = ordered.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE,
  );
  const failures = files.filter((file) => file.state === "error").length;
  const syncing = syncState.syncing;
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: tokens.bg }}
      edges={["top"]}
    >
      <Stack.Screen options={{ title: "设置" }} />
      <NativeHost style={{ flex: 1 }}>
        <FieldGroup>
          <FieldGroup.Section title="本地与同步">
            {creds.bucket && <Button label="同步升级与编辑恢复" onPress={() => router.push("./sync-recovery")} />}
            <ListItem
              supportingText={
                syncState.hydrationReady
                  ? "本地副本可离线编辑"
                  : "正在初始化本地副本，请保持应用打开"
              }
            >
              本地保存
            </ListItem>
            <ListItem
              supportingText={
                syncState.error ||
                sessionError ||
                (syncing
                  ? "正在同步数据…"
                  : syncState.pendingPush
                    ? `${syncState.pendingPush} 项数据等待同步`
                    : syncState.hydrationReady
                      ? "数据同步完成"
                      : "等待首次下载")
              }
            >
              数据同步
            </ListItem>
            <ListItem
              supportingText={`待上传 ${usage.pending} 项 · 附件异常 ${failures} 项`}
            >
              附件传输
            </ListItem>
            {syncState.lastSuccessAt ? (
              <NativeDataText textStyle={{ color: tokens.muted }}>
                上次数据同步：
                {new Date(syncState.lastSuccessAt).toLocaleString()}
              </NativeDataText>
            ) : null}
            <Button
              disabled={busy || syncing}
              label={syncing ? "正在同步数据…" : "立即同步数据"}
              onPress={() => void run(syncNow)}
            />
            <Button
              disabled={busy}
              variant="text"
              label="重试全部待上传"
              onPress={() => void retry()}
            />
            {feedback ? (
              <NativeDataText textStyle={{ color: tokens.danger }}>
                {feedback}
              </NativeDataText>
            ) : null}
          </FieldGroup.Section>
          <FieldGroup.Section title="工作区">
            <Picker
              selectedValue={creds.baseUrl}
              enabled={!busy}
              onValueChange={(value) => {
                if (value !== creds.baseUrl)
                  void run(() => switchServer(value));
              }}
            >
              {(servers ?? [creds]).map((server) => (
                <Picker.Item
                  key={server.baseUrl}
                  value={server.baseUrl}
                  label={server.bucket?.bucket ?? server.baseUrl}
                />
              ))}
            </Picker>
            <Button
              disabled={busy}
              variant="text"
              label="添加服务器或存储桶"
              onPress={() => router.push("/add-server")}
            />
            <ListItem
              supportingText={
                version?.version ?? (versionError ? "获取失败" : "正在读取…")
              }
            >
              服务端版本
            </ListItem>
            <Button
              disabled={busy}
              variant="text"
              label={reconnecting ? "关闭凭据表单" : "更新连接凭据"}
              onPress={() => {
                if (reconnecting)
                  Alert.alert("关闭凭据表单？", "尚未保存的输入会被丢弃。", [
                    { text: "继续填写", style: "cancel" },
                    {
                      text: "关闭",
                      style: "destructive",
                      onPress: () => setReconnecting(false),
                    },
                  ]);
                else setReconnecting(true);
              }}
            />
            {authInvalid ? (
              <Text textStyle={{ color: tokens.danger }}>
                连接凭据已失效，请重新验证。本地内容已保留。
              </Text>
            ) : null}
            {authInvalid || reconnecting ? (
              <RNHostView matchContents={{ vertical: true }}>
                <View>
                  {creds.bucket ? (
                    <BucketForm
                      onVerified={async (value) => {
                        await connect(value);
                        setReconnecting(false);
                      }}
                    />
                  ) : (
                    <ServerForm
                      initialUrl={creds.baseUrl}
                      submitLabel="重新连接"
                      onVerified={async (value) => {
                        await connect(value);
                        setReconnecting(false);
                      }}
                    />
                  )}
                </View>
              </RNHostView>
            ) : null}
            <Button
              disabled={busy}
              variant="text"
              label="断开连接"
              onPress={confirmDisconnect}
            />
          </FieldGroup.Section>
          <FieldGroup.Section title="离线附件">
            <Text>{`${usage.count} 个文件 · ${mb(usage.bytes)}`}</Text>
            {usage.orphanCount > 0 ? (
              <NativeDataText textStyle={{ color: tokens.muted }}>
                另外保留 {usage.orphanCount} 个待核查文件（
                {mb(usage.orphanBytes)}），以保护可能尚未恢复的内容。
              </NativeDataText>
            ) : null}
            <Button
              disabled={busy}
              label="清理未固定的下载副本"
              variant="text"
              onPress={clear}
            />
            {!visible.length ? (
              <Text textStyle={{ color: tokens.muted }}>
                还没有离线附件。在文档中打开或固定附件后会显示在这里。
              </Text>
            ) : null}
            {visible.map((file) => (
              <Column key={file.src} spacing={6}>
                <NativeDataText
                  textStyle={{ fontWeight: "600", color: tokens.fg }}
                >
                  {file.name || file.src}
                </NativeDataText>
                <Text
                  textStyle={{ color: tokens.muted }}
                >{`${STATES[file.state]} · ${mb(file.size)}${file.pinned ? " · 已固定" : ""}${["uploading", "downloading"].includes(file.state) && file.total > 0 ? ` · ${Math.min(100, Math.round((file.transferred / file.total) * 100))}%` : ""}`}</Text>
                {file.error ? (
                  <NativeDataText textStyle={{ color: tokens.danger }}>
                    {file.error}
                  </NativeDataText>
                ) : null}
                {file.pending ? (
                  <>
                    <Button
                      disabled={busy}
                      variant="text"
                      label="重试全部待上传"
                      onPress={() => void retry()}
                    />
                    <Button
                      disabled={busy}
                      variant="text"
                      label="重新选择原文件修复"
                      onPress={() =>
                        void run(async () => {
                          const result = await attachments.repairPending(
                            file.src,
                          );
                          if (result.src) {
                            const report = await attachments.retryPending();
                            setFeedback(
                              report.pending
                                ? `仍有 ${report.pending} 项附件待上传，请查看原因`
                                : "附件已修复并上传",
                            );
                          }
                        })
                      }
                    />
                  </>
                ) : file.state === "error" ? (
                  <Button
                    disabled={busy}
                    variant="text"
                    label="重试下载"
                    onPress={() => void run(() => attachments.cache(file.src))}
                  />
                ) : null}
                {!file.pending && file.pinned ? (
                  <Button
                    disabled={busy}
                    variant="text"
                    label="取消离线固定"
                    onPress={() =>
                      void run(() => attachments.unpinDownloaded(file.src))
                    }
                  />
                ) : null}
              </Column>
            ))}
            {lastPage > 0 ? (
              <Column spacing={6}>
                <Text>{`第 ${currentPage + 1} / ${lastPage + 1} 页`}</Text>
                <Button
                  label="上一页"
                  variant="text"
                  disabled={currentPage === 0}
                  onPress={() => setPage(currentPage - 1)}
                />
                <Button
                  label="下一页"
                  variant="text"
                  disabled={currentPage === lastPage}
                  onPress={() => setPage(currentPage + 1)}
                />
              </Column>
            ) : null}
          </FieldGroup.Section>
          <FieldGroup.Section title="外观">
            <Picker
              selectedValue={pref}
              onValueChange={(value: ThemePref) => setPref(value)}
            >
              <Picker.Item value="system" label="跟随系统" />
              <Picker.Item value="light" label="浅色" />
              <Picker.Item value="dark" label="深色" />
            </Picker>
            {dynamicAvailable ? (
              <Switch
                value={materialYou}
                onValueChange={setMaterialYou}
                label="跟随系统壁纸（Material You）"
              />
            ) : null}
          </FieldGroup.Section>
        </FieldGroup>
      </NativeHost>
    </SafeAreaView>
  );
}
