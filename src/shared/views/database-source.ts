import type { RecordRow } from "../../core/records";
import type { RecordQuery } from "./query";
export interface QueryIndex {
  totalExact?: boolean;
  progress?: number;
  protocol?: 2;
  mode?: "cursor" | "index";
  statistics?: "loading" | "complete";
  id: string;
  revision: number;
  total: number;
  calc: Record<string, string>;
  partitions: Record<string, number>;
  range: { min: string | null; max: string | null };
}
export interface QueryPage {
  records: RecordRow[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  calc: Record<string, string>;
}
/** Same query semantics on HTTP, worker and native SQLite. */
export interface DatabaseDataSource {
  recordQueryStatus?(id: string): Promise<QueryIndex>;
  openRecordQuery(databaseId: string, query: RecordQuery): Promise<QueryIndex>;
  readRecordQuery(
    id: string,
    offset?: number,
    limit?: number,
    partition?: string,
  ): Promise<QueryPage>;
  locateRecordQuery(id: string, recordId: string): Promise<number>;
  closeRecordQuery(id: string): Promise<unknown>;
}
export interface DatabaseHost {
  pickDate?(
    value: unknown,
  ): Promise<{ cancelled?: boolean; value?: string | null }>;
  discardCheckpoint?(record: string, prop: string): Promise<unknown>;
  openRecord(id: string): Promise<void>;
  clipboardRead(): Promise<string>;
  clipboardWrite(text: string): Promise<void>;
  flush(): Promise<void>;
}
/** Page bodies alone are cached. Sparse array slots preserve absolute positions
 * without allocating placeholder records for every row. All views share this LRU. */
export class DatabaseQueryWindow {
  index: QueryIndex | null = null;
  private pages = new Map<string, RecordRow[]>();
  private pending = new Map<string, Promise<void>>();
  private epoch = 0;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private owner = `window-${Date.now()}-${Math.random()}`;
  constructor(
    private source: DatabaseDataSource,
    private changed: () => void,
    private failed: (e: Error) => void,
  ) {}
  async open(databaseId: string, query: RecordQuery) {
    clearTimeout(this.statusTimer);
    const epoch = ++this.epoch,
      old = this.index;
    this.index = null;
    this.pages.clear();
    this.pending.clear();
    if (old) void this.source.closeRecordQuery(old.id).catch(() => {});
    const index = await this.source.openRecordQuery(databaseId, {
      ...query,
      protocol: 2,
      owner: this.owner,
    });
    if (epoch !== this.epoch) {
      await this.source.closeRecordQuery(index.id);
      return;
    }
    this.index = index;
    this.changed();
    this.pollStatus(epoch);
  }
  private pollStatus(epoch: number) {
    if (this.index?.statistics !== "loading" || !this.source.recordQueryStatus)
      return;
    this.statusTimer = setTimeout(() => {
      const id = this.index?.id;
      if (!id || epoch !== this.epoch) return;
      void this.source.recordQueryStatus!(id)
        .then((index) => {
          if (epoch !== this.epoch) return;
          this.index = index;
          this.changed();
          this.pollStatus(epoch);
        })
        .catch((e) => {
          if (epoch === this.epoch) this.failed(e);
        });
    }, 50);
  }
  rows(partition?: string): RecordRow[] {
    const total =
      partition === undefined
        ? this.index?.total
        : (this.index?.partitions[partition] ?? 0);
    const rows = new Array<RecordRow>(total ?? 0),
      prefix = JSON.stringify(partition ?? null) + ":";
    for (const [key, page] of this.pages)
      if (key.startsWith(prefix)) {
        const offset = Number(key.slice(prefix.length));
        page.forEach((row, i) => {
          rows[offset + i] = row;
        });
      }
    return rows;
  }
  find(id: string) {
    for (const page of this.pages.values()) {
      const row = page.find((r) => r.id === id);
      if (row) return row;
    }
  }
  patch(row: RecordRow) {
    for (const page of this.pages.values()) {
      const i = page.findIndex((r) => r.id === row.id);
      if (i >= 0) page[i] = row;
    }
    this.changed();
  }
  async ensure(start: number, end: number, partition?: string, pageSize = 100) {
    const index = this.index;
    if (!index) return;
    const total =
      partition === undefined
        ? index.total
        : (index.partitions[partition] ?? 0);
    const jobs: Promise<void>[] = [];
    for (
      let offset = Math.floor(Math.max(0, start) / pageSize) * pageSize;
      offset < Math.min(total, end);
      offset += pageSize
    ) {
      const key = JSON.stringify(partition ?? null) + ":" + offset;
      if (
        (this.pages.get(key)?.length ?? 0) >= Math.min(pageSize, total - offset)
      ) {
        const page = this.pages.get(key)!;
        this.pages.delete(key);
        this.pages.set(key, page);
        continue;
      }
      let job = this.pending.get(key);
      if (!job) {
        const epoch = this.epoch;
        job = this.source
          .readRecordQuery(index.id, offset, pageSize, partition)
          .then((page) => {
            if (epoch !== this.epoch) return;
            this.pages.set(key, page.records);
            while (
              [...this.pages.values()].reduce(
                (sum, rows) => sum + rows.length,
                0,
              ) > 1000
            )
              this.pages.delete(this.pages.keys().next().value!);
            this.changed();
          })
          .catch((e) => {
            if (epoch === this.epoch) this.failed(e);
          })
          .finally(() => {
            if (epoch === this.epoch) this.pending.delete(key);
          });
        this.pending.set(key, job);
      }
      jobs.push(job);
    }
    await Promise.all(jobs);
  }
  async readRange(start: number, end: number) {
    const throughEnd =
      this.index?.totalExact === false && end >= this.index.total;
    while (
      this.index?.statistics === "loading" &&
      this.source.recordQueryStatus
    ) {
      const epoch = this.epoch,
        id = this.index.id;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      const next = await this.source.recordQueryStatus(id);
      if (epoch !== this.epoch) throw new Error("Replica query cancelled");
      this.index = next;
      this.changed();
    }
    const index = this.index;
    if (!index) throw new Error("查询尚未完成");
    if (throughEnd) end = index.total;
    const rows: RecordRow[] = [];
    for (
      let offset = start;
      offset < Math.min(end, index.total);
      offset += 100
    ) {
      const page = await this.source.readRecordQuery(
        index.id,
        offset,
        Math.min(100, end - offset),
      );
      rows.push(...page.records);
    }
    return rows;
  }
  async dispose() {
    clearTimeout(this.statusTimer);
    this.epoch++;
    await this.source.closeRecordQuery("owner:" + this.owner);
    const old = this.index;
    this.index = null;
    this.pages.clear();
    if (old) await this.source.closeRecordQuery(old.id);
  }
}
