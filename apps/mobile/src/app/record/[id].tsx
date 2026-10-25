import { FieldGroup, Host, Picker, Switch, Text } from "@expo/ui";
import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import {
  Stack,
  useLocalSearchParams,
  useNavigation,
  useRouter,
} from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Pressable,
  StyleSheet,
  Text as RNText,
  View,
} from "react-native";

import { usePreventRemove } from "expo-router/react-navigation";

import { RecordTextInput } from "@/components/RecordTextInput";
import { RecordDrafts, parseNumberDraft } from "@/lib/record-drafts";
import { HistorySheet } from "@/components/HistorySheet";
import { MultiSelectSheet } from "@/components/MultiSelectSheet";
import { RefPickerSheet, useRefData } from "@/components/RefField";
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
  const { client, replica, isCurrent } = useSession();
  const { tokens } = useTheme();
  const [multiOpen, setMultiOpen] = useState<PropInfo | null>(null);
  const [refOpen, setRefOpen] = useState<PropInfo | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const navigation = useNavigation();
  const [, redraw] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const leaving = useRef(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [savingBeforeLeave, setSavingBeforeLeave] = useState(false);

  const [refreshVersion, setRefreshVersion] = useState(0);
  const drafts = useMemo(() => {
    const store = replica.service.drafts;
    const draftState = new RecordDrafts(
      (pid, value) => client.updateRecord(id, { [pid]: value }),
      () => { setLeaveError(null); redraw((n) => n + 1); },
      () => setRefreshVersion((n) => n + 1),
      (fields) => {
        for (const [pid, draft] of fields) {
          if (draft.status === "saved")
            store.acknowledgeField(id, pid, draft.value);
          else
            store.checkpointField(id, pid, {
              value: draft.value,
              status: draft.status === "saving" ? "pending" : draft.status,
              error: draft.error,
            });
        }
      },
    );
    for (const [pid, draft] of Object.entries(store.readFields(id)))
      draftState.fields.set(pid, {
        ...draft,
        status: draft.status === "pending" ? "draft" : draft.status,
      });
    return draftState;
  }, [client, id, replica]);
  useEffect(() => {
    drafts.resume();
    return () => drafts.stop();
  }, [drafts]);
  useEffect(() => {
    if (deleted) router.back();
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

  const commit = (prop: PropInfo, value: unknown) =>
    drafts.save(prop.id, value);
  const saveText = (prop: PropInfo) => {
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
    const prop = data?.props.find(prop => prop.id === pid);
    if (!prop) throw new Error("字段信息尚未就绪，请刷新后重试");
    return prop.type === "number" ? parseNumberDraft(String(value ?? "")) : value;
  };
  const saveAll = () => {
    setLeaveError(null);
    void drafts.flush(prepareDraft).then(result => {
      if (isCurrent() && !result.ok) setLeaveError(result.error);
    });
  };
  usePreventRemove(!deleted, ({ data: action }) => {
    if (leaving.current) return;
    leaving.current = true;
    setSavingBeforeLeave(true); setLeaveError(null);
    void (async () => {
      if (!data && drafts.dirty) {
        setLeaveError("记录仍在加载，请稍后重试");
        return;
      }
      const result = await drafts.flush(prepareDraft);
      if (!isCurrent()) return;
      if (result.ok) navigation.dispatch(action.action);
      else setLeaveError(result.error);
    })().catch(error => {
      if (isCurrent()) setLeaveError(error instanceof Error ? error.message : String(error));
    }).finally(() => { leaving.current = false; setSavingBeforeLeave(false); });
  });
  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)");
  };
  const closeButton = () => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="关闭记录"
      hitSlop={12}
      disabled={savingBeforeLeave}
      onPress={close}
    >
      <RNText style={{ color: tokens.accent, fontSize: fs.ui }}>关闭</RNText>
    </Pressable>
  );
  const leaveNotice = leaveError ? (
    <RNText accessibilityRole="alert" style={{ color: tokens.danger, padding: 12 }}>
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
  // Resolve relation/doc target titles outside the SwiftUI Host (hook must
  // run unconditionally, before the early returns below).
  const {
    candidates,
    refDisplay,
    loading: refsLoading,
    error: refsError,
    refetch: refetchRefs,
  } = useRefData(data?.props ?? EMPTY_PROPS);

  if (error && !data) {
    return (
      <View style={[styles.center, { backgroundColor: tokens.bg }]}>
        <Stack.Screen options={{ title: "记录", headerLeft: closeButton }} />
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
        <Stack.Screen options={{ title: "记录", headerLeft: closeButton }} />
        {leaveNotice}
      </View>
    );
  }

  const { rec, props } = data;

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <Stack.Screen
        options={{
          title,
          headerLeft: closeButton,
          headerRight: () => (
            <View style={styles.headerRight}>
              <Pressable
                hitSlop={10}
                onPress={() =>
                  drafts.dirty
                    ? Alert.alert(
                        "请先保存修改",
                        "完成保存或重试后再恢复历史版本。",
                      )
                    : setHistoryOpen(true)
                }
              >
                <RNText style={{ color: tokens.accent, fontSize: fs.ui }}>
                  历史
                </RNText>
              </Pressable>
              <Pressable
                hitSlop={10}
                disabled={deleting || saving}
                onPress={() =>
                  Alert.alert("删除记录", "确定删除这条记录吗？", [
                    { text: "取消", style: "cancel" },
                    {
                      text: "删除",
                      style: "destructive",
                      onPress: async () => {
                        setDeleting(true);
                        try {
                          await client.deleteRecord(rec.id);
                          replica.service.drafts.discardRecord(rec.id);
                          drafts.stop();
                          setDeleted(true);
                        } catch (e) {
                          Alert.alert(
                            "删除失败",
                            e instanceof Error ? e.message : String(e),
                          );
                        } finally {
                          setDeleting(false);
                        }
                      },
                    },
                  ])
                }
              >
                <RNText style={{ color: tokens.danger, fontSize: fs.ui }}>
                  删除
                </RNText>
              </Pressable>
            </View>
          ),
        }}
      />
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
      <Host style={styles.host}>
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
                      onChangeText={(t) => drafts.stage(prop.id, t)}
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
                      onChangeText={(t) => drafts.stage(prop.id, t)}
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
                    <DateTimePicker
                      value={cur ?? new Date()}
                      mode="date"
                      display="compact"
                      locale="zh_CN"
                      onChange={(_e, date) => {
                        if (!date) return;
                        const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
                        if (iso !== value) void commit(prop, iso);
                      }}
                    />
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
                    <Text onPress={() => setRefOpen(prop)}>
                      {refDisplay(prop, value)}
                    </Text>
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
      </Host>
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
