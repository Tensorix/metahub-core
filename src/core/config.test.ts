import { describe, expect, test } from "bun:test";
import { normalizePublicBaseUrl } from "./config.ts";

describe("normalizePublicBaseUrl", () => {
  test("normalizes HTTPS and strips trailing slash", () => {
    expect(normalizePublicBaseUrl(" https://site.example.com/ ")).toEqual({
      url: "https://site.example.com",
      scope: "public",
    });
  });

  test("allows local and private HTTP", () => {
    expect(normalizePublicBaseUrl("http://127.0.0.1:7777/").scope).toBe("local");
    expect(normalizePublicBaseUrl("http://192.168.1.5:7777").scope).toBe("lan");
    expect(normalizePublicBaseUrl("http://[::1]:7777").scope).toBe("local");
    expect(normalizePublicBaseUrl("http://[fd00::5]:7777").scope).toBe("lan");
  });

  test("requires HTTPS for public hosts", () => {
    expect(() => normalizePublicBaseUrl("http://site.example.com")).toThrow("必须使用 HTTPS");
  });

  test("rejects credentials, query and fragment", () => {
    expect(() => normalizePublicBaseUrl("https://u:p@example.com")).toThrow("不能包含");
    expect(() => normalizePublicBaseUrl("https://example.com/?a=1")).toThrow("不能包含");
    expect(() => normalizePublicBaseUrl("https://example.com/#x")).toThrow("不能包含");
    expect(() => normalizePublicBaseUrl("https://example.com/metahub")).toThrow("不能包含路径");
  });
});
