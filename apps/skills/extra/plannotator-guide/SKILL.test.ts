/**
 * The skill's worked example must stay a valid input for the CLI it tells the
 * agent to run — if the flags or the guide.json shape change, this is what
 * catches the skill drifting from the binary.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GUIDE_CLI_USAGE, buildAuthoredGuideSnapshot } from "../../../../packages/server/guide/guide-cli";

const skill = readFileSync(join(import.meta.dir, "SKILL.md"), "utf-8");

function fence(lang: string, containing: string): string {
  const re = new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g");
  for (const m of skill.matchAll(re)) if (m[1].includes(containing)) return m[1];
  throw new Error(`no ${lang} fence containing ${containing}`);
}

describe("plannotator-guide skill", () => {
  test("the example guide.json is accepted by the CLI, and every path it names is a patch file", () => {
    const example = fence("json", '"sections"');
    const guide = JSON.parse(example) as { sections: Array<{ diffs: Array<{ file: string }> }> };
    const files = guide.sections.flatMap((s) => s.diffs.map((d) => d.file));
    const patch = files.map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-a\n+b\n`).join("");
    const built = buildAuthoredGuideSnapshot(example, patch, { cwd: import.meta.dir, now: "2026-01-01T00:00:00.000Z", source: { kind: "local", repo: "x" } });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.snapshot.guide.unplacedFiles ?? []).toEqual([]);
    expect(built.snapshot.review.gitRef).toBe("origin/main...HEAD");
  });

  test("the export command the skill gives uses flags the CLI documents", () => {
    const command = fence("bash", "plannotator guide export").trim();
    for (const flag of command.match(/--[a-z-]+/g) ?? []) expect(GUIDE_CLI_USAGE).toContain(flag);
    expect(command).toContain("--guide guide.json --patch guide.patch");
  });
});
