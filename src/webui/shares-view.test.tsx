/** @jsxImportSource preact */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";
import { render } from "preact";
import { act } from "preact/test-utils";
import { api, type ShareListItem } from "./api.ts";
import { ShareView } from "./shares-view.tsx";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());
test("expired shares expand and remain visible when filtering directly", async () => {
  const original = api.listShares;
  api.listShares = async () => [
    { slug: "live", kind: "doc", title: "Live document", transport: "s3", sourceKind: "bucket", source: "test", permission: "view", expiresAt: Date.now() + 86400000 },
    { slug: "expired", kind: "doc", title: "Expired document", transport: "s3", sourceKind: "bucket", source: "test", permission: "view", expiresAt: 1 },
  ] as ShareListItem[];
  const host = document.createElement("div");
  document.body.append(host);
  try {
    await act(async () => { render(<ShareView onNavigate={() => {}} />, host); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const group = host.querySelector<HTMLUListElement>("#shv-expired")!;
    const toggle = host.querySelector<HTMLButtonElement>(".shv-group-toggle")!;
    expect(group.hidden).toBe(true);
    await act(() => toggle.click());
    expect(group.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await act(() => toggle.click());
    expect(group.hidden).toBe(true);
    const filters = host.querySelectorAll<HTMLButtonElement>(".shv-seg-btn");
    await act(() => filters[3]!.click());
    expect(host.querySelector<HTMLUListElement>("#shv-expired")!.hidden).toBe(false);
    expect(host.querySelector(".shv-group-toggle")).toBeNull();
    expect(host.querySelectorAll(".shv-row").length).toBe(1);
    expect(filters[3]!.getAttribute("aria-pressed")).toBe("true");
  } finally {
    render(null, host);
    host.remove();
    api.listShares = original;
  }
});
