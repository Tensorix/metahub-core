import { test, expect } from "bun:test";
import { keyBetween, keysBetween } from "./fracdex.ts";

test("keyBetween produces a key strictly between its bounds", () => {
  const a = keyBetween(null, null);
  const before = keyBetween(null, a);
  const after = keyBetween(a, null);
  expect(before < a).toBe(true);
  expect(a < after).toBe(true);

  const mid = keyBetween(before, a);
  expect(before < mid).toBe(true);
  expect(mid < a).toBe(true);
});

test("repeated append stays ordered", () => {
  let prev: string | null = null;
  const keys: string[] = [];
  for (let i = 0; i < 200; i++) {
    const k = keyBetween(prev, null);
    keys.push(k);
    prev = k;
  }
  for (let i = 1; i < keys.length; i++) expect(keys[i - 1]! < keys[i]!).toBe(true);
});

test("repeated prepend stays ordered", () => {
  let next: string | null = null;
  const keys: string[] = [];
  for (let i = 0; i < 200; i++) {
    const k = keyBetween(null, next);
    keys.unshift(k);
    next = k;
  }
  for (let i = 1; i < keys.length; i++) expect(keys[i - 1]! < keys[i]!).toBe(true);
});

test("repeated midpoint insertion stays strictly ordered", () => {
  let lo = keyBetween(null, null);
  let hi = keyBetween(lo, null);
  for (let i = 0; i < 200; i++) {
    const mid = keyBetween(lo, hi);
    expect(lo < mid).toBe(true);
    expect(mid < hi).toBe(true);
    // alternate which side we keep squeezing
    if (i % 2 === 0) hi = mid;
    else lo = mid;
  }
});

test("keysBetween returns n ascending, distinct keys within bounds", () => {
  for (const [a, b] of [
    [null, null],
    [null, keyBetween(null, null)],
    [keyBetween(null, null), null],
  ] as [string | null, string | null][]) {
    const ks = keysBetween(a, b, 50);
    expect(ks.length).toBe(50);
    expect(new Set(ks).size).toBe(50);
    for (let i = 1; i < ks.length; i++) expect(ks[i - 1]! < ks[i]!).toBe(true);
    if (a !== null) expect(a < ks[0]!).toBe(true);
    if (b !== null) expect(ks[ks.length - 1]! < b).toBe(true);
  }
});

test("keysBetween between two adjacent keys interleaves correctly", () => {
  const a = keyBetween(null, null);
  const b = keyBetween(a, null);
  const ks = keysBetween(a, b, 10);
  const all = [a, ...ks, b];
  for (let i = 1; i < all.length; i++) expect(all[i - 1]! < all[i]!).toBe(true);
});

test("keysBetween edge counts", () => {
  expect(keysBetween(null, null, 0)).toEqual([]);
  expect(keysBetween(null, null, 1).length).toBe(1);
});
