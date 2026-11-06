import { cloneProtocolState } from "./portable-json.ts";
import { MhError } from "../errors.ts";
import type { StorageClient } from "./storage.ts";

export interface CommitRecord<T> {
  protocolVersion: 2;
  workspaceId: string;
  sequence: number;
  previous: string | null;
  requestId: string;
  payload: T;
}
export interface CommitHead<S> {
  sequence: number;
  hash: string | null;
  state: S;
  serverTime: number | null;
}
export interface CommitCodec {
  encode(value: unknown): Promise<Uint8Array>;
  decode(bytes: Uint8Array): Promise<unknown>;
}
export async function commitHash(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.length); copy.set(bytes);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", copy))]
    .map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Immutable numbered slots arbitrate concurrent proposals. Absence is only a
 * read hint: append must win an atomic conditional create before it succeeds.
 * Callers supply an authenticated codec and a pure validating state reducer. */
export function createCommitLog<S, T>(options: {
  client: StorageClient;
  prefix: string;
  workspaceId: string;
  codec: CommitCodec;
  initialState(): S;
  validateProposal?(payload: T): void;
  checkHead?(state: S): void;
  checkAccepted?(state: S, payload: T): void;
  reduce(state: S, payload: T, committedAt: number): S;
  parsePayload(value: unknown): T;
}) {
  const { client, codec } = options;
  const limit = 1024 * 1024;
  const key = (sequence: number) => `${options.prefix}/control/${String(sequence).padStart(16, "0")}.commit`;
  const initial = (): CommitHead<S> => ({ sequence: 0, hash: null, state: options.initialState(), serverTime: null });
  const record = (raw: unknown): CommitRecord<T> => {
    if (!raw || typeof raw !== "object") throw new MhError("invalid_input", "invalid commit record");
    const r = raw as CommitRecord<unknown>;
    if (r.protocolVersion !== 2 || r.workspaceId !== options.workspaceId ||
        !Number.isSafeInteger(r.sequence) || r.sequence < 1 ||
        typeof r.requestId !== "string" || !r.requestId.length ||
        !(r.previous === null || (typeof r.previous === "string" && /^[a-f0-9]{64}$/.test(r.previous))))
      throw new MhError("invalid_input", "invalid commit envelope");
    return { ...r, payload: options.parsePayload(r.payload) };
  };
  const verified = new Map<number, { record: CommitRecord<T>; hash: string; at: number }>();
  const readNext = async (head: CommitHead<S>) => {
    if (!client.getWithMetadata) throw new MhError("invalid_input", "commit log requires metadata reads");
    let entry = verified.get(head.sequence + 1);
    if (!entry) {
      const object = await client.getWithMetadata(key(head.sequence + 1), { maxBytes: limit });
      if (!object) return null; // Never cache absence: visibility may lag a committed PUT.
      const decoded = record(await codec.decode(object.bytes));
      const at = object.lastModified, now = object.serverDate;
      if (at === null || now === null) {
        const missing = [at === null ? "Last-Modified" : null, now === null ? "Date" : null].filter(Boolean).join(", ");
        throw new MhError("clock_skew", `commit time cannot be verified: missing or invalid ${missing} response header; check bucket CORS ExposeHeaders`);
      }
      if (at > now)
        throw new MhError("clock_skew", `commit time cannot be verified: Last-Modified (${at}) is later than Date (${now})`);
      entry = { record: decoded, hash: await commitHash(object.bytes), at };
    }
    const r = cloneProtocolState(entry.record), at = entry.at;
    if (r.sequence !== head.sequence + 1 || r.previous !== head.hash)
      throw new MhError("conflict", "commit chain is discontinuous");
    if (head.serverTime !== null && at < head.serverTime)
      throw new MhError("clock_skew", `commit time cannot be verified: timestamp regressed at sequence ${r.sequence} (${at} < ${head.serverTime})`);
    // Only verified immutable records are cached, scoped to this log instance.
    verified.set(r.sequence, entry);
    // Storage time may cross a deadline between proposal and PUT. A validly
    // encoded but rejected transition consumes its slot as a deterministic no-op;
    // it must not poison the chain and strand every later participant.
    let state = cloneProtocolState(head.state);
    let rejected: MhError | null = null;
    try { state = options.reduce(state, r.payload, at); }
    catch (error) {
      if (!(error instanceof MhError)) throw error;
      rejected = error;
      state = cloneProtocolState(head.state);
    }
    if (!rejected) options.checkAccepted?.(state, r.payload);
    const next: CommitHead<S> = {
      sequence: r.sequence, hash: entry.hash, state, serverTime: at,
    };
    return { record: r, head: next, rejected };
  };
  return {
    initial,
    async read(from = initial(), visit?: (record: CommitRecord<T>, head: CommitHead<S>, rejected: MhError | null) => Promise<void>, through = Infinity): Promise<CommitHead<S>> {
      let head = from;
      while (head.sequence < through) {
        const next = await readNext(head);
        if (!next) {
          if (through === Infinity) options.checkHead?.(head.state);
          return head;
        }
        if (visit) await visit(next.record, next.head, next.rejected);
        head = next.head;
      }
      return head;
    },
    async append(requestId: string, propose: (state: S) => T): Promise<CommitHead<S>> {
      if (!await client.conditionalCreateCapability?.())
        throw new MhError("invalid_input", "atomic conditional creation is unavailable");
      if (!requestId) throw new MhError("invalid_input", "requestId is required");
      // Replay also detects an earlier successful request after a lost response.
      let head = initial();
      for (let attempts = 0; attempts < 10000;) {
        const next = await readNext(head);
        if (next) {
          head = next.head;
          if (next.record.requestId === requestId) { if (next.rejected) throw next.rejected; return head; }
          continue;
        }
        options.checkHead?.(head.state);
        attempts++;
        const payload = options.parsePayload(propose(cloneProtocolState(head.state)));
        options.validateProposal?.(payload);
        // Reject invalid transitions before occupying an immutable slot. Use
        // the last committed time conservatively; callers can append a clock
        // observation before proposing a transition that depends on elapsed time.
        options.reduce(cloneProtocolState(head.state), payload, head.serverTime ?? 0);
        const r: CommitRecord<T> = { protocolVersion: 2, workspaceId: options.workspaceId,
          sequence: head.sequence + 1, previous: head.hash, requestId, payload };
        const bytes = await codec.encode(r);
        if (bytes.length > limit) throw new MhError("invalid_input", "commit metadata exceeds limit");
        try { await client.put(key(r.sequence), bytes, { ifNoneMatch: true }); }
        catch (error) {
          if (!(error instanceof MhError) || error.code !== "conflict") throw error;
        }
        const visible = await readNext(head);
        if (!visible) throw new MhError("busy", "commit is not yet visible; retry the same requestId");
        head = visible.head;
        if (visible.record.requestId === requestId) { if (visible.rejected) throw visible.rejected; return head; }
      }
      throw new MhError("busy", "commit contention; retry the same requestId");
    },
  };
}
