# 007 — Portable Guided Reviews

Date: 2026-08-15
Status: accepted (design), implementation spec in `adr/implementation/portable-guided-reviews.md`
Supersedes: branch `guided-review-html-export` (`2cf18cc3`, never merged) — salvaged in parts, spine redesigned.

## Context

A Guided Review is the most shareable artifact Plannotator produces: an ordered, chaptered walkthrough of a changeset with the real diffs inline. Today it exists only inside a running Plannotator session. We want to hand one to someone as a single file that looks exactly like it does in the app, and — later — host it at a URL and let a future platform build on the same format.

The earlier attempt exported the *entire review app* into the HTML (17–18 MB) or referenced a mutable `v1/` viewer on the marketing CDN, and could only export the guide currently in memory. Both properties conflicted with the goal. See `adr/implementation/portable-guided-reviews.md` §"Salvage" for what survives from it.

## Decisions

Each numbered decision below is traceable to a verification check in the implementation spec (§Verification matrix).

### D1 — The artifact is one small HTML file whose size is the diff, never the app
The exported file contains the guide JSON, the exact diff, provenance, and a plain-text fallback body. It references the renderer on `guides.show`; it does not embed it. **No caps on diff size** — a huge diff produces a huge file and that is the user's call. The thing we refuse is a multi-megabyte *baseline* caused by packing the application.

### D2 — One renderer, two hosts: the in-app guide and the portable guide are the same code
The guide rendering chain (`GuideView → GuideSectionCard → GuideFileCard → GuideViewportManager → AllFilesCodeView` on `@pierre/diffs`, plus the two dependency-free markdown renderers) moves into a package, `@plannotator/guide-viewer`, and Plannotator's review app imports it from there. "No visual drift" is therefore structural, not a promise. `AllFilesCodeView` is reused behind a `readOnly` mode rather than replaced by a lean sibling; the annotation/edit machinery code-splits out for read-only hosts. Rejected: a separate lean diff renderer (would drift on the first Pierre upgrade and re-derive the #1158 viewport contract).

### D3 — Read-only now, feedback later, format reserved for it
The portable guide is read-only (scroll, expand/collapse chapters, jump to files, light/dark, in-session "reviewed" toggles that persist nowhere). Reviewer annotations and PR comment threads are **not** exported in v1. The snapshot format reserves an `annotations` block and the viewer keeps its annotation slot so shared feedback can be added without breaking the format or the renderer.

### D4 — Guide screen only
The portable file renders the guide screen — never the full review shell (file tree, all-files view, search, approve/feedback). Nothing in the file may attempt a server call.

### D5 — The snapshot is a versioned, strict, self-describing document
Payload (v1): `guide` (title, intent, sections[{title, overview, diffs[{file, summary}]}], unplacedFiles, reviewed[]), `review` (rawPatch, gitRef label, diffType, base), `source` (kind local|pr|workspace|commit, repo, branch, headSha, pr{url,number,title,platform}?, commitSha?), `generator` (engine, model, generatedAt, **customInstructions** for provenance), `theme?` (exporter palette hint). Parsing rejects unknown fields; the format has a fixture per version and a compatibility test. Every guide source (local diff types incl. commits/worktrees, PR layer/full-stack, multi-repo workspace) is exportable, and the header must state plainly what the guide is *of*.

### D6 — Capture the diff when the guide job launches, not when the user exports
A guide describes the diff it was generated against; the on-screen diff may have moved by export time. Plannotator captures the launch-time patch on the job (the same channel `changedFilesSnapshot`/`guideContext` already use) and stores it beside the saved guide (`{id}.patch`). One guide at a time; not a "previous guides" feature — just not throwing away the input. Rejected: an in-memory-only map (dies with the server, and leaked in the earlier branch).

### D7 — guides.show is the CDN today and the platform tomorrow, on Cloudflare, standalone
A Cloudflare Worker with static assets serves immutable viewer files under `guides.show/v1/…`. It has **nothing to do with the paste service** (separate app, separate deploy, separate wrangler config). URL space reserved from day one: `/v1/…` immutable assets, `/g/<id>` future shared guides, `/` landing. Efficiency, cost and scale for the future platform are first-class when shaping it.

### D8 — Immutable, pinned viewer; grammars and fonts fetched per need
Every file under `/v1/` is content-hashed and never overwritten or deleted, so an exported HTML keeps working indefinitely; the HTML pins the exact viewer build (hash + `integrity`). Syntax grammars are shipped as one small file per language and the exporter lists the languages the diff actually contains, so the viewer fetches only those. Fonts are the real ones (Inter + Geist Mono latin subsets, ~78 KB, cached) with system fallback. Base Plannotator theme with light/dark now, extensible to other palettes. Highlighting runs main-thread when the file is opened from disk (browsers block workers on `file://`) and in a worker when served from an origin — same bundle, one runtime switch.

### D9 — The export is a pure function with three callers
`(snapshot) → HTML` lives once, in the format package. Callers: (1) Plannotator UI Share menu → "Download portable guide"; (2) `plannotator guide export` CLI subcommand; (3) later, an agent skill that produces the guide JSON itself and wraps it via the CLI so people without the Plannotator app get a guide. (1) and (2) shipped first; (3) followed as the `plannotator-guide` extra skill over `plannotator guide export --guide guide.json --patch guide.patch` — the CLI validates and wraps, the agent only writes the guide. No redesign was needed.

### D10 — Viewer releases ride Plannotator releases
New viewer builds are uploaded to guides.show by a GitHub Actions workflow on tagged Plannotator releases, gated by the format compatibility test. Because assets are pinned (D8), a bad deploy cannot break existing exports.

### D11 — Share links are out of scope
No upload/`/g/<id>` route is built. The Share menu shows only "Download portable guide" — no disabled placeholders. The menu is expected to grow "Create share link" once guides.show can host.

### D12 — Not now (explicit)
Annotations in exports; PR comment threads; share links; palettes beyond the base theme; any embed component API for the commercial platform (the platform, if it needs guides, serves the same HTML page).

## Consequences

- `packages/review-editor` loses the guide chain to `packages/guide-viewer` and imports it back; the app's behavior must be unchanged (parity gate).
- ~6 type-only modules move `packages/shared → packages/core` so the viewer has no Node imports.
- The viewer needs its own Tailwind build (existing `@plannotator/ui/styles.css` does not scan review-editor classes).
- Consumers of the npm package must alias `shiki` to the narrowed grammar entry (as the app already does for `shiki/wasm`) or pay ~11.6 MB — documented as a hard requirement.
- Bun and Pi servers gain identical export endpoints; Pi vendors the format package.

## References
- `adr/implementation/portable-guided-reviews.md` — implementation spec, phases, verification matrix
- `adr/decisions/006-guided-review-first-class-feature-20260702-192821.md`
- `adr/research/SPIKE-guide-diff-annotation-reuse-20260702-194831.md`
- Branch `guided-review-html-export` (`2cf18cc3`) — salvage source
