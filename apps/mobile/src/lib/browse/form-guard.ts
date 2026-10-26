export interface FormExitState {
  pending: boolean;
  dirty: boolean;
  revision: number;
}
export type ExitDecision =
  | { kind: "blocked" }
  | { kind: "confirm"; confirm: () => ExitDecision }
  | { kind: "ready" }
  | { kind: "idle" };
/** Every exit is checked now, after confirmation, and immediately before navigation. */
export function createFormExitGuard(read: () => FormExitState) {
  let queued: { action: () => void; confirmedRevision: number | null } | null =
    null;
  const evaluate = (
    action: () => void,
    confirmedRevision: number | null,
  ): ExitDecision => {
    const state = read();
    if (state.pending) {
      queued = null;
      return { kind: "blocked" };
    }
    if (state.dirty && confirmedRevision !== state.revision) {
      queued = null;
      const revision = state.revision;
      return { kind: "confirm", confirm: () => evaluate(action, revision) };
    }
    queued = { action, confirmedRevision };
    return { kind: "ready" };
  };
  return {
    request: (action: () => void) => evaluate(action, null),
    commit(): ExitDecision {
      const next = queued;
      queued = null;
      if (!next) return { kind: "idle" };
      const decision = evaluate(next.action, next.confirmedRevision);
      if (decision.kind === "ready") {
        queued = null;
        next.action();
      }
      return decision;
    },
  };
}
/** Tokens stop a late receipt or duplicate finally from releasing a newer write. */
export function createMutationGate() {
  let current: symbol | null = null;
  return {
    isPending: () => current !== null,
    begin() {
      if (current) return null;
      const token = Symbol("mutation");
      current = token;
      return () => {
        if (current === token) current = null;
      };
    },
  };
}
