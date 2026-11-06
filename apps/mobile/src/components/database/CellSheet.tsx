import { useRouter } from "expo-router";
import { useSession } from "@/lib/auth/session";
import { useState, useRef } from "react";
import { Button, Column, Checkbox, Picker, Text, Switch } from "@expo/ui";
import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import { NativeSheet } from "../native/NativeSheet";
import { NativeHost } from "../native/NativeHost";
import { RecordTextInput } from "../RecordTextInput";
import { RefPickerSheet, referenceIds } from "../RefField";
import type { PropInfo } from "@/lib/api/sdk";
import { parseDate, toISO } from "../../../../../src/shared/views/date";
export function CellSheet({
  prop,
  value,
  onSave,
  onClose,
  onStage,
}: {
  prop: PropInfo;
  value: unknown;
  onStage?(value: unknown): void;
  onSave(value: unknown): Promise<boolean>;
  onClose(): void;
}) {
  const router = useRouter(),
    session = useSession();
  const initial = prop.type === "date" && !parseDate(value) ? toISO(new Date()) : value;
  const latest = useRef(initial);
  const [draft, updateDraft] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const setDraft = (value: unknown) => {
    latest.current=value;
    updateDraft(value);
    onStage?.(value);
  };
  const save = async (v = latest.current) => {
    if (busy) return;
    setBusy(true);
    try {
      if (await onSave(v)) onClose();
      else setError("保存失败，请重试");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  if (prop.type === "relation" || prop.type === "doc")
    return (
      <RefPickerSheet
        prop={prop}
        initialSelected={referenceIds(draft)}
        onChange={setDraft}
        busy={busy}
        error={error ? new Error(error) : null}
        onRetry={() => void save()}
        onOpen={(id) => {
          void (async () => {
            if (busy) return;
            setBusy(true);
            try {
              const [target] = await session.client.referenceSummaries({
                kind: prop.type === "doc" ? "document" : "record",
                databaseId: prop.config?.database as string | undefined,
                ids: [id],
              });
              if (!target || target.missing)
                throw new Error("目标已删除或不可用");
              if (await onSave(latest.current)) {
                onClose();
                router.push(
                  `/${prop.type === "doc" ? "doc" : "record"}/${encodeURIComponent(id)}`,
                );
              } else setError("保存失败，请重试");
            } catch (e) {
              setError(String(e));
            } finally {
              setBusy(false);
            }
          })();
        }}
        onClose={() => void save()}
      />
    );
  return (
    <NativeHost>
      <NativeSheet
        isPresented
        onDismiss={() => {
          if (!busy) void save();
        }}
        dismissible={!busy}
      >
        <Column>
          <Text>{prop.name}</Text>
          {prop.type === "select" ? (
            <Picker
              selectedValue={String(draft ?? "")}
              onValueChange={(v) => setDraft(v || null)}
            >
              <Picker.Item value="" label="无" />
              {(prop.config?.options ?? []).map((o) => (
                <Picker.Item key={o} value={o} label={o} />
              ))}
            </Picker>
          ) : prop.type === "multi_select" ? (
            (prop.config?.options ?? []).map((o) => (
              <Checkbox
                key={o}
                label={o}
                value={Array.isArray(draft) && draft.includes(o)}
                onValueChange={(checked) =>
                  setDraft(
                    checked
                      ? [
                          ...new Set([
                            ...(Array.isArray(draft) ? draft : []),
                            o,
                          ]),
                        ]
                      : (Array.isArray(draft) ? draft : []).filter(
                          (v) => v !== o,
                        ),
                  )
                }
              />
            ))
          ) : prop.type === "date" ? (
            <DateTimePicker
              value={parseDate(draft) ?? new Date()}
              mode="date"
              onChange={(_, d) => {
                if (d) setDraft(toISO(d));
              }}
            />
          ) : prop.type === "checkbox" ? (
            <Switch
              label={prop.name}
              value={draft === true}
              onValueChange={setDraft}
            />
          ) : (
            <RecordTextInput
              text={String(draft ?? "")}
              onChangeText={setDraft}
              multiline={prop.type === "text"}
              keyboardType={
                prop.type === "number"
                  ? "decimal-pad"
                  : prop.type === "url"
                    ? "url"
                    : "default"
              }
            />
          )}
          {!!error && <Text>{error}</Text>}
          <Button
            label="清空"
            variant="text"
            disabled={busy}
            onPress={() => setDraft(null)}
          />
          <Button
            label={busy ? "保存中…" : "完成"}
            disabled={busy}
            onPress={() => void save()}
          />
        </Column>
      </NativeSheet>
    </NativeHost>
  );
}
