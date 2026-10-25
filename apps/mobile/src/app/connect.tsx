import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { KeyboardAvoidingView, Platform, ScrollView } from "react-native";
import { BucketForm } from "@/components/BucketForm";
import { useSessionCtx } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";

/** Public entry point: a bucket invitation works before or after first setup. */
export default function ConnectScreen() {
  const { enroll } = useLocalSearchParams<{ enroll?: string | string[] }>();
  const code = typeof enroll === "string" ? enroll : "";
  const { connect } = useSessionCtx();
  const { tokens } = useTheme();
  const router = useRouter();
  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: tokens.bg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={96}
    >
      <Stack.Screen options={{ title: "连接存储桶", headerShown: true }} />
      <ScrollView contentContainerStyle={{ padding: 24 }} keyboardShouldPersistTaps="handled">
        <BucketForm
          key={code}
          initialCode={code}
          onVerified={async (credentials) => {
            await connect(credentials);
            router.replace("/(tabs)");
          }}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
