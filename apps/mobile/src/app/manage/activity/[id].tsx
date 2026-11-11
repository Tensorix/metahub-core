import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useSession } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";
import { useApiData } from "@/lib/api/hooks";
import { Switch } from "@expo/ui";
import { NativeHost } from "@/components/native/NativeHost";
import { fs } from "@/lib/theme/tokens";
import { ManagementAction } from "@/components/ManagementControls";
const valueLabel = (value: unknown) =>
  value == null
    ? "空"
    : typeof value === "string"
      ? value
      : JSON.stringify(value);
export default function DatabaseActivity() {
  const { id } = useLocalSearchParams<{ id: string }>(),
    session = useSession(),
    { tokens } = useTheme();
  const [showRepair, setShowRepair] = useState(false);
  const fetch = useCallback(async () => {
    const [entries, props] = await Promise.all([
      session.replica.service.call("listDatabaseActivity", id, 200),
      session.client.listProperties(id),
    ]);
    return { entries, names: new Map(props.map((p) => [p.id, p.name])) };
  }, [session, id]);
  const data = useApiData(fetch);
  return (
    <>
      <Stack.Screen options={{ title: "最近动态" }} />
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: tokens.bg }}
        contentContainerStyle={{
          padding: 20,
          paddingBottom: 48,
          gap: 24,
          width: "100%",
          maxWidth: 720,
          alignSelf: "center",
        }}
        data={(data.data?.entries ?? []).filter(
          (row) => showRepair || row.kind !== "repair",
        )}
        keyExtractor={(row) => row.record_id + ":" + row.version}
        ListHeaderComponent={
          <View style={{ gap: 12, paddingBottom: 8 }}>
            <Text style={{ color: tokens.fgSoft, fontSize: fs.ui }}>
              最近 200 条记录动态
            </Text>
            <NativeHost
              matchContents={{ vertical: true }}
              style={{ minHeight: 48 }}
            >
              <Switch
                label="显示修复记录"
                value={showRepair}
                onValueChange={setShowRepair}
              />
            </NativeHost>
          </View>
        }
        ListEmptyComponent={
          <View style={{ gap: 12, paddingVertical: 24 }}>
            {data.loading && <ActivityIndicator color={tokens.accent} />}
            <Text
              accessibilityRole={data.error ? "alert" : undefined}
              style={{
                color: data.error ? tokens.danger : tokens.fgSoft,
                fontSize: fs.body,
              }}
            >
              {data.loading
                ? "加载中…"
                : data.error
                  ? String(data.error)
                  : "暂无动态"}
            </Text>
          </View>
        }
        ListFooterComponent={
          data.error ? (
            <ManagementAction
              label="重试"
              onPress={() => void data.refetch()}
            />
          ) : undefined
        }
        renderItem={({ item }) => (
          <View
            style={{
              gap: 8,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderColor: tokens.line,
              paddingBottom: 24,
            }}
          >
            <Text
              selectable
              style={{
                color: tokens.fg,
                fontWeight: "600",
                fontSize: fs.body,
                lineHeight: 24,
              }}
            >
              {item.record_title || item.record_id}
            </Text>
            <Text
              style={{ color: tokens.fgSoft, fontSize: fs.sm, lineHeight: 20 }}
            >
              {new Date(item.at).toLocaleString()} ·{" "}
              {item.created
                ? "创建"
                : item.deleted
                  ? "删除"
                  : `修改 ${item.changes} 项`}
            </Text>
            {item.diffs.map((diff, index) => (
              <Text
                key={index}
                selectable
                style={{
                  color: tokens.fgSoft,
                  fontSize: fs.ui,
                  lineHeight: 23,
                }}
              >
                {data.data?.names.get(diff.prop) || diff.prop}：
                {valueLabel(diff.before)} → {valueLabel(diff.after)}
              </Text>
            ))}
          </View>
        )}
      />
    </>
  );
}
