/** @jsxImportSource preact */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, test, expect } from "bun:test";
import { render } from "preact";
import { act } from "preact/test-utils";
import { PageHeader } from "./primitives.tsx";
import { LocalRecovery } from "./local-recovery.tsx";
import { UpgradePrompt, UpgradeWarning } from "./upgrade-prompt.tsx";

GlobalRegistrator.register();
const host = document.createElement("div");
document.body.append(host);
const originalFetch = globalThis.fetch;
afterEach(() => {
  act(() => render(null, host));
  globalThis.fetch = originalFetch;
  delete window.metahubDesktop;
});
afterAll(() => { host.remove(); GlobalRegistrator.unregister(); });

test("the page header warning contains the upgrade action and retry feedback", async () => {
  const calls: string[] = [];
  window.metahubDesktop = { platform: "darwin", versions: { electron: "", chrome: "", node: "" }, rebuildReplica: async (url: string) => {
    calls.push(url); throw new Error("offline");
  } };
  globalThis.fetch = (async () => Response.json(["s3://one", "s3://two"])) as unknown as typeof fetch;
  act(() => render(<UpgradePrompt><PageHeader title="数据与备份" banner={<UpgradeWarning />} /></UpgradePrompt>, host));
  await act(async () => { await Bun.sleep(5); });
  const dialog = host.querySelector("dialog")!;
  expect(dialog.open).toBe(true);
  await act(() => Array.from(dialog.querySelectorAll("button")).find(b => b.textContent === "稍后")!.click());
  window.dispatchEvent(new Event("focus"));
  await act(async () => { await Bun.sleep(5); });
  expect(calls).toEqual([]);
  const banner = host.querySelector(".page-header-banner .set-callout.warn")!;
  expect(host.querySelector("dialog")).toBeNull();
  const select = banner.querySelector("select")!;
  await act(() => { select.value = "s3://two"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => { banner.querySelector<HTMLButtonElement>(".btn-primary")!.click(); await Bun.sleep(5); });
  expect(calls).toEqual(["s3://two"]);
  expect(banner.querySelector('[role="alert"]')?.textContent).toBe("offline");
  expect(banner.querySelector<HTMLButtonElement>(".btn-primary")!.disabled).toBe(false);
});

test("a current replica has no upgrade action and settings only show outstanding edits", async () => {
  window.metahubDesktop = { platform: "darwin", versions: { electron: "", chrome: "", node: "" },
    rebuildReplica: async () => { throw new Error("unexpected rebuild"); } };
  let items: unknown[] = [];
  globalThis.fetch = (async (url: string) => Response.json(url.endsWith("/items") ? items : [])) as unknown as typeof fetch;
  act(() => render(<><UpgradePrompt><UpgradeWarning /></UpgradePrompt><LocalRecovery desktop /></>, host));
  await act(async () => { await Bun.sleep(5); });
  expect(host.querySelector(".sync-upgrade")).toBeNull();
  expect(host.querySelector("dialog")).toBeNull();
  expect(host.textContent).not.toContain("本地副本与恢复");
  items = [{ id: "offline", target: "doc", local: '{"title":"离线编辑"}' }];
  act(() => render(<LocalRecovery key="refresh" desktop />, host));
  await act(async () => { await Bun.sleep(5); });
  expect(host.textContent).toContain("离线编辑");
  expect(Array.from(host.querySelectorAll("button")).map(button => button.textContent?.trim())).toEqual(["创建恢复副本", "丢弃此项"]);
});

test("a newer data format offers the app updater and keeps a read-only warning after dismissal", async () => {
  const calls: string[] = [];
  window.metahubDesktop = { platform: "darwin", versions: { electron: "", chrome: "", node: "" },
    rebuildReplica: async url => { calls.push(url); throw new Error("unexpected rebuild"); } };
  globalThis.fetch = (async () => Response.json({ urls: ["s3://one"], dataVersion: 3 })) as unknown as typeof fetch;
  act(() => render(<UpgradePrompt><UpgradeWarning /></UpgradePrompt>, host));
  await act(async () => { await Bun.sleep(5); });
  expect(host.querySelector("dialog")!.textContent).toContain("客户端最高支持 2");
  const button = [...host.querySelectorAll("dialog button")].find(b => b.textContent === "更新应用") as HTMLButtonElement;
  await act(async () => { button.click(); await Bun.sleep(5); });
  expect(location.hash).toBe("#/settings?sec=about");
  expect(host.querySelector("dialog")).toBeNull();
  expect(host.querySelector(".sync-upgrade")?.textContent).toContain("需要更新客户端");
  expect(calls).toEqual([]);
});
