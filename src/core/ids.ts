const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Collision-resistant lowercase token (base36). */
export function randomSuffix(len = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (const b of bytes) out += ALPHABET.charAt(b % ALPHABET.length);
  return out;
}

/** ASCII-only, url-safe slug from an arbitrary name. Empty -> fallback. */
export function slugify(name: string, fallback = "item"): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return slug || fallback;
}

/** id = slug(name) + "-" + random. Readable yet safe for offline multi-node creation. */
export function makeId(name: string, fallback = "item"): string {
  return `${slugify(name, fallback)}-${randomSuffix()}`;
}

/** Entity kinds whose ids carry a type prefix. */
export type Kind = "db" | "prop" | "rec" | "doc" | "blk";

const KINDS: ReadonlySet<string> = new Set<Kind>(["db", "prop", "rec", "doc", "blk"]);

/**
 * Typed id = "<kind>_<slug>-<rand>". `slugify` emits only [a-z0-9-] and
 * `randomSuffix` only base36, so the FIRST "_" is unambiguously the type
 * separator — `idKind` recovers the kind, and legacy ids (no "_") read as null.
 */
export function newId(kind: Kind, name: string, fallback: string = kind): string {
  return `${kind}_${slugify(name, fallback)}-${randomSuffix()}`;
}

/** The kind encoded in a typed id, or null for legacy (prefix-less) ids. */
export function idKind(id: string): Kind | null {
  const i = id.indexOf("_");
  if (i <= 0) return null;
  const prefix = id.slice(0, i);
  return KINDS.has(prefix) ? (prefix as Kind) : null;
}
