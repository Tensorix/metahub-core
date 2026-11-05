// Integration profiles may use IPv6 on hosts whose VPN routes IPv4 loopback away.
export const desktopHost =
  process.env.MH_TEST_USER_DATA && process.env.MH_TEST_IPV6 === "1"
    ? "::1"
    : "127.0.0.1";
export const desktopOrigin = (port: number) =>
  `http://${desktopHost === "::1" ? "[::1]" : desktopHost}:${port}`;
