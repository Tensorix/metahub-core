import { useConnectionLeaveGuard } from "@/components/use-connection-leave-guard";
import { NativeDataText } from "@/components/native/NativeDataText";
import * as Clipboard from "expo-clipboard";
import { Button, Column, Text } from "@expo/ui";
import { useRef, useEffect, useState } from "react";
import { NativeHost } from "@/components/native/NativeHost";
import { RecordTextInput } from "@/components/RecordTextInput";

import { verifyServer } from "@/lib/api/mobile-api";
import { normalizeBaseUrl, type Credentials } from "@/lib/auth/credentials";
import { useTheme } from "@/lib/theme";

/** Server address + token entry with paste and verification, shared by
 *  onboarding and the add-server screen. Calls onVerified once /health and
 *  an authed /api/version both pass. */
export function ServerForm({
  onVerified,
  submitLabel = "连接",
  initialUrl = "",
}: {
  onVerified: (creds: Credentials) => Promise<void>;
  submitLabel?: string;
  initialUrl?: string;
}) {
  const { tokens } = useTheme();
  const mounted = useRef(true);
  const submitting = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [url, setUrl] = useState(initialUrl);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const committingRef = useConnectionLeaveGuard(
    url !== initialUrl || !!token,
    busy,
  );

  const submit = async () => {
    if (submitting.current) return;
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
    submitting.current = true;
    setBusy(true);
    try {
      const result = await verifyServer(baseUrl, tok);
      if (!mounted.current) return;
      if (!result.ok) {
        setBusy(false);
        setError(
          result.reason === "unreachable"
            ? "连不上服务器——确认手机和服务器在同一网络，且服务器以 --host 0.0.0.0 启动"
            : "服务器可达，但令牌无效或已过期",
        );
        return;
      }
      committingRef.current = true;
      await onVerified({ baseUrl, token: tok });
    } catch {
      committingRef.current = false;
      if (mounted.current) setError("连接或保存失败，请重试，输入内容已保留");
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const pasteToken = async () => {
    try {
      const text = (await Clipboard.getStringAsync()).trim();
      if (text) setToken(text);
    } catch {
      setError("无法读取剪贴板，请手动输入令牌");
    }
  };

  return (
    <NativeHost matchContents style={{ width: "100%" }}>
      <Column spacing={12}>
        <Text textStyle={{ color: tokens.fg, fontWeight: "600" }}>
          服务器地址
        </Text>
        <RecordTextInput
          text={url}
          onChangeText={setUrl}
          placeholder="http://192.168.1.10:5173"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          editable={!busy}
          style={{
            padding: 12,
            borderWidth: 1,
            borderColor: tokens.line,
            borderRadius: 10,
          }}
        />
        <Text textStyle={{ color: tokens.fg, fontWeight: "600" }}>
          访问令牌
        </Text>
        <RecordTextInput
          text={token}
          onChangeText={setToken}
          placeholder="mh_…"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          autoComplete="off"
          editable={!busy}
          style={{
            padding: 12,
            borderWidth: 1,
            borderColor: tokens.line,
            borderRadius: 10,
          }}
        />
        <Button
          label="从剪贴板粘贴令牌"
          variant="text"
          onPress={() => void pasteToken()}
          disabled={busy}
        />
        {error ? (
          <NativeDataText textStyle={{ color: tokens.danger }}>
            {error}
          </NativeDataText>
        ) : null}
        <Button
          label={busy ? "正在验证并保存…" : submitLabel}
          disabled={busy}
          onPress={() => void submit()}
        />
      </Column>
    </NativeHost>
  );
}
