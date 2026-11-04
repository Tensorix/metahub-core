import { RNHostView } from "@expo/ui";
import { useCallback, useState } from "react";
import { FlatList, Text, View } from "react-native";
import { NativeSheet } from "@/components/native/NativeSheet";
import { useSheetContentHeight } from "@/components/native/useSheetContentHeight";
import { NativeButton } from "@/components/native/NativeButton";
import { ManagementInput } from "@/components/ManagementControls";
import { useApiData } from "@/lib/api/hooks";
import { useSession } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";
export function DatabasePickerSheet({
  onSelect,
  onClose,
}: {
  onSelect: (id: string, name: string) => void;
  onClose: () => void;
}) {
  const { client } = useSession(),
    { tokens } = useTheme(),
    sheetHeight = useSheetContentHeight(600, 0.7),
    [query, setQuery] = useState("");
  const fetch = useCallback(() => client.listDatabases(), [client]);
  const data = useApiData(fetch);
  return (
    <NativeSheet isPresented onDismiss={onClose}>
      <RNHostView matchContents={{ vertical: true }}>
        <View
          style={{
            height: sheetHeight,
            width: "100%",
            backgroundColor: tokens.surface,
            gap: 8,
          }}
        >
          <ManagementInput
            label="搜索数据库"
            value={query}
            onChange={setQuery}
          />
          {data.error ? (
            <NativeButton onPress={() => void data.refetch()}>
              加载失败，重试
            </NativeButton>
          ) : null}
          <FlatList
            style={{ flex: 1 }}
            keyboardShouldPersistTaps="always"
            keyboardDismissMode="interactive"
            data={(data.data ?? []).filter((d) =>
              d.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
            )}
            keyExtractor={(d) => d.id}
            renderItem={({ item }) => (
              <NativeButton
                variant="text"
                onPress={() => {
                  onSelect(item.id, item.name);
                  onClose();
                }}
              >
                {item.name}
              </NativeButton>
            )}
            ListEmptyComponent={
              !data.error ? (
                <Text style={{ color: tokens.muted, padding: 16 }}>
                  {data.loading ? "加载中…" : "没有匹配的数据库"}
                </Text>
              ) : undefined
            }
          />
          <NativeButton onPress={onClose}>取消</NativeButton>
        </View>
      </RNHostView>
    </NativeSheet>
  );
}
