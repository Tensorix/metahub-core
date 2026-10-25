/** One writer per record. Newer edits replace queued values, never in-flight writes. */
export type Draft = {
  value: unknown;
  status: "draft" | "invalid" | "pending" | "saving" | "saved" | "error";
  error?: string;
  savedVersion?: number;
};

export type RecordFlushResult = { ok: true } | { ok: false; error: string };

export class RecordDrafts {
  readonly fields = new Map<string, Draft>();
  acknowledgedVersion = 0;
  private running = false;
  private stopped = false;
  private idleWaiters = new Set<() => void>();
  private persistenceError: string | null = null;

  constructor(
    private write: (id: string, value: unknown) => Promise<unknown>,
    private changed: () => void,
    private settled: () => void = () => {},
    private persistDrafts?: (fields: ReadonlyMap<string, Draft>) => void,
  ) {}

  get dirty() {
    return [...this.fields.values()].some((d) => d.status !== "saved");
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

  /** Commit staged text and wait for every accepted write, including edits
   * entered while a previous write was in flight. Invalid values stay local;
   * one failed write blocks departure rather than starting an automatic loop. */
  async flush(
    prepare: (id: string, value: unknown) => unknown = (_id, value) => value,
  ): Promise<RecordFlushResult> {
    let retryErrors = true;
    while (!this.stopped) {
      for (const [id, draft] of this.fields) {
        if (
          draft.status !== "draft" &&
          !(retryErrors && draft.status === "error")
        ) continue;
        try {
          this.fields.set(id, {
            value: prepare(id, draft.value), status: "pending",
          });
        } catch (error) {
          this.fields.set(id, {
            ...draft, status: "invalid",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      retryErrors = false;
      this.notify();
      void this.drain();
      while (this.running && !this.stopped)
        await new Promise<void>(resolve => this.idleWaiters.add(resolve));
      if (this.stopped) break;
      // A newer text edit may have replaced the in-flight field without being
      // submitted by blur. Prepare it on the next pass before calling it clean.
      if ([...this.fields.values()].some(draft =>
        draft.status === "draft" || draft.status === "pending" || draft.status === "saving",
      )) continue;
      const failed = [...this.fields.values()].find(draft =>
        draft.status === "invalid" || draft.status === "error",
      );
      if (this.persistenceError || failed) return {
        ok: false,
        error: this.persistenceError || failed?.error || "修改尚未保存，请检查后重试",
      };
      return { ok: true };
    }
    return { ok: false, error: "记录编辑会话已结束" };
  }

  /** Only a read started after a successful write may replace its saved overlay.
   * Call after the fetch hook accepts the response, never inside its fetcher. */
  reconcile(cells: Record<string, unknown>, readVersion?: number) {
    let changed = false;
    for (const [id, draft] of this.fields) {
      const fresh =
        readVersion !== undefined &&
        draft.savedVersion !== undefined &&
        readVersion >= draft.savedVersion;
      const confirmed =
        JSON.stringify(cells[id] ?? null) ===
        JSON.stringify(draft.value ?? null);
      if (draft.status === "saved" && (fresh || confirmed)) {
        this.fields.delete(id);
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  stop() {
    this.stopped = true;
    this.wakeIdleWaiters();
  }

  private wakeIdleWaiters() {
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  // Effects may restart during React StrictMode's setup/cleanup verification.
  resume() {
    this.stopped = false;
    void this.drain();
  }

  private notify() {
    if (!this.stopped && this.persistDrafts) {
      try {
        this.persistDrafts(this.fields);
        this.persistenceError = null;
      } catch (error) {
        this.persistenceError = `本地草稿保存失败：${error instanceof Error ? error.message : String(error)}`;
        for (const draft of this.fields.values())
          if (draft.status !== "saved") {
            draft.status = "error";
            draft.error = this.persistenceError;
          }
      }
    }
    if (!this.stopped) this.changed();
  }

  private async drain() {
    if (this.running || this.stopped) return;
    this.running = true;
    let wrote = false;
    try {
      while (!this.stopped) {
        const next = [...this.fields].find(
          ([, draft]) => draft.status === "pending",
        );
        if (!next) break;
        const [id, draft] = next;
        draft.status = "saving";
        this.notify();
        // A failed durable checkpoint is a failed save precondition.
        if (draft.status !== "saving") continue;
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
            draft.error =
              error instanceof Error ? error.message : String(error);
          }
        }
        this.notify();
      }
    } finally {
      this.running = false;
      this.wakeIdleWaiters();
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
