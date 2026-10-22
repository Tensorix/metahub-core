# metahub website

Public product website for https://metahub.tensorix.org. Independent of the application shell and share viewer.

## Preview

From the repository root:

```sh
bun website/serve.ts
```

Open http://127.0.0.1:4173. No build step or runtime dependencies are required.

## Publish to Cloudflare

Wrangler requires a supported Node.js runtime (22+ on PATH); use `bunx` to invoke it rather than forcing Wrangler itself to run under Bun. The website preview still runs on Bun.

```sh
bunx wrangler login
bunx wrangler deploy --config website/wrangler.jsonc
```

The `metahub-website` Worker serves only `website/public/`. The custom domain configuration binds `metahub.tensorix.org`; the authenticated account must own the `tensorix.org` Cloudflare zone. Do not replace an existing unrelated domain binding.

Published at https://metahub.tensorix.org/ on 2026-10-22. Current deployment (v0.5.4 screenshots): `8bbf48c4-6dff-466f-9dda-59e805890510`.

## Content and assets

- Product claims and commands come from the repository README and agent skill.
- Product screenshots were captured from the current v0.5.4 source WebUI on 2026-10-22 at 1440 × 900. The interface and demo content are both English. They use a separate, synthetic demo knowledge base, never the user's personal data. The hero is explicitly labeled as an illustrative workspace.
- Brand images come from `assets/brand/color/`.
- Manrope is self-hosted; its Open Font License is included in `public/assets/Manrope-LICENSE.txt`.
- English is the default; the language control switches marketing copy to Simplified Chinese and persists the choice locally.
- No analytics, cookies, external fonts, or visitor data collection.

Update `public/index.html` for content, `style.css` for presentation, and `app.js` for language/tabs/clipboard behavior. Both tab groups support arrow keys, Home, and End. Reduced-motion preferences are respected.

## GitHub Actions

`Deploy Website` (`.github/workflows/deploy-website.yml`) deploys this existing
**Workers Static Assets** site; there is no dynamic Worker script or backend.

- Pushes to `main` affecting `website/**` or the deployment workflow validate and deploy the site.
- Manual runs are supported from `main` only. No Core or desktop release tag is needed.
- `dev` and pull requests run validation through the existing `CI / Fast checks` job, without deployment.
- Website-only changes skip Core dependency installation, tests, binary builds and release dry-runs. Mixed changes retain the full Core checks. New branches conservatively run Core checks.
- Validation compiles browser JavaScript and checks local HTML/CSS assets, both product screenshots, and required static files. Deployment verifies that the public homepage matches the checked-out file.

The repository already uses `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
The token must permit deployment to the configured account and management of the
`metahub.tensorix.org` custom domain. A Pages-only token is insufficient: use the
[Cloudflare Edit Cloudflare Workers token template](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/), scoped to the intended account and zone.
GitHub does not expose stored secret values, so token permissions are verified on the first deployment.
If updating a token shared with the other workflows, retain their existing Pages and D1 permissions.

Local validation:

```sh
bun website/check.ts
bun test scripts/ci-scope.test.ts
```
