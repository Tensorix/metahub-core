import { RecordDrafts, parseNumberDraft } from "./record-drafts";
import type { ReplicaService } from "../../../../src/core/replica/service";
import type { PropInfo, RecordInfo } from "./api/sdk";

/** A workspace owns one writer per record, shared by grid and detail screens. */
const registries = new WeakMap<
  ReplicaService,
  Map<string, { drafts: RecordDrafts; listeners: Set<() => void> }>
>();
export function recordWriter(service: ReplicaService, id: string) {
  let registry = registries.get(service);
  if (!registry) {
    registry = new Map();
    registries.set(service, registry);
  }
  let entry = registry.get(id);
  if (!entry) {
    const listeners = new Set<() => void>();
    const notify = () => listeners.forEach((fn) => fn());
    const drafts = new RecordDrafts(
      (pid, value) => service.client.updateRecord(id, { [pid]: value }),
      notify,
      notify,
      (fields) => {
        for (const [pid, draft] of fields) {
          if (draft.status === "saved")
            service.drafts.acknowledgeField(id, pid, draft.value);
          else
            service.drafts.checkpointField(id, pid, {
              value: draft.value,
              status: draft.status === "saving" ? "pending" : draft.status,
              error: draft.error,
            });
        }
      },
      (cells) => service.client.updateRecord(id, cells),
    );
    for (const [pid, draft] of Object.entries(service.drafts.readFields(id)))
      drafts.fields.set(pid, {
        ...draft,
        status: draft.status === "pending" ? "draft" : draft.status,
      });
    entry = { drafts, listeners };
    registry.set(id, entry);
  }
  return entry;
}
export function prepareCell(props: PropInfo[], pid: string, value: unknown) {
  const prop = props.find((p) => p.id === pid);
  if (!prop) throw new Error("字段已删除或不可用");
  return prop.type === "number" ? parseNumberDraft(String(value ?? "")) : value;
}

/** A read-only overlay; writers are recovered when records load, never during render. */
export function withRecordDrafts(
  service: ReplicaService,
  record: RecordInfo,
): RecordInfo {
  const entry = registries.get(service)?.get(record.id);
  if (!entry?.drafts.fields.size) return record;
  return {
    ...record,
    cells: {
      ...record.cells,
      ...Object.fromEntries(
        [...entry.drafts.fields].map(([id, d]) => [id, d.value]),
      ),
    },
  };
}

export function hasDirtyWriters(service: ReplicaService) {
  return [...(registries.get(service)?.values() ?? [])].some(
    (entry) => entry.drafts.dirty,
  );
}
