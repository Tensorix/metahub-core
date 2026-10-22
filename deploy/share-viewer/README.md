# Share viewer and short links

The existing `metahub-share` Cloudflare Pages project serves the viewer. A Pages
advanced-mode Worker handles **only `/api/*`**, with a `SHARE_LINKS` D1 binding.
All HTML, JS, icons and `/s/:id` rewrites remain static CDN requests. No migration
of the product website or application shell is required.

## Provision and deploy

```sh
bunx wrangler d1 create metahub-share-links
bun run build:share-viewer
# Use the UUID printed by d1 create, not the database name.
SHARE_LINKS_DATABASE_ID=<uuid> bun run scripts/configure-share-viewer.ts
bunx wrangler d1 migrations apply SHARE_LINKS --remote --config dist/wrangler.json
bunx wrangler --cwd dist pages deploy share-viewer --project-name=metahub-share --branch=main
```

For GitHub Actions, set the repository **variable** `SHARE_LINKS_DATABASE_ID`.
The existing `CLOUDFLARE_API_TOKEN` needs Cloudflare Pages Edit **and D1 Edit**;
`CLOUDFLARE_ACCOUNT_ID` stays unchanged. The workflow applies additive migrations
before deploying. Use a **separate D1 database** for preview/testing; never run
preview code with the production binding. Keep the existing custom domain.

Local workerd smoke test (use a throwaway UUID for the generated local config):

```sh
bunx wrangler d1 migrations apply SHARE_LINKS --local --config dist/wrangler.json
bunx wrangler --cwd dist pages dev share-viewer --d1 SHARE_LINKS
# In a second terminal:
bun run scripts/smoke-share-viewer.ts http://localhost:8788
```

## Protocol and compatibility

- Default link: `/s/<22-character ID>#k=<43-character base64url key>`.
- Password link: `/s/<ID>`; salt comes from the descriptor, the password is
  entered locally and never sent to the API.
- Old `/#m=<encoded presigned URL>&k=<base64 key>` and `&s=<base64 salt>` links
  still work without any API call. A static custom viewer without this API
  continues to receive long links. HTTP/local or subpath viewers use long links.
- `GET /api/links` advertises the service. `GET /api/links/:id` resolves a link.
- `PUT /api/links/:id` creates (`If-None-Match: *`) or updates (`If-Match: ETag`)
  with an independent `Authorization: Bearer ...` management capability.
- `DELETE /api/links/:id` requires that capability and leaves a tombstone.
  Authenticated GET permits owners to renew expired records; public GET returns
  410 for expired/revoked records. All API responses are `no-store`.
- D1 stores only a presigned manifest URL, expiry, optional salt, capability
  hash, version and revocation flag. It never receives a content key, password,
  bucket secret or document plaintext. The viewer still trusts the host's JS.

Each viewer's random management capability lives in a separate private bucket
object, `shares/<slug>/links/<viewer-hash>.json`, encrypted with the bucket master
key when bucket encryption is enabled (the same policy as `meta.json`). It is
not included in the recipient manifest. Conditional object creation ensures
devices agree on the same identity. The short ID is bound to this capability.
Bucket credential rotation does not change the short URL.

Creating/renewing a share updates the same ID; copying currently follows the
existing re-sign flow. Renewing also restores access for holders of that old
short URL. Failure returns a working legacy URL with a warning; already-issued
short links still depend on the API. Revoke must confirm aliases and object
deletion before discarding management metadata; failures report
`cleanup_pending` and can be retried. Downloads already obtained cannot be
recalled. The API cannot extend S3 signatures while the owner's devices are
offline; the current seven-day cap remains.

Registration is anonymous but bounded to 60 new links/IP/hour and 1,000/day for
this service, using atomic D1 counters. Reads perform no analytics writes.
Request bodies are bounded to 12 KiB, URLs to 8 KiB, and only signed HTTPS S3
descriptors are accepted. The server never fetches a supplied URL or redirects
to it. Unknown descriptor fields (including keys) are rejected. CORS supports
CLI, desktop and browser replicas without cookies. Capabilities, not CORS,
authorize mutations. Do not add request-body/Authorization logging or third-party
scripts to this origin.

Registration performs bounded expiry cleanup: rate counters after two days,
links/tombstones after their expiry plus 30 days. Empty traffic leaves expired
records stored but inaccessible; periodic manual cleanup can reclaim space if
needed. Default D1 reads use the primary; do not add replica reads or CDN caching
without preserving create/update/revoke consistency.
