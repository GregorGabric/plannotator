/**
 * Endpoint wiring for durable guide persistence (#1112), against BOTH server
 * runtimes (Bun packages/server/review.ts and the Pi mirror
 * apps/pi-extension/server/serverReview.ts):
 *
 *   GET    /api/guides                    — repo-scoped list
 *   GET    /api/guide/saved:{id}          — serve a persisted guide
 *   PUT    /api/guide/saved:{id}/reviewed — persist reviewed state
 *   DELETE /api/guides/:id                — remove a saved guide
 *
 * Both servers are started with no gitContext/PR, so the guide store derives
 * its repo key via the no-remote fallback (process.cwd()) — the tests seed the
 * store through @plannotator/shared/guide-store under that same key.
 *
 * Requires `bash apps/pi-extension/vendor.sh` to have been run (same as the
 * other cross-runtime tests).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeGuideOutput } from "@plannotator/shared/guide";
import {
  deriveGuideRepoKeyFallback,
  listGuides,
  loadGuide,
  saveGuide,
  saveGuidePatch,
  type SavedGuideEnvelope,
} from "@plannotator/shared/guide-store";
import { GUIDE_SNAPSHOT_SCRIPT_ID, parseGuideSnapshotJson } from "@plannotator/shared/guide-format";
import { startReviewServer as startBunReviewServer } from "./review";
import { startReviewServer as startPiReviewServer } from "../../apps/pi-extension/server";

const SPA_HTML = "<!doctype html><html><body>SPA fallback</body></html>";

const GUIDE: CodeGuideOutput = {
  title: "Persisted guide",
  intent: "Round-trips through the saved: endpoints.",
  sections: [
    { title: "Core", overview: "The heart.", diffs: [{ file: "a.ts" }] },
    { title: "Glue", overview: "Wiring.", diffs: [{ file: "b.ts" }] },
  ],
};

function envelope(overrides: Partial<SavedGuideEnvelope> = {}): SavedGuideEnvelope {
  return {
    version: 1,
    savedAt: 1000,
    label: "feature/x",
    title: GUIDE.title,
    guide: GUIDE,
    reviewed: [false, false],
    ...overrides,
  };
}

interface RunningServer {
  readonly url: string;
  stop(): void;
}

const serverCases = [
  {
    name: "Bun review",
    start: () =>
      startBunReviewServer({
        rawPatch: "",
        gitRef: "HEAD",
        origin: "claude-code",
        htmlContent: SPA_HTML,
      }),
  },
  {
    name: "Pi review",
    start: () =>
      startPiReviewServer({
        rawPatch: "",
        gitRef: "HEAD",
        origin: "pi",
        htmlContent: SPA_HTML,
      }),
  },
] as const;

let dataDir = "";
let previousDataDir: string | undefined;
let previousPort: string | undefined;
let previousRemote: string | undefined;
// Both servers run with no gitContext/PR/workspace, so the session's repo key
// is the fallback derivation over process.cwd().
const repoKey = deriveGuideRepoKeyFallback(process.cwd());

beforeAll(() => {
  previousPort = process.env.PLANNOTATOR_PORT;
  previousRemote = process.env.PLANNOTATOR_REMOTE;
  delete process.env.PLANNOTATOR_PORT;
  process.env.PLANNOTATOR_REMOTE = "0";
});

afterAll(() => {
  if (previousPort === undefined) delete process.env.PLANNOTATOR_PORT;
  else process.env.PLANNOTATOR_PORT = previousPort;
  if (previousRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
  else process.env.PLANNOTATOR_REMOTE = previousRemote;
});

// Fresh data dir per test so seeded guides never leak across cases.
function useTempDataDir() {
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-guide-endpoints-"));
  previousDataDir = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
}

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = previousDataDir;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = "";
});

for (const serverCase of serverCases) {
  describe(`${serverCase.name} guide persistence endpoints`, () => {
    test("lists, serves, updates reviewed (persisted across restart), and deletes saved guides", async () => {
      useTempDataDir();
      saveGuide(repoKey, "1000-persisted-guide", envelope());

      let server = await serverCase.start();
      try {
        // GET /api/guides — the seeded guide is listed with progress + moved.
        const listRes = await fetch(`${server.url}/api/guides`);
        expect(listRes.status).toBe(200);
        const list = await listRes.json() as Array<Record<string, unknown>>;
        expect(list.length).toBe(1);
        expect(list[0].id).toBe("1000-persisted-guide");
        expect(list[0].label).toBe("feature/x");
        expect(list[0].title).toBe(GUIDE.title);
        expect(list[0].progress).toEqual({ reviewed: 0, total: 2 });
        expect(list[0].moved).toBe(false); // no headSha stored → never flagged

        // GET /api/guide/saved:{id} — full guide + reviewed + saved/moved.
        const getRes = await fetch(`${server.url}/api/guide/saved:1000-persisted-guide`);
        expect(getRes.status).toBe(200);
        const data = await getRes.json() as Record<string, unknown>;
        expect(data.title).toBe(GUIDE.title);
        expect((data.sections as unknown[]).length).toBe(2);
        expect(data.reviewed).toEqual([false, false]);
        expect(data.saved).toBe(true);
        expect(data.moved).toBe(false);

        // Unknown saved id → 404.
        const missingRes = await fetch(`${server.url}/api/guide/saved:2000-missing`);
        expect(missingRes.status).toBe(404);

        // PUT /api/guide/saved:{id}/reviewed persists to disk.
        const putRes = await fetch(`${server.url}/api/guide/saved:1000-persisted-guide/reviewed`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reviewed: [true, false] }),
        });
        expect(putRes.status).toBe(200);
        expect(loadGuide(repoKey, "1000-persisted-guide")!.reviewed).toEqual([true, false]);
      } finally {
        server.stop();
      }

      // Server restart — the reviewed state survives on the new session.
      server = await serverCase.start();
      try {
        const data = await (await fetch(`${server.url}/api/guide/saved:1000-persisted-guide`)).json() as Record<string, unknown>;
        expect(data.reviewed).toEqual([true, false]);

        // DELETE /api/guides/:id removes it; a repeat delete 404s.
        const delRes = await fetch(`${server.url}/api/guides/1000-persisted-guide`, { method: "DELETE" });
        expect(delRes.status).toBe(200);
        expect(listGuides(repoKey).length).toBe(0);
        const delAgain = await fetch(`${server.url}/api/guides/1000-persisted-guide`, { method: "DELETE" });
        expect(delAgain.status).toBe(404);
        const listAfter = await (await fetch(`${server.url}/api/guides`)).json() as unknown[];
        expect(listAfter).toEqual([]);
      } finally {
        server.stop();
      }
    });

    test("exports a saved guide as portable HTML pinned to the viewer, and refuses one whose diff was not retained", async () => {
      useTempDataDir();
      const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
      // A guide saved WITH its launch review (patch beside the envelope).
      saveGuidePatch(repoKey, "1000-exportable", patch);
      saveGuide(repoKey, "1000-exportable", envelope({
        engine: "claude",
        model: "sonnet",
        generatedAt: 1234,
        customInstructions: "Focus on auth.",
        review: {
          gitRef: "origin/main..HEAD",
          diffType: "since-base",
          base: "origin/main",
          source: { kind: "local", repo: "acme/demo", branch: "feature/x" },
          patchFile: "1000-exportable.patch",
        },
      }));
      // A pre-portable guide: no review block, no patch → not exportable.
      saveGuide(repoKey, "1000-legacy", envelope({ title: "Legacy" }));

      const server = await serverCase.start();
      try {
        const info = await fetch(`${server.url}/api/guide/saved:1000-exportable/export-info`);
        expect(info.status).toBe(200);
        const infoBody = await info.json() as { bytes: number; filename: string; languages: string[] };
        expect(infoBody.filename).toBe("guided-review-persisted-guide.html");
        expect(infoBody.languages).toEqual(["typescript"]);
        expect(infoBody.bytes).toBeGreaterThan(1000);

        const res = await fetch(`${server.url}/api/guide/saved:1000-exportable/export`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/html");
        expect(res.headers.get("content-disposition")).toContain('filename="guided-review-persisted-guide.html"');
        const html = await res.text();
        // Pins the viewer this build ships (script + integrity) — never inlines it.
        expect(html).toMatch(/<script type="module" src="https:\/\/guides\.show\/v1\/viewer\.[A-Za-z0-9_-]+\.js" integrity="sha384-/);
        expect(html.length).toBeLessThan(20_000);
        // The embedded snapshot is exactly the saved guide + the retained diff + provenance.
        const embedded = new RegExp(`<script id="${GUIDE_SNAPSHOT_SCRIPT_ID}" type="application/json">([\\s\\S]*?)</script>`).exec(html)![1];
        const parsed = parseGuideSnapshotJson(embedded);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) {
          expect(parsed.value.review.rawPatch).toBe(patch);
          expect(parsed.value.review.gitRef).toBe("origin/main..HEAD");
          expect(parsed.value.source).toEqual({ kind: "local", repo: "acme/demo", branch: "feature/x" });
          expect(parsed.value.generator).toEqual({
            engine: "claude",
            model: "sonnet",
            generatedAt: new Date(1234).toISOString(),
            customInstructions: "Focus on auth.",
          });
          expect(parsed.value.guide.sections.length).toBe(2);
        }

        // Legacy envelope → 404 with the honest reason; unknown ids → 404.
        const legacy = await fetch(`${server.url}/api/guide/saved:1000-legacy/export`);
        expect(legacy.status).toBe(404);
        expect(((await legacy.json()) as { error: string }).error).toContain("not retained");
        expect((await fetch(`${server.url}/api/guide/saved:2000-nope/export-info`)).status).toBe(404);
        expect((await fetch(`${server.url}/api/guide/live-unknown/export`)).status).toBe(404);
      } finally {
        server.stop();
      }
    });

    test("traversal-shaped ids are rejected and corrupt files load as no guide", async () => {
      useTempDataDir();
      const server = await serverCase.start();
      try {
        // Traversal-shaped ids never reach the disk layer.
        const evil = await fetch(`${server.url}/api/guide/saved:..%2F..%2Fescape`);
        expect(evil.status).toBe(404);
        const evilDelete = await fetch(`${server.url}/api/guides/..%2Fescape`, { method: "DELETE" });
        expect(evilDelete.status).toBe(404);

        // A live (non-saved) job id still routes to the in-memory session.
        const live = await fetch(`${server.url}/api/guide/some-live-job-id`);
        expect(live.status).toBe(404);
        expect(await live.json()).toEqual({ error: "Guide not found" });
      } finally {
        server.stop();
      }
    });
  });
}
