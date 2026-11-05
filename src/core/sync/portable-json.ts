/** Hermes does not guarantee TextDecoder or structuredClone. Protocol state is
 * JSON-only; keep this fallback local rather than replacing platform globals. */
export function cloneProtocolState<T>(value: T): T {
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}
export function decodeUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const pieces: string[] = [], units: number[] = [];
  const flush = () => { pieces.push(String.fromCharCode(...units)); units.length = 0; };
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i++]!;
    let point = first, remaining = 0, minimum = 0;
    if (first >= 0xc2 && first <= 0xdf) { point = first & 31; remaining = 1; minimum = 0x80; }
    else if (first >= 0xe0 && first <= 0xef) { point = first & 15; remaining = 2; minimum = 0x800; }
    else if (first >= 0xf0 && first <= 0xf4) { point = first & 7; remaining = 3; minimum = 0x10000; }
    else if (first >= 0x80) throw new Error("Invalid UTF-8 leading byte");
    while (remaining--) {
      const next = bytes[i++];
      if (next === undefined || (next & 0xc0) !== 0x80) throw new Error("Invalid UTF-8 continuation");
      point = (point << 6) | (next & 63);
    }
    if (point < minimum || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw new Error("Invalid UTF-8 code point");
    if (point > 0xffff) { point -= 0x10000; units.push(0xd800 | (point >> 10), 0xdc00 | (point & 1023)); }
    else units.push(point);
    if (units.length >= 4096) flush();
  }
  if (units.length) flush();
  return pieces.join("").replace(/^\uFEFF/, "");
}
