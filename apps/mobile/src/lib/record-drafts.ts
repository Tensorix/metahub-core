/** One writer per record. Newer edits replace queued values, never in-flight writes. */
export type Draft = {
  value: unknown;
  status: "draft" | "invalid" | "pending" | "saving" | "saved" | "error";
  error?: string;
  savedVersion?: number;
};

export class RecordDrafts {
  readonly fields = new Map<string, Draft>();
  acknowledgedVersion = 0;
  private running = false;
  private stopped = false;

  constructor(
    private write: (id: string, value: unknown) => Promise<unknown>,
    private changed: () => void,
    private settled: () => void = () => {},
  ) {}

  get dirty() {
    return [...this.fields.values()].some(d => d.status !== "saved");
  }

  stage(id: string, value: unknown) {
    this.fields.set(id, { value, status: "draft" });
    this.notify();
  }

  fail(id: string, error: string) {
    const draft = this.fields.get(id);
    if (!draft) return;
    this.fields.set(id, { ...draft, status: "invalid", error });
    this.notify();
  }

  save(id: string, value: unknown) {
    this.fields.set(id, { value, status: "pending" });
    this.notify();
    void this.drain();
  }

  retry() {
    for (const [id, draft] of this.fields) {
      if (draft.status === "error") {
        this.fields.set(id, { value: draft.value, status: "pending" });
      }
    }
    this.notify();
    void this.drain();
  }

  /** Only a read started after a successful write may replace its saved overlay.
   * Call after the fetch hook accepts the response, never inside its fetcher. */
  reconcile(cells: Record<string, unknown>, readVersion?: number) {
    let changed = false;
    for (const [id, draft] of this.fields) {
      const fresh = readVersion !== undefined && draft.savedVersion !== undefined && readVersion >= draft.savedVersion;
      const confirmed = JSON.stringify(cells[id] ?? null) === JSON.stringify(draft.value ?? null);
      if (draft.status === "saved" && (fresh || confirmed)) {
        this.fields.delete(id);
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  stop() {
    this.stopped = true;
  }

  // Effects may restart during React StrictMode's setup/cleanup verification.
  resume() {
    this.stopped = false;
    void this.drain();
  }

  private notify() {
    if (!this.stopped) this.changed();
  }

  private async drain() {
    if (this.running || this.stopped) return;
    this.running = true;
    let wrote = false;
    try {
      while (!this.stopped) {
        const next = [...this.fields].find(([, draft]) => draft.status === "pending");
        if (!next) break;
        const [id, draft] = next;
        draft.status = "saving";
        this.notify();
        wrote = true;
        try {
          await this.write(id, draft.value);
          const version = ++this.acknowledgedVersion;
          if (this.fields.get(id) === draft) {
            draft.status = "saved";
            draft.savedVersion = version;
          }
        } catch (error) {
          // A failed older write must leave a newer edit queued and intact.
          if (this.fields.get(id) === draft) {
            draft.status = "error";
            draft.error = error instanceof Error ? error.message : String(error);
          }
        }
        this.notify();
      }
    } finally {
      this.running = false;
      if (!this.stopped && wrote) this.settled();
    }
  }
}

export function parseNumberDraft(value: string): number | null {
  if (!value.trim()) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("请输入有效数字");
  return number;
}
