import { Form } from "@expo/ui/swift-ui";
import { scrollContentBackground, scrollEdgeEffectStyle } from "@expo/ui/swift-ui/modifiers";
import type { PropsWithChildren } from "react";
export function SettingsForm({ children }: PropsWithChildren) {
  return <Form modifiers={[scrollContentBackground("hidden"), scrollEdgeEffectStyle("soft", "top")]}>{children}</Form>;
}
