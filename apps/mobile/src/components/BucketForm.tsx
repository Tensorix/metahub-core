import { useConnectionLeaveGuard } from "@/components/use-connection-leave-guard";
import { NativeDataText } from "@/components/native/NativeDataText";
import { useEffect, useRef, useState } from "react";
import { Button, Column, Text } from "@expo/ui";
import {
  ConnectionAction,
  ConnectionChoice,
} from "@/components/native/ConnectionControls";
import { NativeHost } from "@/components/native/NativeHost";
import { connectionFieldModifiers } from "@/components/native/connection-field-modifiers";
import { RecordTextInput } from "@/components/RecordTextInput";
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
  showTitle = true,
}: {
  onVerified: (credentials: Credentials) => Promise<void>;
  initialCode?: string;
  showTitle?: boolean;
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
  const [unlockMethod, setUnlockMethod] = useState<"passphrase" | "recovery">(
    "passphrase",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const committingRef = useConnectionLeaveGuard(
    code !== initialCode ||
      !!endpoint ||
      !!bucket ||
      !!accessKeyId ||
      !!secretAccessKey ||
      !!passphrase ||
      !!recoveryCode,
    busy,
  );
  const input = (
    id: string,
    label: string,
    value: string,
    change: (s: string) => void,
    secret = false,
  ) => (
    <Column key={label} spacing={8} style={{ width: "100%" }}>
      <Text
        textStyle={{ color: tokens.fgSoft, fontSize: 15, fontWeight: "500" }}
      >
        {label}
      </Text>
      <RecordTextInput
        testID={`bucket-${id}`}
        modifiers={connectionFieldModifiers(label)}
        placeholder={label}
        text={value}
        onChangeText={change}
        secureTextEntry={secret}
        editable={!busy}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          backgroundColor: tokens.surface2,
          borderRadius: 14,
          padding: 16,
        }}
      />
    </Column>
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
      committingRef.current = true;
      setSaving(true);
      await onVerified({
        baseUrl: storageUrl(config.endpoint, config.bucket, config.prefix),
        token: "",
        bucket: config,
      });
    } catch (e) {
      committingRef.current = false;
      setSaving(false);
      if (!attempt.signal.aborted)
        setError(e instanceof Error ? e.message : "连接失败，请检查配置后重试");
    } finally {
      if (operation.current === attempt) operation.current = null;
      if (!attempt.signal.aborted) setBusy(false);
    }
  }
  return (
    <NativeHost matchContents={{ vertical: true }} style={{ width: "100%" }}>
      <Column spacing={24} style={{ paddingVertical: 16, width: "100%" }}>
        {showTitle ? (
          <Text
            textStyle={{ color: tokens.fg, fontSize: 22, fontWeight: "600" }}
          >
            连接存储桶
          </Text>
        ) : null}
        <Text
          textStyle={{ color: tokens.fgSoft, fontSize: 16, lineHeight: 24 }}
        >
          直接同步已有存储桶，下载完成后可离线编辑。
        </Text>
        <Column spacing={16} style={{ width: "100%" }}>
          <ConnectionChoice
            label="连接方式"
            value={manual ? "manual" : "code"}
            disabled={busy}
            onChange={(value) => setManual(value === "manual")}
            options={[
              { value: "code", label: "使用接入码" },
              { value: "manual", label: "手动填写配置" },
            ]}
          />
          {manual ? (
            <>
              {input("endpoint", "Endpoint", endpoint, setEndpoint)}
              {input("bucket", "Bucket", bucket, setBucket)}
              {input("region", "Region", region, setRegion)}
              {input("prefix", "Prefix", prefix, setPrefix)}
              {input("access-key", "Access Key", accessKeyId, setAccessKeyId)}
              {input(
                "secret-key",
                "Secret Key",
                secretAccessKey,
                setSecretAccessKey,
                true,
              )}
            </>
          ) : (
            input("enrollment-code", "接入码或链接", code, setCode, true)
          )}
        </Column>
        <Column spacing={16} style={{ width: "100%" }}>
          <ConnectionChoice<"passphrase" | "recovery">
            label="解密方式"
            value={unlockMethod}
            disabled={busy}
            onChange={(value) => {
              setUnlockMethod(value);
              setError(null);
            }}
            options={[
              { value: "passphrase", label: "使用解密密码" },
              { value: "recovery", label: "使用恢复码" },
            ]}
          />
          {unlockMethod === "recovery" ? (
            <>
              {input(
                "recovery-code",
                "恢复码",
                recoveryCode,
                setRecoveryCode,
                true,
              )}
              <Text textStyle={{ color: tokens.muted }}>
                输入以 MH1 开头的恢复码，仅用于在此设备解密已有数据。
              </Text>
            </>
          ) : (
            input("passphrase", "解密密码", passphrase, setPassphrase, true)
          )}
        </Column>
        {error ? (
          <NativeDataText textStyle={{ color: tokens.danger }}>
            {error}
          </NativeDataText>
        ) : null}
        <ConnectionAction
          disabled={busy}
          label={busy ? "正在验证并连接…" : "连接并同步"}
          onPress={() => void connect()}
        />
        {busy && !saving ? (
          <Button
            label="取消连接"
            variant="text"
            onPress={() => {
              operation.current?.abort();
              operation.current = null;
              setBusy(false);
            }}
          />
        ) : null}
      </Column>
    </NativeHost>
  );
}
