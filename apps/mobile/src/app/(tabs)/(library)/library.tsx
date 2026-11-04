import { Stack, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { FlatList, Platform, Text, View } from "react-native";
import { useSession } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";
import { useApiData, useLiveInvalidate } from "@/lib/api/hooks";
import { documentPageRows, validPageOffset } from "@/lib/browse/management";
import { LibrarySwitch } from "@/components/native/LibrarySwitch";
import type { LibraryKind } from "@/components/native/LibrarySwitch.types";
import { BrowseSearch } from "@/components/native/BrowseSearch";
import { BrowseCreate } from "@/components/BrowseCreate";
import { BrowseRow } from "@/components/BrowseRow";
import { NativeButton } from "@/components/native/NativeButton";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
export default function LibraryScreen() {
  const { client, workspaceId } = useSession();
  const { tokens } = useTheme();
  const router = useRouter();
  const [kind, setKind] = useState<LibraryKind>("documents");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState({ key: "", offset: 0 });
  const key = `${workspaceId}:${query}`;
  const offset = page.key === key ? page.offset : 0;
  const fetcher = useCallback(
    () =>
      Promise.all([
        client.queryDocuments({ search: query, offset, limit: 60 }),
        client.listDatabases(),
      ]),
    [client, query, offset],
  );
  const { data, error, loading, refetch } = useApiData(fetcher);
  useLiveInvalidate(["documents", "databases"], () => void refetch());
  const docs = data?.[0];
  const dbs = data?.[1] ?? [];
  if (docs && validPageOffset(offset, docs.total, 60) !== offset)
    setPage({ key, offset: validPageOffset(offset, docs.total, 60) });
  const rows =
    kind === "documents"
      ? documentPageRows(docs?.documents ?? []).map((r) => ({
          id: r.doc.id,
          title: r.doc.title,
          depth: r.depth,
        }))
      : dbs
          .filter((d) =>
            d.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
          )
          .map((d) => ({ id: d.id, title: d.name, depth: 0 }));
  return (
    <>
      <FlatList
        style={{ flex: 1, backgroundColor: tokens.bg }}
        data={rows}
        key={kind}
        keyExtractor={(r) => r.id}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingBottom: Platform.OS === "android" ? 100 : 28,
        }}
        ListHeaderComponent={
          <>
            <BrowseSearch />
            <View
              style={{
                paddingHorizontal: 20,
                paddingTop: 12,
                paddingBottom: 16,
              }}
            >
              <LibrarySwitch value={kind} onChange={setKind} />
              <Text
                style={{ color: tokens.fgSoft, fontSize: 13, marginTop: 16 }}
              >
                {kind === "documents"
                  ? `${docs?.total ?? 0} 篇文档`
                  : `${rows.length} 个数据表`}
              </Text>
            </View>
            {error ? (
              <ErrorBanner message="资料加载失败" onRetry={refetch} />
            ) : null}
          </>
        }
        renderItem={({ item }) => (
          <BrowseRow
            title={item.title}
            depth={item.depth}
            kind={kind === "documents" ? "document" : "database"}
            onPress={() =>
              router.push(
                kind === "documents" ? `/doc/${item.id}` : `/db/${item.id}`,
              )
            }
          />
        )}
        ListEmptyComponent={
          loading ? (
            <EmptyState title="正在读取资料…" />
          ) : !error ? (
            <EmptyState
              title={
                query
                  ? "没有匹配结果"
                  : kind === "documents"
                    ? "还没有文档"
                    : "还没有数据表"
              }
              hint={query ? "试试其他关键词" : "点按新建，添加第一份资料"}
            />
          ) : undefined
        }
        ListFooterComponent={
          kind === "documents" && (offset > 0 || docs?.hasMore) ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                padding: 20,
              }}
            >
              <NativeButton
                disabled={!offset || loading}
                onPress={() =>
                  setPage({ key, offset: Math.max(0, offset - 60) })
                }
              >
                上一页
              </NativeButton>
              <Text style={{ color: tokens.fgSoft }}>
                第 {Math.floor(offset / 60) + 1} 页
              </Text>
              <NativeButton
                disabled={!docs?.hasMore || loading}
                onPress={() => setPage({ key, offset: offset + 60 })}
              >
                下一页
              </NativeButton>
            </View>
          ) : undefined
        }
      />
      <Stack.Title large={Platform.OS === "ios"}>资料库</Stack.Title>
      {Platform.OS === "ios" ? (
        <Stack.SearchBar
          placeholder={kind === "documents" ? "搜索文档" : "搜索数据表"}
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
