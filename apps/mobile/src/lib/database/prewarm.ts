import { warmEditorSurface } from "../editor/warmup";
import { warmDatabaseSurface } from "./warmup";
let preferred: "document" | "database" = "document";
export function preferSurface(kind: typeof preferred) {
  preferred = kind;
}
/** Only the most recently used surface is warmed. The document module does not
 * expose a shell-ready promise, so chaining its warm() would race WebKit startup. */
export function scheduleSurfaceWarmup() {
  const kind = preferred;
  const task = requestIdleCallback(() => {
    if (kind === "document") warmEditorSurface();
    else void warmDatabaseSurface().catch(() => {});
  });
  return () => cancelIdleCallback(task);
}
