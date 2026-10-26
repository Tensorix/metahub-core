import { RNHostView } from "@expo/ui";
import { Text, type TextStyle } from "react-native";

/** Expo UI Text lacks selectable in SDK57. Keep recovery details copyable. */
export function NativeDataText({
  children,
  textStyle,
}: {
  children: React.ReactNode;
  textStyle?: TextStyle;
}) {
  return (
    <RNHostView matchContents={{ vertical: true }}>
      <Text selectable style={textStyle}>
        {children}
      </Text>
    </RNHostView>
  );
}
