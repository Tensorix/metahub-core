/** Release diagnostics require both compile-time public flags; ordinary builds stay in the app. */
export function diagnosticsEnabled(development: boolean, selftest?: string, releaseOptIn?: string) {
  return selftest === "1" && (development || releaseOptIn === "1");
}
