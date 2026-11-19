import { Icon, IconButton } from "@expo/ui/jetpack-compose";
import { size } from "@expo/ui/jetpack-compose/modifiers";
import { NativeHost } from "./native/NativeHost";
import { toolbarIcons } from "./document-toolbar-icons";
import type { DocumentToolbarButtonProps } from "./DocumentToolbarButton";

export function DocumentToolbarButton({ kind, label, disabled, onPress }: DocumentToolbarButtonProps) {
  return <NativeHost matchContents style={{ width: 48, height: 48 }}>
    <IconButton enabled={!disabled} modifiers={[size(48, 48)]} onClick={onPress}>
      <Icon source={toolbarIcons[kind]} size={24} contentDescription={label} />
    </IconButton>
  </NativeHost>;
}
