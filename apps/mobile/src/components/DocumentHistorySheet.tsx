import { RNHostView } from "@expo/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Text, View } from "react-native";
import { NativeSheet } from "@/components/native/NativeSheet";
import { useSheetContentHeight } from "@/components/native/useSheetContentHeight";
import { NativeButton } from "@/components/native/NativeButton";
import { useApiData } from "@/lib/api/hooks";
import { useSession } from "@/lib/auth/session";
import type { ReplicaClient } from "@/lib/replica";
import { useTheme } from "@/lib/theme";
type Preview = Awaited<ReturnType<ReplicaClient["documentAt"]>>;
export function DocumentHistorySheet({
  documentId,
  visible,
  onClose,
  onReverted,
}: {
  documentId: string;
  visible: boolean;
  onClose: () => void;
  onReverted: () => void;
}) {
  const { client, isCurrent } = useSession();
  const { tokens } = useTheme();
  const sheetHeight = useSheetContentHeight(680, 0.72);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    const current = generation;
    return () => {
      current.current++;
    };
  }, []);
  const fetchHistory = useCallback(
    async () =>
      visible
        ? {
            revisions: await client.documentHistory(documentId),
            current: await client.getDocument(documentId),
          }
        : null,
    [client, documentId, visible],
  );
  const history = useApiData(fetchHistory);
  const show = async (version: string) => {
    const g = generation.current;
    setBusy(true);
    setError("");
    try {
      const p = await client.documentAt(documentId, version);
      if (isCurrent() && g === generation.current) setPreview(p);
    } catch (e) {
      if (isCurrent() && g === generation.current)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (g === generation.current) setBusy(false);
    }
  };
  const restore = () => {
    if (!preview || !history.data) return;
    const p = preview;
    const version = history.data.current.version;
    Alert.alert(
      "恢复此版本",
      "当前文档将以新版本保存。若文档已被其他设备更新，将保留当前内容并提示重试。",
      [
        { text: "取消", style: "cancel" },
        {
          text: "恢复",
          onPress: () =>
            void (async () => {
              const g = generation.current;
              setBusy(true);
              setError("");
              try {
                await client.revertDocument(documentId, p.version, version);
                if (isCurrent() && g === generation.current) {
                  onReverted();
                  onClose();
                }
              } catch (e) {
                if (isCurrent() && g === generation.current) {
                  setError(e instanceof Error ? e.message : String(e));
                  void history.refetch();
                }
              } finally {
                if (g === generation.current) setBusy(false);
              }
            })(),
        },
      ],
    );
  };
  return (
    <NativeSheet
      isPresented={visible}
      onDismiss={() => {
        if (!busy) onClose();
      }}
      dismissible={!busy}
    >
      <RNHostView matchContents={{ vertical: true }}>
        <View
          style={{
            height: sheetHeight,
            width: "100%",
            gap: 12,
            backgroundColor: tokens.surface,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <Text
              selectable
              style={{ fontSize: 18, color: tokens.fg, fontWeight: "600" }}
            >
              {preview ? "版本预览" : "文档历史"}
            </Text>
            <NativeButton
              variant="text"
              disabled={busy}
              onPress={() => (preview ? setPreview(null) : onClose())}
            >
              {preview ? "返回" : "完成"}
            </NativeButton>
          </View>
          {(history.loading || busy) && <ActivityIndicator />}
          {(error || history.error) && (
            <View>
              <Text
                selectable
                accessibilityRole="alert"
                style={{ color: tokens.danger }}
              >
                {error || history.error?.message}
              </Text>
              <NativeButton
                onPress={() => {
                  setError("");
                  void history.refetch();
                }}
              >
                重试
              </NativeButton>
            </View>
          )}
          {preview ? (
            <>
              <Text selectable style={{ color: tokens.fg, fontWeight: "600" }}>
                {preview.title || "未命名"}
                {preview.deleted ? "（已删除）" : ""}
              </Text>
              <FlatList
                style={{ flex: 1 }}
                contentInsetAdjustmentBehavior="automatic"
                data={preview.body.split("\n")}
                keyExtractor={(_line, index) => String(index)}
                renderItem={({ item }) => (
                  <Text selectable style={{ color: tokens.fg, lineHeight: 24 }}>
                    {item || " "}
                  </Text>
                )}
              />
              <NativeButton disabled={busy} onPress={restore}>
                恢复此版本
              </NativeButton>
            </>
          ) : (
            <FlatList
              style={{ flex: 1 }}
              contentInsetAdjustmentBehavior="automatic"
              data={history.data?.revisions ?? []}
              keyExtractor={(r) => r.version}
              renderItem={({ item }) => (
                <NativeButton
                  variant="text"
                  disabled={busy}
                  onPress={() => void show(item.version)}
                >
                  {new Date(item.at).toLocaleString() +
                    " · " +
                    (item.created
                      ? "创建"
                      : item.deleted
                        ? "删除"
                        : "改动 " + item.changes + " 项")}
                </NativeButton>
              )}
              ListEmptyComponent={
                !history.loading && !history.error ? (
                  <Text style={{ color: tokens.muted }}>暂无历史</Text>
                ) : undefined
              }
            />
          )}
        </View>
      </RNHostView>
    </NativeSheet>
  );
}
