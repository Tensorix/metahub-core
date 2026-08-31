import { useRouter } from "expo-router";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ServerForm } from "@/components/ServerForm";
import { useSessionCtx } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";
import { fs, radii } from "@/lib/theme/tokens";

export default function OnboardingScreen() {
  const router = useRouter();
  const { connect } = useSessionCtx();
  const { tokens } = useTheme();

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

          <ServerForm onVerified={connect} />
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
});
