import { expect, test } from "bun:test";
import { SessionOwner } from "./session-owner";

test("the last still-focused route wins while the previous document drains", async () => {
  const owners = new SessionOwner();
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const closing = new Promise<void>(resolve => { finish = resolve; });
  const a = { yield: async () => { entered(); await closing; owners.release(a); } };
  const b = { yield: async () => { throw new Error("B should never own this renderer"); } };
  const c = { yield: async () => {} };
  expect(await owners.acquire(a)).toBe(true);
  const first = owners.acquire(b);
  await started;
  const last = owners.acquire(c);
  finish();
  expect(await first).toBe(false);
  expect(await last).toBe(true);
});

test("a failed save keeps the original owner and a later retry can succeed", async () => {
  const owners = new SessionOwner();
  let full = true;
  const a = { yield: async () => { if (full) throw new Error("disk full"); } };
  const b = { yield: async () => {} };
  await owners.acquire(a);
  await expect(owners.acquire(b)).rejects.toThrow("disk full");
  expect(await owners.acquire(a)).toBe(true);
  full = false;
  expect(await owners.acquire(b)).toBe(true);
});
