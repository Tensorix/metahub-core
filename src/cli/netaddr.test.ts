import { test, expect } from "bun:test";
import {
  classifyV4,
  classifyV6,
  formatUrl,
  localAddresses,
  resolveEndpoints,
  isLoopback,
} from "./netaddr.ts";

// Minimal shape compatible with os.NetworkInterfaceInfo for the fields we read.
type Iface = { address: string; family: string | number; internal: boolean };
const ifaces = (m: Record<string, Iface[]>) => m as any;

test("classifyV4 splits loopback / lan / public", () => {
  expect(classifyV4("127.0.0.1")).toBe("loopback");
  expect(classifyV4("10.1.2.3")).toBe("lan");
  expect(classifyV4("192.168.1.42")).toBe("lan");
  expect(classifyV4("172.16.0.1")).toBe("lan");
  expect(classifyV4("172.31.255.1")).toBe("lan");
  expect(classifyV4("169.254.10.10")).toBe("lan");
  expect(classifyV4("172.32.0.1")).toBe("public"); // just outside 172.16/12
  expect(classifyV4("100.123.130.100")).toBe("lan"); // 100.64/10 CGNAT / Tailscale
  expect(classifyV4("100.63.0.1")).toBe("public"); // just below 100.64/10
  expect(classifyV4("100.128.0.1")).toBe("public"); // just above 100.64/10
  expect(classifyV4("198.18.0.1")).toBe("lan"); // 198.18/15 benchmarking range
  expect(classifyV4("198.19.0.1")).toBe("lan");
  expect(classifyV4("198.20.0.1")).toBe("public"); // just above 198.18/15
  expect(classifyV4("203.0.113.5")).toBe("public");
  expect(classifyV4("8.8.8.8")).toBe("public");
});

test("classifyV6 splits loopback / lan / public", () => {
  expect(classifyV6("::1")).toBe("loopback");
  expect(classifyV6("fe80::1")).toBe("lan"); // link-local
  expect(classifyV6("fd12:3456::1")).toBe("lan"); // ULA
  expect(classifyV6("2001:db8::1")).toBe("public");
});

test("formatUrl brackets IPv6 and strips zone id", () => {
  expect(formatUrl("203.0.113.5", "IPv4", 7777)).toBe("http://203.0.113.5:7777");
  expect(formatUrl("2001:db8::1", "IPv6", 7777)).toBe("http://[2001:db8::1]:7777");
  expect(formatUrl("fe80::1%en0", "IPv6", 7777)).toBe("http://[fe80::1]:7777");
});

test("localAddresses skips internal and tags family/scope", () => {
  const addrs = localAddresses(
    ifaces({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      en0: [
        { address: "192.168.1.42", family: "IPv4", internal: false },
        { address: "fe80::1", family: "IPv6", internal: false },
      ],
    }),
  );
  expect(addrs).toEqual([
    { ip: "192.168.1.42", family: "IPv4", scope: "lan" },
    { ip: "fe80::1", family: "IPv6", scope: "lan" },
  ]);
});

test("localAddresses normalises numeric family (Bun/Node variance)", () => {
  const addrs = localAddresses(
    ifaces({ en0: [{ address: "203.0.113.5", family: 4, internal: false }] }),
  );
  expect(addrs[0]).toEqual({ ip: "203.0.113.5", family: "IPv4", scope: "public" });
});

test("loopback host → only localhost, ignores interfaces", () => {
  expect(isLoopback("127.0.0.1")).toBe(true);
  const eps = resolveEndpoints(
    "127.0.0.1",
    7777,
    ifaces({ en0: [{ address: "192.168.1.42", family: "IPv4", internal: false }] }),
  );
  expect(eps).toEqual([{ scope: "loopback", family: "IPv4", url: "http://localhost:7777" }]);
});

test("wildcard host → localhost + one rep per (scope, family), ordered", () => {
  const eps = resolveEndpoints(
    "0.0.0.0",
    7777,
    ifaces({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      en0: [
        { address: "192.168.1.42", family: "IPv4", internal: false },
        { address: "192.168.1.43", family: "IPv4", internal: false }, // dup scope/family → dropped
        { address: "fd00::1", family: "IPv6", internal: false },
      ],
      eth0: [{ address: "203.0.113.5", family: "IPv4", internal: false }],
    }),
  );
  expect(eps).toEqual([
    { scope: "loopback", family: "IPv4", url: "http://localhost:7777" },
    { scope: "lan", family: "IPv4", url: "http://192.168.1.42:7777" },
    { scope: "lan", family: "IPv6", url: "http://[fd00::1]:7777" },
    { scope: "public", family: "IPv4", url: "http://203.0.113.5:7777" },
  ]);
});

test("NAT machine (only LAN) shows no public endpoint", () => {
  const eps = resolveEndpoints(
    "0.0.0.0",
    7777,
    ifaces({ en0: [{ address: "192.168.1.42", family: "IPv4", internal: false }] }),
  );
  expect(eps.map((e) => e.scope)).toEqual(["loopback", "lan"]);
});

test("link-local IPv6 (fe80) is skipped — unusable without a zone id", () => {
  const eps = resolveEndpoints(
    "0.0.0.0",
    7777,
    ifaces({
      en0: [
        { address: "fe80::1c0a:c9be:64da:7011", family: "IPv6", internal: false },
        { address: "2409:8a21::1", family: "IPv6", internal: false },
      ],
    }),
  );
  expect(eps.map((e) => e.url)).toEqual([
    "http://localhost:7777",
    "http://[2409:8a21::1]:7777", // only the global IPv6 survives
  ]);
});

test("explicit non-loopback bind still enumerates", () => {
  const eps = resolveEndpoints(
    "192.168.1.42",
    7777,
    ifaces({ en0: [{ address: "192.168.1.42", family: "IPv4", internal: false }] }),
  );
  expect(eps.map((e) => e.scope)).toEqual(["loopback", "lan"]);
});
