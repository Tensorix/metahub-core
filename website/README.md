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

Latest recorded production release: 2026-11-04, from main commit `ecbd4116405c6d564df4ea69e43654ac076a5487`. Cloudflare version: `10702e0a-2844-4af8-98f8-a569379f3af7`. The homepage and its four CSS/JavaScript files were verified byte-for-byte against that commit. Product screenshots remain the explicitly labeled v0.5.4 captures.

For that release, GitHub Actions passed validation but the repository token could not access the `metahub-website` service. Deployment completed with the maintainer's existing Cloudflare OAuth login. Before relying on automatic deployments again, correct the repository token's account/service permissions; the required permission scope is described below.

## Content and assets

- Product narrative and bilingual slogan follow the [brand guide](../assets/brand/README.md); implementation follows [DESIGN.md](./DESIGN.md). Product capabilities and commands come from the repository README, agent guide, and source. The locked hero is “Where you and your AI keep working.” / “你和 AI 接着往下做的地方。”
- Notes, Tables, and Sites share one fixed-height interactive demonstration area. Each has a pausable walkthrough, manual interactions, explicit AI re-read feedback, and reset. Switching scenes or language retains visitor edits while cancelling unfinished demonstrations. Data stays in page memory; no model calls or submissions are sent.
- Demo surfaces track the actual WebUI palette, typography stack, sidebar, document editor, board, and data grid. Board cards omit the grouping property; status cells use the app's option chips and searchable picker, with a bottom sheet on phones. The date selector sits outside the app frame as a demo control. On mobile, sign-up and write-back views switch in place rather than stacking.
- Product screenshots were captured from v0.5.4 WebUI on 2026-10-22 at 1440 × 900, using a synthetic sample workspace. They are retained as versioned English evidence in an expandable section; live demo copy is fully English/Chinese.
- Brand images come from `assets/brand/color/`.
- Manrope is self-hosted; its Open Font License is included in `public/assets/Manrope-LICENSE.txt`.
- English is the default; the language control switches marketing copy to Simplified Chinese and persists the choice locally.
- No analytics, cookies, external fonts, or visitor data collection.

Update `public/index.html` for semantic structure and initial English content, `copy.js` for both languages, `style.css` for presentation, `demo.js` for interaction/motion, and `app.js` for page language/tabs/clipboard behavior. Keep initial HTML text and the English dictionary in sync. Every tab group supports arrow keys, Home, and End. Reduced-motion preferences disable autoplay and spatial animation.

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
bun test website/demo.test.ts
bun test scripts/ci-scope.test.ts
```
