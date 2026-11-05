import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../../../../../src/core/schema-init";
import { createSite, writeFileRow } from "../../../../../src/core/sites-core";
import { createReplicaService } from "../../../../../src/core/replica/service";
import { serveLocalSite } from "./gateway";

test("unpublished site serves modules, SPA and local CRUD independently of deployment", () => {
  const db = new Database(":memory:");
  initSchema(db);
  const replica = createReplicaService(db);
  try {
    const site = createSite(db, { name: "offline" });
    db.query("UPDATE sites SET spa=1 WHERE id=?").run(site.id);
    writeFileRow(
      db,
      site.id,
      "index.html",
      "text/html",
      "utf8",
      "<main>Hello</main>",
    );
    writeFileRow(
      db,
      site.id,
      "app.js",
      "application/javascript",
      "utf8",
      "export default 1",
    );
    writeFileRow(db, site.id, "404.html", "text/html", "utf8", "missing");
    writeFileRow(
      db,
      site.id,
      "mh-manifest.json",
      "application/json",
      "utf8",
      "external",
    );
    const call = (path: string, method = "GET", body = "") =>
      serveLocalSite(replica, site.id, method, path, body, "sdk", () => null);
    expect(call("/sites/offline/").text).toContain("Hello");
    expect(call("/sites/offline/detail").status).toBe(200);
    expect(call("/sites/offline/app.js").mime).toBe("application/javascript");
    expect(call("/sites/offline/missing.png").status).toBe(404);
    expect(
      JSON.parse(call("/sites/offline/mh-manifest.json").text!),
    ).toMatchObject({ mode: "live", runtimeEndpoint: "/" });
    expect(call("/sites/other/").status).toBe(404);
    expect(call("/api/repair/clock", "POST").status).toBe(404);
    const created = call(
      "/sites/offline/api/documents",
      "POST",
      JSON.stringify({ title: "Offline note", body: "saved" }),
    );
    expect(created.status).toBe(200);
    const id = JSON.parse(created.text!).id;
    expect(replica.commands.getDocument(id).title).toBe("Offline note");
    expect(JSON.parse(call("/api/document?id=" + id).text!).title).toBe(
      "Offline note",
    );
  } finally {
    replica.dispose();
    db.close();
  }
});

test("file responses use the current site revision and verified cache handle", () => {
  const db = new Database(":memory:");
  initSchema(db);
  const service = createReplicaService(db);
  try {
    const site = createSite(db, { name: "photos" });
    const hash = "a".repeat(32);
    writeFileRow(db, site.id, "photo.png", "image/png", "blob", hash);
    const request = (path: string, cached: boolean) =>
      serveLocalSite(service, site.id, "GET", path, "", "export {}", (key) =>
        key === hash && cached ? "file:///fixture/photo" : null,
      );
    expect(request("/sites/photos/photo.png", false).status).toBe(404);
    expect(request("/sites/photos/photo.png", true).file).toBe(
      "file:///fixture/photo",
    );
    writeFileRow(db, site.id, "photo.png", "image/png", "base64", "YQ==");
    expect(request("/sites/photos/photo.png", false).base64).toBe("YQ==");
    expect(request("/metahub-sdk.js", false).text).toBe("export {}");
    expect(request("/api/version", false).status).toBe(404);
  } finally {
    service.dispose();
    db.close();
  }
});
