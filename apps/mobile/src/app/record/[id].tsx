import { FieldGroup, Host, Picker, Switch, Text, TextInput } from "@expo/ui";
import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text as RNText, View } from "react-native";

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
  const { client } = useSession();
  const { tokens } = useTheme();
  const [multiOpen, setMultiOpen] = useState<PropInfo | null>(null);
  const [refOpen, setRefOpen] = useState<PropInfo | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Text drafts keyed by prop id; committed on blur/submit.
  const drafts = useRef(new Map<string, string>());

  const fetchRecord = useCallback(async () => {
    const rec = await client.getRecord(id);
    const props = await client.listProperties(rec.database_id);
    return { rec, props: props.slice().sort((a, b) => a.position - b.position) };
  }, [client, id]);
  const { data, error, refetch } = useApiData(fetchRecord);

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

  const commit = useCallback(
    async (prop: PropInfo, value: unknown) => {
      try {
        await client.updateRecord(id, { [prop.id]: value });
        void refetch();
      } catch (e) {
        if (e instanceof MetahubError && (e.code === "stale" || e.code === "conflict")) {
          void refetch();
          Alert.alert("已被其他设备修改", "内容已刷新，请重新编辑。");
        } else {
          Alert.alert("保存失败", e instanceof Error ? e.message : String(e));
        }
      }
    },
    [client, id, refetch],
  );

  const title = useMemo(
    () => (data ? recordTitle(data.rec, data.props) : "记录"),
    [data],
  );
  // Resolve relation/doc target titles outside the SwiftUI Host (hook must
  // run unconditionally, before the early returns below).
  const { candidates, refDisplay } = useRefData(data?.props ?? EMPTY_PROPS);

  if (error) {
    return (
      <View style={[styles.center, { backgroundColor: tokens.bg }]}>
        <Stack.Screen options={{ title: "记录" }} />
        <RNText style={{ color: tokens.danger, fontSize: fs.ui }}>
          {error instanceof MetahubError && error.code === "not_found"
            ? "记录不存在（可能已被删除）"
            : "加载失败"}
        </RNText>
      </View>
    );
  }
  if (!data) {
    return (
      <View style={[styles.center, { backgroundColor: tokens.bg }]}>
        <Stack.Screen options={{ title: "记录" }} />
      </View>
    );
  }

  const { rec, props } = data;

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <Stack.Screen
        options={{
          title,
          headerRight: () => (
            <View style={styles.headerRight}>
              <Pressable hitSlop={10} onPress={() => setHistoryOpen(true)}>
                <RNText style={{ color: tokens.accent, fontSize: fs.ui }}>历史</RNText>
              </Pressable>
              <Pressable
                hitSlop={10}
                onPress={() =>
                  Alert.alert("删除记录", "确定删除这条记录吗？", [
                    { text: "取消", style: "cancel" },
                    {
                      text: "删除",
                      style: "destructive",
                      onPress: async () => {
                        await client.deleteRecord(rec.id).catch(() => {});
                        router.back();
                      },
                    },
                  ])
                }
              >
                <RNText style={{ color: tokens.danger, fontSize: fs.ui }}>删除</RNText>
              </Pressable>
            </View>
          ),
        }}
      />
      <Host style={styles.host}>
        <FieldGroup>
          {props.map((prop) => {
            const value = rec.cells[prop.id];
            switch (prop.type) {
              case "text":
              case "url":
                return (
                  <FieldGroup.Section key={prop.id} title={prop.name}>
                    <TextInput
                      defaultValue={typeof value === "string" ? value : ""}
                      placeholder="未填写"
                      multiline={prop.type === "text"}
                      autoCorrect={false}
                      keyboardType={prop.type === "url" ? "url" : "default"}
                      onChangeText={(t) => drafts.current.set(prop.id, t)}
                      onBlur={() => {
                        const draft = drafts.current.get(prop.id);
                        if (draft !== undefined && draft !== (value ?? "")) {
                          drafts.current.delete(prop.id);
                          void commit(prop, draft);
                        }
                      }}
                    />
                  </FieldGroup.Section>
                );
              case "number":
                return (
                  <FieldGroup.Section key={prop.id} title={prop.name}>
                    <TextInput
                      defaultValue={value != null ? String(value) : ""}
                      placeholder="未填写"
                      keyboardType="decimal-pad"
                      onChangeText={(t) => drafts.current.set(prop.id, t)}
                      onBlur={() => {
                        const draft = drafts.current.get(prop.id);
                        if (draft === undefined) return;
                        drafts.current.delete(prop.id);
                        const trimmed = draft.trim();
                        if (trimmed === "" && value != null) {
                          void commit(prop, null);
                          return;
                        }
                        const n = Number(trimmed);
                        if (trimmed !== "" && Number.isFinite(n) && n !== value)
                          void commit(prop, n);
                      }}
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
                      <Text onPress={() => void commit(prop, null)}>清除日期</Text>
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
          initialSelected={
            Array.isArray(rec.cells[refOpen.id])
              ? (rec.cells[refOpen.id] as unknown[]).filter(
                  (v): v is string => typeof v === "string",
                )
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
            Array.isArray(rec.cells[multiOpen.id])
              ? (rec.cells[multiOpen.id] as unknown[]).filter(
                  (v): v is string => typeof v === "string",
                )
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
