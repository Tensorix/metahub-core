import { Picker, Text } from "@expo/ui/swift-ui";
import { pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { NativeHost } from "./NativeHost";
import type { LibraryKind, LibrarySwitchProps } from "./LibrarySwitch.types";
export function LibrarySwitch({ value, onChange }: LibrarySwitchProps) {
  return (
    <NativeHost matchContents={{ vertical: true }} style={{ minHeight: 44 }}>
      <Picker<LibraryKind>
        label="资料类型"
        selection={value}
        onSelectionChange={onChange}
        modifiers={[pickerStyle("segmented")]}
      >
        <Text modifiers={[tag("documents")]}>文档</Text>
        <Text modifiers={[tag("databases")]}>数据表</Text>
      </Picker>
    </NativeHost>
  );
}
