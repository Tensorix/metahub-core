import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSession } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";
import type { PropertyRow, PropType } from "../../../../src/core/properties.ts";
import type { DatabaseRow } from "../../../../src/core/databases.ts";

function Rename({ value, label, onSave }: { value: string; label: string; onSave(value: string): Promise<unknown> }) {
  const { tokens } = useTheme();
  const [text, setText] = useState(value), [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <View style={{ marginBottom: 12 }}>
    <Text style={{ color: tokens.muted }}>{label}</Text>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <TextInput accessibilityLabel={label} value={text} onChangeText={setText} style={{ flex: 1, color: tokens.fg, paddingVertical: 12, borderBottomWidth: 1, borderColor: tokens.line }} />
      <Pressable disabled={busy || !text.trim() || text === value} style={{ padding: 12 }} onPress={() => { setBusy(true); setError(""); void onSave(text.trim()).catch(e => setError(String(e))).finally(() => setBusy(false)); }}><Text style={{ color: tokens.accent }}>{busy ? "保存中…" : "保存"}</Text></Pressable>
    </View>{error ? <Text accessibilityRole="alert" style={{ color: tokens.danger }}>{error}</Text> : null}
  </View>;
}
export function DatabaseManageSheet({ database, props, onClose }: { database: DatabaseRow; props: PropertyRow[]; onClose(): void }) {
  const { client } = useSession(), { tokens } = useTheme();
  const [name, setName] = useState(""), [type, setType] = useState<PropType>("text"), [options, setOptions] = useState(""), [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const run = (job: () => Promise<unknown>) => { if (busy) return; setBusy(true); setError(""); void job().catch(e => setError(String(e))).finally(() => setBusy(false)); };
  return <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, paddingBottom: 80, backgroundColor: tokens.bg }}>
      <Pressable onPress={onClose} style={{ alignSelf: "flex-end", padding: 12 }}><Text style={{ color: tokens.accent }}>完成</Text></Pressable>
      <Text style={{ color: tokens.fg, fontSize: 24, fontWeight: "600", marginBottom: 20 }}>管理数据库</Text>
      <Rename key={database.id} label="数据库名称" value={database.name} onSave={value => client.updateDatabase(database.id, { name: value })} />
      {error ? <Text accessibilityRole="alert" style={{ color: tokens.danger }}>{error}</Text> : null}
      {props.map((prop, index) => <View key={prop.id} style={{ paddingVertical: 12, borderTopWidth: 1, borderColor: tokens.line }}>
        <Rename label={`${prop.type} · 字段名称`} value={prop.name} onSave={value => client.updateProperty(prop.id, { name: value })} />
        <View style={{ flexDirection: "row", gap: 20 }}>
          {index > 0 ? <Pressable disabled={busy} style={{ padding: 12 }} onPress={() => run(async () => { const before = props[index - 1]!; const position = index > 1 ? (props[index - 2]!.position + before.position) / 2 : before.position - 1; await client.updateProperty(prop.id, { position }); })}><Text style={{ color: tokens.accent }}>上移</Text></Pressable> : null}
          {index < props.length - 1 ? <Pressable disabled={busy} style={{ padding: 12 }} onPress={() => run(async () => { const after = props[index + 1]!; const position = index + 2 < props.length ? (after.position + props[index + 2]!.position) / 2 : after.position + 1; await client.updateProperty(prop.id, { position }); })}><Text style={{ color: tokens.accent }}>下移</Text></Pressable> : null}
        </View>
        {(prop.type === "select" || prop.type === "multi_select") ? <>
          {(prop.config?.options ?? []).map(option => <Rename key={option} label="选项名称" value={option} onSave={value => client.renameSelectOption(prop.id, option, value)} />)}
          <Rename key={`${prop.id}:${prop.config?.options?.length}`} label="添加选项" value="" onSave={value => client.updateProperty(prop.id, { config: { options: [...new Set([...(prop.config?.options ?? []), value])] } })} />
        </> : null}
      </View>)}
      <Text style={{ color: tokens.fg, fontSize: 20, marginTop: 24 }}>添加字段</Text>
      <TextInput accessibilityLabel="新字段名称" placeholder="字段名称" placeholderTextColor={tokens.muted} value={name} onChangeText={setName} style={{ paddingVertical: 16, color: tokens.fg }} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>{(["text", "number", "checkbox", "select", "multi_select", "date", "url", "relation", "doc"] as PropType[]).map(item => <Pressable key={item} accessibilityRole="button" accessibilityState={{ selected: type === item }} onPress={() => setType(item)} style={{ padding: 12, backgroundColor: type === item ? tokens.accentSoft : tokens.surface }}><Text style={{ color: tokens.fg }}>{item}</Text></Pressable>)}</View>
      {type === "select" || type === "multi_select" ? <TextInput accessibilityLabel="选项，每行一个" placeholder="选项，每行一个" multiline value={options} onChangeText={setOptions} style={{ padding: 16, color: tokens.fg }} /> : null}
      {type === "relation" ? <TextInput accessibilityLabel="目标数据库完整 ID" placeholder="目标数据库完整 ID" value={target} onChangeText={setTarget} style={{ padding: 16, color: tokens.fg }} /> : null}
      <Pressable disabled={busy || !name.trim()} style={{ paddingVertical: 20 }} onPress={() => run(async () => { await client.createProperty({ db: database.id, name: name.trim(), type, ...(type === "select" || type === "multi_select" ? { config: { options: [...new Set(options.split("\n").map(v => v.trim()).filter(Boolean))] } } : type === "relation" ? { config: { database: target.trim() } } : {}) }); setName(""); setOptions(""); })}><Text style={{ color: tokens.accent }}>{busy ? "保存中…" : "添加字段"}</Text></Pressable>
    </ScrollView>
  </Modal>;
}
