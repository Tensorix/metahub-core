import { fillMaxWidth, semantics } from "@expo/ui/jetpack-compose/modifiers";
import { accessibilityLabel, frame } from "@expo/ui/swift-ui/modifiers";
import { Platform } from "react-native";

/** Label the editable control itself and keep it inside its host's width. */
export function connectionFieldModifiers(label: string) {
  if (Platform.OS === "ios")
    return [frame({ maxWidth: Infinity }), accessibilityLabel(label)];
  if (Platform.OS === "android")
    return [fillMaxWidth(), semantics({ contentDescription: label })];
  return [];
}
