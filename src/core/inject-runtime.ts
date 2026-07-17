// The one place that knows how the page runtime is injected into served HTML.
// Portable (no node / DOM deps) so all three injectors share it byte-for-byte:
// the server's withShim (sync/auth.ts), the service worker's offline site
// serving (webui/sw.ts), and the cold-start offline bootstrap (webui/runtime.ts).
//
// /mh-runtime.js carries the token fetch-shim + service-worker registration +
// the local-replica RPC bridge; it is loaded as a synchronous classic script,
// head-first, so fetch is wrapped before any page code runs.

/** The injected tag. The closing tag is split so this constant can never
 *  terminate an enclosing <script> when this module's source is itself inlined
 *  into an HTML document (bundlers/templates that embed JS in <script> blocks
 *  would otherwise cut the string in half at `</script>`). */
export const RUNTIME_TAG = '<script src="/mh-runtime.js"></scr' + "ipt>";

/** Insert the runtime into an HTML document (right after <head>, else prepend). */
export function injectRuntimeTag(html: string): string {
  const i = html.toLowerCase().indexOf("<head>");
  if (i >= 0) return html.slice(0, i + 6) + RUNTIME_TAG + html.slice(i + 6);
  return RUNTIME_TAG + html;
}
