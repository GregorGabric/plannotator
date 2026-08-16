# guides.show

The portable Guided Review viewer and its Cloudflare Worker.
Decision record: `adr/decisions/007-portable-guided-reviews-20260815.md`; spec: `adr/implementation/portable-guided-reviews.md`.

## What lives here

- `viewer/` — the browser entry that turns an exported guide (`<script id="plannotator-guided-review">`) into the same guide UI Plannotator renders: `@plannotator/guide-viewer` over `AllFilesCodeView` in `readOnly` mode. Multi-file Vite build (`vite.viewer.config.ts`): `viewer.<hash>.js/.css`, one chunk per Shiki grammar, the highlight worker as a file, fonts as files.
- `worker/` — the Cloudflare Worker: serves `/v1/*` from the `guides-show-viewer` R2 bucket (immutable, CORS `*` so `file://` documents can load it), the landing page from static assets, and shared guides (`/g/<id>`, `/api/g*`) through the share handler over the `guides-show-guides` R2 bucket.
- `share/` — the guide share service (contract: `adr/implementation/guide-share-hosting.md`): `core/handler.ts` is the pure request handler both hosts run, `core/storage.ts` the store interface, `stores/` the R2, filesystem, S3 and in-memory stores.
- `targets/bun.ts` — the Bun self-host target: the same routes as the Worker in one process, no Cloudflare needed (see "Self-hosting").
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

## Self-hosting

Shared guides are stored by whoever runs the service. The hosted service is guides.show; both recipes below give you the same routes on your own host, and Plannotator can be pointed at either.

### Cloudflare (Worker + R2)

Once per account:

```sh
cd apps/guides-show
wrangler r2 bucket create guides-show-viewer      # immutable viewer builds under /v1/
wrangler r2 bucket create guides-show-guides      # shared guides (deletable)
```

Then publish the viewer build and the Worker (the domain in `wrangler.toml` `routes` is yours to change):

```sh
bun run build:viewer && bun run deploy:viewer     # add-only upload of dist/viewer to /v1/
wrangler deploy
```

`wrangler.toml` also declares an optional `RATE_LIMITER` binding for upload rate limiting. If your plan rejects it at deploy, remove that block; the handler runs without limiting when the binding is absent.

### Bun (single process)

Serves `/v1/*` from a viewer build directory, shared guides from a filesystem or S3-compatible store, the landing page and `/healthz`:

```sh
bun run --cwd apps/guides-show build:viewer       # produces dist/viewer, served under /v1/
bun run apps/guides-show/targets/bun.ts --port 8788 --store fs:/var/lib/guides-show
# or, from apps/guides-show: bun run serve -- --port 8788 --store fs:/var/lib/guides-show
```

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--port <n>` | `PORT` | `8788` | Port to listen on |
| `--store <spec>` | `GUIDES_SHOW_STORE` | `fs:./guides-data` | `fs:<dir>`, `s3:<bucket>` (Bun's built-in S3 client; credentials and endpoint from `S3_*` / `AWS_*` env) or `memory` (lost on restart) |
| `--viewer-dir <dir>` | `GUIDES_SHOW_VIEWER_DIR` | `dist/viewer` | Directory served under `/v1/` with immutable + CORS `*` headers |
| `--host <addr>` | `GUIDES_SHOW_HOST` | `0.0.0.0` | Address to bind |
| `--public-origin <url>` | `GUIDES_SHOW_PUBLIC_ORIGIN` | unset | Fixed https origin that pages pin and links use, e.g. `https://guides.example.com`. Preferred behind a TLS proxy: nothing a client sends can reach the page. |
| `--trust-proxy` | `GUIDES_SHOW_TRUST_PROXY=1` | off | Take the request origin from `X-Forwarded-Proto` / `X-Forwarded-Host` (when no `--public-origin`) and the client address from the last `X-Forwarded-For` hop. Only behind a proxy that SETS these headers itself (`proxy_set_header X-Forwarded-Host $host;` in nginx); a proxy that passes a client's headers through would let a client pick the origin the page loads its viewer script from. |
| `--upload-limit <n>` | `GUIDES_SHOW_UPLOAD_LIMIT` | `30` | Uploads per client address per minute (in-process, fixed window); `0` disables the limiter |
| `--max-ttl <duration>` | `GUIDES_SHOW_MAX_TTL` | unset | Keep no guide longer than this (seconds, or `30m` / `24h` / `7d`): uploads without a ttl get this lifetime and longer requests are clamped. Unset keeps guides until whoever shared them removes them. The Worker has the same knob as `MAX_TTL_SECONDS` in `wrangler.toml` `[vars]`. |

Shared pages pin `<origin>/v1/` as their viewer base and `<origin>/g/<id>` as their canonical URL, where the origin is the fixed `--public-origin` when set, else the one the request arrived on. Exported guides only accept an https viewer base (http is allowed for localhost only), so a self-host reached over plain http from another machine answers 500 on `/g/<id>`: terminate TLS in front of the process (Caddy, nginx, a tunnel) and start it with `--public-origin https://<your host>` so pages pin the public https origin.

Uploads are anonymous by design (the encrypted default means the host cannot read them), so a host on the open network has only these brakes: the per-address upload limit, the size cap (25 MiB per guide), and `--max-ttl`. Set `--max-ttl` on any host you do not want to grow without bound.

### Pointing Plannotator at your host

| Setting | Effect |
|---|---|
| `PLANNOTATOR_GUIDE_SHARE_URL=https://guides.example.com` (or `{ "guideShareUrl": "..." }` in `~/.plannotator/config.json`) | Where `plannotator guide share`, the review UI's share dialog and `unshare` upload to and delete from. `plannotator guide share --service-url <u>` overrides it per invocation. |
| `PLANNOTATOR_GUIDE_VIEWER_URL=https://guides.example.com/v1/` | The viewer base that downloaded portable guides pin, so exports open against your `/v1/` instead of guides.show. Must be https (or http on localhost). |
| `PLANNOTATOR_SHARE=disabled` (or `{ "share": "disabled" }`) | Turns sharing off entirely; the share commands refuse and the UI hides the option. |

Local trial against a running Bun target:

```sh
bun run apps/guides-show/targets/bun.ts --store fs:/tmp/guides --port 8788
PLANNOTATOR_GUIDE_SHARE_URL=http://localhost:8788 PLANNOTATOR_GUIDE_VIEWER_URL=http://localhost:8788/v1/ \
  plannotator guide share --guide guide.json --patch guide.patch
```

## Share API

Identical on the Worker and the Bun target. Guides are encrypted by default: the uploader keeps the key in the URL fragment (`#key=...`) and the host only ever sees ciphertext; `plain` guides (`--public` / "allow link previews") are stored as snapshot JSON so the page can carry `og:title` and friends.

| Route | Request | Response |
|---|---|---|
| `POST /api/g` | JSON `{ mode: "encrypted" \| "plain", data: string, viewer?: { js, css, jsIntegrity?, cssIntegrity?, langs? }, ttlSeconds?: number }` | `201 { id, url, deleteToken, expiresAt? }`; `url = <origin>/g/<id>` (the uploader appends `#key=...` for encrypted). `400` bad shape or a plain snapshot that fails validation (`{ error, path, message }`), `413 { error: "too large", maxBytes }` over 25 MiB, `429` rate limited (the Worker's `RATE_LIMITER` binding, or the Bun target's `--upload-limit`). When the host sets a maximum lifetime, `expiresAt` reflects it even for uploads that asked for none. |
| `GET /g/<id>` | | `200 text/html`: plain guides render the full page with the pinned viewer; encrypted guides get the shell that fetches `/api/g/<id>` and decrypts in the browser. `Cache-Control: public, max-age=300`. `404`: a small "not found" page. |
| `GET /api/g/<id>` | | The stored body: `text/plain` ciphertext (encrypted) or `application/json` (plain). `Access-Control-Allow-Origin: *`, `Cache-Control: public, max-age=300`. `404 { error: "not found" }`. |
| `DELETE /api/g/<id>` | `Authorization: Bearer <deleteToken>` | `204`; `401` missing or wrong token; `404` unknown or expired. |
| `OPTIONS /api/g*` | | CORS preflight: `*`, `POST, GET, DELETE, OPTIONS`, `Content-Type, Authorization`. |
| `GET /v1/*` | | Immutable viewer assets, CORS `*`. |
| `GET /healthz` | | `{ "ok": true }`. |

The `viewer` pin is the `{ js, css, jsIntegrity, cssIntegrity, langs? }` the uploader embeds in its own exports; the host renders the page with it, on its own `/v1/`. Without a pin the host uses its bundled manifest. Ids and delete tokens are 16 random bytes as base64url; the token is stored as a SHA-256 hash and shown once at create.

## Immutability

Everything under `/v1/` is content-hashed and never overwritten or deleted. Exports pin `viewer.<hash>.js` + `integrity`, so a guide exported today opens forever. Mutable pointers (build manifests) live under `/meta/`, never `/v1/`.

## Deploy status

First deployed 2026-08-15 from a local wrangler login: bucket `guides-show-viewer` created, viewer build `viewer.DULnMtI1.js` published to `/v1/`, Worker live on the `guides.show` custom domain. Verified: immutable + CORS headers on the edge, served bytes match the pinned SRI, an export with the default URL opens from disk.

## First deploy checklist (one-time)

1. Cloudflare: create R2 buckets `guides-show-viewer` (viewer builds) and `guides-show-guides` (shared guides); add the `guides.show` zone; the Worker route uses `custom_domain = true`.
2. GitHub: `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit, Workers R2 Storage:Edit, Zone DNS for the custom domain) and `CLOUDFLARE_ACCOUNT_ID` secrets in the `production` environment (the paste-service secrets may already cover this if the token has R2 scope).
3. Run the `guides.show deploy` workflow manually once (workflow_dispatch), then it runs on every `v*` tag.
