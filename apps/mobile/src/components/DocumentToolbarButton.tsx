import type { DocumentToolbarAction } from "./document-toolbar-actions";
import { Icon } from "@expo/ui";
import { NativeButton } from "./native/NativeButton";
import { useTheme } from "@/lib/theme";

const icons = {
  library: require("./native/assets/photo.xml"),
  file: require("./native/assets/attachment.xml"),
  p: require("./native/assets/editor-p.xml"),
  h1: require("./native/assets/editor-h1.xml"),
  h2: require("./native/assets/editor-h2.xml"),
  h3: require("./native/assets/editor-h3.xml"),
  bullet: require("./native/assets/editor-bullet.xml"),
  numbered: require("./native/assets/editor-numbered.xml"),
  todo: require("./native/assets/editor-todo.xml"),
  quote: require("./native/assets/editor-quote.xml"),
  code: require("./native/assets/editor-code.xml"),
  table: require("./native/assets/editor-table.xml"),
  divider: require("./native/assets/editor-divider.xml"),
  audio: require("./native/assets/editor-audio.xml"),
  html: require("./native/assets/editor-html.xml"),
};

export interface DocumentToolbarButtonProps {
  kind: DocumentToolbarAction;
  label: string;
  disabled: boolean;
  onPress(): void;
}
export function DocumentToolbarButton({ kind, label, disabled, onPress }: DocumentToolbarButtonProps) {
  const { tokens, scheme } = useTheme();
  return <NativeButton variant="text" disabled={disabled} onPress={onPress} style={{ width: 40, height: 40 }}>
    <Icon name={icons[kind]}
      size={22} color={disabled ? tokens.muted : scheme === "dark" ? "#ffffff" : "#000000"} accessibilityLabel={label} />
  </NativeButton>;
}
