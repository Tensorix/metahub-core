import { Text, VStack } from "@expo/ui/swift-ui";
import { font, foregroundStyle, padding } from "@expo/ui/swift-ui/modifiers";
import type { PropsWithChildren } from "react";

export function SettingsDetailRow({ children, supportingText }: PropsWithChildren<{ supportingText?: string }>) {
  return <VStack alignment="leading" spacing={4} modifiers={[padding({ vertical: 4 })]}>
    <Text modifiers={[font({ textStyle: "body" })]}>{children}</Text>
    {supportingText ? <Text modifiers={[
      font({ textStyle: "subheadline" }),
      foregroundStyle({ type: "hierarchical", style: "secondary" }),
    ]}>{supportingText}</Text> : null}
  </VStack>;
}
