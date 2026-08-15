---
title: "Portable guides"
description: "The portable Guided Review file: what is in it, how it renders from guides.show, and the snapshot format agents and tools can produce."
sidebar:
  order: 34
section: "Reference"
---

A portable guide is **one HTML file** that renders a Guided Review — chapters, per-file summaries, and the exact diff — anywhere: from disk, from an email attachment, from any web host. It contains the guide and the diff; the rendering code is loaded from `guides.show` and pinned to a specific build, so a file exported today keeps opening as-is.

## What is in the file

- The **guide**: title, intent, ordered sections with overviews and per-file summaries, unplaced files, and the reviewed checkboxes at export time.
- The **review**: the exact unified diff the guide was generated against (captured when the guide was generated, not when it was exported), its label, diff type, and base.
- The **source**: what the change is — local changes, a pull/merge request (with a link), a single commit, or a multi-repository workspace — plus repo, branch, and head SHA when known.
- **Provenance**: which agent and model generated the guide, when, and any custom instructions used.
- A **plain-text fallback**: the guide's text and file lists render even when `guides.show` is unreachable.

The file's size is roughly the size of the diff. There is no cap: a huge diff makes a large file, and that is your call.

## Producing one

- In Plannotator: open a guide and click **Download portable guide** (top right).
- From the terminal: `plannotator guide list`, then `plannotator guide export --id <id> [--out file.html]`.
- From anything else: write a snapshot document (below) and run `plannotator guide export --snapshot guide.json`. This is how an agent skill can produce a guide without the Plannotator app: generate the guide JSON, run `git diff` for the patch, wrap.

`PLANNOTATOR_GUIDE_VIEWER_URL` (or `--viewer-url`) points exports at a self-hosted or local viewer build; it must be `https:` (or `http://localhost`).

## Snapshot format (v1)

Strict JSON — unknown fields are rejected so a file is never silently misread.

```jsonc
{
  "kind": "plannotator-guided-review",
  "version": 1,
  "exportedAt": "2026-08-15T20:00:00.000Z",
  "guide": {
    "title": "…", "intent": "…",
    "sections": [{ "title": "…", "overview": "…markdown…", "diffs": [{ "file": "src/auth.ts", "summary": "…" }] }],
    "unplacedFiles": ["README.md"],
    "reviewed": [true, false]
  },
  "review": { "rawPatch": "diff --git a/… ", "gitRef": "origin/main..HEAD", "diffType": "since-base", "base": "origin/main" },
  "source": {
    "kind": "pr",                                   // local | pr | workspace | commit
    "repo": "owner/repo", "branch": "feat/x", "headSha": "…",
    "pr": { "url": "https://github.com/owner/repo/pull/1", "number": 1, "title": "…", "platform": "github" }
  },
  "generator": { "engine": "claude", "model": "sonnet", "generatedAt": "…", "customInstructions": "…" },
  "theme": { "palette": "plannotator" }
}
```

Every `diffs[].file` and `unplacedFiles[]` entry should name a file present in `rawPatch`; files that are not resolve to an "outdated" chip in the viewer rather than breaking it.

## guides.show

`guides.show/v1/…` hosts viewer builds. Files there are content-hashed and never changed or removed; each exported HTML names the exact `viewer.<hash>.js` and `.css` it was made with (with integrity hashes), and preloads only the syntax grammars its diff needs. Nothing about your guide is sent to `guides.show` — the page only fetches the viewer, fonts, and grammars.
