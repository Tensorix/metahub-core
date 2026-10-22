/** Public desktop links only select a local document; never accept a server URL,
 * file path, command, or arbitrary renderer route from an external application. */
export const DOCUMENT_PROTOCOL = "mh";

export function documentIdFromLink(value: unknown): string | null {
  if (typeof value !== "string" || value.slice(0, 5).toLowerCase() !== "mh://") return null;
  // Match the original spelling rather than a URL parser's normalized path:
  // dot segments, escapes, credentials, extra parameters and fragments are invalid.
  const route = value.slice(5);
  const match = /^(?:doc\/(doc_[a-z0-9][a-z0-9-]*)\/?|document\/open\?id=(doc_[a-z0-9][a-z0-9-]*))$/.exec(route);
  if (match?.[0] !== route) return null;
  return match?.[1] ?? match?.[2] ?? null;
}

interface UrlEventSource {
  on(event: "open-url", listener: (event: { preventDefault(): void }, url: string) => void): unknown;
}

/** Install synchronously, before app.whenReady(): macOS delivers cold-start URLs
 * early. The caller's existing main-window gate waits for sidecar readiness. */
export function installDocumentLinks(app: UrlEventSource, openDocument: (id: string) => void) {
  app.on("open-url", (event, url) => {
    event.preventDefault();
    const id = documentIdFromLink(url);
    if (id) openDocument(id);
  });
  return {
    // Windows/Linux deliver URLs in launch argv and second-instance argv. Do
    // not assume the URL is last (Chromium/desktop launchers may append flags).
    handleArguments(argv: readonly string[]): boolean {
      const id = argv.map(documentIdFromLink).findLast((id) => id !== null);
      if (!id) return false;
      openDocument(id);
      return true;
    },
  };
}
