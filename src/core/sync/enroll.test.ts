import { test, expect } from "bun:test";
import { encodeEnroll, decodeEnroll, type EnrollPayload } from "./enroll.ts";
import { MhError } from "../errors.ts";

const sample: EnrollPayload = {
  endpoint: "https://my-bucket.cos.ap-shanghai.myqcloud.com",
  region: "ap-shanghai",
  bucket: "my-bucket",
  prefix: "metahub",
  accessKeyId: "AKID-测试-1234",
  secretAccessKey: "s3cr3t/key+value",
  encrypt: true,
  virtualHostedStyle: true,
};

test("round-trips a payload (incl. unicode)", () => {
  const token = encodeEnroll(sample);
  expect(decodeEnroll(token)).toEqual(sample);
});

test("decodes a bare token, an enroll= fragment, and a full deep link", () => {
  const token = encodeEnroll(sample);
  expect(decodeEnroll(token)).toEqual(sample);
  expect(decodeEnroll(`enroll=${token}`)).toEqual(sample);
  expect(decodeEnroll(`https://shell.example.com/#enroll=${token}`)).toEqual(sample);
  expect(decodeEnroll(`  https://shell.example.com/#enroll=${token}&foo=1 `)).toEqual(sample);
});

test("is byte-compatible with the legacy escape/unescape base64url scheme", () => {
  // The exact scheme the WebUI used before this module existed.
  const slim = {
    endpoint: sample.endpoint,
    region: sample.region,
    bucket: sample.bucket,
    prefix: sample.prefix,
    accessKeyId: sample.accessKeyId,
    secretAccessKey: sample.secretAccessKey,
    encrypt: sample.encrypt,
    virtualHostedStyle: sample.virtualHostedStyle,
  };
  const legacy = btoa(unescape(encodeURIComponent(JSON.stringify(slim))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  expect(encodeEnroll(sample)).toBe(legacy); // new encoder produces the same bytes
  expect(decodeEnroll(legacy)).toEqual(sample); // and old tokens still decode
});

test("omits undefined optional fields and fills them back as undefined", () => {
  const minimal: EnrollPayload = {
    endpoint: "https://s3.example.com",
    bucket: "b",
    accessKeyId: "id",
    secretAccessKey: "key",
  };
  expect(decodeEnroll(encodeEnroll(minimal))).toEqual(minimal);
});

test("throws invalid_input on garbage / missing fields / empty", () => {
  expect(() => decodeEnroll("")).toThrow(MhError);
  expect(() => decodeEnroll("!!!not-base64!!!")).toThrow(/invalid enroll code/);
  const partial = btoa(JSON.stringify({ endpoint: "x", bucket: "b" }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  expect(() => decodeEnroll(partial)).toThrow(/missing 'accessKeyId'/);
});
