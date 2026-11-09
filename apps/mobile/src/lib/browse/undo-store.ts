type Entry = {
  id: number;
  message: string;
  undo?: () => Promise<string | void>;
};
type State = { entries: Entry[]; busy: boolean; error: string | null };

/** One FIFO per workspace session; a new action never steals an older undo. */
export function createUndoStore() {
  let sequence = 0;
  let state: State = { entries: [], busy: false, error: null };
  const listeners = new Set<() => void>();
  const publish = (next: State) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    push(message: string, undo?: Entry["undo"]) {
      publish({
        ...state,
        entries: [...state.entries, { id: ++sequence, message, undo }],
      });
    },
    dismiss(id: number) {
      if (state.busy || state.entries[0]?.id !== id) return;
      publish({ entries: state.entries.slice(1), busy: false, error: null });
    },
    async undo(id: number) {
      const entry = state.entries[0];
      if (state.busy || entry?.id !== id || !entry.undo) return;
      publish({ ...state, busy: true, error: null });
      try {
        await entry.undo();
        publish({
          entries: state.entries.slice(1),
          busy: false,
          error: null,
        });
      } catch (error) {
        publish({
          ...state,
          busy: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
const stores = new WeakMap<object, ReturnType<typeof createUndoStore>>();
export function undoStoreFor(owner: object) {
  let store = stores.get(owner);
  if (!store) {
    store = createUndoStore();
    stores.set(owner, store);
  }
  return store;
}
