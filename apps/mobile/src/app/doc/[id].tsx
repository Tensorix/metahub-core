import { Stack, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { useMemo, useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { DocumentEditor, type DocumentEditorHandle } from "@/components/DocumentEditor";
import { useLiveInvalidate } from "@/lib/api/hooks";
import { useSession } from "@/lib/auth/session";
import type { EditorHostServices } from "@/lib/editor/host";
import { useTheme } from "@/lib/theme";

export default function DocScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const session = useSession();
  return <LocalDocument key={`${session.id}:${id}`} id={id} />;
}
function LocalDocument({ id }: { id: string }) {
  const session = useSession();
  const router = useRouter();
  const navigation = useNavigation();
  const { tokens, scheme } = useTheme();
  const editor = useRef<DocumentEditorHandle>(null);
  const navigating = useRef(false);
  const [notice, setNotice] = useState("");
  useLiveInvalidate(["documents", "doc_blocks"], () => editor.current?.refresh());
  const [error, setError] = useState<string | null>(null);
  // Prevent native swipe/back/replace from removing the renderer before its
  // latest checkpoint and SQLite mutation are accepted. React Navigation's
  // hook is exposed through Expo Router's versioned compatibility entry point.
  usePreventRemove(true, ({ data }) => {
    if (navigating.current) return;
    navigating.current = true;
    void (async () => {
      const result = await editor.current?.flush();
      if (!session.isCurrent()) return;
      if (result?.ok) navigation.dispatch(data.action);
      else setError(result?.error || "编辑器尚未就绪，请稍后重试");
    })().finally(() => { navigating.current = false; });
  });
  const host = useMemo<EditorHostServices>(() => {
    const check = () => { if (!session.isCurrent()) throw new Error("工作区会话已结束"); };
    const drafts = session.replica.service.drafts;
    return {
      isCurrent: session.isCurrent,
      async load() {
        check();
        const doc = await session.client.getDocument(id);
        check(); return { title: doc.title ?? "", body: doc.body ?? "", version: doc.version ?? null };
      },
      async readDraft() { check(); return drafts.readDocument(id); },
      async checkpoint(draft) { check(); drafts.checkpointDocument(id, draft); },
      async acknowledge(revision, version) { check(); drafts.acknowledgeDocument(id, revision, version ?? undefined); },
      async save(snapshot) {
        check();
        const doc = await session.client.updateDocument(id, {
          title: snapshot.title, body: snapshot.body,
          ...(!snapshot.force && snapshot.version !== null ? { if_match: snapshot.version } : {}),
        });
        check(); void session.syncNow().catch(() => {});
        return { version: doc.version ?? null };
      },
      async listTargets() {
        check();
        const [docs, databases] = await Promise.all([session.client.listDocuments(), session.client.listDatabases()]);
        check();
        return [...docs.map(doc => ({ id: doc.id, title: doc.title, kind: "doc" as const })), ...databases.map(db => ({ id: db.id, title: db.name, kind: "db" as const }))];
      },
      media: request => session.attachments.media(request),
      async navigate(target) {
        check();
        if (target.startsWith("/blob/")) { await session.attachments.media({ action: "preview", src: target }); return; }
        const match = /^(?:#)?\/(doc|db|rec)\/([^/?#]+)$/.exec(target);
        if (match) {
          const route = match[1] === "rec" ? "record" : match[1];
          router.push(`/${route}/${encodeURIComponent(decodeURIComponent(match[2]!))}` as Parameters<typeof router.push>[0]);
          return;
        }
        if (/^https?:\/\//i.test(target) || /^mailto:/i.test(target)) { await Linking.openURL(target); return; }
        throw new Error("此链接无法在移动端打开");
      },
    };
  // Session ID and resources remain stable across token refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, router, session.id, session.client, session.replica, session.isCurrent, session.attachments, session.syncNow]);
  const downloadAttachments = async () => {
    setNotice("正在下载附件…");
    try {
      const doc = await session.client.getDocument(id);
      if (!session.isCurrent()) return;
      const body = session.replica.service.drafts.readDocument(id)?.body ?? doc.body ?? "";
      const sources = [...new Set(body.match(/\/blob\/[a-f0-9]{16,64}(?:\.[a-z0-9]{1,12})?/g) ?? [])];
      for (const src of sources) { await session.attachments.cache(src); if (!session.isCurrent()) return; }
      setNotice(`已保留 ${sources.length} 个附件，可离线打开`);
    } catch (error) { if (session.isCurrent()) setNotice(error instanceof Error ? error.message : String(error)); }
  };
  const leave = () => { if (router.canGoBack()) router.back(); else router.replace("/(tabs)"); };
  return <View style={[styles.root, { backgroundColor: tokens.bg }]}>
    <Stack.Screen options={{ title: "文档", headerBackButtonMenuEnabled: false, headerRight: () => <Pressable accessibilityRole="button" onPress={() => void downloadAttachments()}><Text style={{ color: tokens.accent }}>离线附件</Text></Pressable>, headerLeft: () => <Pressable accessibilityRole="button" accessibilityLabel="返回" hitSlop={12} onPress={leave}><Text style={{ color: tokens.accent }}>返回</Text></Pressable> }} />
    {notice && <Text role="status" style={{ color: tokens.fg, padding: 12 }}>{notice}</Text>}
    {error && <View style={{ padding: 12, backgroundColor: tokens.bg }}><Text accessibilityRole="alert" style={{ color: tokens.fg }}>{error}</Text><Pressable accessibilityRole="button" onPress={() => { setError(null); editor.current?.retry(); }}><Text style={{ color: tokens.accent, paddingTop: 8 }}>恢复草稿并重试</Text></Pressable></View>}
    <DocumentEditor ref={editor} documentId={id} sessionId={String(session.id)} host={host} dark={scheme === "dark"} onError={setError} onState={state => { if (state === "saved") setError(null); }} />
  </View>;
}
const styles = StyleSheet.create({ root: { flex: 1 } });
