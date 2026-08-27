import { Pressable, StyleSheet, Text } from "react-native";

import { fs, radii } from "@/lib/theme/tokens";
import { useTheme } from "@/lib/theme";

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { tokens } = useTheme();
  return (
    <Pressable
      onPress={onRetry}
      style={[styles.wrap, { backgroundColor: tokens.dangerSoft }]}
    >
      <Text style={[styles.text, { color: tokens.danger }]}>
        {message}
        {onRetry ? "（点按重试）" : ""}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: 16,
    marginVertical: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radii.md,
  },
  text: { fontSize: fs.sm },
});
