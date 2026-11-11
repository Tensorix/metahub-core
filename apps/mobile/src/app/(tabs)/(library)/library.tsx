import { UndoNotice } from "@/components/UndoNotice";
import { Stack, useRouter } from "expo-router";
import {
  useCallback,
  useMemo,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { Platform, View } from "react-native";
import { useSession } from "@/lib/auth/session";
import { useLiveInvalidate } from "@/lib/api/hooks";
import { LibraryTree, type LibraryKind, type Row } from "@/lib/browse/library";
import { useDocumentActions } from "@/lib/browse/use-document-actions";
import { LibraryList } from "@/components/native/LibraryList";
import { LibrarySearch } from "@/components/native/LibrarySearch";
import { BrowseCreate } from "@/components/BrowseCreate";
export default function LibraryScreen() {
  const session = useSession();
  return <WorkspaceLibrary key={session.id} />;
}
function WorkspaceLibrary() {
  const session = useSession(),
    router = useRouter();
  const [kind, setKind] = useState<LibraryKind>("documents"),
    [query, setQuery] = useState("");
  const actions = useDocumentActions(kind);
  const browse = useMemo(
    () => new LibraryTree(session.replica.db, kind, ""),
    [session.replica, kind],
  );
  const needle = query.trim();
  const tree = useMemo(
    () => (needle ? new LibraryTree(session.replica.db, kind, needle) : browse),
    [session.replica, kind, browse, needle],
  );
  const current = useRef(tree);
  useLayoutEffect(() => {
    current.current = tree;
  }, [tree]);
  const [revision, update] = useReducer((n: number) => n + 1, 0);
  // The controller mutates only on an explicit load, toggle or invalidation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => tree.rows(), [tree, revision]);
  const browseRows = useMemo(
    () => (tree === browse ? rows : browse.rows()),
    [browse, tree, rows],
  );
  const more = useCallback(
    (row: Row) => {
      if (
        current.current !== tree ||
        !tree.rows().some((r) => r.key === row.key)
      )
        return;
      if (row.error) tree.refresh();
      else tree.load(row.branch);
      update();
    },
    [tree],
  );
  const toggle = useCallback(
    (row: Row) => {
      tree.toggle(row.key);
      update();
    },
    [tree],
  );
  const open = useCallback(
    (row: Row) =>
      router.push(kind === "documents" ? `/doc/${row.key}` : `/db/${row.key}`),
    [router, kind],
  );
  const reload = () => {
    current.current.refresh();
    if (browse !== current.current) browse.refresh();
    update();
  };
  useLiveInvalidate([kind], reload);
  const [refreshing, setRefreshing] = useState(false),
    [error, setError] = useState("");
  const active = useRef<Promise<void> | null>(null);
  const refresh = () => {
    if (active.current) return active.current;
    const run = async () => {
      setRefreshing(true);
      setError("");
      reload();
      try {
        await session.syncNow();
        if (session.isCurrent()) {
          reload();
          if (session.sync.status.error) setError("同步未完成，已显示本地资料");
        }
      } catch {
        if (session.isCurrent()) setError("同步未完成，已显示本地资料");
      } finally {
        setRefreshing(false);
        active.current = null;
      }
    };
    active.current = run();
    return active.current;
  };
  const listProps = {
    actions,
    kind,
    changeKind: setKind,
    more,
    open,
    toggle,
    refresh,
    refreshing,
    error,
  };
  return (
    <>
      {Platform.OS === "android" && <Stack.Screen options={{ headerShown: false }} />}
      <Stack.Title large={Platform.OS === "ios"}>资料库</Stack.Title>
      {Platform.OS === "ios" ? (
        <Stack.SearchBar
          placeholder="搜索资料库"
          onChangeText={(e) => setQuery(e.nativeEvent.text)}
          onCancelButtonPress={() => setQuery("")}
        />
      ) : (
        <LibrarySearch
          value={query}
          onChangeText={setQuery}
        >
          {(close) => <LibraryList {...listProps} rows={rows} open={(row) => { close(); open(row); }} />}
        </LibrarySearch>
      )}
      <View style={{ flex: 1, display: needle && Platform.OS !== "android" ? "none" : "flex" }}>
        <LibraryList {...listProps} rows={browseRows} />
      </View>
      {!!needle && Platform.OS !== "android" && <LibraryList {...listProps} rows={rows} />}
      <BrowseCreate />
      <UndoNotice />
    </>
  );
}
