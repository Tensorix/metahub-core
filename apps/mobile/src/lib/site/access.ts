/** Every request, including the one-shot WebView bootstrap, is bound to one
 * listener and one live workspace session. Cookies alone cannot authorize writes. */
export function createSiteGate(bootstrap: string, cookie: string) {
  let issued = false;
  return (
    active: boolean,
    host: string,
    headers: Map<string, string>,
    method: string,
    target: string,
  ) => {
    if (!active || !host || headers.get("host") !== host) return "deny";
    if (!issued && method === "GET" && target === bootstrap) {
      issued = true;
      return "bootstrap";
    }
    if (!issued || !headers.get("cookie")?.split(/;\s*/).includes(cookie))
      return "deny";
    if (
      method !== "GET" &&
      method !== "HEAD" &&
      headers.get("origin") !== "http://" + host
    )
      return "deny";
    return "serve";
  };
}
