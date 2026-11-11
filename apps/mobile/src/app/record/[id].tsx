import { recordWriter } from "@/lib/database-drafts";
import { NativeToolbarAction } from "@/components/native/NativeToolbarAction";
import { Button, FieldGroup, Picker, Switch, Text } from "@expo/ui";
import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text as RNText,
  View,
} from "react-native";

import { usePreventRemove } from "expo-router/react-navigation";

import { createRecentStore } from "@/lib/navigation/recent";
import { NativeHost } from "@/components/native/NativeHost";
import { RecordTextInput } from "@/components/RecordTextInput";
import { parseNumberDraft } from "@/lib/record-drafts";
import { HistorySheet } from "@/components/HistorySheet";
import { MultiSelectSheet } from "@/components/MultiSelectSheet";
import {
  RefPickerSheet,
  referenceIds,
  useRefData,
} from "@/components/RefField";
import { useApiData, useLiveInvalidate } from "@/lib/api/hooks";
import { MetahubError, type PropInfo } from "@/lib/api/sdk";
import { useSession } from "@/lib/auth/session";
import { recordTitle, selectOptions } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { fs } from "@/lib/theme/tokens";

const NONE = "__none__";
const EMPTY_PROPS: PropInfo[] = [];

export default function RecordScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { client, replica, isCurrent, workspaceId } = useSession();
  const mutationEnabled = useRef(true);
  const recent = useMemo(
    () => createRecentStore(replica.db, workspaceId),
    [replica, workspaceId],
  );
  const { tokens } = useTheme();
  const [multiOpen, setMultiOpen] = useState<PropInfo | null>(null);
  const [refOpen, setRefOpen] = useState<PropInfo | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState<string | null>(null);
  const [, redraw] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [exitAllowed, setExitAllowed] = useState(false);
  // Re-arm if a parent prevents the replay and this screen stays mounted.
  useEffect(() => {
    if (!exitAllowed) return;
    const frame = requestAnimationFrame(() => setExitAllowed(false));
    return () => cancelAnimationFrame(frame);
  }, [exitAllowed]);
  const leaving = useRef(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [savingBeforeLeave, setSavingBeforeLeave] = useState(false);

  const [refreshVersion, setRefreshVersion] = useState(0);
  const writer = useMemo(
    () => recordWriter(replica.service, id),
    [replica, id],
  );
  const drafts = writer.drafts;
  useEffect(() => {
    let acknowledged = drafts.acknowledgedVersion;
    const changed = () => {
      setLeaveError(null);
      redraw((n) => n + 1);
      if (acknowledged !== drafts.acknowledgedVersion) {
        acknowledged = drafts.acknowledgedVersion;
        setRefreshVersion((n) => n + 1);
      }
    };
    writer.listeners.add(changed);
    drafts.resume();
    return () => {
      writer.listeners.delete(changed);
    };
  }, [writer, drafts]);
  useEffect(() => {
    if (deleted) {
      if (router.canGoBack()) router.back();
      else router.replace("/");
    }
  }, [deleted, router]);
  const fetchRecord = useCallback(async () => {
    const readVersion = drafts.acknowledgedVersion;
    const rec = await client.getRecord(id);
    const props = await client.listProperties(rec.database_id);
    return {
      rec,
      readVersion,
      props: props.slice().sort((a, b) => a.position - b.position),
    };
  }, [client, id, drafts]);
  const { data, error, refetch } = useApiData(fetchRecord);

  useEffect(() => {
    if (data?.rec.id === id) drafts.reconcile(data.rec.cells, data.readVersion);
  }, [data, drafts, id]);
  useEffect(() => {
    if (refreshVersion > 0) void refetch();
  }, [refreshVersion, refetch]);

  // Another device may edit this record while it's open.
  useLiveInvalidate(["records", "properties"], (change) => {
    if (
      change.truncated ||
      change.datasets.includes("properties") ||
      !change.rowIds.length ||
      change.rowIds.includes(id)
    )
      void refetch();
  });

  const commit = (prop: PropInfo, value: unknown) => {
    if (mutationEnabled.current && !deleting && !deleted)
      drafts.save(prop.id, value);
  };
  const saveText = (prop: PropInfo) => {
    if (!mutationEnabled.current || deleting || deleted) return;
    const draft = drafts.fields.get(prop.id);
    if (!draft || (draft.status !== "draft" && draft.status !== "invalid"))
      return;
    try {
      commit(
        prop,
        prop.type === "number"
          ? parseNumberDraft(String(draft.value))
          : draft.value,
      );
    } catch (e) {
      drafts.fail(prop.id, e instanceof Error ? e.message : String(e));
    }
  };
  const prepareDraft = (pid: string, value: unknown) => {
    const prop = data?.props.find((prop) => prop.id === pid);
    if (!prop) throw new Error("字段信息尚未就绪，请刷新后重试");
    return prop.type === "number"
      ? parseNumberDraft(String(value ?? ""))
      : value;
  };
  const saveAll = () => {
    setLeaveError(null);
    void drafts.flush(prepareDraft).then((result) => {
      if (isCurrent() && !result.ok) setLeaveError(result.error);
    });
  };
  usePreventRemove(!deleted && !exitAllowed, ({ repeat }) => {
    if (leaving.current || !mutationEnabled.current) return;
    leaving.current = true;
    setSavingBeforeLeave(true);
    setLeaveError(null);
    Keyboard.dismiss();
    void (async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      if (!data && drafts.dirty) {
        setLeaveError("记录仍在加载，请稍后重试");
        return;
      }
      mutationEnabled.current = false;
      const result = await drafts.flush(prepareDraft);
      if (!isCurrent()) return;
      if (result.ok) {
        setExitAllowed(true);
        repeat();
      } else setLeaveError(result.error);
    })()
      .catch((error) => {
        if (isCurrent())
          setLeaveError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        leaving.current = false;
        mutationEnabled.current = true;
        if (isCurrent()) setSavingBeforeLeave(false);
      });
  });
  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };
  const closeToolbar = (
    <NativeToolbarAction
      placement="left"
      label="关闭"
      disabled={savingBeforeLeave || deleting}
      onPress={close}
    />
  );
  const leaveNotice = leaveError ? (
    <RNText
      accessibilityRole="alert"
      style={{ color: tokens.danger, padding: 12 }}
    >
      {leaveError}（修改已保留）
    </RNText>
  ) : null;
  const failed = [...drafts.fields.values()].find(
    (d) => d.status === "error" || d.status === "invalid",
  );
  const saving = [...drafts.fields.values()].some(
    (d) => d.status === "saving" || d.status === "pending",
  );

  const title = useMemo(
    () => (data ? recordTitle(data.rec, data.props) : "记录"),
    [data],
  );
  useEffect(() => {
    if (data && isCurrent()) {
      try {
        recent.remember({ id, kind: "record", title });
      } catch {}
    }
  }, [data, id, title, isCurrent, recent]);
  // Resolve relation/doc target titles outside the SwiftUI Host (hook must
  // run unconditionally, before the early returns below).
  const {
    candidates,
    titleOf,
    missing: missingRef,
    loading: refsLoading,
    error: refsError,
    refetch: refetchRefs,
  } = useRefData(data?.props ?? EMPTY_PROPS, {
    ...data?.rec.cells,
    ...Object.fromEntries(
      [...drafts.fields].map(([pid, draft]) => [pid, draft.value]),
    ),
  });
  useLiveInvalidate(["documents", "records", "properties"], () => {
    void refetchRefs();
  });
  const openReference = async (prop: PropInfo, targetId: string) => {
    if (leaving.current || deleting || deleted) return;
    leaving.current = true;
    setSavingBeforeLeave(true);
    setLeaveError(null);
    Keyboard.dismiss();
    try {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      mutationEnabled.current = false;
      const result = await drafts.flush(prepareDraft);
      if (!isCurrent()) return;
      if (!result.ok) {
        setLeaveError(result.error);
        return;
      }
      const [target] = await client.referenceSummaries({
        kind: prop.type === "doc" ? "document" : "record",
        ...(prop.type === "relation"
          ? { databaseId: prop.config?.database as string | undefined }
          : {}),
        ids: [targetId],
      });
      if (!isCurrent()) return;
      if (!target || target.missing) {
        setLeaveError(
          "关联目标已删除或不可用，引用仍保留，可通过更改关联移除。",
        );
        void refetchRefs();
        return;
      }
      router.push(
        `/${prop.type === "doc" ? "doc" : "record"}/${encodeURIComponent(targetId)}` as Parameters<
          typeof router.push
        >[0],
      );
    } catch (error) {
      if (isCurrent())
        setLeaveError(error instanceof Error ? error.message : String(error));
    } finally {
      leaving.current = false;
      mutationEnabled.current = true;
      if (isCurrent()) setSavingBeforeLeave(false);
    }
  };

  if (error && !data) {
    return (
      <View style={[styles.center, { backgroundColor: tokens.bg }]}>
        <Stack.Screen options={{ title: "记录" }} />
        {closeToolbar}
        {leaveNotice}
        <RNText style={{ color: tokens.danger, fontSize: fs.ui }}>
          {error instanceof MetahubError && error.code === "not_found"
            ? "记录不存在（可能已被删除）"
            : "加载失败"}
        </RNText>
        <Pressable onPress={() => void refetch()}>
          <RNText style={{ color: tokens.accent }}>重试</RNText>
        </Pressable>
      </View>
    );
  }
  if (!data) {
    return (
      <View style={[styles.center, { backgroundColor: tokens.bg }]}>
        <Stack.Screen options={{ title: "记录" }} />
        {closeToolbar}
        {leaveNotice}
      </View>
    );
  }

  const { rec, props } = data;

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <Stack.Screen options={{ title }} />
      {closeToolbar}
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu
          title="记录操作"
          accessibilityLabel="记录操作"
          icon={
            process.env.EXPO_OS === "ios"
              ? "ellipsis.circle"
              : require("@/components/native/assets/more.xml")
          }
        >
          <Stack.Toolbar.MenuAction
            disabled={deleting || saving}
            destructive={false}
            onPress={() =>
              drafts.dirty
                ? Alert.alert(
                    "请先保存修改",
                    "完成保存或重试后再恢复历史版本。",
                  )
                : setHistoryOpen(true)
            }
          >
            {"版本历史"}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            disabled={deleting || saving}
            destructive={true}
            onPress={() =>
              Alert.alert("删除记录", "确定删除这条记录吗？", [
                { text: "取消", style: "cancel" },
                {
                  text: "删除",
                  style: "destructive",
                  onPress: async () => {
                    if (
                      leaving.current ||
                      !mutationEnabled.current ||
                      !isCurrent()
                    )
                      return;
                    leaving.current = true;
                    Keyboard.dismiss();
                    setSavingBeforeLeave(true);
                    try {
                      await new Promise<void>((resolve) =>
                        requestAnimationFrame(() => resolve()),
                      );
                      mutationEnabled.current = false;
                      setDeleting(true);
                      const flushed = await drafts.flush(prepareDraft);
                      if (!isCurrent()) return;
                      if (!flushed.ok) throw new Error(flushed.error);
                      drafts.stop();
                      const result = await client.deleteRecord(rec.id);
                      if (!isCurrent()) return;
                      if (!result.ok)
                        throw new Error("记录未能删除，请刷新后重试");
                      replica.service.drafts.discardRecord(rec.id);
                      try {
                        recent.forget("record", rec.id);
                      } catch {}
                      setDeleted(true);
                    } catch (e) {
                      drafts.resume();
                      mutationEnabled.current = true;
                      if (isCurrent())
                        Alert.alert(
                          "删除失败",
                          e instanceof Error ? e.message : String(e),
                        );
                    } finally {
                      leaving.current = false;
                      if (isCurrent()) {
                        setDeleting(false);
                        setSavingBeforeLeave(false);
                      }
                    }
                  },
                },
              ])
            }
          >
            {"删除记录"}
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      {leaveNotice}
      <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
        <RNText
          accessibilityLiveRegion="polite"
          style={{ color: failed ? tokens.danger : tokens.muted }}
        >
          {failed
            ? `保存失败：${failed.error}（修改已保留）`
            : saving || savingBeforeLeave
              ? "正在保存…"
              : drafts.dirty
                ? "有未保存的修改"
                : "已保存"}
        </RNText>
        {failed ||
        [...drafts.fields.values()].some((d) => d.status === "draft") ? (
          <Pressable onPress={saveAll}>
            <RNText style={{ color: tokens.accent }}>保存 / 重试</RNText>
          </Pressable>
        ) : null}
        {error ? (
          <Pressable onPress={() => void refetch()}>
            <RNText style={{ color: tokens.danger }}>刷新失败，点按重试</RNText>
          </Pressable>
        ) : null}
      </View>
      <NativeHost
        style={styles.host}
        pointerEvents={deleting || savingBeforeLeave ? "none" : "auto"}
      >
        <FieldGroup>
          {props.map((prop) => {
            const value = drafts.fields.has(prop.id)
              ? drafts.fields.get(prop.id)!.value
              : rec.cells[prop.id];
            switch (prop.type) {
              case "text":
              case "url":
                return (
                  <FieldGroup.Section key={prop.id} title={prop.name}>
                    <RecordTextInput
                      text={typeof value === "string" ? value : ""}
                      placeholder="未填写"
                      multiline={prop.type === "text"}
                      autoCorrect={false}
                      keyboardType={prop.type === "url" ? "url" : "default"}
                      editable={!deleting && !deleted && !savingBeforeLeave}
                      onChangeText={(t) => {
                        if (mutationEnabled.current && !deleting && !deleted)
                          drafts.stage(prop.id, t);
                      }}
                      onBlur={() => saveText(prop)}
                      onSubmitEditing={() => saveText(prop)}
                    />
                  </FieldGroup.Section>
                );
              case "number":
                return (
                  <FieldGroup.Section key={prop.id} title={prop.name}>
                    <RecordTextInput
                      text={value != null ? String(value) : ""}
                      placeholder="未填写"
                      keyboardType="decimal-pad"
                      editable={!deleting && !deleted && !savingBeforeLeave}
                      onChangeText={(t) => {
                        if (mutationEnabled.current && !deleting && !deleted)
                          drafts.stage(prop.id, t);
                      }}
                      onBlur={() => saveText(prop)}
                      onSubmitEditing={() => saveText(prop)}
                    />
                  </FieldGroup.Section>
                );
              case "checkbox":
                return (
                  <FieldGroup.Section key={prop.id}>
                    <Switch
                      label={prop.name}
                      value={value === true}
                      onValueChange={(v) => void commit(prop, v)}
                    />
                  </FieldGroup.Section>
                );
              case "select": {
                const options = selectOptions(prop);
                const cur = typeof value === "string" && value ? value : NONE;
                return (
                  <FieldGroup.Section key={prop.id} title={prop.name}>
                    <Picker
                      selectedValue={cur}
                      onValueChange={(v) =>
                        void commit(prop, v === NONE ? null : String(v))
                      }
                    >
                      <Picker.Item label="（无）" value={NONE} />
                      {options.map((o) => (
                        <Picker.Item key={o} label={o} value={o} />
                      ))}
                    </Picker>
                  </FieldGroup.Section>
                );
              }
              case "multi_select": {
                const cur = Array.isArray(value)
                  ? value.filter((v): v is string => typeof v === "string")
                  : [];
                return (
                  <FieldGroup.Section key={prop.id} title={prop.name}>
                    <Text onPress={() => setMultiOpen(prop)}>
                      {cur.length ? cur.join(" · ") : "（点按选择）"}
                    </Text>
                  </FieldGroup.Section>
                );
              }
              case "date": {
                const cur =
                  typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)
                    ? new Date(`${value.slice(0, 10)}T00:00:00`)
                    : null;
                return (
                  <FieldGroup.Section key={prop.id} title={prop.name}>
                    {Platform.OS === "android" && (
                      <Button
                        label={
                          cur ? cur.toLocaleDateString("zh-CN") : "选择日期"
                        }
                        onPress={() => setDateOpen(prop.id)}
                      />
                    )}
                    {(Platform.OS !== "android" || dateOpen === prop.id) && (
                      <DateTimePicker
                        value={cur ?? new Date()}
                        mode="date"
                        display="compact"
                        locale="zh_CN"
                        onChange={(event, date) => {
                          if (Platform.OS === "android") setDateOpen(null);
                          if (event.type !== "set" || !date) return;
                          const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
                          if (iso !== value) void commit(prop, iso);
                        }}
                      />
                    )}
                    {cur ? (
                      <Text onPress={() => void commit(prop, null)}>
                        清除日期
                      </Text>
                    ) : null}
                  </FieldGroup.Section>
                );
              }
              case "relation":
              case "doc":
                return (
                  <FieldGroup.Section key={prop.id} title={prop.name}>
                    {referenceIds(value).map((targetId) => (
                      <Button
                        key={targetId}
                        disabled={
                          deleting ||
                          savingBeforeLeave ||
                          missingRef(prop, targetId)
                        }
                        onPress={() => void openReference(prop, targetId)}
                        label={`打开 ${titleOf(prop, targetId)}`}
                      />
                    ))}
                    <Button
                      disabled={deleting || savingBeforeLeave}
                      onPress={() => setRefOpen(prop)}
                      label="更改关联"
                    />
                  </FieldGroup.Section>
                );
              default:
                return (
                  <FieldGroup.Section key={prop.id} title={prop.name}>
                    <Text>{value != null ? String(value) : "（空）"}</Text>
                  </FieldGroup.Section>
                );
            }
          })}
        </FieldGroup>
      </NativeHost>
      {refOpen ? (
        <RefPickerSheet
          key={refOpen.id}
          prop={refOpen}
          candidates={candidates(refOpen)}
          loading={refsLoading}
          error={refsError}
          onRetry={() => void refetchRefs()}
          initialSelected={
            Array.isArray(
              drafts.fields.get(refOpen.id)?.value ?? rec.cells[refOpen.id],
            )
              ? (
                  (drafts.fields.get(refOpen.id)?.value ??
                    rec.cells[refOpen.id]) as unknown[]
                ).filter((v): v is string => typeof v === "string")
              : []
          }
          onChange={(next) => void commit(refOpen, next)}
          onClose={() => setRefOpen(null)}
        />
      ) : null}
      <HistorySheet
        visible={historyOpen}
        onClose={() => setHistoryOpen(false)}
        recordId={rec.id}
        props={props}
        onReverted={() => void refetch()}
      />
      {multiOpen ? (
        <MultiSelectSheet
          key={multiOpen.id}
          isPresented={multiOpen !== null}
          onDismiss={() => setMultiOpen(null)}
          title={multiOpen.name}
          options={selectOptions(multiOpen)}
          initialSelected={
            Array.isArray(
              drafts.fields.get(multiOpen.id)?.value ?? rec.cells[multiOpen.id],
            )
              ? (
                  (drafts.fields.get(multiOpen.id)?.value ??
                    rec.cells[multiOpen.id]) as unknown[]
                ).filter((v): v is string => typeof v === "string")
              : []
          }
          onChange={(next) => void commit(multiOpen, next)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  host: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  headerRight: { flexDirection: "row", gap: 18 },
});
