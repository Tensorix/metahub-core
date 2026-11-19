import type { DocumentToolbarAction } from "./document-toolbar-actions";
import { Icon } from "@expo/ui";
import { NativeButton } from "./native/NativeButton";
import { useTheme } from "@/lib/theme";

import { toolbarIcons } from "./document-toolbar-icons";

export interface DocumentToolbarButtonProps {
  kind: DocumentToolbarAction;
  label: string;
  disabled: boolean;
  onPress(): void;
}
export function DocumentToolbarButton({ kind, label, disabled, onPress }: DocumentToolbarButtonProps) {
  const { tokens, scheme } = useTheme();
  return <NativeButton variant="text" disabled={disabled} onPress={onPress} style={{ width: 40, height: 40 }}>
    <Icon name={toolbarIcons[kind]}
      size={22} color={disabled ? tokens.muted : scheme === "dark" ? "#ffffff" : "#000000"} accessibilityLabel={label} />
  </NativeButton>;
}
