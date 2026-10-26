import {
  FieldGroup,
  Picker,
  Text as NativeText,
  type TextInputRef,
} from "@expo/ui";
import {
  Stack,
  useLocalSearchParams,
  useNavigation,
  useRouter,
} from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Text,
  View,
} from "react-native";
import { NativeButton } from "@/components/native/NativeButton";
import { NativeFormButton } from "@/components/native/NativeFormButton";
import { NativeHost } from "@/components/native/NativeHost";
import { NativeToolbarAction } from "@/components/native/NativeToolbarAction";
import { RecordTextInput } from "@/components/RecordTextInput";
import { useApiData } from "@/lib/api/hooks";
import { useSession } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";
import { saveDocumentForm } from "@/lib/document-actions";
export default function DocumentManagement() {
  const { id, mode = "rename" } = useLocalSearchParams<{
    id: string;
    mode?: string;
  }>();
  const session = useSession();
  return (
    <DocumentManagementForm
      key={session.id + ":" + id + ":" + mode}
      id={id}
      mode={mode}
    />
  );
}
function DocumentManagementForm({ id, mode }: { id: string; mode: string }) {
  const session = useSession();
  const router = useRouter();
  const navigation = useNavigation();
  const { tokens } = useTheme();
  const [titleDraft, setTitle] = useState<string | null>(null);
  const titleValue = useRef<string | null>(null);
  const revision = useRef(0);
  const receipt = useRef<{ id: string; version?: string } | null>(null);
  const titleInput = useRef<TextInputRef>(null);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [target, setTarget] = useState<string | null>(null);
  const [where, setWhere] = useState("into");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ id?: string; revision: number } | null>(
    null,
  );
  const [discard, setDiscard] = useState(false);
  const pendingAction = useRef<
    Parameters<typeof navigation.dispatch>[0] | null
  >(null);
  const fetchInfo = useCallback(
    async () => (id === "new" ? null : session.client.getDocument(id)),
    [session.client, id],
  );
  const info = useApiData(fetchInfo);
  const initial =
    mode === "rename"
      ? (info.data?.title ?? "")
      : mode === "copy"
        ? (info.data?.title || "未命名") + " 副本"
        : "";
  const title = titleDraft ?? initial;
  const dirty =
    title !== initial ||
    target !== null ||
    (mode === "move" && where !== "into") ||
    !!error;
  usePreventRemove(!done && !discard && (busy || dirty), ({ data }) => {
    if (busyRef.current) return;
    Alert.alert("放弃修改？", "尚未保存的修改会被丢弃。", [
      { text: "继续编辑", style: "cancel" },
      {
        text: "放弃",
        style: "destructive",
        onPress: () => {
          if (busyRef.current) return;
          pendingAction.current = data.action;
          setDiscard(true);
        },
      },
    ]);
  });
  useEffect(() => {
    if (discard && pendingAction.current)
      navigation.dispatch(pendingAction.current);
  }, [discard, navigation]);
  useEffect(() => {
    if (done) {
      if (!session.isCurrent()) return;
      if (done.revision !== revision.current) {
        setDone(null);
        setError("较早的修改已保存，新的修改仍待保存，请再次保存");
        return;
      }
      if (done.id)
        router.replace(
          ("/doc/" + encodeURIComponent(done.id)) as Parameters<
            typeof router.replace
          >[0],
        );
      else router.back();
    }
  }, [done, router, session]);
  const fetchChoices = useCallback(
    () =>
      mode === "move"
        ? session.client.queryDocuments({ search: query, offset, limit: 60 })
        : Promise.resolve(null),
    [session.client, mode, query, offset],
  );
  const choices = useApiData(fetchChoices);
  const save = async (root = false) => {
    if (busyRef.current || !session.isCurrent()) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    titleInput.current?.blur();
    try {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      const nextTitle = titleValue.current ?? initial;
      if (id !== "new" && !info.data)
        throw new Error("文档仍在加载，请稍后重试");
      const saved = await saveDocumentForm({
        revision: () => revision.current,
        isCurrent: session.isCurrent,
        write: async () => {
          let opened: string | undefined;
          let document: { id: string; version?: string } | undefined;
          if (
            (mode === "create" || mode === "child" || mode === "copy") &&
            receipt.current
          ) {
            // A prior write succeeded while a newer native input was arriving.
            // Continue on that document instead of creating a second copy.
            document = await session.client.updateDocument(receipt.current.id, {
              title: nextTitle,
              if_match: receipt.current.version,
            });
            opened = document.id;
          } else if (mode === "create" || mode === "child") {
            document = await session.client.createDocument({
              title: nextTitle,
              ...(mode === "child" ? { parent_id: id } : {}),
            });
            opened = document.id;
          } else if (mode === "rename") {
            document = await session.client.updateDocument(id, {
              title: nextTitle,
              if_match: receipt.current?.version ?? info.data?.version,
            });
          } else if (mode === "copy") {
            document = await session.client.duplicateDocument(id, {
              title: nextTitle,
            });
            opened = document.id;
          } else if (mode === "move") {
            if (root)
              document = await session.client.updateDocument(id, {
                parent_id: null,
                if_match: receipt.current?.version ?? info.data?.version,
              });
            else {
              if (!target) throw new Error("请选择目标文档");
              document = await session.client.moveDocument(
                id,
                target,
                where as "before" | "after" | "into",
              );
            }
          } else throw new Error("未知文档操作");
          return { opened, document };
        },
        remember: (saved) => {
          if (saved.document) receipt.current = saved.document;
          void session.syncNow().catch(() => {});
        },
      });
      setDone({ id: saved.opened, revision: revision.current });
    } catch (e) {
      if (session.isCurrent())
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const label =
    (
      {
        create: "新建文档",
        child: "新建子文档",
        rename: "重命名",
        copy: "复制文档",
        move: "移动文档",
      } as Record<string, string>
    )[mode] ?? "文档操作";
  const header = (
    <View
      style={{ gap: 12, padding: 16, flex: 1 }}
    >
      {error && (
        <Text
          selectable
          accessibilityRole="alert"
          style={{ color: tokens.danger }}
        >
          {error}（修改已保留）
        </Text>
      )}
      {info.error && (
        <NativeButton onPress={() => void info.refetch()}>
          加载失败，重试
        </NativeButton>
      )}
      {info.loading && id !== "new" && <ActivityIndicator />}
      {mode === "move" ? (
        <NativeHost style={{ flex: 1 }}>
          <FieldGroup>
            <FieldGroup.Section title="移动位置">
              <Picker
                selectedValue={where}
                enabled={!busy}
                onValueChange={(v) => {
                  revision.current++;
                  setWhere(String(v));
                }}
              >
                <Picker.Item value="into" label="作为子文档" />
                <Picker.Item value="before" label="目标之前" />
                <Picker.Item value="after" label="目标之后" />
              </Picker>
              <NativeFormButton disabled={busy} onPress={() => void save(true)} label="移到根目录" />
            </FieldGroup.Section>
            <FieldGroup.Section title="目标文档">
              <RecordTextInput
                text={query}
                placeholder="搜索目标文档"
                editable={!busy}
                onChangeText={(value) => {
                  setQuery(value);
                  setOffset(0);
                }}
              />
              {choices.loading ? <NativeText>正在加载目标文档…</NativeText> : null}
              {choices.error ? (
                <NativeFormButton onPress={() => void choices.refetch()} label="加载目标失败，重试" />
              ) : null}
              {choices.data?.documents.filter((d) => d.id !== id).map((document) => (
                <NativeFormButton
                  key={document.id}
                  selected={target === document.id}
                  disabled={busy}
                  onPress={() => {
                    revision.current++;
                    setTarget(document.id);
                  }}
                  label={document.title || "未命名"}
                />
              ))}
              {!choices.loading && !choices.error &&
                !choices.data?.documents.some((d) => d.id !== id) ? (
                  <NativeText>没有匹配文档</NativeText>
                ) : null}
            </FieldGroup.Section>
            <FieldGroup.Section>
              <NativeFormButton
                disabled={!offset || choices.loading || busy}
                onPress={() => setOffset(Math.max(0, offset - 60))}
                label="上一页"
              />
              <NativeFormButton
                disabled={!choices.data?.hasMore || choices.loading || busy}
                onPress={() => setOffset(offset + 60)}
                label="下一页"
              />
            </FieldGroup.Section>
          </FieldGroup>
        </NativeHost>
      ) : (
        // FieldGroup is a native scrolling Form/LazyColumn. Give it the
        // remaining sheet height instead of measuring it inside an RN scroller.
        <NativeHost style={{ flex: 1 }}>
          <FieldGroup>
            <FieldGroup.Section title="标题">
              <RecordTextInput
                ref={titleInput}
                text={title}
                placeholder="未命名"
                editable={!busy}
                autoFocus
                onChangeText={(value) => {
                  revision.current++;
                  titleValue.current = value;
                  setTitle(value);
                }}
              />
              <NativeText>
                {mode === "copy"
                  ? "复制包含当前文档正文。"
                  : "保存后可继续编辑正文。"}
              </NativeText>
            </FieldGroup.Section>
          </FieldGroup>
        </NativeHost>
      )}
    </View>
  );
  return (
    <View style={{ flex: 1, backgroundColor: tokens.bg }}>
      <Stack.Screen options={{ title: label, gestureEnabled: !busy }} />
      <NativeToolbarAction
        placement="left"
        label="取消"
        disabled={busy}
        onPress={() => router.back()}
      />
      <NativeToolbarAction
        placement="right"
        variant="done"
        label={busy ? "保存中…" : "保存"}
        disabled={
          busy ||
          (id !== "new" && (info.loading || !!info.error)) ||
          (mode === "move" && !target)
        }
        onPress={() => void save()}
      />
      {header}
    </View>
  );
}
