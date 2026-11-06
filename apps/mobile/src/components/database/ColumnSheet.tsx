import { RNHostView } from "@expo/ui";
import { ScrollView, View, Text, useWindowDimensions } from "react-native";
import { NativeSheet } from "../native/NativeSheet";
import { NativeButton } from "../native/NativeButton";
import type { NativeMenuItem } from "../native/NativeMenu.types";
import { useTheme } from "@/lib/theme";
export function ColumnSheet({
  label,
  items,
  onClose,
}: {
  label: string;
  items: NativeMenuItem[];
  onClose(): void;
}) {
  const { tokens } = useTheme(),
    { height } = useWindowDimensions();
  return (
    <NativeSheet isPresented onDismiss={onClose}>
      <RNHostView matchContents={{ vertical: true }}>
        <View
          style={{
            height: Math.min(560, height * 0.65),
            backgroundColor: tokens.surface,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
              padding: 8,
            }}
          >
            <Text style={{ color: tokens.fg, fontWeight: "600", fontSize: 18 }}>
              {label}
            </Text>
            <NativeButton variant="text" onPress={onClose}>
              完成
            </NativeButton>
          </View>
          <ScrollView>
            {items.map((item) => (
              <NativeButton
                key={item.id}
                variant="text"
                disabled={item.disabled}
                onPress={() => {
                  item.onPress();
                  onClose();
                }}
              >
                {item.title}
              </NativeButton>
            ))}
          </ScrollView>
        </View>
      </RNHostView>
    </NativeSheet>
  );
}
