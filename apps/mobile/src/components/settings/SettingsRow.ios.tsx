import { Button, HStack, Image, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  accessibilityHidden, background, buttonStyle, contentShape, font,
  foregroundStyle, frame, lineLimit, shapes, truncationMode,
} from "@expo/ui/swift-ui/modifiers";
import { useTheme } from "@/lib/theme";

export function SettingsRow({ title, value, icon, onPress }: {
  title: string;
  value?: string;
  icon: "sun.max" | "internaldrive" | "folder" | "arrow.triangle.2.circlepath" | "info.circle";
  onPress: () => void;
}) {
  const { tokens } = useTheme();
  return (
    <Button onPress={onPress} modifiers={[buttonStyle("plain")]}>
      <HStack spacing={12} modifiers={[frame({ minHeight: 48 }), contentShape(shapes.rectangle())]}>
        <Image systemName={icon} size={18} modifiers={[
          foregroundStyle(tokens.accent), frame({ width: 32, height: 32 }),
          background(tokens.accentSoft, shapes.roundedRectangle({ cornerRadius: 8 })),
          accessibilityHidden(),
        ]} />
        <VStack alignment="leading" spacing={4}>
          <Text modifiers={[font({ textStyle: "body" })]}>{title}</Text>
          {value && <Text modifiers={[
            font({ textStyle: "subheadline" }), lineLimit(2), truncationMode("middle"),
            foregroundStyle({ type: "hierarchical", style: "secondary" }),
          ]}>{value}</Text>}
        </VStack>
        <Spacer />
        <Image systemName="chevron.right" size={11} modifiers={[
          font({ size: 11, weight: "semibold" }),
          foregroundStyle({ type: "hierarchical", style: "tertiary" }), accessibilityHidden(),
        ]} />
      </HStack>
    </Button>
  );
}
