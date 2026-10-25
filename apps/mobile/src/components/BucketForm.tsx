import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { decodeEnroll } from "../../../../src/core/sync/enroll.ts";
import {
  storageClientFor,
  type S3Config,
} from "../../../../src/core/sync/storage.ts";
import { storageUrl } from "../../../../src/core/sync/storage-url.ts";
import { initializeNativeSyncRuntime } from "@/lib/sync/runtime";
import type { Credentials } from "@/lib/auth/credentials";
import { resolveBucketEnrollment } from "@/lib/auth/bucket-enrollment";
import { useTheme } from "@/lib/theme";

export function BucketForm({
  onVerified,
  initialCode = "",
}: {
  onVerified: (credentials: Credentials) => Promise<void>;
  initialCode?: string;
}) {
  const { tokens } = useTheme();
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);
  const [code, setCode] = useState(initialCode);
  const [manual, setManual] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("auto");
  const [prefix, setPrefix] = useState("metahub");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [unlockMethod, setUnlockMethod] = useState<"passphrase" | "recovery">("passphrase");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = (
    label: string,
    value: string,
    change: (s: string) => void,
    secret = false,
  ) => (
    <View key={label} style={{ gap: 6 }}>
      <Text style={{ color: tokens.fg }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={change}
        secureTextEntry={secret}
        editable={!busy}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          color: tokens.fg,
          backgroundColor: tokens.surface,
          borderColor: tokens.line,
          borderWidth: 1,
          borderRadius: 10,
          padding: 12,
        }}
      />
    </View>
  );
  async function connect() {
    if (operation.current) return;
    const attempt = new AbortController();
    operation.current = attempt;
    setBusy(true);
    setError(null);
    try {
      await initializeNativeSyncRuntime();
      if (attempt.signal.aborted) return;
      const data = manual
        ? {
            endpoint: endpoint.trim(),
            bucket: bucket.trim(),
            region: region.trim(),
            prefix: prefix.trim(),
            accessKeyId: accessKeyId.trim(),
            secretAccessKey: secretAccessKey.trim(),
            encrypt: true,
          }
        : decodeEnroll(code);
      if (
        !data.endpoint ||
        !data.bucket ||
        !data.accessKeyId ||
        !data.secretAccessKey
      )
        throw new Error("请填写完整的存储桶信息");
      const url = new URL(data.endpoint);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error("存储桶地址无效");
      const settings: S3Config = {
        ...data,
        region: data.region || "auto",
        prefix: data.prefix || "metahub",
        encrypt: data.encrypt !== false,
        publish: false,
      };
      const client = storageClientFor(settings, { signal: attempt.signal });
      const config = await resolveBucketEnrollment(
        client,
        settings,
        unlockMethod === "recovery"
          ? { method: "recovery", recoveryCode }
          : { method: "passphrase", passphrase },
        attempt.signal,
      );
      if (attempt.signal.aborted) return;
      await onVerified({
        baseUrl: storageUrl(config.endpoint, config.bucket, config.prefix),
        token: "",
        bucket: config,
      });
    } catch (e) {
      if (!attempt.signal.aborted)
        setError(e instanceof Error ? e.message : "连接失败，请检查配置后重试");
    } finally {
      if (operation.current === attempt) operation.current = null;
      if (!attempt.signal.aborted) setBusy(false);
    }
  }
  return (
    <View style={{ gap: 12, paddingVertical: 16 }}>
      <Text style={{ color: tokens.fg, fontSize: 20, fontWeight: "600" }}>
        连接存储桶
      </Text>
      <Text style={{ color: tokens.muted }}>
        直接同步已有存储桶，下载完成后可离线编辑。
      </Text>
      <Pressable disabled={busy} onPress={() => setManual(!manual)}>
        <Text style={{ color: tokens.accent }}>
          {manual ? "使用接入码" : "手动填写配置"}
        </Text>
      </Pressable>
      {manual ? (
        <>
          {input("Endpoint", endpoint, setEndpoint)}
          {input("Bucket", bucket, setBucket)}
          {input("Region", region, setRegion)}
          {input("Prefix", prefix, setPrefix)}
          {input("Access Key", accessKeyId, setAccessKeyId)}
          {input("Secret Key", secretAccessKey, setSecretAccessKey, true)}
        </>
      ) : (
        input("接入码或链接", code, setCode, true)
      )}
      <View style={{ flexDirection: "row", gap: 16 }}>
        {(["passphrase", "recovery"] as const).map((method) => (
          <Pressable
            key={method}
            accessibilityRole="radio"
            accessibilityState={{ checked: unlockMethod === method, disabled: busy }}
            disabled={busy}
            onPress={() => {
              setUnlockMethod(method);
              setError(null);
            }}
            style={{ paddingVertical: 8 }}
          >
            <Text style={{ color: unlockMethod === method ? tokens.accent : tokens.muted }}>
              {method === "passphrase" ? "使用解密密码" : "使用恢复码"}
            </Text>
          </Pressable>
        ))}
      </View>
      {unlockMethod === "recovery" ? (
        <>
          {input("恢复码", recoveryCode, setRecoveryCode, true)}
          <Text style={{ color: tokens.muted }}>
            输入以 MH1 开头的恢复码，仅用于在此设备解密已有数据。
          </Text>
        </>
      ) : (
        input("解密密码", passphrase, setPassphrase, true)
      )}
      {error ? (
        <Text accessibilityLiveRegion="polite" style={{ color: tokens.danger }}>
          {error}
        </Text>
      ) : null}
      <Pressable
        disabled={busy}
        onPress={() => void connect()}
        style={{
          backgroundColor: tokens.accent,
          borderRadius: 12,
          padding: 14,
          alignItems: "center",
        }}
      >
        {busy ? (
          <ActivityIndicator color={tokens.accentFg} />
        ) : (
          <Text style={{ color: tokens.accentFg }}>连接并同步</Text>
        )}
      </Pressable>
    </View>
  );
}
