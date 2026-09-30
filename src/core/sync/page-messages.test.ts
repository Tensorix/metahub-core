import { test, expect } from "bun:test";
import { localizeError, pm, pmIfKnown } from "./page-messages.ts";
import { MhError, mhError } from "../errors.ts";
import { errorResponse } from "./routes.ts";

test("pmIfKnown translates known text under en and passes unknown text through", () => {
  expect(pmIfKnown("en", "站点入口健康响应无效")).toBe("Site entry health response is invalid");
  expect(pmIfKnown("zh-CN", "站点入口健康响应无效")).toBe("站点入口健康响应无效");
  expect(pmIfKnown("en", "no such document: x")).toBe("no such document: x");
});

test("mhError keeps the interpolated message and the template for translation", () => {
  const e = mhError("network", "站点入口健康检查失败（HTTP {status}）", { status: 502 });
  expect(e).toBeInstanceOf(MhError);
  expect(e.code).toBe("network");
  expect(e.message).toBe("站点入口健康检查失败（HTTP 502）");
  expect(localizeError("en", e)).toBe("Site entry health check failed (HTTP 502)");
  expect(localizeError("zh-CN", e)).toBe("站点入口健康检查失败（HTTP 502）");
  expect(localizeError("en", new MhError("auth", "Cloudflare 授权超时，请重试"))).toBe("Cloudflare authorization timed out; try again");
  expect(localizeError("en", new Error("plain"))).toBe("plain");
});

test("errorResponse negotiates the locale from the request", async () => {
  const e = mhError("conflict", "站点入口节点不匹配（期望 {expected}，实际 {actual}）；这是防误配检查，不是身份认证", { expected: "a", actual: "b" });
  const en = await errorResponse(e, new Request("http://x/", { headers: { "accept-language": "en-US" } })).json();
  expect(en).toEqual({ error: "Site entry node mismatch (expected a, got b); this is a misconfiguration guard, not authentication", code: "conflict" });
  const zh = await errorResponse(e, new Request("http://x/")).json();
  expect(zh.error).toBe("站点入口节点不匹配（期望 a，实际 b）；这是防误配检查，不是身份认证");
  const cookie = await errorResponse(e, new Request("http://x/", { headers: { "accept-language": "en", cookie: "mh-lang=zh-CN" } })).json();
  expect(cookie.error).toBe(zh.error);
  const bare = await errorResponse(e).json();
  expect(bare.error).toBe(zh.error);
  expect(pm("en", "✅ 已授权")).toBe("✅ Authorized");
});
