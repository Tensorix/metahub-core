import { Platform, View, type ImageSourcePropType } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { MaterialFab } from "@/components/native/MaterialFab";

export interface AdaptiveFabProps {
  /** Retained for existing callers; Android uses a native add icon by default. */
  glyph?: string;
  label?: string;
  onPress: () => void;
  icon?: ImageSourcePropType;
  /** Native tab content already consumes its bottom safe area. */
  bottomInsetConsumed?: boolean;
}

/** iOS callers expose this action in Stack.Toolbar; Android uses a Compose FAB. */
export function AdaptiveFab({
  label = "新建",
  onPress,
  icon,
  bottomInsetConsumed = false,
}: AdaptiveFabProps) {
  const insets = useSafeAreaInsets();
  if (Platform.OS === "ios") return null;

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        right: 16 + insets.right,
        bottom: 16 + (bottomInsetConsumed ? 0 : insets.bottom),
      }}
    >
      <MaterialFab label={label} onPress={onPress} icon={icon} />
    </View>
  );
}
