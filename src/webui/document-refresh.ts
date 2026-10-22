/** Coalesce notifications while a read is in flight, but always drain the
 * trailing notification—even if the read itself was too stale to apply. */
export function createDocumentRefresh(read: () => Promise<void>, failed: (error: unknown) => void) {
  let running = false;
  let pending = false;
  let disposed = false;
  return {
    async request() {
      pending = true;
      if (running || disposed) return;
      running = true;
      try {
        while (pending && !disposed) {
          pending = false;
          try { await read(); } catch (error) { if (!disposed) failed(error); }
        }
      } finally { running = false; }
    },
    dispose() { disposed = true; pending = false; },
  };
}
