/** Shared by every document surface. A successful request only acknowledges
 * the revision it sent, never keystrokes entered while it was in flight. */
export type DocumentSaveState = "saved" | "dirty" | "saving" | "conflict" | "error";
export type DocumentSaveResult = { ok: true } | { ok: false; error: string };

export class DocumentSaveQueue {
  version: string | null = null;
  revision = 0;
  private cleanRevision = 0;
  private epoch = 0;
  private chain: Promise<unknown> = Promise.resolve();
  state: DocumentSaveState = "saved";
  error = "";
  constructor(private readonly options: {
    snapshot: () => { title: string; body: string };
    write: (snapshot: { title: string; body: string }, version: string | null, force: boolean) => Promise<{ version?: string | null }>;
    isConflict: (error: unknown) => boolean;
    changed: (state: DocumentSaveState) => void;
  }) {}
  get dirty() { return this.revision !== this.cleanRevision; }
  private publish(state: DocumentSaveState) { this.state = state; this.options.changed(state); }
  reset(version: string | null) {
    this.epoch++;
    this.version = version;
    this.cleanRevision = ++this.revision;
    this.error = "";
    this.publish("saved");
  }
  restoreDraft(version: string | null, error: string) {
    this.reset(version);
    this.revision++;
    this.error = error;
    // The source editor could not save. Keep the recovered draft blocked
    // until the user chooses how to resolve it, rather than retrying blindly.
    this.publish("conflict");
  }
  edit() {
    this.revision++;
    if (this.state !== "conflict") this.publish("dirty");
    else this.options.changed(this.state);
  }
  save(force = false): Promise<DocumentSaveResult> {
    const epoch = this.epoch;
    const run = async (): Promise<DocumentSaveResult> => {
      if (epoch !== this.epoch || !this.dirty) return { ok: true };
      if (this.state === "conflict" && !force) return { ok: false, error: this.error };
      const revision = this.revision;
      const snapshot = this.options.snapshot();
      this.publish("saving");
      try {
        const result = await this.options.write(snapshot, this.version, force);
        if (epoch !== this.epoch) return { ok: true };
        this.version = result.version ?? null;
        this.cleanRevision = revision;
        this.error = "";
        this.publish(this.dirty ? "dirty" : "saved");
        return { ok: true };
      } catch (error) {
        if (epoch !== this.epoch) return { ok: false, error: String(error) };
        this.error = error instanceof Error ? error.message : String(error);
        this.publish(this.options.isConflict(error) ? "conflict" : "error");
        return { ok: false, error: this.error };
      }
    };
    const next = this.chain.then(run, run);
    this.chain = next;
    return next;
  }
  async flush(): Promise<DocumentSaveResult> {
    // Wait for in-flight saves too; closing a window must not race the last
    // response. A close request freezes input in the renderer first.
    await this.chain;
    while (this.dirty) {
      const result = await this.save();
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  /** A read may only replace a clean editor if neither a save nor an edit
   * overtook it. Call immediately before applying its result. */
  canRefresh(revision: number, version: string | null) {
    return !this.dirty && revision === this.revision && version === this.version;
  }
}
