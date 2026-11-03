import { expect, test } from "bun:test";
import { storageClientFor } from "./storage.ts";
import "./storage-s3-bun.ts";

test("conditional S3 writes preserve typed-array slices and request headers", async () => {
  const requests: { bytes: number[]; match: string | null; contentType: string | null }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      requests.push({
        bytes: Array.from(new Uint8Array(await req.arrayBuffer())),
        match: req.headers.get("if-match"),
        contentType: req.headers.get("content-type"),
      });
      return new Response(null, { status: 200 });
    },
  });
  try {
    const client = storageClientFor({
      endpoint: server.url.origin, region: "us-east-1", bucket: "test", prefix: "",
      accessKeyId: "test", secretAccessKey: "test", encrypt: false,
    });
    for (const buffer of [new ArrayBuffer(5), new SharedArrayBuffer(5)]) {
      new Uint8Array(buffer).set([99, 1, 2, 3, 99]);
      await client.put("object", new Uint8Array(buffer, 1, 3), {
        ifMatch: '"etag"', contentType: "application/octet-stream",
      });
    }
    expect(requests).toEqual(Array.from({ length: 2 }, () => ({
      bytes: [1, 2, 3], match: '"etag"', contentType: "application/octet-stream",
    })));
  } finally {
    await server.stop(true);
  }
});
