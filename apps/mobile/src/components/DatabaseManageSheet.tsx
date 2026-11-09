import {
  useState,
  useEffect,
  useSyncExternalStore,
  useRef,
  useCallback,
} from "react";
import {
  type TextDraftSnapshot,
  createTextDraft,
} from "@/lib/browse/text-draft";
import { Text, View } from "react-native";
import { DatabasePickerSheet } from "@/components/DatabasePickerSheet";
import { Picker } from "@expo/ui";
import { NativeHost } from "@/components/native/NativeHost";
import {
  ManagementAction,
  ManagementInput,
  ManagementSection,
} from "@/components/ManagementControls";
import { useSession } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";
import type { PropertyRow, PropType } from "../../../../src/core/properties.ts";
import type { DatabaseRow } from "../../../../src/core/databases.ts";

function Rename({
  value,
  label,
  onSave,
  draftKey,
  onDraftState,
  clearAfterSave = false,
}: {
  value: string;
  label: string;
  onSave: (value: string) => Promise<unknown>;
  draftKey: string;
  clearAfterSave?: boolean;
  onDraftState: (key: string, state: TextDraftSnapshot | undefined) => void;
}) {
  const [draft] = useState(() => createTextDraft(value));
  const state = useSyncExternalStore(
    draft.subscribe,
    draft.snapshot,
    draft.snapshot,
  );
  useEffect(() => draft.reconcile(value), [draft, value]);
  useEffect(() => {
    const report = () => onDraftState(draftKey, draft.snapshot());
    report();
    const unsubscribe = draft.subscribe(report);
    return () => {
      unsubscribe();
      onDraftState(draftKey, undefined);
    };
  }, [draft, draftKey, onDraftState]);
  const { tokens } = useTheme();
  return (
    <View>
      <ManagementInput label={label} value={state.text} onChange={draft.edit} />
      <ManagementAction
        label={state.busy ? "保存中…" : "保存"}
        disabled={state.busy || !state.text.trim() || !state.dirty}
        onPress={() => {
          void draft.save(onSave, clearAfterSave);
        }}
      />
      {state.error ? (
        <Text
          selectable
          accessibilityRole="alert"
          style={{ color: tokens.danger }}
        >
          {state.error}
        </Text>
      ) : null}
    </View>
  );
}
/** Router form content; every mutation is explicit and failures retain its draft. */
export function DatabaseManageSheet({
  database,
  props,
  onClose,
  onBusyChange,
  onDirtyChange,
  renameOnly = false,
}: {
  database: DatabaseRow;
  props: PropertyRow[];
  onClose(): void;
  onBusyChange?: (busy: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
  renameOnly?: boolean;
}) {
  const session = useSession(),
    { client } = session,
    { tokens } = useTheme();
  const [field, setField] = useState({
    name: "",
    type: "text" as PropType,
    options: "",
    target: "",
    targetName: "",
  });
  const latestField = useRef(field);
  const fieldBaseline = useRef(field);
  const dirtyItems = useRef(
    new Map<string, { signature: string; dirty: boolean }>(),
  );
  const reportDraft = useCallback(
    (key: string, state: TextDraftSnapshot | undefined) => {
      const signature = state ? JSON.stringify(state) : "removed";
      if (dirtyItems.current.get(key)?.signature === signature) return;
      if (state)
        dirtyItems.current.set(key, {
          signature,
          dirty: state.dirty || !!state.error,
        });
      else dirtyItems.current.delete(key);
      onDirtyChange?.(
        [...dirtyItems.current.values()].some((item) => item.dirty),
      );
    },
    [onDirtyChange],
  );
  const reportField = () => {
    dirtyItems.current.set("new-field", {
      signature: JSON.stringify(latestField.current),
      dirty:
        JSON.stringify(latestField.current) !==
        JSON.stringify(fieldBaseline.current),
    });
    onDirtyChange?.(
      [...dirtyItems.current.values()].some((item) => item.dirty),
    );
  };
  const editField = (patch: Partial<typeof field>) => {
    const next = { ...latestField.current, ...patch };
    latestField.current = next;
    reportField();
    setField(next);
  };
  const { name, type, options, target, targetName } = field;
  const [pickingDatabase, setPickingDatabase] = useState(false);
  const [optionAliases, setOptionAliases] = useState<
    { property: string; source: string; target: string; key: string }[]
  >([]);
  const optionKey = (property: string, option: string, all: string[]) =>
    optionAliases.findLast(
      (alias) =>
        alias.property === property &&
        alias.target === option &&
        !all.includes(alias.source),
    )?.key ?? JSON.stringify([property, option]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const activeWrites = useRef(0);
  const mutate = async <T,>(job: () => Promise<T>): Promise<T> => {
    activeWrites.current++;
    setBusy(true);
    if (activeWrites.current === 1) onBusyChange?.(true);
    try {
      return await job();
    } finally {
      activeWrites.current--;
      setBusy(activeWrites.current > 0);
      if (!activeWrites.current) onBusyChange?.(false);
    }
  };
  const run = (job: () => Promise<unknown>) => {
    if (activeWrites.current) return;
    setError("");
    void mutate(job).catch((e) => setError(String(e)));
  };
  return (
    <View style={{ gap: 12 }}>
      <Rename
        draftKey={`database:${database.id}`}
        onDraftState={reportDraft}
        label="数据库名称"
        value={database.name}
        onSave={(value) =>
          mutate(() => client.updateDatabase(database.id, { name: value }))
        }
      />
      {error ? (
        <Text
          selectable
          accessibilityRole="alert"
          style={{ color: tokens.danger }}
        >
          {error}
        </Text>
      ) : null}
      {!renameOnly && (
        <>
          {props.map((prop, index) => (
            <ManagementSection
              key={prop.id}
              title={`${prop.name} · ${prop.type}`}
            >
              <Rename
                draftKey={`property:${prop.id}`}
                onDraftState={reportDraft}
                label="字段名称"
                value={prop.name}
                onSave={(value) =>
                  mutate(() => client.updateProperty(prop.id, { name: value }))
                }
              />
              <View style={{ flexDirection: "row", gap: 8 }}>
                <ManagementAction
                  label="字段上移"
                  disabled={busy || index === 0}
                  onPress={() =>
                    run(() =>
                      client.moveProperty(
                        prop.id,
                        props[index - 1]!.id,
                        "before",
                      ),
                    )
                  }
                />
                <ManagementAction
                  label="字段下移"
                  disabled={busy || index === props.length - 1}
                  onPress={() =>
                    run(() =>
                      client.moveProperty(
                        prop.id,
                        props[index + 1]!.id,
                        "after",
                      ),
                    )
                  }
                />
              </View>
              {prop.type === "select" || prop.type === "multi_select" ? (
                <>
                  {(prop.config?.options ?? []).map((option, i, all) => {
                    const key = optionKey(prop.id, option, all);
                    return (
                      <View key={key}>
                        <Rename
                          draftKey={`option:${key}`}
                          onDraftState={reportDraft}
                          label="选项名称"
                          value={option}
                          onSave={(value) => {
                            setOptionAliases((previous) => [
                              ...previous,
                              {
                                property: prop.id,
                                source: option,
                                target: value,
                                key,
                              },
                            ]);
                            return mutate(() =>
                              client.renameSelectOption(prop.id, option, value),
                            );
                          }}
                        />
                        <View style={{ flexDirection: "row" }}>
                          <ManagementAction
                            label="选项上移"
                            disabled={busy || !i}
                            onPress={() =>
                              run(() =>
                                client.moveSelectOption(
                                  prop.id,
                                  option,
                                  all[i - 1]!,
                                  "before",
                                ),
                              )
                            }
                          />
                          <ManagementAction
                            label="选项下移"
                            disabled={busy || i === all.length - 1}
                            onPress={() =>
                              run(() =>
                                client.moveSelectOption(
                                  prop.id,
                                  option,
                                  all[i + 1]!,
                                  "after",
                                ),
                              )
                            }
                          />
                        </View>
                      </View>
                    );
                  })}
                  <Rename
                    draftKey={`new-option:${prop.id}`}
                    onDraftState={reportDraft}
                    key={prop.id}
                    clearAfterSave
                    label="添加选项"
                    value=""
                    onSave={(value) =>
                      mutate(async () => {
                        const latest = (
                          await client.listProperties(database.id)
                        ).find((p) => p.id === prop.id);
                        if (!latest) throw new Error("字段已不存在");
                        return client.updateProperty(prop.id, {
                          config: {
                            ...latest.config,
                            options: [
                              ...new Set([
                                ...(latest.config?.options ?? []),
                                value,
                              ]),
                            ],
                          },
                        });
                      })
                    }
                  />
                </>
              ) : null}
            </ManagementSection>
          ))}
          <ManagementSection title="添加字段">
            <ManagementInput
              disabled={busy}
              label="新字段名称"
              value={name}
              onChange={(name) => editField({ name })}
            />
            <NativeHost matchContents>
              <Picker
                enabled={!busy}
                selectedValue={type}
                onValueChange={(v) => editField({ type: v as PropType })}
              >
                {(
                  [
                    "text",
                    "number",
                    "checkbox",
                    "select",
                    "multi_select",
                    "date",
                    "url",
                    "relation",
                    "doc",
                  ] as PropType[]
                ).map((t) => (
                  <Picker.Item key={t} label={t} value={t} />
                ))}
              </Picker>
            </NativeHost>
            {type === "select" || type === "multi_select" ? (
              <ManagementInput
                disabled={busy}
                label="选项，每行一个"
                value={options}
                onChange={(options) => editField({ options })}
                multiline
              />
            ) : null}
            {type === "relation" ? (
              <>
                <ManagementAction
                  disabled={busy}
                  label={
                    targetName ? `目标数据库：${targetName}` : "选择目标数据库"
                  }
                  onPress={() => setPickingDatabase(true)}
                />
                {pickingDatabase ? (
                  <DatabasePickerSheet
                    onClose={() => setPickingDatabase(false)}
                    onSelect={(id, name) => {
                      editField({ target: id, targetName: name });
                    }}
                  />
                ) : null}
              </>
            ) : null}
            <ManagementAction
              label={busy ? "保存中…" : "添加字段"}
              disabled={
                busy || !name.trim() || (type === "relation" && !target)
              }
              onPress={() =>
                run(async () => {
                  const snapshot = latestField.current;
                  if (
                    !snapshot.name.trim() ||
                    (snapshot.type === "relation" && !snapshot.target)
                  )
                    throw new Error("请填写字段名称并选择关联数据库");
                  const { name, type, options, target } = snapshot;
                  await client.createProperty({
                    db: database.id,
                    name: name.trim(),
                    type,
                    ...(type === "select" || type === "multi_select"
                      ? {
                          config: {
                            options: [
                              ...new Set(
                                options
                                  .split("\n")
                                  .map((v) => v.trim())
                                  .filter(Boolean),
                              ),
                            ],
                          },
                        }
                      : type === "relation"
                        ? { config: { database: target } }
                        : {}),
                  });
                  if (session.isCurrent() && latestField.current === snapshot) {
                    const clean = { ...snapshot, name: "", options: "" };
                    fieldBaseline.current = clean;
                    latestField.current = clean;
                    reportField();
                    setField(clean);
                  }
                })
              }
            />
          </ManagementSection>
        </>
      )}
      <ManagementAction
        label="完成"
        disabled={busy}
        onPress={() => {
          if (!activeWrites.current) onClose();
        }}
      />
    </View>
  );
}
