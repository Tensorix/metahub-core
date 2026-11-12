import {
  BottomSheet,
  Button,
  Checkbox,
  Column,
  List,
  Row,
  Text,
} from "@expo/ui";
import { useCallback } from "react";
import { NativeHost } from "./NativeHost";
import { RecordTextInput } from "../RecordTextInput";
import type {
  SelectionItem,
  SelectionSheetProps,
} from "./SelectionSheet.types";

/** Universal native fallback: Compose owns rows and sheet/keyboard layout. */
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
  const close = () => {
    if (!busy) onClose();
  };
  const renderItem = useCallback(
    ({ item }: { item: SelectionItem }) => (
      <Row>
        <Checkbox
          label={item.title}
          value={item.selected}
          disabled={busy}
          onValueChange={() => onSelect(item.id)}
        />
        {item.canOpen && onOpen && (
          <Button
            variant="text"
            disabled={busy}
            onPress={() => onOpen(item.id)}
          >
            打开
          </Button>
        )}
      </Row>
    ),
    [busy, onSelect, onOpen],
  );
  return (
    <NativeHost style={{ position: "absolute" }} pointerEvents="none">
      <BottomSheet
        isPresented={isPresented}
        onDismiss={close}
        snapPoints={["half", "full"]}
        shouldDismissOnBackPress={!busy}
        shouldDismissOnClickOutside={!busy}
        testID={testID}
      >
        <Column spacing={12}>
          <Text>{title}</Text>
          <Button variant="text" disabled={busy} onPress={close}>
            {busy ? "保存中…" : "完成"}
          </Button>
          {search && (
            <RecordTextInput
              text={search.value}
              placeholder={search.placeholder}
              accessibilityLabel={search.placeholder}
              onChangeText={search.onChange}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
            />
          )}
          <Text>{summary}</Text>
          {loading && <Text>正在加载…</Text>}
          {notices.map((notice, index) => (
            <Column key={index}>
              <Text>{notice.text}</Text>
              {notice.action && (
                <Button disabled={busy} onPress={notice.action.onPress}>
                  {notice.action.label}
                </Button>
              )}
            </Column>
          ))}
          <List>
            <List.ForEach data={items} keyExtractor={(item) => item.id}>
              {renderItem}
            </List.ForEach>
            {!loading && items.length === 0 && empty && <Text>{empty}</Text>}
            {pagination && (
              <Column>
                <Button
                  disabled={!pagination.hasPrevious || loading}
                  onPress={pagination.onPrevious}
                >
                  上一页
                </Button>
                <Text>{"第 " + pagination.page + " 页"}</Text>
                <Button
                  disabled={!pagination.hasNext || loading}
                  onPress={pagination.onNext}
                >
                  下一页
                </Button>
              </Column>
            )}
          </List>
        </Column>
      </BottomSheet>
    </NativeHost>
  );
}
