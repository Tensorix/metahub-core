import {
  Button,
  Checkbox,
  FieldGroup,
  Picker,
  Switch,
  Text as NativeText,
} from "@expo/ui";
import { useRef, useState } from "react";
import { Text, View } from "react-native";
import { NativeHost } from "@/components/native/NativeHost";
import { RecordTextInput } from "@/components/RecordTextInput";
import { RefPickerSheet } from "@/components/RefField";
import type { PropertyRow } from "../../../../src/core/properties.ts";
import {
  condsFor,
  type ViewDef,
  type FilterRule,
} from "../../../../src/shared/views/model.ts";
import { useTheme } from "@/lib/theme";

/** One native Form owns scrolling and grouped rows; only the reference selector is a sibling sheet. */
export function ViewSettingsSheet({
  view,
  props,
  onClose,
  onSave,
  onSaved,
  onDirtyChange,
  section = "settings",
}: {
  section?: "settings" | "filter" | "sort";
  view: ViewDef;
  props: PropertyRow[];
  onClose(): void;
  onSave(view: ViewDef): Promise<void>;
  onSaved?(): void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { tokens } = useTheme();
  const [draft, setDraft] = useState(view),
    latest = useRef(view),
    baseline = useRef(view),
    saving = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [reference, setReference] = useState<string | null>(null),
    [addProperty, setAddProperty] = useState(props[0]?.id ?? "");
  const edit = (update: (value: ViewDef) => ViewDef) => {
    const next = update(latest.current);
    latest.current = next;
    onDirtyChange?.(JSON.stringify(next) !== JSON.stringify(baseline.current));
    setDraft(next);
  };
  const changeRule = (id: string, patch: Partial<FilterRule>) =>
    edit((v) => ({
      ...v,
      filter: {
        ...v.filter,
        rules: v.filter.rules.map((r) =>
          r.id === id ? { ...r, ...patch } : r,
        ),
      },
    }));
  const save = () => {
    if (saving.current) return;
    const snapshot = latest.current;
    if (!snapshot.name.trim()) return;
    saving.current = true;
    setBusy(true);
    setError("");
    void onSave({ ...snapshot, name: snapshot.name.trim() })
      .then(() => {
        baseline.current = snapshot;
        if (JSON.stringify(latest.current) === JSON.stringify(snapshot)) {
          saving.current = false;
          onDirtyChange?.(false);
          (onSaved ?? onClose)();
        } else {
          onDirtyChange?.(true);
          setError("新的修改尚未保存，请再次保存。");
        }
      })
      .catch((e) => {
        onDirtyChange?.(true);
        setError(String(e));
      })
      .finally(() => {
        saving.current = false;
        setBusy(false);
      });
  };
  const referenceRule = draft.filter.rules.find((r) => r.id === reference),
    referenceProp = props.find((p) => p.id === referenceRule?.prop);
  const selectProps = props.filter((p) => p.type === "select");
  return (
    <View style={{ flex: 1 }}>
      <NativeHost style={{ flex: 1 }}>
        <FieldGroup disabled={busy}>
          {section === "settings" && (
            <FieldGroup.Section title="视图">
              <RecordTextInput
                text={draft.name}
                placeholder="视图名称"
                editable={!busy}
                onChangeText={(name) => edit((v) => ({ ...v, name }))}
              />
              <Picker
                selectedValue={draft.layout}
                enabled={!busy}
                onValueChange={(layout) =>
                  edit((v) => ({ ...v, layout: layout as ViewDef["layout"] }))
                }
              >
                <Picker.Item label="表格" value="table" />
                <Picker.Item label="看板" value="board" />
                <Picker.Item label="日历" value="calendar" />
                <Picker.Item label="时间轴" value="timeline" />
              </Picker>
            </FieldGroup.Section>
          )}
          {section === "sort" && (
            <FieldGroup.Section title="排序">
              {props.map((prop) => {
                const sort = draft.sort.find((s) => s.prop === prop.id);
                return (
                  <Picker
                    key={prop.id}
                    enabled={!busy}
                    selectedValue={sort ? (sort.desc ? "desc" : "asc") : "none"}
                    onValueChange={(value) =>
                      edit((v) => ({
                        ...v,
                        sort:
                          value === "none"
                            ? v.sort.filter((s) => s.prop !== prop.id)
                            : v.sort.some((s) => s.prop === prop.id)
                              ? v.sort.map((s) =>
                                  s.prop === prop.id
                                    ? { ...s, desc: value === "desc" }
                                    : s,
                                )
                              : [
                                  ...v.sort,
                                  { prop: prop.id, desc: value === "desc" },
                                ],
                      }))
                    }
                  >
                    <Picker.Item
                      label={`${prop.name} · 默认顺序`}
                      value="none"
                    />
                    <Picker.Item label={`${prop.name} · 升序`} value="asc" />
                    <Picker.Item label={`${prop.name} · 降序`} value="desc" />
                  </Picker>
                );
              })}
            </FieldGroup.Section>
          )}
          {section === "settings" && (
            <>
              <FieldGroup.Section title="显示字段">
                <Switch
                  label="单元格内容换行"
                  value={!!draft.wrap}
                  onValueChange={(wrap) => edit((v) => ({ ...v, wrap }))}
                />
                {props.map((prop) => (
                  <Checkbox
                    key={prop.id}
                    label={prop.name}
                    disabled={busy}
                    value={!draft.hidden.includes(prop.id)}
                    onValueChange={(visible) =>
                      edit((v) => ({
                        ...v,
                        hidden: visible
                          ? v.hidden.filter((id) => id !== prop.id)
                          : [...new Set([...v.hidden, prop.id])],
                      }))
                    }
                  />
                ))}
              </FieldGroup.Section>
              <FieldGroup.Section title="看板分组">
                <Picker
                  enabled={!busy}
                  selectedValue={draft.group ?? ""}
                  onValueChange={(group) =>
                    edit((v) => ({ ...v, group: String(group) || undefined }))
                  }
                >
                  <Picker.Item label="默认分组" value="" />
                  {selectProps.map((prop) => (
                    <Picker.Item
                      key={prop.id}
                      label={prop.name}
                      value={prop.id}
                    />
                  ))}
                  {draft.group &&
                  !selectProps.some((p) => p.id === draft.group) ? (
                    <Picker.Item label="保留原分组字段" value={draft.group} />
                  ) : null}
                </Picker>
              </FieldGroup.Section>
            </>
          )}
          {section === "filter" && (
            <>
              <FieldGroup.Section title="筛选组合">
                <Picker
                  enabled={!busy}
                  selectedValue={draft.filter.op}
                  onValueChange={(op) =>
                    edit((v) => ({
                      ...v,
                      filter: { ...v.filter, op: op as "and" | "or" },
                    }))
                  }
                >
                  <Picker.Item label="满足全部条件" value="and" />
                  <Picker.Item label="满足任一条件" value="or" />
                </Picker>
              </FieldGroup.Section>
              {draft.filter.rules.map((rule) => {
                const prop = props.find((p) => p.id === rule.prop),
                  conditions = prop ? condsFor(prop.type) : [],
                  condition = conditions.find((c) => c.id === rule.cond);
                const selected = Array.isArray(rule.value)
                  ? rule.value.filter((v): v is string => typeof v === "string")
                  : [];
                return (
                  <FieldGroup.Section
                    key={rule.id}
                    title={prop?.name ?? `不可用字段 · ${rule.prop}`}
                  >
                    <Picker
                      enabled={!busy}
                      selectedValue={rule.cond}
                      onValueChange={(cond) =>
                        changeRule(rule.id, { cond: String(cond) })
                      }
                    >
                      {conditions.map((cond) => (
                        <Picker.Item
                          key={cond.id}
                          label={cond.label}
                          value={cond.id}
                        />
                      ))}
                      {!condition ? (
                        <Picker.Item
                          label={`保留原条件 ${rule.cond}`}
                          value={rule.cond}
                        />
                      ) : null}
                    </Picker>
                    {rule.cond === "empty" ||
                    rule.cond === "not_empty" ? null : prop?.type ===
                        "relation" || prop?.type === "doc" ? (
                      <Button
                        variant="text"
                        disabled={busy}
                        onPress={() => setReference(rule.id)}
                        label={`选择关联项（已选 ${selected.length}）`}
                      />
                    ) : prop?.type === "checkbox" ? (
                      <Switch
                        disabled={busy}
                        label="筛选值"
                        value={rule.value === true || rule.value === "true"}
                        onValueChange={(value) =>
                          changeRule(rule.id, { value })
                        }
                      />
                    ) : prop?.type === "select" ? (
                      <Picker
                        enabled={!busy}
                        selectedValue={String(rule.value ?? "")}
                        onValueChange={(value) =>
                          changeRule(rule.id, { value })
                        }
                      >
                        <Picker.Item label="选择选项" value="" />
                        {[
                          ...new Set([
                            ...(prop.config?.options ?? []),
                            ...(typeof rule.value === "string" && rule.value
                              ? [rule.value]
                              : []),
                          ]),
                        ].map((value) => (
                          <Picker.Item
                            key={value}
                            label={value}
                            value={value}
                          />
                        ))}
                      </Picker>
                    ) : prop?.type === "multi_select" ? (
                      <>
                        {[
                          ...new Set([
                            ...(prop.config?.options ?? []),
                            ...selected,
                          ]),
                        ].map((option) => (
                          <Checkbox
                            key={option}
                            label={option}
                            disabled={busy}
                            value={selected.includes(option)}
                            onValueChange={(checked) =>
                              changeRule(rule.id, {
                                value: checked
                                  ? [...new Set([...selected, option])]
                                  : selected.filter(
                                      (value) => value !== option,
                                    ),
                              })
                            }
                          />
                        ))}
                      </>
                    ) : (
                      <RecordTextInput
                        editable={!busy}
                        text={String(rule.value ?? "")}
                        placeholder={
                          prop?.type === "date"
                            ? "YYYY-MM-DD 或 today / this_week / past7"
                            : "筛选值"
                        }
                        onChangeText={(value) => changeRule(rule.id, { value })}
                      />
                    )}
                    <Button
                      label="移除此条件"
                      variant="text"
                      disabled={busy}
                      onPress={() =>
                        edit((v) => ({
                          ...v,
                          filter: {
                            ...v.filter,
                            rules: v.filter.rules.filter(
                              (r) => r.id !== rule.id,
                            ),
                          },
                        }))
                      }
                    />
                  </FieldGroup.Section>
                );
              })}
              <FieldGroup.Section title="添加筛选条件">
                <Picker
                  enabled={!busy}
                  selectedValue={addProperty}
                  onValueChange={(value) => setAddProperty(String(value))}
                >
                  {props.map((prop) => (
                    <Picker.Item
                      key={prop.id}
                      label={prop.name}
                      value={prop.id}
                    />
                  ))}
                </Picker>
                <Button
                  label="添加条件"
                  variant="text"
                  disabled={busy || !addProperty}
                  onPress={() => {
                    const prop = props.find((p) => p.id === addProperty);
                    if (!prop) return;
                    edit((v) => ({
                      ...v,
                      filter: {
                        ...v.filter,
                        rules: [
                          ...v.filter.rules,
                          {
                            id: `f_${Date.now()}_${Math.random()}`,
                            prop: prop.id,
                            cond: condsFor(prop.type)[0]!.id,
                          },
                        ],
                      },
                    }));
                  }}
                />
              </FieldGroup.Section>
            </>
          )}
          <FieldGroup.Section>
            <Button
              disabled={busy || !draft.name.trim()}
              onPress={save}
              label={busy ? "保存中…" : "保存视图"}
            />
            <Button
              label="取消"
              variant="text"
              disabled={busy}
              onPress={() => {
                if (!saving.current) onClose();
              }}
            />
            {error ? (
              <NativeText textStyle={{ color: tokens.danger }}>
                {error}
              </NativeText>
            ) : null}
          </FieldGroup.Section>
        </FieldGroup>
      </NativeHost>
      {error ? (
        <Text
          selectable
          accessibilityRole="alert"
          style={{ padding: 12, color: tokens.danger }}
        >
          {error}
        </Text>
      ) : null}
      {referenceRule && referenceProp ? (
        <RefPickerSheet
          prop={referenceProp}
          initialSelected={
            Array.isArray(referenceRule.value)
              ? referenceRule.value.filter(
                  (v): v is string => typeof v === "string",
                )
              : []
          }
          onChange={(value) => changeRule(referenceRule.id, { value })}
          onClose={() => setReference(null)}
        />
      ) : null}
    </View>
  );
}
