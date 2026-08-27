import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { verifyServer } from "@/lib/api/mobile-api";
import { normalizeBaseUrl } from "@/lib/auth/credentials";
import { useSessionCtx } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";
import { fs, radii } from "@/lib/theme/tokens";

export default function OnboardingScreen() {
  const router = useRouter();
  const { connect } = useSessionCtx();
  const { tokens } = useTheme();

  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (rawUrl = url, rawToken = token) => {
    setError(null);
    const baseUrl = normalizeBaseUrl(rawUrl);
    if (!baseUrl) {
      setError("服务器地址无效，例如 http://192.168.1.10:5173");
      return;
    }
    const tok = rawToken.trim();
    if (!tok) {
      setError("请填写访问令牌（桌面端 设置 → 设备 可查看）");
      return;
    }
    setBusy(true);
    const result = await verifyServer(baseUrl, tok);
    setBusy(false);
    if (!result.ok) {
      setError(
        result.reason === "unreachable"
          ? "连不上服务器——确认手机和服务器在同一网络，且服务器以 --host 0.0.0.0 启动"
          : "服务器可达，但令牌无效或已过期",
      );
      return;
    }
    await connect({ baseUrl, token: tok });
  };

  const pasteToken = async () => {
    const text = (await Clipboard.getStringAsync()).trim();
    if (text) setToken(text);
  };

  const inputStyle = [
    styles.input,
    {
      backgroundColor: tokens.surface,
      borderColor: tokens.line,
      color: tokens.fg,
    },
  ];

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: tokens.bg }]}>
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={[styles.logo, { color: tokens.fg }]}>Metahub</Text>
          <Text style={[styles.subtitle, { color: tokens.muted }]}>
            连接你的 Metahub 服务器
          </Text>

          <Pressable
            onPress={() => router.push("/onboarding/scan")}
            style={[styles.scanBtn, { backgroundColor: tokens.accent }]}
          >
            <Text style={[styles.scanBtnText, { color: tokens.accentFg }]}>
              扫码连接
            </Text>
          </Pressable>
          <Text style={[styles.scanHint, { color: tokens.muted }]}>
            在电脑端 WebUI 打开「在手机上打开」二维码
          </Text>

          <View style={[styles.divider, { backgroundColor: tokens.line }]} />

          <Text style={[styles.label, { color: tokens.fgSoft }]}>服务器地址</Text>
          <TextInput
            style={inputStyle}
            value={url}
            onChangeText={setUrl}
            placeholder="http://192.168.1.10:5173"
            placeholderTextColor={tokens.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!busy}
          />

          <Text style={[styles.label, { color: tokens.fgSoft }]}>访问令牌</Text>
          <View style={styles.tokenRow}>
            <TextInput
              style={[...inputStyle, styles.tokenInput]}
              value={token}
              onChangeText={setToken}
              placeholder="mh_…"
              placeholderTextColor={tokens.muted}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              editable={!busy}
            />
            <Pressable
              onPress={pasteToken}
              style={[styles.pasteBtn, { backgroundColor: tokens.surface2 }]}
            >
              <Text style={{ color: tokens.fgSoft, fontSize: fs.sm }}>粘贴</Text>
            </Pressable>
          </View>

          {error ? (
            <Text style={[styles.error, { color: tokens.danger }]}>{error}</Text>
          ) : null}

          <Pressable
            onPress={() => submit()}
            disabled={busy}
            style={[
              styles.connectBtn,
              { backgroundColor: tokens.accent, opacity: busy ? 0.6 : 1 },
            ]}
          >
            {busy ? (
              <ActivityIndicator color={tokens.accentFg} />
            ) : (
              <Text style={[styles.scanBtnText, { color: tokens.accentFg }]}>连接</Text>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 24, paddingTop: 64 },
  logo: { fontSize: 34, fontWeight: "700", textAlign: "center" },
  subtitle: { fontSize: fs.ui, textAlign: "center", marginTop: 6, marginBottom: 28 },
  scanBtn: {
    height: 48,
    borderRadius: radii.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  scanBtnText: { fontSize: fs.body, fontWeight: "600" },
  scanHint: { fontSize: fs.sm, textAlign: "center", marginTop: 8 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 24 },
  label: { fontSize: fs.sm, fontWeight: "600", marginBottom: 6, marginTop: 12 },
  input: {
    height: 46,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingHorizontal: 12,
    fontSize: fs.body,
  },
  tokenRow: { flexDirection: "row", gap: 8 },
  tokenInput: { flex: 1 },
  pasteBtn: {
    paddingHorizontal: 14,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
  },
  error: { fontSize: fs.sm, marginTop: 12 },
  connectBtn: {
    height: 48,
    borderRadius: radii.lg,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 20,
  },
});
