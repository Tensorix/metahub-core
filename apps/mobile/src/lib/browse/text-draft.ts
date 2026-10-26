export interface TextDraftSnapshot {
  text: string;
  source: string;
  dirty: boolean;
  busy: boolean;
  error: string;
  revision: number;
}
/** Receipts may acknowledge only their captured revision, never later native input. */
export function createTextDraft(initial: string) {
  let state: TextDraftSnapshot = {
    text: initial,
    source: initial,
    dirty: false,
    busy: false,
    error: "",
    revision: 0,
  };
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<TextDraftSnapshot>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reconcile(source: string) {
      if (source === state.source) return;
      const pristine = !state.dirty && !state.busy && !state.error;
      publish({
        source,
        ...(pristine ? { text: source } : {}),
        dirty: pristine ? false : state.text !== source || !!state.error,
      });
    },
    edit(text: string) {
      publish({
        text,
        revision: state.revision + 1,
        dirty: text !== state.source,
        error: "",
      });
    },
    async save(
      write: (text: string) => Promise<unknown>,
      clearAfterSave = false,
    ) {
      if (state.busy || !state.text.trim()) return false;
      const captured = {
        text: state.text.trim(),
        source: state.source,
        revision: state.revision,
      };
      publish({ busy: true, error: "" });
      try {
        await write(captured.text);
        const sameRevision = state.revision === captured.revision;
        const sourceMatches =
          state.source === captured.source || state.source === captured.text;
        const source = sourceMatches
          ? clearAfterSave
            ? ""
            : captured.text
          : state.source;
        const text =
          sameRevision && sourceMatches
            ? clearAfterSave
              ? ""
              : captured.text
            : state.text;
        publish({ source, text, dirty: text !== source, busy: false });
        return true;
      } catch (error) {
        publish({ busy: false, dirty: true, error: String(error) });
        return false;
      }
    },
  };
}
