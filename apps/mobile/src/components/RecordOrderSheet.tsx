import { RNHostView } from "@expo/ui";
import { useCallback, useState, useRef } from "react";
import { FlatList, Text, View, useWindowDimensions } from "react-native";
import { NativeSheet } from "@/components/native/NativeSheet";
import { NativeButton } from "@/components/native/NativeButton";
import { ManagementInput } from "@/components/ManagementControls";
import { useApiData } from "@/lib/api/hooks";
import { useSession } from "@/lib/auth/session";
import { recordTitle } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import type { PropInfo } from "@/lib/api/sdk";
export function RecordOrderSheet({
  databaseId,
  recordId,
  props,
  onClose,
  onMoved,
}: {
  databaseId: string;
  recordId: string;
  props: PropInfo[];
  onClose: () => void;
  onMoved: () => void;
}) {
  const session = useSession(),
    { client } = session,
    { tokens } = useTheme(),
    { height } = useWindowDimensions();
  const [query, setQuery] = useState(""),
    [offset, setOffset] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const fetch = useCallback(
    () => client.queryRecords(databaseId, { search: query, offset, limit: 60 }),
    [client, databaseId, query, offset],
  );
  const data = useApiData(fetch);
  const moving = useRef(false);
  const move = (target: string, where: "before" | "after") => {
    if (moving.current) return;
    moving.current = true;
    setBusy(true);
    setError("");
    void client
      .moveRecord(recordId, target, where)
      .then(() => {
        if (session.isCurrent()) {
          onMoved();
          onClose();
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => {
        moving.current = false;
        setBusy(false);
      });
  };
  return (
    <NativeSheet
      isPresented
      onDismiss={() => {
        if (!moving.current) onClose();
      }}
      dismissible={!busy}
    >
      <RNHostView matchContents>
        <View
          style={{
            height: Math.min(height * 0.7, 600),
            gap: 8,
            backgroundColor: tokens.surface,
          }}
        >
          <ManagementInput
            disabled={busy}
            label="选择顺序锚点"
            value={query}
            onChange={(q) => {
              setQuery(q);
              setOffset(0);
            }}
          />
          {error || data.error ? (
            <Text
              selectable
              accessibilityRole="alert"
              style={{ color: tokens.danger }}
            >
              {error || String(data.error)}
            </Text>
          ) : null}
          {data.error ? (
            <NativeButton onPress={() => void data.refetch()}>
              重试加载
            </NativeButton>
          ) : null}
          <FlatList
            data={data.data?.records.filter((r) => r.id !== recordId) ?? []}
            keyExtractor={(r) => r.id}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <View style={{ padding: 12, gap: 4 }}>
                <Text style={{ color: tokens.fg }}>
                  {recordTitle(item, props)}
                </Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <NativeButton
                    disabled={busy}
                    onPress={() => move(item.id, "before")}
                  >
                    移到前面
                  </NativeButton>
                  <NativeButton
                    disabled={busy}
                    onPress={() => move(item.id, "after")}
                  >
                    移到后面
                  </NativeButton>
                </View>
              </View>
            )}
            ListEmptyComponent={
              data.error ? null : (
                <Text style={{ color: tokens.muted, padding: 16 }}>
                  {data.loading ? "加载中…" : "没有可用锚点"}
                </Text>
              )
            }
          />
          <View
            style={{ flexDirection: "row", justifyContent: "space-between" }}
          >
            <NativeButton
              disabled={busy || !offset || data.loading}
              onPress={() => setOffset(Math.max(0, offset - 60))}
            >
              上一页
            </NativeButton>
            <NativeButton
              disabled={busy || !data.data?.hasMore || data.loading}
              onPress={() => setOffset(offset + 60)}
            >
              下一页
            </NativeButton>
            <NativeButton disabled={busy} onPress={onClose}>
              完成
            </NativeButton>
          </View>
        </View>
      </RNHostView>
    </NativeSheet>
  );
}
