import { Stack } from "expo-router";
import { useState } from "react";
import { FlatList, Text, View, Platform } from "react-native";
import { useTheme } from "@/lib/theme";
import { useSites } from "@/lib/navigation/use-sites";
import { SiteShortcut } from "@/components/SiteShortcut";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
export default function SitesScreen() {
  const { tokens } = useTheme();
  const sites = useSites();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Stack.Screen
        options={{
          title: "Sites",
          headerTintColor: tokens.fg,
          ...(Platform.OS === "ios"
            ? {
                headerTransparent: true,
                headerShadowVisible: false,
                headerLargeTitleShadowVisible: false,
                headerLargeStyle: { backgroundColor: "transparent" },
                headerBlurEffect: "none",
                headerSearchBarOptions: {
                  placeholder: "查找站点",
                  hideWhenScrolling: true,
                  placement: "stacked",
                  onChangeText: (e) => setQuery(e.nativeEvent.text),
                  onCancelButtonPress: () => setQuery(""),
                },
              }
            : { headerStyle: { backgroundColor: tokens.bg } }),
        }}
      />
      <FlatList
        style={{ flex: 1, backgroundColor: tokens.bg }}
        data={(sites.data ?? []).filter((s) =>
          s.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
        )}
        numColumns={3}
        keyExtractor={(s) => s.id}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 20, gap: 24 }}
        columnWrapperStyle={{ gap: 12 }}
        ListHeaderComponent={
          <View style={{ gap: 12 }}>
            <Text
              style={{ color: tokens.fgSoft, fontSize: 15, lineHeight: 22 }}
            >
              你的站点与小工具。打开后会出现在首页。
            </Text>
            {sites.error ? (
              <ErrorBanner message="站点列表加载失败" onRetry={sites.refetch} />
            ) : null}
            {error ? <ErrorBanner message={error} /> : null}
          </View>
        }
        renderItem={({ item }) => (
          <View
            style={{
              flex: 1,
              maxWidth: "33.33%",
              alignItems: "center",
              gap: 4,
            }}
          >
            <SiteShortcut
              title={item.title}
              iconUri={item.iconUri}
              onPress={() => {
                setError(null);
                void sites
                  .open(item)
                  .catch(() => setError("站点暂时无法打开，请稍后重试"));
              }}
            />
            <Text
              style={{
                color: tokens.fgSoft,
                fontSize: 12,
                textAlign: "center",
              }}
            >
              {!item.hasEntry
                ? "入口文件尚未同步"
                : sites.missing(item.id).length
                  ? "正在准备资源"
                  : "可离线使用"}
            </Text>
            {item.url && (
              <Text
                accessibilityRole="link"
                style={{ color: tokens.fgSoft }}
                onPress={() =>
                  void sites
                    .published(item)
                    ?.catch(() => setError("发布版暂时无法打开"))
                }
              >
                打开发布版
              </Text>
            )}
          </View>
        )}
        ListEmptyComponent={
          sites.loading ? (
            <EmptyState title="正在读取站点…" />
          ) : !sites.error ? (
            <EmptyState
              title={query ? "没有匹配的站点" : "还没有 Sites"}
              hint="在桌面端创建并同步站点后，这里会自动出现"
            />
          ) : undefined
        }
      />
    </>
  );
}
