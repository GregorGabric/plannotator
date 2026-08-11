import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCallFlowSnapshotPlan } from "./call-flow";

let repo = "";

function run(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "plannotator-call-flow-test-"));
  run(["init", "-q"]);
  run(["config", "user.name", "Test"]);
  run(["config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "main.ts"), "export function main() { return 1; }\n");
  run(["add", "main.ts"]);
  run(["commit", "-qm", "initial"]);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("createCallFlowSnapshotPlan", () => {
  test("materializes an uncommitted patch as an immutable commit without changing the source repo", async () => {
    writeFileSync(join(repo, "main.ts"), "export function helper() { return 2; }\nexport function main() { return helper(); }\n");
    const patch = run(["diff", "--binary", "--full-index"]);
    const sourceHead = run(["rev-parse", "HEAD"]);
    const plan = await createCallFlowSnapshotPlan({ snapshotId: "s", cwd: repo, diffType: "uncommitted", base: "main", rawPatch: patch, vcsType: "git" });
    try {
      expect(plan.from).toBe(sourceHead);
      expect(Bun.spawnSync(["git", "show", `${plan.to}:main.ts`], { cwd: plan.cwd }).stdout.toString()).toContain("helper()");
      expect(run(["rev-parse", "HEAD"])).toBe(sourceHead);
      expect(run(["status", "--short"])).toBe("M main.ts");
    } finally {
      plan.cleanup();
    }
  });

  test("uses the index snapshot as the left side of an unstaged review", async () => {
    writeFileSync(join(repo, "main.ts"), "export function staged() { return 2; }\n");
    run(["add", "main.ts"]);
    writeFileSync(join(repo, "main.ts"), "export function staged() { return 2; }\nexport function unstaged() { return 3; }\n");
    const patch = run(["diff", "--binary", "--full-index"]);
    const plan = await createCallFlowSnapshotPlan({ snapshotId: "s", cwd: repo, diffType: "unstaged", base: "main", rawPatch: patch, vcsType: "git" });
    try {
      const before = Bun.spawnSync(["git", "show", `${plan.from}:main.ts`], { cwd: plan.cwd }).stdout.toString();
      const after = Bun.spawnSync(["git", "show", `${plan.to}:main.ts`], { cwd: plan.cwd }).stdout.toString();
      expect(before).toContain("staged");
      expect(before).not.toContain("unstaged");
      expect(after).toContain("unstaged");
    } finally {
      plan.cleanup();
    }
  });
});
