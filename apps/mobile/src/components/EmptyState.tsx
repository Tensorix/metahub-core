import { StyleSheet, Text, View } from "react-native";

import { fs } from "@/lib/theme/tokens";
import { useTheme } from "@/lib/theme";

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.wrap}>
      <Text style={[styles.title, { color: tokens.fgSoft }]}>{title}</Text>
      {hint ? <Text style={[styles.hint, { color: tokens.muted }]}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", paddingVertical: 48, paddingHorizontal: 24, gap: 6 },
  title: { fontSize: fs.ui, fontWeight: "500" },
  hint: { fontSize: fs.sm, textAlign: "center" },
});
