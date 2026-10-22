/** Preload starts listening before the WebUI mounts. Keep the latest requested
 * document until its navigation subscriber exists; don't replay it on remount. */
export function createDocumentLinkInbox() {
  let pending: string | null = null;
  const listeners = new Set<(id: string) => void>();
  return {
    receive(id: string): void {
      if (listeners.size === 0) pending = id;
      else for (const listener of listeners) listener(id);
    },
    subscribe(listener: (id: string) => void): () => void {
      listeners.add(listener);
      if (pending !== null) {
        const id = pending;
        pending = null;
        listener(id);
      }
      return () => { listeners.delete(listener); };
    },
  };
}
