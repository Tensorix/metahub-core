import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

/** Keep the native Host in the screen hierarchy so it receives layout and mounts. */
export function NoticeOverlay({ children }: { children: ReactNode }) {
  return (
    <View
      collapsable={false}
      pointerEvents="box-none"
      style={[StyleSheet.absoluteFill, { zIndex: 100, elevation: 16 }]}
    >
      {children}
    </View>
  );
}
