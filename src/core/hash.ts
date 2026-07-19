/** Portable FNV-1a helpers used for non-cryptographic content fingerprints. */

const FNV32_OFFSET = 0x811c9dc5;
const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const U64_MASK = 0xffffffffffffffffn;

export function fnv1a32(text: string): number {
  let h = FNV32_OFFSET;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    // Multiplication by the FNV-1a 32-bit prime, kept in uint32 space.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

export function fnv1a64Hex(text: string): string {
  let h = FNV64_OFFSET;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * FNV64_PRIME) & U64_MASK;
  }
  return h.toString(16).padStart(16, "0");
}
