# guides.show

The portable Guided Review viewer and its Cloudflare Worker.
Decision record: `adr/decisions/007-portable-guided-reviews-20260815.md`; spec: `adr/implementation/portable-guided-reviews.md`.

## What lives here

- `viewer/` — the browser entry that turns an exported guide (`<script id="plannotator-guided-review">`) into the same guide UI Plannotator renders: `@plannotator/guide-viewer` over `AllFilesCodeView` in `readOnly` mode. Multi-file Vite build (`vite.viewer.config.ts`): `viewer.<hash>.js/.css`, one chunk per Shiki grammar, the highlight worker as a file, fonts as files.
- `worker/` — the Cloudflare Worker: serves `/v1/*` from the `guides-show-viewer` R2 bucket (immutable, CORS `*` so `file://` documents can load it), the landing page from static assets, and reserves `/g/*` + `/api/*` for the future platform.
- `build/` — `manifest-plugin` (emits `manifest.json`: entry paths + SRI + grammar chunk map), `read-only-stubs-plugin` (keeps annotation UI out of the bundle), `deploy-viewer` (add-only R2 upload), `check-budgets`, `sync-manifest`, `export-sample`, `serve-local`.
- `packages/core/guide-viewer-manifest.ts` (generated here by `sync-manifest`) — checked in; what Plannotator embeds so exports pin the viewer this release publishes. Regenerate with `bun run build:viewer && bun run sync:manifest`; CI fails if stale.
- `site/` — landing page.

## Local loop

```sh
bun run --cwd apps/guides-show build:viewer          # dist/viewer
bun run --cwd apps/guides-show serve:local           # http://localhost:8787/v1/ (CDN stand-in)
bun run --cwd apps/guides-show export:samples -- --base http://localhost:8787/v1/ --out dist/samples-local
open apps/guides-show/dist/samples-local/*.html      # opens from file://, loads the local "CDN"
```

Or through the real Worker: `bun run deploy:viewer -- --local` (seeds local R2) then `bun run dev:worker` and export against `http://localhost:8787/v1/`.

## Immutability

Everything under `/v1/` is content-hashed and never overwritten or deleted. Exports pin `viewer.<hash>.js` + `integrity`, so a guide exported today opens forever. Mutable pointers (build manifests) live under `/meta/`, never `/v1/`.

## Deploy status

First deployed 2026-08-15 from a local wrangler login: bucket `guides-show-viewer` created, viewer build `viewer.DULnMtI1.js` published to `/v1/`, Worker live on the `guides.show` custom domain. Verified: immutable + CORS headers on the edge, served bytes match the pinned SRI, an export with the default URL opens from disk.

## First deploy checklist (one-time)

1. Cloudflare: create R2 bucket `guides-show-viewer`; add the `guides.show` zone; the Worker route uses `custom_domain = true`.
2. GitHub: `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit, Workers R2 Storage:Edit, Zone DNS for the custom domain) and `CLOUDFLARE_ACCOUNT_ID` secrets in the `production` environment (the paste-service secrets may already cover this if the token has R2 scope).
3. Run the `guides.show deploy` workflow manually once (workflow_dispatch), then it runs on every `v*` tag.
