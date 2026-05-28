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
