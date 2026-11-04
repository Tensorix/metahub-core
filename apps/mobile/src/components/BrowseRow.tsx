import { Pressable, Text, View } from "react-native";
import { BrowseIcon } from "./BrowseIcon";
import { useTheme } from "@/lib/theme";
export function BrowseRow({
  title,
  subtitle,
  kind = "document",
  onPress,
  depth = 0,
}: {
  title: string;
  subtitle?: string;
  kind?: "document" | "database" | "site";
  onPress: () => void;
  depth?: number;
}) {
  const { tokens } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 64,
        marginHorizontal: 20,
        paddingVertical: 14,
        paddingLeft: Math.min(depth, 3) * 16,
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        backgroundColor: pressed ? tokens.hover : undefined,
        borderBottomColor: tokens.line,
        borderBottomWidth: 0.5,
      })}
    >
      <BrowseIcon kind={kind} />
      <View style={{ flex: 1, gap: 5 }}>
        <Text numberOfLines={2} style={{ fontSize: 17, color: tokens.fg }}>
          {title || "未命名"}
        </Text>
        {subtitle ? (
          <Text
            numberOfLines={1}
            style={{ fontSize: 13, color: tokens.fgSoft }}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
