// Resolve the set of base URLs the server is reachable on. Pure presentation —
// lives in the CLI layer, never in core. We only ever report addresses that are
// genuinely bound to a network interface (no external echo probe), so every URL
// shown is something the machine actually answers on: a cloud box surfaces its
// public NIC IP, a NAT'd machine shows only localhost + LAN.

import os from "node:os";

export type Scope = "loopback" | "lan" | "public";
export type Family = "IPv4" | "IPv6";

export interface Addr {
  ip: string;
  family: Family;
  scope: Scope;
}

export interface Endpoint {
  scope: Scope;
  family: Family;
  url: string;
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/** RFC1918 / shared / link-local vs genuinely public for an IPv4 literal. */
export function classifyV4(ip: string): Scope {
  if (ip.startsWith("127.")) return "loopback";
  if (ip.startsWith("10.")) return "lan";
  if (ip.startsWith("192.168.")) return "lan";
  if (ip.startsWith("169.254.")) return "lan"; // link-local
  const a = /^172\.(\d+)\./.exec(ip);
  if (a && Number(a[1]) >= 16 && Number(a[1]) <= 31) return "lan"; // 172.16/12
  const b = /^100\.(\d+)\./.exec(ip);
  if (b && Number(b[1]) >= 64 && Number(b[1]) <= 127) return "lan"; // 100.64/10 CGNAT (RFC6598, Tailscale)
  if (ip.startsWith("198.18.") || ip.startsWith("198.19.")) return "lan"; // 198.18/15 benchmarking (RFC2544; Tailscale utun)
  return "public";
}

/** Loopback / ULA / link-local vs global for an IPv6 literal. */
export function classifyV6(ip: string): Scope {
  const v = ip.toLowerCase();
  if (v === "::1") return "loopback";
  if (v.startsWith("fe80")) return "lan"; // link-local fe80::/10
  if (v.startsWith("fc") || v.startsWith("fd")) return "lan"; // ULA fc00::/7
  return "public"; // global unicast 2000::/3 (and anything else routable)
}

/** Normalise Node/Bun's `family` field, which may be "IPv4"/"IPv6" or 4/6. */
function normFamily(family: string | number): Family {
  return family === "IPv6" || family === 6 ? "IPv6" : "IPv4";
}

/** Build a browser-ready base URL; IPv6 literals get bracketed, %scope stripped. */
export function formatUrl(ip: string, family: Family, port: number): string {
  if (family === "IPv6") {
    const bare = ip.replace(/%.*$/, ""); // drop zone id, e.g. fe80::1%en0
    return `http://[${bare}]:${port}`;
  }
  return `http://${ip}:${port}`;
}

/** Enumerate non-internal interface addresses, tagged with family + scope. */
export function localAddresses(ifaces: os.NetworkInterfaceInfo[] | Record<string, os.NetworkInterfaceInfo[] | undefined> = os.networkInterfaces()): Addr[] {
  const groups = Array.isArray(ifaces) ? { _: ifaces } : ifaces;
  const out: Addr[] = [];
  for (const list of Object.values(groups)) {
    for (const info of list ?? []) {
      if (info.internal) continue;
      const family = normFamily(info.family);
      const scope = family === "IPv6" ? classifyV6(info.address) : classifyV4(info.address);
      out.push({ ip: info.address, family, scope });
    }
  }
  return out;
}

const SCOPE_ORDER: Record<Scope, number> = { loopback: 0, lan: 1, public: 2 };

/**
 * Base URLs the server is reachable on. Loopback bind → just localhost.
 * Wildcard / explicit non-loopback bind → localhost plus one representative per
 * (scope, family) found on a real interface, ordered loopback → lan → public.
 */
export function resolveEndpoints(
  host: string,
  port: number,
  ifaces = os.networkInterfaces(),
): Endpoint[] {
  const localhost: Endpoint = {
    scope: "loopback",
    family: "IPv4",
    url: `http://localhost:${port}`,
  };
  if (isLoopback(host)) return [localhost];

  const seen = new Set<string>(); // dedupe by `${scope}:${family}`
  const reps: Endpoint[] = [];
  for (const a of localAddresses(ifaces)) {
    if (a.scope === "loopback") continue; // localhost already covers it
    // Link-local IPv6 needs a %zone id to be usable; a bare URL is unreachable
    // from another host, so it would only mislead — skip it.
    if (a.family === "IPv6" && a.ip.toLowerCase().startsWith("fe80")) continue;
    const key = `${a.scope}:${a.family}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reps.push({ scope: a.scope, family: a.family, url: formatUrl(a.ip, a.family, port) });
  }
  reps.sort((x, y) =>
    SCOPE_ORDER[x.scope] - SCOPE_ORDER[y.scope] || x.family.localeCompare(y.family),
  );
  return [localhost, ...reps];
}
