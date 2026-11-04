import { Image, Pressable, Text, View } from "react-native";
import { BrowseIcon } from "./BrowseIcon";
import { useTheme } from "@/lib/theme";
export function SiteShortcut({
  title,
  more,
  iconUri,
  onPress,
}: {
  title: string;
  more?: boolean;
  iconUri?: string;
  onPress: () => void;
}) {
  const { tokens } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={more ? "查看全部 Sites" : title}
      style={({ pressed }) => ({
        width: 80,
        minHeight: 100,
        alignItems: "center",
        gap: 10,
        opacity: pressed ? 0.55 : 1,
      })}
    >
      <View
        style={{
          width: 60,
          height: 60,
          borderRadius: 30,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: more ? tokens.surface2 : tokens.accentSoft,
        }}
      >
        {iconUri ? (
          <Image
            source={{ uri: iconUri }}
            style={{ width: 60, height: 60, borderRadius: 30 }}
          />
        ) : more ? (
          <BrowseIcon kind="more" size={26} />
        ) : (
          <Text
            style={{ fontSize: 23, fontWeight: "600", color: tokens.accent }}
          >
            {Array.from(title.trim())[0]?.toLocaleUpperCase() || "S"}
          </Text>
        )}
      </View>
      <Text
        numberOfLines={2}
        style={{ fontSize: 13, textAlign: "center", color: tokens.fg }}
      >
        {title}
      </Text>
    </Pressable>
  );
}
