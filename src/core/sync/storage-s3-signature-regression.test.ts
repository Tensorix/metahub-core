import { expect, test } from "bun:test";
import { createFetchStorageClient } from "./storage-s3-fetch.ts";
import { awsSigner } from "./storage-s3-sign.ts";
import type { S3Config } from "./storage.ts";

const config: S3Config = {
  endpoint: "https://bucket.example", bucket: "bucket", region: "auto", prefix: "mh",
  accessKeyId: "access", secretAccessKey: "secret", encrypt: true,
};

test("metadata cache bypass is signed before React Native can mutate the URL", async () => {
  const OriginalRequest = globalThis.Request;
  // whatwg-fetch, used by React Native, implements cache modes by modifying
  // the URL in its Request constructor, after aws4fetch calculates a signature.
  class NativeRequest extends OriginalRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      if (init?.cache === "no-store" || init?.cache === "no-cache") {
        const url = new URL(input instanceof OriginalRequest ? input.url : String(input));
        url.searchParams.set("_", "native-cache-buster");
        input = url;
      }
      super(input, init);
    }
  }
  globalThis.Request = NativeRequest as typeof Request;
  try {
    const urls: string[] = [];
    const client = createFetchStorageClient(config, { fetch: (async (input: RequestInfo | URL) => {
      const request = input as Request;
      const expected = await awsSigner(config).sign(request.url, {
        headers: { "x-amz-content-sha256": request.headers.get("x-amz-content-sha256")! },
        aws: { datetime: request.headers.get("x-amz-date")! },
      });
      expect(request.headers.get("authorization")).toBe(expected.headers.get("authorization"));
      expect(new URL(request.url).searchParams.has("_")).toBe(false);
      expect(new URL(request.url).searchParams.has("__mh_refresh")).toBe(true);
      urls.push(request.url);
      return new Response("x");
    }) as typeof fetch });
    await client.getWithMetadata!("object", { maxBytes: 1 });
    await client.getWithMetadata!("object", { maxBytes: 1 });
    expect(new Set(urls).size).toBe(2);
  } finally {
    globalThis.Request = OriginalRequest;
  }
});

test.each([
  ["SignatureDoesNotMatch", "network", "签名校验失败"],
  ["AccessDenied", "invalid_input", "权限不足"],
  ["InvalidAccessKeyId", "auth", "凭据无效"],
  ["ExpiredToken", "auth", "凭据无效"],
  ["RequestTimeTooSkewed", "clock_skew", "设备时钟"],
  ["UnknownProviderError", "network", "S3 get failed: 403"],
])("S3 error %s reports the cause without exposing response data", async (providerCode, code, message) => {
  const client = createFetchStorageClient(config, { fetch: (async () => new Response(
    `<Error><Code>${providerCode}</Code><Message>secret-credential</Message><CanonicalRequest>secret-signature</CanonicalRequest></Error>`,
    { status: 403 },
  )) as typeof fetch });
  try {
    await client.get("object");
    throw new Error("Expected the request to fail");
  } catch (error) {
    expect(error).toMatchObject({ code, message: expect.stringContaining(message) });
    expect(String(error)).not.toContain("secret-");
  }
});
