import { SymbolView } from "expo-symbols";
import { Platform, Text, View } from "react-native";
import { useTheme } from "@/lib/theme";
export function BrowseIcon({
  kind,
  size = 22,
}: {
  kind: "document" | "database" | "site" | "more";
  size?: number;
}) {
  const { tokens } = useTheme();
  const name = {
    document: "doc.text",
    database: "tablecells",
    site: "globe",
    more: "ellipsis",
  } as const;
  if (Platform.OS === "ios")
    return (
      <SymbolView
        name={name[kind]}
        tintColor={tokens.accent}
        size={size}
        style={{ width: size, height: size }}
      />
    );
  return (
    <View
      accessible={false}
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        style={{
          color: tokens.accent,
          fontSize: size * 0.7,
          fontWeight: "600",
        }}
      >
        {kind === "document"
          ? "文"
          : kind === "database"
            ? "表"
            : kind === "site"
              ? "S"
              : "···"}
      </Text>
    </View>
  );
}
