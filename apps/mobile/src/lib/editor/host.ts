import { type EditorDraft, type EditorMediaRequest, type EditorRequest, type EditorResponse } from "./protocol";
export interface EditorHostServices {
  load(): Promise<{ title: string; body: string; version: string | null }>;
  readDraft(): Promise<EditorDraft | null>;
  checkpoint(draft: EditorDraft): Promise<void>;
  acknowledge(revision: number, version: string | null): Promise<void>;
  save(snapshot: { title: string; body: string; version: string | null; force: boolean }): Promise<{ version: string | null }>;
  listTargets?(): Promise<{ id: string; title: string; kind: "doc" | "db" | "rec" }[]>;
  media?(request: EditorMediaRequest): Promise<{ src?: string; url?: string; name?: string; mime?: string }>;
  navigate?(target: string): Promise<void>;
  isCurrent(): boolean;
}
/** One instance per renderer. Every mutation runs in order; a late old-session
 * response cannot enter a replacement renderer or acknowledge its draft. */
export class EditorHost {
  private disposed = false;
  private chain: Promise<unknown> = Promise.resolve();
  private seen = new Set<number>();
  private lastRevision = -1;
  private versions = new Map<string | null, string | null>();
  private rebase(draft: EditorDraft): EditorDraft {
    let version = draft.version;
    const visited = new Set<string | null>();
    while (this.versions.has(version) && !visited.has(version)) { visited.add(version); version = this.versions.get(version)!; }
    return version === draft.version ? draft : { ...draft, version };
  }
  constructor(readonly session: string, private services: EditorHostServices) {}
  dispose() { this.disposed = true; }
  private current() {
    if (this.disposed || !this.services.isCurrent()) throw new Error("Editor session has expired");
  }
  request(request: EditorRequest): Promise<EditorResponse | null> {
    if (request.session !== this.session || this.seen.has(request.id)) return Promise.resolve(null);
    this.seen.add(request.id);
    const run = async (): Promise<EditorResponse | null> => {
      try {
        this.current();
        const value = await this.perform(request);
        this.current();
        return { v: 1, session: this.session, type: "response", id: request.id, ok: true, value };
      } catch (error) {
        if (this.disposed || !this.services.isCurrent()) return null;
        return { v: 1, session: this.session, type: "response", id: request.id, ok: false, error: error instanceof Error ? error.message : String(error), code: (error as { code?: string })?.code };
      }
    };
    if (request.method === "media" || request.method === "targets" || request.method === "navigate") return run();
    const pending = this.chain.then(run, run);
    this.chain = pending;
    return pending;
  }
  private async perform(request: EditorRequest): Promise<unknown> {
    switch (request.method) {
      case "load": {
        const draft = await this.services.readDraft();
        this.current();
        if (draft) { this.lastRevision = draft.revision; return { ...draft, recovered: true }; }
        const doc = await this.services.load();
        this.current();
        return { ...doc, revision: 0, recovered: false };
      }
      case "refresh": return this.services.load();
      case "checkpoint": {
        const draft = this.rebase(request.params as EditorDraft);
        if (draft.revision < this.lastRevision) throw new Error("Stale draft checkpoint");
        await this.services.checkpoint(draft);
        this.current();
        this.lastRevision = draft.revision;
        return null;
      }
      case "save": {
        const draft = { ...this.rebase(request.params as EditorDraft), force: (request.params as EditorDraft & { force: boolean }).force };
        // Durable checkpoint is a precondition, including explicit retries.
        await this.services.checkpoint(draft);
        this.current();
        this.lastRevision = Math.max(this.lastRevision, draft.revision);
        const saved = await this.services.save(draft);
        this.current();
        if (draft.version !== saved.version) this.versions.set(draft.version, saved.version);
        // A newer keystroke may have checkpointed before this save reached
        // native. Rebase only our own accepted save; preserve the newer body.
        const newer = await this.services.readDraft();
        this.current();
        if (newer && newer.revision > draft.revision) await this.services.checkpoint(this.rebase(newer));
        this.current();
        await this.services.acknowledge(draft.revision, saved.version);
        return saved;
      }
      case "targets": return this.services.listTargets?.() ?? [];
      case "media": {
        if (!this.services.media) throw new Error("Media is unavailable in this session");
        return this.services.media(request.params as EditorMediaRequest);
      }
      case "navigate": {
        if (!this.services.navigate) throw new Error("Navigation is unavailable in this session");
        await this.services.navigate(request.params as string);
        return null;
      }
    }
  }
}
