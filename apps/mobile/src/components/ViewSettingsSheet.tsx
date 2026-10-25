import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { PropertyRow } from "../../../../src/core/properties.ts";
import { condsFor, type ViewDef, type FilterRule } from "../../../../src/shared/views/model.ts";
import { useTheme } from "@/lib/theme";

export function ViewSettingsSheet({ view, props, onClose, onSave }: { view: ViewDef; props: PropertyRow[]; onClose(): void; onSave(view: ViewDef): Promise<void> }) {
  const { tokens } = useTheme();
  const [draft, setDraft] = useState(view), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const button = (label: string, onPress: () => void, selected = false) => <Pressable key={label} accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={{ padding: 12, backgroundColor: selected ? tokens.accentSoft : tokens.surface }}><Text style={{ color: tokens.fg }}>{label}</Text></Pressable>;
  const changeRule = (index: number, patch: Partial<FilterRule>) => setDraft(v => ({ ...v, filter: { ...v.filter, rules: v.filter.rules.map((r, i) => i === index ? { ...r, ...patch } : r) } }));
  return <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, paddingBottom: 80, backgroundColor: tokens.bg }}>
      <Pressable style={{ padding: 12, alignSelf: "flex-end" }} onPress={onClose}><Text style={{ color: tokens.accent }}>取消</Text></Pressable>
      <Text style={{ fontSize: 24, color: tokens.fg, fontWeight: "600" }}>视图设置</Text>
      <TextInput accessibilityLabel="视图名称" value={draft.name} onChangeText={name => setDraft(v => ({ ...v, name }))} style={{ paddingVertical: 20, color: tokens.fg }} />
      <View style={{ flexDirection: "row", gap: 8 }}>{button("列表", () => setDraft(v => ({ ...v, layout: "table" })), draft.layout === "table")}{button("看板", () => setDraft(v => ({ ...v, layout: "board" })), draft.layout === "board")}</View>
      <Text style={{ color: tokens.fg, fontSize: 18, marginTop: 24, marginBottom: 8 }}>排序（点按切换升序、降序、默认）</Text>
      {props.map(prop => { const sort = draft.sort.find(r => r.prop === prop.id); return button(`${prop.name} · ${sort ? sort.desc ? "降序" : "升序" : "默认"}`, () => setDraft(v => ({ ...v, sort: !sort ? [...v.sort, { prop: prop.id, desc: false }] : !sort.desc ? v.sort.map(r => r.prop === prop.id ? { ...r, desc: true } : r) : v.sort.filter(r => r.prop !== prop.id) })), !!sort); })}
      <Text style={{ color: tokens.fg, fontSize: 18, marginTop: 24, marginBottom: 8 }}>显示字段</Text>
      {props.map(prop => button(`${draft.hidden.includes(prop.id) ? "隐藏" : "显示"} · ${prop.name}`, () => setDraft(v => ({ ...v, hidden: v.hidden.includes(prop.id) ? v.hidden.filter(id => id !== prop.id) : [...v.hidden, prop.id] })), !draft.hidden.includes(prop.id)))}
      <Text style={{ color: tokens.fg, fontSize: 18, marginTop: 24, marginBottom: 8 }}>看板分组</Text>
      {button("默认分组", () => setDraft(v => ({ ...v, group: undefined })), !draft.group)}
      {props.filter(p => p.type === "select").map(prop => button(prop.name, () => setDraft(v => ({ ...v, group: prop.id })), draft.group === prop.id))}
      <Text style={{ color: tokens.fg, fontSize: 18, marginTop: 24, marginBottom: 8 }}>筛选</Text>
      {button(draft.filter.op === "and" ? "满足全部条件" : "满足任一条件", () => setDraft(v => ({ ...v, filter: { ...v.filter, op: v.filter.op === "and" ? "or" : "and" } })))}
      {draft.filter.rules.map((rule, index) => { const prop = props.find(p => p.id === rule.prop); return <View key={rule.id} style={{ marginVertical: 12, borderBottomWidth: 1, borderColor: tokens.line }}>
        <Text style={{ color: tokens.fg }}>{prop?.name ?? rule.prop}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>{(prop ? condsFor(prop.type) : []).map(cond => button(cond.label, () => changeRule(index, { cond: cond.id }), rule.cond === cond.id))}</View>
        {rule.cond !== "empty" && rule.cond !== "not_empty" ? <TextInput accessibilityLabel={`${prop?.name ?? rule.prop} 筛选值`} placeholder={prop?.type === "checkbox" ? "true / false" : prop?.type === "date" ? "YYYY-MM-DD 或 today / this_week / this_month / past7 / next7" : prop?.type === "multi_select" || prop?.type === "relation" || prop?.type === "doc" ? "多个值用逗号分隔" : "筛选值"} placeholderTextColor={tokens.muted} value={Array.isArray(rule.value) ? rule.value.join(",") : String(rule.value ?? "")} onChangeText={text => changeRule(index, { value: prop?.type === "checkbox" ? text : ["multi_select", "relation", "doc"].includes(prop?.type ?? "") ? text.split(",").map(v => v.trim()).filter(Boolean) : text })} style={{ paddingVertical: 16, color: tokens.fg }} /> : null}
        {button("移除此条件", () => setDraft(v => ({ ...v, filter: { ...v.filter, rules: v.filter.rules.filter((_, i) => i !== index) } })))}
      </View>; })}
      <Text style={{ color: tokens.muted, marginTop: 12 }}>添加筛选条件</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>{props.map(prop => button(prop.name, () => setDraft(v => ({ ...v, filter: { ...v.filter, rules: [...v.filter.rules, { id: `f_${Date.now()}_${Math.random()}`, prop: prop.id, cond: condsFor(prop.type)[0]!.id }] } }))))}</View>
      {error ? <Text accessibilityRole="alert" style={{ color: tokens.danger }}>{error}</Text> : null}
      <Pressable disabled={busy || !draft.name.trim()} style={{ paddingVertical: 24 }} onPress={() => { setBusy(true); setError(""); void onSave({ ...draft, name: draft.name.trim() }).then(onClose).catch(e => setError(String(e))).finally(() => setBusy(false)); }}><Text style={{ color: tokens.accent }}>{busy ? "保存中…" : "保存视图"}</Text></Pressable>
    </ScrollView>
  </Modal>;
}
