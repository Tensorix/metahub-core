import { test, expect } from "bun:test";
import { storageUrl } from "./storage-url.ts";

test("storageUrl folds the endpoint host into the key", () => {
  expect(storageUrl("https://s3.amazonaws.com", "backups", "metahub")).toBe(
    "s3://s3.amazonaws.com/backups/metahub",
  );
});

test("storageUrl strips the default port so :443 and no-port collapse to one key", () => {
  const a = storageUrl("https://h.example.com", "b", "p");
  const b = storageUrl("https://h.example.com:443", "b", "p");
  expect(a).toBe(b);
  expect(a).toBe("s3://h.example.com/b/p");
});

test("storageUrl keeps a non-default port (distinct endpoints stay distinct)", () => {
  expect(storageUrl("http://minio.local:9000", "b", "p")).toBe("s3://minio.local:9000/b/p");
  // ...and http default port 80 is stripped
  expect(storageUrl("http://minio.local:80", "b", "p")).toBe("s3://minio.local/b/p");
});

test("storageUrl defaults the prefix so callers passing none agree", () => {
  expect(storageUrl("https://h", "b")).toBe("s3://h/b/metahub");
  expect(storageUrl("https://h", "b", "")).toBe("s3://h/b/metahub");
});

test("same bucket name on two endpoints yields two distinct keys (the collision fix)", () => {
  const r2 = storageUrl("https://a.r2.cloudflarestorage.com", "shared", "data");
  const minio = storageUrl("https://b.minio.example.com", "shared", "data");
  expect(r2).not.toBe(minio);
});
