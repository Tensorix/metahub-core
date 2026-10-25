export type QrParse =
  | { kind: "server"; baseUrl: string; token: string }
  | { kind: "enroll"; code: string }
  | { kind: "unknown" };

/** Classify existing web/CLI enrollment codes and native app enrollment links. */
export function parseQrPayload(data: string): QrParse {
  const s = data.trim();
  if (/(?:[#&?]|^)enroll=[^&\s]+/.test(s))
    return { kind: "enroll", code: s };
  try {
    const u = new URL(s);
    const token = u.searchParams.get("token");
    if ((u.protocol === "http:" || u.protocol === "https:") && token)
      return { kind: "server", baseUrl: u.origin, token };
  } catch {
    /* not a URL */
  }
  return { kind: "unknown" };
}
