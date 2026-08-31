import { useFocusEffect, useRouter } from "expo-router";
import { useCallback } from "react";
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
  const { creds, api } = useSession();
  const { disconnect, switchServer } = useSessionCtx();
  const { tokens, pref, setPref, dynamicAvailable, materialYou, setMaterialYou } =
    useTheme();

  const fetchVersion = useCallback(() => api.version(), [api]);
  const { data: version } = useApiData(fetchVersion);
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
    Alert.alert("断开连接", "将从本机移除该服务器；若保存了其他服务器则切换过去。", [
      { text: "取消", style: "cancel" },
      {
        text: "断开",
        style: "destructive",
        onPress: () => void disconnect().then(() => refetchServers()),
      },
    ]);
  };

  const card = { backgroundColor: tokens.surface, borderColor: tokens.line };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: tokens.bg }]} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: tokens.fg }]}>设置</Text>

        <Text style={[styles.section, { color: tokens.muted }]}>服务器</Text>
        <View style={[styles.card, card]}>
          {(servers ?? [creds]).map((s, i) => (
            <View key={s.baseUrl}>
              {i > 0 ? <Divider color={tokens.line} /> : null}
              <Pressable
                onPress={() =>
                  s.baseUrl === creds.baseUrl
                    ? undefined
                    : void switchServer(s.baseUrl).then(() => refetchServers())
                }
                style={styles.row}
              >
                <Text
                  numberOfLines={1}
                  style={[styles.rowLabel, { color: tokens.fg, flexShrink: 1 }]}
                >
                  {s.baseUrl}
                </Text>
                {s.baseUrl === creds.baseUrl ? (
                  <Text style={{ color: tokens.accent, fontSize: fs.body }}>✓</Text>
                ) : null}
              </Pressable>
            </View>
          ))}
          <Divider color={tokens.line} />
          <Pressable onPress={() => router.push("/add-server")} style={styles.row}>
            <Text style={[styles.rowLabel, { color: tokens.accent }]}>添加服务器</Text>
          </Pressable>
          <Divider color={tokens.line} />
          <Row label="服务端版本" value={version?.version ?? "…"} tokens={tokens} />
          <Divider color={tokens.line} />
          <Pressable onPress={confirmDisconnect} style={styles.row}>
            <Text style={[styles.rowLabel, { color: tokens.danger }]}>断开连接</Text>
          </Pressable>
        </View>

        <Text style={[styles.section, { color: tokens.muted }]}>外观</Text>
        <View style={[styles.card, card]}>
          {THEME_OPTIONS.map((opt, i) => (
            <View key={opt.key}>
              {i > 0 ? <Divider color={tokens.line} /> : null}
              <Pressable onPress={() => setPref(opt.key)} style={styles.row}>
                <Text style={[styles.rowLabel, { color: tokens.fg }]}>{opt.label}</Text>
                {pref === opt.key ? (
                  <Text style={{ color: tokens.accent, fontSize: fs.body }}>✓</Text>
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
      <Text numberOfLines={1} style={[styles.rowValue, { color: tokens.muted }]}>
        {value}
      </Text>
    </View>
  );
}

function Divider({ color }: { color: string }) {
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: color }} />;
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
