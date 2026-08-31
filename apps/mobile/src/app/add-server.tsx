import { Stack, useRouter } from "expo-router";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { ServerForm } from "@/components/ServerForm";
import { useSessionCtx } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";
import { fs } from "@/lib/theme/tokens";

/** Add another server while signed in; connecting also switches to it. */
export default function AddServerScreen() {
  const router = useRouter();
  const { connect } = useSessionCtx();
  const { tokens } = useTheme();

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <Stack.Screen options={{ title: "添加服务器", headerShown: true }} />
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={[styles.hint, { color: tokens.muted }]}>
            连接成功后会切换到新服务器；原服务器保留在列表中，可随时切回。
          </Text>
          <ServerForm
            submitLabel="添加并切换"
            onVerified={async (creds) => {
              await connect(creds);
              router.back();
            }}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 24 },
  hint: { fontSize: fs.sm, lineHeight: 20 },
});
