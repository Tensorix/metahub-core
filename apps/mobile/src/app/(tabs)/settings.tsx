import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { BucketForm } from "@/components/BucketForm";
import { ServerForm } from "@/components/ServerForm";
import { useApiData } from "@/lib/api/hooks";
import { listServers } from "@/lib/auth/credentials";
import { useSession, useSessionCtx } from "@/lib/auth/session";
import { useTheme, type ThemePref } from "@/lib/theme";
import { fs, radii } from "@/lib/theme/tokens";

const THEME_OPTIONS: { key: ThemePref; label: string }[] = [
  { key: "system", label: "跟随系统" },
  { key: "light", label: "浅色" },
  { key: "dark", label: "深色" },
];

export default function SettingsScreen() {
  const router = useRouter();
  const { creds, api, sync, authInvalid, syncNow, attachments } = useSession();
  const [syncState, setSyncState] = useState(sync.status);
  useEffect(() => sync.onStatus(setSyncState), [sync]);
  const [reconnecting, setReconnecting] = useState(false);
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

  const fetchVersion = useCallback(() => api.version(), [api]);
  const { data: version, error: versionError } = useApiData(fetchVersion);
  const fetchServers = useCallback(() => listServers(), []);
  const { data: servers, refetch: refetchServers } = useApiData(fetchServers);
  // The list changes behind this screen's back (add-server modal, token
  // rotation) — refresh whenever the tab regains focus.
  useFocusEffect(
    useCallback(() => {
      void refetchServers();
    }, [refetchServers]),
  );

  const confirmDisconnect = () => {
    Alert.alert(
      "断开连接",
      "移除连接并切换其他工作区。本地数据库和未同步内容会保留，重新连接相同地址可继续使用。",
      [
        { text: "取消", style: "cancel" },
        {
          text: "断开",
          style: "destructive",
          onPress: () =>
            void disconnect().catch(() => Alert.alert("移除失败", "请重试")),
        },
      ],
    );
  };

  const card = { backgroundColor: tokens.surface, borderColor: tokens.line };

  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: tokens.bg }]}
      edges={["top"]}
    >
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: tokens.fg }]}>设置</Text>

        <Text
          accessibilityLiveRegion="polite"
          style={{ color: authInvalid ? tokens.danger : tokens.muted }}
        >
          {syncState.syncing
            ? syncState.hydrationReady
              ? "正在同步"
              : "正在下载本地副本，请保持应用打开"
            : syncState.error || sessionError
              ? "同步暂未完成，本地内容仍可编辑"
              : syncState.pendingPush
                ? `已保存到手机，${syncState.pendingPush} 项等待同步`
                : syncState.hydrationReady
                  ? "已保存到手机 · 同步完成"
                  : "正在初始化本地副本"}
        </Text>
        {syncState.error || sessionError ? (
          <Text style={{ color: tokens.danger }}>
            {syncState.error || sessionError}
          </Text>
        ) : null}
        <Pressable
          style={styles.row}
          onPress={() =>
            void syncNow()
              .then(() => attachments.retryPending())
              .catch((e) => Alert.alert("同步失败", String(e)))
          }
        >
          <Text style={{ color: tokens.accent }}>立即同步 / 重试附件</Text>
        </Pressable>
        <Text style={{ color: tokens.muted }}>
          待上传附件：{attachments.pendingCount()} ·{" "}
          {syncState.lastSuccessAt
            ? `上次同步 ${new Date(syncState.lastSuccessAt).toLocaleString()}`
            : "尚未同步完成"}
        </Text>
        {authInvalid || reconnecting ? (
          creds.bucket ? (
            <BucketForm onVerified={connect} />
          ) : (
            <ServerForm
              initialUrl={creds.baseUrl}
              submitLabel="重新连接"
              onVerified={connect}
            />
          )
        ) : (
          <Pressable onPress={() => setReconnecting(true)} style={styles.row}>
            <Text style={{ color: tokens.accent }}>更新连接凭据</Text>
          </Pressable>
        )}
        <Text style={[styles.section, { color: tokens.muted }]}>工作区</Text>
        <View style={[styles.card, card]}>
          {(servers ?? [creds]).map((s, i) => (
            <View key={s.baseUrl}>
              {i > 0 ? <Divider color={tokens.line} /> : null}
              <Pressable
                onPress={() =>
                  s.baseUrl === creds.baseUrl
                    ? undefined
                    : void switchServer(s.baseUrl).catch(() =>
                        Alert.alert("切换失败", "请重试"),
                      )
                }
                style={styles.row}
              >
                <Text
                  numberOfLines={1}
                  style={[styles.rowLabel, { color: tokens.fg, flexShrink: 1 }]}
                >
                  {s.bucket ? s.bucket.bucket : s.baseUrl}
                </Text>
                {s.baseUrl === creds.baseUrl ? (
                  <Text style={{ color: tokens.accent, fontSize: fs.body }}>
                    ✓
                  </Text>
                ) : null}
              </Pressable>
            </View>
          ))}
          <Divider color={tokens.line} />
          <Pressable
            onPress={() => router.push("/add-server")}
            style={styles.row}
          >
            <Text style={[styles.rowLabel, { color: tokens.accent }]}>
              添加服务器或存储桶
            </Text>
          </Pressable>
          <Divider color={tokens.line} />
          <Row
            label="服务端版本"
            value={version?.version ?? (versionError ? "获取失败" : "…")}
            tokens={tokens}
          />
          <Divider color={tokens.line} />
          <Pressable onPress={confirmDisconnect} style={styles.row}>
            <Text style={[styles.rowLabel, { color: tokens.danger }]}>
              断开连接
            </Text>
          </Pressable>
        </View>

        <Text style={[styles.section, { color: tokens.muted }]}>离线附件</Text>
        <View style={[styles.card, card]}>
          <Text style={[styles.rowLabel, { color: tokens.fg, padding: 14 }]}>
            {attachments.usage().count} 个文件 ·{" "}
            {(attachments.usage().bytes / 1024 / 1024).toFixed(1)} MB
          </Text>
          <Pressable
            style={styles.row}
            onPress={() =>
              Alert.alert(
                "清理已下载附件",
                "只移除本机已同步的附件副本，待上传内容会保留。已下载附件将需要重新联网下载。",
                [
                  { text: "取消", style: "cancel" },
                  {
                    text: "清理",
                    onPress: () => {
                      try {
                        attachments.clearDownloaded();
                        setSyncState({ ...sync.status });
                      } catch (e) {
                        Alert.alert("暂时无法清理", String(e));
                      }
                    },
                  },
                ],
              )
            }
          >
            <Text style={{ color: tokens.accent }}>清理已下载附件</Text>
          </Pressable>
        </View>
        <Text style={[styles.section, { color: tokens.muted }]}>外观</Text>
        <View style={[styles.card, card]}>
          {THEME_OPTIONS.map((opt, i) => (
            <View key={opt.key}>
              {i > 0 ? <Divider color={tokens.line} /> : null}
              <Pressable onPress={() => setPref(opt.key)} style={styles.row}>
                <Text style={[styles.rowLabel, { color: tokens.fg }]}>
                  {opt.label}
                </Text>
                {pref === opt.key ? (
                  <Text style={{ color: tokens.accent, fontSize: fs.body }}>
                    ✓
                  </Text>
                ) : null}
              </Pressable>
            </View>
          ))}
          {dynamicAvailable ? (
            <View>
              <Divider color={tokens.line} />
              <View style={styles.row}>
                <Text style={[styles.rowLabel, { color: tokens.fg }]}>
                  跟随系统壁纸（Material You）
                </Text>
                <Switch
                  value={materialYou}
                  onValueChange={setMaterialYou}
                  trackColor={{ true: tokens.accent }}
                />
              </View>
            </View>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({
  label,
  value,
  tokens,
}: {
  label: string;
  value: string;
  tokens: { fg: string; muted: string };
}) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: tokens.fg }]}>{label}</Text>
      <Text
        numberOfLines={1}
        style={[styles.rowValue, { color: tokens.muted }]}
      >
        {value}
      </Text>
    </View>
  );
}

function Divider({ color }: { color: string }) {
  return (
    <View
      style={{ height: StyleSheet.hairlineWidth, backgroundColor: color }}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16, paddingBottom: 80 },
  title: { fontSize: 28, fontWeight: "700", marginBottom: 8 },
  section: {
    fontSize: fs.xs,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: 18,
    marginBottom: 6,
    paddingHorizontal: 2,
  },
  card: {
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 13,
    gap: 12,
  },
  rowLabel: { fontSize: fs.ui },
  rowValue: { fontSize: fs.sm, flexShrink: 1 },
});
