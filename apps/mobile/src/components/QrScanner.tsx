import { ScannerButton } from "@/components/ScannerButton";
import { CameraView, useCameraPermissions } from "expo-camera";
import {
  ActivityIndicator,
  Linking,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useTheme } from "@/lib/theme";
import { fs, radii } from "@/lib/theme/tokens";

export function QrScanner({
  onScan,
  message,
  busy = false,
}: {
  onScan: (data: string) => void;
  message: string | null;
  busy?: boolean;
}) {
  const { tokens } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  if (!permission?.granted) {
    return (
      <View style={[styles.center, { backgroundColor: tokens.bg }]}>
        <Text style={[styles.hint, { color: tokens.fgSoft }]}>
          需要相机权限来扫描二维码
        </Text>
        <ScannerButton
          primary
          label={
            permission?.canAskAgain === false ? "打开系统设置" : "允许使用相机"
          }
          onPress={() => {
            if (permission?.canAskAgain === false) void Linking.openSettings();
            else void requestPermission();
          }}
        />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => onScan(data)}
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
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: 24,
  },
  hint: { fontSize: fs.ui, textAlign: "center" },
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
