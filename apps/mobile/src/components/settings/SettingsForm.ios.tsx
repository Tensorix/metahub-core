import { Form } from "@expo/ui/swift-ui";
import { scrollEdgeEffectStyle } from "@expo/ui/swift-ui/modifiers";
import type { PropsWithChildren } from "react";

export function SettingsForm({ children }: PropsWithChildren) {
  // Keep SwiftUI's grouped canvas and automatic insets beneath native navigation.
  return <Form modifiers={[scrollEdgeEffectStyle("soft", "top")]}>{children}</Form>;
}
