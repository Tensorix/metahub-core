import { BottomSheet, ListItem } from "@expo/ui";
import {
  Button,
  HStack,
  Image,
  List,
  NavigationStack,
  ProgressView,
  Section,
  Text,
  Toolbar,
  ToolbarItem,
} from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  accessibilityValue,
  buttonStyle,
  disabled,
  fixedSize,
  foregroundStyle,
  interactiveDismissDisabled,
  labelStyle,
  navigationTitle,
  navigationBarTitleDisplayMode,
  scrollDismissesKeyboard,
  textSelection,
} from "@expo/ui/swift-ui/modifiers";
import { useCallback } from "react";
import { NativeHost } from "./NativeHost";
import { useTheme } from "@/lib/theme";
import { RecordTextInput } from "../RecordTextInput";
import type {
  SelectionItem,
  SelectionSheetProps,
} from "./SelectionSheet.types";

// The native navigation/list tree owns sizing, safe areas, keyboard avoidance,
// typography and row insets. No Yoga height measurement inside a fitted sheet.
export function SelectionSheet({
  title,
  isPresented = true,
  onClose,
  busy = false,
  items,
  onSelect,
  onOpen,
  search,
  summary,
  loading,
  notices = [],
  pagination,
  empty,
  testID,
}: SelectionSheetProps) {
  const { tokens } = useTheme();
  const close = () => {
    if (!busy) onClose();
  };
  const renderItem = useCallback(
    ({ item }: { item: SelectionItem }) => (
      <HStack>
        <ListItem
          onPress={() => onSelect(item.id)}
          modifiers={[
            disabled(busy),
            accessibilityLabel(item.title),
            accessibilityValue(item.selected ? "已选" : "未选"),
          ]}
          trailing={
            item.selected ? (
              <Image
                systemName="checkmark"
                modifiers={[foregroundStyle(tokens.accent)]}
              />
            ) : undefined
          }
        >
          <Text modifiers={[fixedSize({ horizontal: false, vertical: true })]}>
            {item.title}
          </Text>
        </ListItem>
        {item.canOpen && onOpen && (
          <Button
            onPress={() => onOpen(item.id)}
            modifiers={[buttonStyle("borderless"), disabled(busy)]}
          >
            <Text>打开</Text>
          </Button>
        )}
      </HStack>
    ),
    [busy, onSelect, onOpen, tokens.accent],
  );
  return (
    <NativeHost style={{ position: "absolute" }} pointerEvents="none">
      <BottomSheet
        isPresented={isPresented}
        onDismiss={close}
        snapPoints={["half", "full"]}
        contentPadding={0}
        modifiers={[interactiveDismissDisabled(busy)]}
        testID={testID}
      >
        <NavigationStack>
          <Toolbar
            modifiers={[
              navigationTitle(title),
              navigationBarTitleDisplayMode("inline"),
            ]}
          >
            <List modifiers={[scrollDismissesKeyboard("interactively")]}>
              {search && (
                <Section>
                  <RecordTextInput
                    text={search.value}
                    placeholder={search.placeholder}
                    accessibilityLabel={search.placeholder}
                    onChangeText={search.onChange}
                    autoCorrect={false}
                    autoCapitalize="none"
                    returnKeyType="search"
                  />
                </Section>
              )}
              {(loading || notices.length > 0) && (
                <Section>
                  {loading && <ProgressView />}
                  {notices.map((notice, index) => (
                    <Section key={index}>
                      <Text modifiers={[textSelection(true)]}>
                        {notice.text}
                      </Text>
                      {notice.action && (
                        <Button
                          onPress={notice.action.onPress}
                          modifiers={[disabled(busy)]}
                        >
                          <Text>{notice.action.label}</Text>
                        </Button>
                      )}
                    </Section>
                  ))}
                </Section>
              )}
              <Section title={summary}>
                <List.ForEach data={items} keyExtractor={(item) => item.id}>
                  {renderItem}
                </List.ForEach>
                {!loading && items.length === 0 && empty && (
                  <Text
                    modifiers={[
                      foregroundStyle({
                        type: "hierarchical",
                        style: "secondary",
                      }),
                    ]}
                  >
                    {empty}
                  </Text>
                )}
              </Section>
              {pagination && (
                <Section>
                  <Button
                    onPress={pagination.onPrevious}
                    modifiers={[disabled(!pagination.hasPrevious || !!loading)]}
                  >
                    <Text>上一页</Text>
                  </Button>
                  <Text>{"第 " + pagination.page + " 页"}</Text>
                  <Button
                    onPress={pagination.onNext}
                    modifiers={[disabled(!pagination.hasNext || !!loading)]}
                  >
                    <Text>下一页</Text>
                  </Button>
                </Section>
              )}
            </List>
            <Toolbar.Content>
              <ToolbarItem placement="confirmationAction">
                <Button
                  label="完成"
                  systemImage="checkmark"
                  onPress={close}
                  modifiers={[
                    labelStyle("iconOnly"),
                    accessibilityLabel(busy ? "保存中" : "完成"),
                    disabled(busy),
                  ]}
                />
              </ToolbarItem>
            </Toolbar.Content>
          </Toolbar>
        </NavigationStack>
      </BottomSheet>
    </NativeHost>
  );
}
