/** @jsxImportSource preact */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { render } from "preact";
import { act } from "preact/test-utils";
import { api, type CreateShareBody, type ShareListItem } from "./api.ts";
import { ObjectShareDialog } from "./object-share-dialog.tsx";
import type { Scope } from "./data/scopes.ts";

GlobalRegistrator.register();
const original = {
  list: api.listShares,
  create: api.createShare,
  renew: api.renewShare,
  revoke: api.revokeShare,
};
let host: HTMLDivElement;
const targets = [
  {
    id: "bucket:s3://test",
    kind: "bucket",
    label: "Bucket",
    subtitle: "test",
    routeOp: { via: "bucket", url: "s3://test" },
  },
] as Scope[];
const record = {
  slug: "one",
  kind: "doc",
  target_id: "doc",
  title: "Test",
  permission: "view",
  transport: "s3",
  source: "test",
  sourceKind: "bucket",
  expiresAt: Date.now() + 100000,
  hasPassword: false,
} as ShareListItem;
const mount = async (hostingTargets = targets) => {
  await act(async () => {
    render(
      <ObjectShareDialog
        target={{ kind: "doc", ref: "doc", title: "Test" }}
        targets={hostingTargets}
        onClose={() => {}}
      />,
      host,
    );
  });
};
const button = (label: string) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
    (node) => node.textContent === label,
  )!;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => {
  act(() => render(null, host));
  host.remove();
  api.listShares = original.list;
  api.createShare = original.create;
  api.renewShare = original.renew;
  api.revokeShare = original.revoke;
});
afterAll(() => GlobalRegistrator.unregister());

test("snapshot creation sends finite expiry and clipboard failure keeps a manual-copy fallback", async () => {
  let rows: ShareListItem[] = [];
  let submitted: CreateShareBody | undefined;
  api.listShares = async () => rows;
  api.createShare = async (body) => {
    submitted = body;
    rows = [record];
    return { ...record, hosting: "s3", url: "https://example.test/one" };
  };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async () => {
        throw new Error("denied");
      },
    },
  });
  await mount();
  expect(host.textContent).toContain("固定快照");
  expect(host.textContent).not.toContain("永不过期");
  await act(async () => {
    button("创建并复制链接").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(submitted?.expiresMs).toBe(604800000);
  expect(submitted?.permission).toBe("view");
  expect(host.textContent).toContain("自动复制失败");
  expect(
    host.querySelector<HTMLInputElement>('input[aria-label="分享链接"]')?.value,
  ).toBe("https://example.test/one");
  expect(button("已复制链接")).toBeUndefined();
  await act(async () => {
    button("新建链接").click();
  });
  expect(host.querySelector('input[aria-label="分享链接"]')).toBeNull();
});

test("pending revocation shows confirmation inline and cancel preserves the sharing surface", async () => {
  let renewals = 0;
  api.listShares = async () => [{ ...record, lifecycle: "cleanup_pending" }];
  api.renewShare = async () => {
    renewals++;
    throw new Error("must not renew");
  };
  await mount();
  expect(host.textContent).toContain("链接可能仍可访问");
  expect(button("复制链接")).toBeUndefined();
  await act(async () => {
    button("重试撤销").click();
  });
  expect(host.textContent).toContain("撤销这个分享？");
  await act(async () => {
    button("取消").click();
  });
  expect(host.textContent).toContain("正在撤销访问");
  expect(renewals).toBe(0);
});

test("loading failure cannot be mistaken for an unshared document", async () => {
  api.listShares = async () => {
    throw new Error("offline");
  };
  await mount();
  expect(host.textContent).toContain("无法加载分享状态");
  expect(button("创建并复制链接")).toBeUndefined();
  api.listShares = async () => [record];
  await act(async () => {
    button("重试").click();
  });
  expect(button("复制链接")).toBeDefined();
});

test("hosting is the first choice and choosing a specific bucket determines transport and constraints", async () => {
  api.listShares = async () => [];
  let submitted: CreateShareBody | undefined;
  api.createShare = async (body) => {
    submitted = body;
    return { ...record, hosting: "s3", url: "https://example.test/one" };
  };
  const hostingTargets = [
    {
      id: "server",
      kind: "server",
      label: "当前服务器",
      subtitle: "https://device.test",
      routeOp: { via: "http" },
    },
    ...targets,
    {
      ...targets[0]!,
      id: "bucket:s3://second",
      subtitle: "Second bucket",
      routeOp: { via: "bucket", url: "s3://second" },
    },
  ] as Scope[];
  await mount(hostingTargets);
  const picker = host.querySelector<HTMLSelectElement>("select")!;
  expect(picker.id).toBe("share-host-destination");
  expect(host.textContent).toContain("设备托管 · 实时内容");
  await act(async () => {
    picker.value = "bucket:s3://second";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(host.textContent).toContain("存储桶托管 · 固定快照");
  expect(host.textContent).not.toContain("永不过期");
  expect(host.querySelectorAll("#share-host-destination")).toHaveLength(1);
  await act(async () => {
    button("创建并复制链接").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(submitted?.bucketUrl).toBe("s3://second");
  expect(submitted?.transport).toBe("s3");
  expect(submitted?.permission).toBe("view");
  expect(submitted?.expiresMs).toBe(604800000);
});

test("existing link displays its actual host before access permissions", async () => {
  api.listShares = async () => [{ ...record, source: "Team archive" }];
  await mount();
  const surface = host.querySelector(".share-dialog")!;
  expect(surface.querySelector("ul")?.getAttribute("aria-label")).toBe(
    "分享链接",
  );
  expect(surface.firstElementChild?.textContent).toContain("Team archive");
  await act(async () => {
    button("新建链接").click();
  });
  expect(
    host.querySelector<HTMLSelectElement>("#share-host-destination")?.value,
  ).toBe("bucket:s3://test");
});

test("list actions copy the chosen row, and details expand independently", async () => {
  const copiedUrls: string[] = [];
  api.listShares = async () => [
    { ...record, source: "First host", url: "https://example.test/one" },
    {
      ...record,
      slug: "two",
      source: "Second host",
      url: "https://example.test/two",
    },
  ];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        copiedUrls.push(value);
      },
    },
  });
  await mount();
  const rows = host.querySelectorAll<HTMLLIElement>(".share-link-list > li");
  expect(rows.length).toBe(2);
  await act(async () => {
    rows[1]!
      .querySelector<HTMLButtonElement>(".share-link-actions button")!
      .click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(copiedUrls).toEqual(["https://example.test/two"]);
  expect(rows[0]!.querySelector(".share-link-actions")!.textContent).toContain(
    "复制链接",
  );
  expect(rows[1]!.querySelector(".share-link-actions")!.textContent).toContain(
    "已复制链接",
  );
  await act(async () => {
    rows[0]!.querySelector<HTMLButtonElement>(".share-link-name")!.click();
  });
  expect(
    rows[0]!.querySelector<HTMLElement>(".share-link-detail")!.hidden,
  ).toBe(false);
  expect(
    rows[1]!.querySelector<HTMLElement>(".share-link-detail")!.hidden,
  ).toBe(true);
});
