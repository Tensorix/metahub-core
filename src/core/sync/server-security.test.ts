import { describe, expect, test } from "bun:test";
import { loopbackUiRejection } from "./server.ts";

describe("desktop loopback UI guard", () => {
  test("accepts the exact loopback host and same-origin mutation", () => {
    const req = new Request("http://127.0.0.1:4567/api/share", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:4567",
        "sec-fetch-site": "same-origin",
      },
    });
    expect(loopbackUiRejection(req, 4567)).toBeNull();
  });

  test("rejects DNS-rebinding hosts and cross-site simple POSTs", () => {
    expect(
      loopbackUiRejection(new Request("http://attacker.test:4567/api/share"), 4567)?.status,
    ).toBe(403);
    expect(
      loopbackUiRejection(
        new Request("http://127.0.0.1:4567/api/share", {
          method: "POST",
          headers: {
            origin: "https://attacker.test",
            "content-type": "text/plain",
            "sec-fetch-site": "cross-site",
          },
        }),
        4567,
      )?.status,
    ).toBe(403);
    expect(
      loopbackUiRejection(
        new Request("http://127.0.0.1:4567/api/share", {
          method: "DELETE",
        }),
        4567,
      )?.status,
    ).toBe(403);
  });
});
