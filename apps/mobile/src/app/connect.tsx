import { Stack, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { BucketForm } from "@/components/BucketForm";
import { useSessionCtx } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";

/** Public entry point: a bucket invitation works before or after first setup. */
export default function ConnectScreen() {
  const { enroll } = useLocalSearchParams<{ enroll?: string | string[] }>();
  const code = typeof enroll === "string" ? enroll : "";
  const { connect } = useSessionCtx();
  const { tokens } = useTheme();
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const form = (
    <BucketForm
      key={code}
      initialCode={code}
      showTitle={false}
      onVerified={async (credentials) => {
        await connect(credentials);
      }}
    />
  );
  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: tokens.bg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Stack.Screen
        options={{
          title: "连接存储桶",
          headerShown: true,
          headerTransparent: Platform.OS === "ios",
          headerBackButtonDisplayMode: "minimal",
        }}
      />
      {Platform.OS === "ios" ? (
        <View
          style={{
            flex: 1,
            paddingTop: headerHeight + 16,
            paddingBottom: insets.bottom,
            paddingHorizontal: 20,
            width: "100%",
            maxWidth: 560,
            alignSelf: "center",
          }}
        >
          {form}
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{
            padding: 24,
            paddingBottom: 48,
            width: "100%",
            maxWidth: 560,
            alignSelf: "center",
          }}
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
        >
          {form}
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}
