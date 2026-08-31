import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { verifyServer } from "@/lib/api/mobile-api";
import { normalizeBaseUrl, type Credentials } from "@/lib/auth/credentials";
import { useTheme } from "@/lib/theme";
import { fs, radii } from "@/lib/theme/tokens";

/** Server address + token entry with paste and verification, shared by
 *  onboarding and the add-server screen. Calls onVerified once /health and
 *  an authed /api/version both pass. */
export function ServerForm({
  onVerified,
  submitLabel = "连接",
}: {
  onVerified: (creds: Credentials) => Promise<void>;
  submitLabel?: string;
}) {
  const { tokens } = useTheme();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const baseUrl = normalizeBaseUrl(url);
    if (!baseUrl) {
      setError("服务器地址无效，例如 http://192.168.1.10:5173");
      return;
    }
    const tok = token.trim();
    if (!tok) {
      setError("请填写访问令牌（桌面端 设置 → 设备 可查看）");
      return;
    }
    setBusy(true);
    const result = await verifyServer(baseUrl, tok);
    if (!result.ok) {
      setBusy(false);
      setError(
        result.reason === "unreachable"
          ? "连不上服务器——确认手机和服务器在同一网络，且服务器以 --host 0.0.0.0 启动"
          : "服务器可达，但令牌无效或已过期",
      );
      return;
    }
    try {
      await onVerified({ baseUrl, token: tok });
    } catch {
      setError("保存失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  const pasteToken = async () => {
    const text = (await Clipboard.getStringAsync()).trim();
    if (text) setToken(text);
  };

  const inputStyle = [
    styles.input,
    { backgroundColor: tokens.surface, borderColor: tokens.line, color: tokens.fg },
  ];

  return (
    <View>
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
        onPress={() => void submit()}
        disabled={busy}
        style={[
          styles.submitBtn,
          { backgroundColor: tokens.accent, opacity: busy ? 0.6 : 1 },
        ]}
      >
        {busy ? (
          <ActivityIndicator color={tokens.accentFg} />
        ) : (
          <Text style={[styles.submitText, { color: tokens.accentFg }]}>
            {submitLabel}
          </Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
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
  submitBtn: {
    height: 48,
    borderRadius: radii.lg,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 20,
  },
  submitText: { fontSize: fs.body, fontWeight: "600" },
});
