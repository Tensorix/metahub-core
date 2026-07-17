// Small portable HTTP helpers shared across the token-exempt serving surfaces
// (sites / share / room / edge). Zero node:/bun: imports so the workerd edge
// bundle can use them too.

/** decodeURIComponent that returns null on a malformed %-escape instead of
 *  throwing URIError. An uncaught throw on these anonymous surfaces becomes an
 *  unhandled 500 — Bun.serve has no error handler, and workerd returns 1101 —
 *  plus a stack in the logs, all reachable by any client sending `%E0%A4`. */
export function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}
