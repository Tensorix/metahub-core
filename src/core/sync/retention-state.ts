import { cloneProtocolState } from "./portable-json.ts";
import { MhError } from "../errors.ts";

export const DAY_MS = 86_400_000;
export const RETENTION_POLICY = Object.freeze({ syncDays: 30, historyDays: 90, protectionDays: 7, prepareMs: 60_000, gcIntervalMs: 7 * DAY_MS });
export interface RetentionMember { sequence: number; expiresAt: number; renewedAt: number; sealed: boolean }
export interface RetentionState {
  epoch: number;
  members: Record<string, RetentionMember>;
  preparing: null | { id: string; startedAt: number; members: string[] };
  lastGcAt: number | null;
  checkpoint: string | null;
  protectedUntil: number | null;
}
export type RetentionEvent =
  | { type: "clock" }
  | { type: "join"; epoch: number; member: string; checkpoint: string | null; replaces?: { member: string; sequence: number } }
  | { type: "batch"; epoch: number; member: string; first: number; last: number; objectHash: string }
  | { type: "renew"; epoch: number; member: string; sequence: number; checkpoint: string | null }
  | { type: "prepare"; epoch: number; id: string }
  | { type: "seal"; epoch: number; id: string; member: string; sequence: number }
  | { type: "cancel"; epoch: number; id: string }
  | { type: "commit"; epoch: number; id: string; checkpoint: string };
export function initialRetentionState(): RetentionState {
  return { epoch: 0, members: {}, preparing: null, lastGcAt: null, checkpoint: null, protectedUntil: null };
}
const fail = (message: string): never => { throw new MhError("conflict", message); };
const hash = (value: string) => /^[a-f0-9]{64}$/.test(value);
/** Deterministic control reducer. Object existence/content/coverage proofs must
 * be validated by the storage layer before it accepts a batch/checkpoint event.
 * Returns a new state: failed proposals never partially modify caller state. */
export function reduceRetention(state: RetentionState, event: RetentionEvent, at: number): RetentionState {
  if (!Number.isSafeInteger(at) || at < 0) throw new MhError("clock_skew", "invalid storage time");
  const next = cloneProtocolState(state);
  if (event.type === "clock") return next;
  if (event.epoch !== next.epoch) fail("sync epoch is obsolete; rebootstrap required");
  const active = (id: string) => {
    const m = Object.hasOwn(next.members, id) ? next.members[id] : undefined;
    if (!m || m.expiresAt <= at) return fail("member qualification expired");
    return m;
  };
  const prepare = (id: string) => {
    if (!next.preparing || next.preparing.id !== id) return fail("prepare is not active");
    return next.preparing;
  };
  switch (event.type) {
    case "join":
      if (next.preparing) fail("membership frozen during prepare");
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(event.member) || ["__proto__", "constructor", "prototype"].includes(event.member)) fail("invalid member id");
      if (Object.hasOwn(next.members, event.member)) fail("incarnation already registered");
      if (event.checkpoint !== next.checkpoint) fail("checkpoint mismatch");
      if (event.replaces) {
        const previous = next.members[event.replaces.member];
        if (!previous || previous.sequence !== event.replaces.sequence || event.replaces.member === event.member)
          fail("replacement does not cover the previous source prefix");
        delete next.members[event.replaces.member];
      }
      next.members[event.member] = { sequence: 0, expiresAt: at + 30 * DAY_MS, renewedAt: at, sealed: false };
      break;
    case "batch": {
      const m = active(event.member);
      if (m.sealed) fail("member is sealed");
      if (!Number.isSafeInteger(event.first) || !Number.isSafeInteger(event.last) || event.first !== m.sequence + 1 || event.last < event.first || !hash(event.objectHash)) fail("noncontiguous source batch");
      m.sequence = event.last;
      break;
    }
    case "renew": {
      if (next.preparing) fail("membership frozen during prepare");
      const m = active(event.member);
      if (event.sequence !== m.sequence || event.checkpoint !== next.checkpoint) fail("incomplete synchronization receipt");
      if (at - m.renewedAt < DAY_MS) fail("qualification can renew only once per day");
      m.renewedAt = at; m.expiresAt = at + 30 * DAY_MS;
      break;
    }
    case "prepare":
      if (next.preparing) fail("another prepare is active");
      if (!event.id || (next.lastGcAt !== null && at - next.lastGcAt < RETENTION_POLICY.gcIntervalMs)) fail("collection is not due");
      next.preparing = { id: event.id, startedAt: at, members: Object.keys(next.members).filter(id => next.members[id]!.expiresAt > at).sort() };
      break;
    case "seal": {
      const p = prepare(event.id), m = next.members[event.member];
      if (!m) return fail("seal member is missing");
      if (!p.members.includes(event.member) || m.sequence !== event.sequence) fail("seal does not cover source prefix");
      if (at - p.startedAt >= RETENTION_POLICY.prepareMs) fail("prepare timed out");
      m.sealed = true;
      break;
    }
    case "cancel":
      prepare(event.id);
      next.preparing = null;
      for (const m of Object.values(next.members)) m.sealed = false;
      break;
    case "commit": {
      const p = prepare(event.id);
      if (at - p.startedAt >= RETENTION_POLICY.prepareMs) fail("prepare timed out");
      if (!p.members.every(id => next.members[id]!.sealed)) fail("unsealed member blocks collection");
      if (!hash(event.checkpoint)) fail("invalid checkpoint hash");
      const retained: Record<string, RetentionMember> = {};
      for (const id of p.members) retained[id] = { ...next.members[id]!, sealed: false };
      next.members = retained;
      next.epoch++;
      next.checkpoint = event.checkpoint;
      next.lastGcAt = at;
      next.protectedUntil = at + RETENTION_POLICY.protectionDays * DAY_MS;
      next.preparing = null;
      break;
    }
    default: fail("unknown retention event");
  }
  return next;
}
