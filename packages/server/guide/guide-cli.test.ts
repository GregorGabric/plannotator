import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveGuide, saveGuidePatch, type SavedGuideEnvelope } from "@plannotator/shared/guide-store";
import { GUIDE_SNAPSHOT_SCRIPT_ID, parseGuideSnapshotJson } from "@plannotator/shared/guide-format";
import { FIXTURE_V1_PR } from "@plannotator/shared/guide-format-fixtures";
import { runGuideCli } from "./guide-cli";

const PATCH = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
const envelope = (overrides: Partial<SavedGuideEnvelope> = {}): SavedGuideEnvelope => ({
  version: 1,
  savedAt: 1000,
  label: "feature/x",
  title: "CLI guide",
  guide: { title: "CLI guide", intent: "i", sections: [{ title: "S", overview: "o", diffs: [{ file: "a.ts" }] }] },
  reviewed: [false],
  ...overrides,
});

let dataDir = "";
let workDir = "";
let previousDataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-guide-cli-data-"));
  workDir = mkdtempSync(join(tmpdir(), "plannotator-guide-cli-work-"));
  previousDataDir = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

const embeddedSnapshot = (html: string) => {
  const m = new RegExp(`<script id="${GUIDE_SNAPSHOT_SCRIPT_ID}" type="application/json">([\\s\\S]*?)</script>`).exec(html);
  const parsed = parseGuideSnapshotJson(m![1]);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

describe("plannotator guide", () => {
  test("usage errors exit 2 and print usage", () => {
    expect(runGuideCli([]).code).toBe(2);
    expect(runGuideCli(["export"]).code).toBe(2);
    expect(runGuideCli(["export", "--id", "x", "--snapshot", "y"]).code).toBe(2);
    expect(runGuideCli(["export", "--id"]).stderr).toContain("--id requires a value");
    expect(runGuideCli(["list", "--bogus"]).code).toBe(2);
    expect(runGuideCli(["nope"]).stderr).toContain("Usage:");
  });

  test("list shows every shelf and whether a guide is exportable", () => {
    saveGuidePatch("shelf-a", "1000-exportable", PATCH);
    saveGuide("shelf-a", "1000-exportable", envelope({ review: { gitRef: "HEAD", source: { kind: "local" }, patchFile: "1000-exportable.patch" } }));
    saveGuide("shelf-b", "2000-legacy", envelope({ title: "Legacy", savedAt: 2000 }));
    const res = runGuideCli(["list"]);
    expect(res.code).toBe(0);
    const lines = res.stdout!.split("\n");
    expect(lines[1]).toContain("2000-legacy");
    expect(lines[1]).toContain("no ");
    expect(lines[2]).toContain("1000-exportable");
    expect(lines[2]).toContain("yes");
    expect(runGuideCli(["list"], {}, workDir).stdout).not.toBe("No saved guides.\n");
    rmSync(dataDir, { recursive: true, force: true });
    expect(runGuideCli(["list"]).stdout).toBe("No saved guides.\n");
  });

  test("export --id writes the portable HTML next to cwd by default and pins the viewer", () => {
    saveGuidePatch("shelf-a", "1000-exportable", PATCH);
    saveGuide("shelf-a", "1000-exportable", envelope({ engine: "claude", review: { gitRef: "origin/main..HEAD", diffType: "since-base", source: { kind: "local", repo: "acme/x" }, patchFile: "1000-exportable.patch" } }));
    const res = runGuideCli(["export", "--id", "1000-exportable"], {}, workDir);
    expect(res.code).toBe(0);
    const out = join(workDir, "guided-review-cli-guide.html");
    expect(res.stdout).toBe(`${out}\n`);
    expect(existsSync(out)).toBe(true);
    const html = readFileSync(out, "utf-8");
    expect(html).toMatch(/src="https:\/\/guide\.show\/v1\/viewer\.[A-Za-z0-9_-]+\.js" integrity="sha384-/);
    const snap = embeddedSnapshot(html);
    expect(snap.review.rawPatch).toBe(PATCH);
    expect(snap.generator?.engine).toBe("claude");
    expect(snap.source).toEqual({ kind: "local", repo: "acme/x" });
  });

  test("export --id honours --out, --out - (stdout) and a viewer URL override", () => {
    saveGuidePatch("shelf-a", "1000-exportable", PATCH);
    saveGuide("shelf-a", "1000-exportable", envelope({ review: { gitRef: "HEAD", source: { kind: "local" }, patchFile: "1000-exportable.patch" } }));
    const toStdout = runGuideCli(["export", "--id", "1000-exportable", "--out", "-", "--viewer-url", "http://localhost:8787/v1/"], {}, workDir);
    expect(toStdout.code).toBe(0);
    expect(toStdout.stdout).toContain('src="http://localhost:8787/v1/viewer.');
    const env = { PLANNOTATOR_GUIDE_VIEWER_URL: "https://cdn.example.test/guides/" } as NodeJS.ProcessEnv;
    const toFile = runGuideCli(["export", "--id", "1000-exportable", "--out", "sub/out.html"], env, workDir);
    expect(toFile.code).toBe(1); // parent dir does not exist → write fails honestly
    expect(toFile.stderr).toContain("Could not write");
    const ok = runGuideCli(["export", "--id", "1000-exportable", "--out", "out.html"], env, workDir);
    expect(ok.code).toBe(0);
    expect(readFileSync(join(workDir, "out.html"), "utf-8")).toContain('src="https://cdn.example.test/guides/viewer.');
    // A non-https override is ignored, not embedded.
    const bad = runGuideCli(["export", "--id", "1000-exportable", "--out", "-", "--viewer-url", "javascript:alert(1)"], {}, workDir);
    expect(bad.stdout).toContain('src="https://guides.show/v1/viewer.');
  });

  test("export --id reports not-found and not-exportable distinctly (exit 1)", () => {
    saveGuide("shelf-b", "2000-legacy", envelope({ title: "Legacy" }));
    const missing = runGuideCli(["export", "--id", "3000-none"], {}, workDir);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("No saved guide");
    const legacy = runGuideCli(["export", "--id", "2000-legacy"], {}, workDir);
    expect(legacy.code).toBe(1);
    expect(legacy.stderr).toContain("not retained");
  });

  test("export --snapshot wraps an authored snapshot document, and rejects an invalid one", () => {
    const file = join(workDir, "snap.json");
    writeFileSync(file, JSON.stringify(FIXTURE_V1_PR));
    const res = runGuideCli(["export", "--snapshot", "snap.json", "--out", "-"], {}, workDir);
    expect(res.code).toBe(0);
    expect(embeddedSnapshot(res.stdout!).source.pr?.number).toBe(42);
    writeFileSync(file, JSON.stringify({ ...FIXTURE_V1_PR, extra: 1 }));
    const bad = runGuideCli(["export", "--snapshot", "snap.json"], {}, workDir);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("Invalid guide snapshot ($)");
    expect(runGuideCli(["export", "--snapshot", "missing.json"], {}, workDir).code).toBe(1);
  });
});
