import { Stack, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Platform, ScrollView, Text, View } from "react-native";
import { useSession } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";
import { useApiData, useLiveInvalidate } from "@/lib/api/hooks";
import { useRecents } from "@/lib/navigation/use-recents";
import { useSites } from "@/lib/navigation/use-sites";
import { useDocumentActions } from "@/lib/browse/use-document-actions";
import { HomeFeed } from "@/components/native/HomeFeed";
import { BrowseCreate } from "@/components/BrowseCreate";
import { BrowseSearch } from "@/components/native/BrowseSearch";
import { NativeButton } from "@/components/native/NativeButton";
import { SearchResults } from "@/components/SearchResults";
import { SiteShortcut } from "@/components/SiteShortcut";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
export default function HomeScreen() {
  const router = useRouter();
  const actions = useDocumentActions();
  const { client } = useSession();
  const { tokens } = useTheme();
  const { items } = useRecents();
  const sites = useSites();
  const [query, setQuery] = useState("");
  const [openError, setOpenError] = useState<string | null>(null);
  const docIdsKey = JSON.stringify(
    items.filter((i) => i.kind === "document").map((i) => i.id),
  );
  const docIds = useMemo(() => JSON.parse(docIdsKey) as string[], [docIdsKey]);
  const fetcher = useCallback(
    () => client.referenceSummaries({ kind: "document", ids: docIds }),
    [client, docIds],
  );
  const recent = useApiData(fetcher);
  useLiveInvalidate(["documents"], () => void recent.refetch());
  const documents = docIds.flatMap((id) => {
    const d = recent.data?.find((d) => d.id === id && !d.missing);
    return d ? [d] : [];
  });
  const recentSites = items
    .filter((i) => i.kind === "site")
    .flatMap((i) => {
      const s = sites.data?.find((s) => s.id === i.id);
      return s ? [s] : [];
    })
    .slice(0, 5);
  return (
    <>
      {query.trim() ? (
        <SearchResults query={query} />
      ) : (
        <HomeFeed
          actions={actions}
          documents={documents.slice(0, 12)}
          openDocument={(id) => router.push(`/doc/${id}`)}
          header={
            <View>
              <BrowseSearch />
              <Text
                accessibilityRole="header"
                style={{
                  fontSize: 22,
                  fontWeight: "700",
                  color: tokens.fg,
                  marginHorizontal: 20,
                  marginTop: 20,
                  marginBottom: 20,
                }}
              >
                最近使用的 Sites
              </Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}
              >
                {recentSites.map((site) => (
                  <SiteShortcut
                    key={site.id}
                    title={site.title}
                    iconUri={site.iconUri}
                    onPress={() => {
                      setOpenError(null);
                      void sites
                        .open(site)
                        .catch(() =>
                          setOpenError("站点暂时无法打开，请稍后重试"),
                        );
                    }}
                  />
                ))}
                <SiteShortcut
                  title="更多"
                  more
                  onPress={() => router.push("/sites")}
                />
              </ScrollView>
              {!recentSites.length ? (
                <Text
                  style={{
                    color: tokens.fgSoft,
                    fontSize: 14,
                    marginHorizontal: 20,
                    marginTop: 6,
                  }}
                >
                  使用过的站点会显示在这里
                </Text>
              ) : null}
              {sites.error ? (
                <ErrorBanner message="Sites 加载失败" onRetry={sites.refetch} />
              ) : null}
              {openError ? <ErrorBanner message={openError} /> : null}
              <Text
                accessibilityRole="header"
                style={{
                  fontSize: 22,
                  fontWeight: "700",
                  color: tokens.fg,
                  marginHorizontal: 20,
                  marginTop: 36,
                  marginBottom: 8,
                }}
              >
                最近打开的文档
              </Text>
              {recent.error ? (
                <ErrorBanner
                  message="最近文档加载失败"
                  onRetry={recent.refetch}
                />
              ) : null}
            </View>
          }
          empty={
            !documents.length && !recent.error ? (
              <View>
                <EmptyState
                  title={
                    recent.loading ? "正在读取最近文档…" : "从一篇文档开始"
                  }
                  hint={
                    recent.loading
                      ? undefined
                      : "在资料库打开文档，下次从这里继续"
                  }
                />
                {!recent.loading ? (
                  <View style={{ alignItems: "center" }}>
                    <NativeButton onPress={() => router.push("/library")}>
                      浏览资料库
                    </NativeButton>
                  </View>
                ) : null}
              </View>
            ) : null
          }
        />
      )}
      <Stack.Title large={Platform.OS === "ios"}>首页</Stack.Title>
      {Platform.OS === "ios" ? (
        <Stack.SearchBar
          placeholder="搜索文档与记录"
          hideWhenScrolling
          placement="stacked"
          onChangeText={(e) => setQuery(e.nativeEvent.text)}
          onCancelButtonPress={() => setQuery("")}
        />
      ) : null}
      <BrowseCreate />
    </>
  );
}
