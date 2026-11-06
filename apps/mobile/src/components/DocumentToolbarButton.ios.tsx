import { DOCUMENT_TOOLBAR_ACTIONS } from "./document-toolbar-actions";
import { Button } from "@expo/ui/swift-ui";
import { accessibilityLabel, buttonStyle, controlSize, disabled as disabledModifier, frame, labelStyle, tint } from "@expo/ui/swift-ui/modifiers";
import { NativeHost } from "./native/NativeHost";
import type { DocumentToolbarButtonProps } from "./DocumentToolbarButton";
import { useTheme } from "@/lib/theme";

export function DocumentToolbarButton({ kind, label, disabled, onPress }: DocumentToolbarButtonProps) {
  const { scheme } = useTheme();
  return <NativeHost matchContents>
    <Button systemImage={DOCUMENT_TOOLBAR_ACTIONS.find(action => action.kind === kind)!.symbol}
      label={label} onPress={onPress} modifiers={[
        buttonStyle("borderless"), labelStyle("iconOnly"), controlSize("small"),
        tint(scheme === "dark" ? "#ffffff" : "#000000"),
        frame({ width: 36, height: 36 }), accessibilityLabel(label), disabledModifier(disabled),
      ]} />
  </NativeHost>;
}
