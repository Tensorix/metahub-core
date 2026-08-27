import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { verifyServer } from "@/lib/api/mobile-api";
import { parseQrPayload } from "@/lib/auth/credentials";
import { useSessionCtx } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";
import { fs, radii } from "@/lib/theme/tokens";

export default function ScanScreen() {
  const { connect } = useSessionCtx();
  const { tokens } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const handled = useRef(false);

  // Scanning is the intent — verify and connect right here; a successful
  // connect flips the session and the Protected stack swaps to the tabs.
  const onScan = async (data: string) => {
    if (handled.current) return;
    const parsed = parseQrPayload(data);
    if (parsed.kind !== "server") {
      setMessage(
        parsed.kind === "enroll"
          ? "这是存储桶接入码，App 暂不支持。请扫 WebUI 的「在手机上打开」二维码（带 ?token）"
          : "无法识别的二维码",
      );
      return;
    }
    handled.current = true;
    setBusy(true);
    const result = await verifyServer(parsed.baseUrl, parsed.token);
    if (!result.ok) {
      setBusy(false);
      handled.current = false;
      setMessage(
        result.reason === "unreachable"
          ? "连不上服务器——确认手机和服务器在同一网络"
          : "服务器可达，但二维码里的令牌无效或已过期",
      );
      return;
    }
    await connect({ baseUrl: parsed.baseUrl, token: parsed.token });
  };

  if (!permission?.granted) {
    return (
      <View style={[styles.center, { backgroundColor: tokens.bg }]}>
        <Text style={[styles.hint, { color: tokens.fgSoft }]}>
          需要相机权限来扫描二维码
        </Text>
        <Pressable
          onPress={requestPermission}
          style={[styles.btn, { backgroundColor: tokens.accent }]}
        >
          <Text style={{ color: tokens.accentFg, fontSize: fs.body, fontWeight: "600" }}>
            允许使用相机
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => void onScan(data)}
      />
      <View style={styles.overlay}>
        <View style={styles.frame} />
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.overlayText}>
            {message ?? "对准电脑屏幕上的二维码"}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  hint: { fontSize: fs.ui, textAlign: "center" },
  btn: {
    paddingHorizontal: 24,
    height: 46,
    borderRadius: radii.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  overlay: { flex: 1, alignItems: "center", justifyContent: "center", gap: 24 },
  frame: {
    width: 220,
    height: 220,
    borderRadius: radii.xl,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.9)",
  },
  overlayText: {
    color: "#fff",
    fontSize: fs.ui,
    textAlign: "center",
    paddingHorizontal: 32,
    textShadowColor: "rgba(0,0,0,0.6)",
    textShadowRadius: 6,
  },
});
