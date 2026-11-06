import {
  NavigationStack,
  Picker,
  Text,
  Toolbar,
  ToolbarItem,
} from "@expo/ui/swift-ui";
import {
  accessibilityHidden,
  containerBackground,
  controlSize,
  frame,
  navigationBarTitleDisplayMode,
  pickerStyle,
  scaleEffect,
  offset,
  tag,
} from "@expo/ui/swift-ui/modifiers";
import { NativeHost } from "./NativeHost";
import type { ListProps } from "./LibraryList.types";

/** Toolbar context gives the system Picker both its glass track and moving lens. */
export function LibraryKindPicker({
  top,
  kind,
  changeKind,
}: Pick<ListProps, "kind" | "changeKind"> & { top: number }) {
  return (
    // A separate host keeps this navigation stack out of the list's scroll hierarchy.
    <NativeHost
      ignoreSafeArea="all"
      style={{
        position: "absolute",
        top,
        alignSelf: "center",
        width: 200,
        // Leave room for the native toolbar and the raised interactive lens.
        height: 80,
      }}
    >
      {/* Scale track, labels and lens together. Offset by 80 * (1 - 0.85) / 2 to keep the top fixed. */}
      <NavigationStack modifiers={[scaleEffect(0.85), offset({ y: -6 })]}>
        <Toolbar
          modifiers={[
            navigationBarTitleDisplayMode("inline"),
            containerBackground("clear", "navigation"),
          ]}
        >
          <Text modifiers={[accessibilityHidden(true)]}>{" "}</Text>
          <Toolbar.Content>
            <ToolbarItem placement="principal">
              <Picker
                label="资料类型"
                selection={kind}
                onSelectionChange={changeKind}
                modifiers={[
                  pickerStyle("segmented"),
                  controlSize("regular"),
                  frame({ width: 168 }),
                ]}
              >
                <Text modifiers={[tag("documents")]}>文档</Text>
                <Text modifiers={[tag("databases")]}>数据表</Text>
              </Picker>
            </ToolbarItem>
          </Toolbar.Content>
        </Toolbar>
      </NavigationStack>
    </NativeHost>
  );
}
