/**
 * `plannotator guide <list|export>` — portable Guided Review exports from the
 * command line (decision record D9): the same pure export function the UI
 * uses, callable without a running review server. Three sources:
 *
 *   --id <savedGuideId>              a guide Plannotator saved (any repo shelf)
 *   --guide <guide.json> --patch <p> a guide authored elsewhere (an agent skill
 *                                    writes the guide, hands over the `git diff`;
 *                                    we validate the guide against the patch,
 *                                    infer provenance from git, and wrap it)
 *   --snapshot <file.json>           a complete snapshot document
 *
 * Kept free of process.exit / console so it is unit-testable; the CLI entry
 * prints `stdout`/`stderr` and exits with `code`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  buildGuideSnapshot,
  createGuideHtml,
  guideExportFilename,
  listGuidePatchFiles,
  parseGuideSnapshot,
  parseGuideSnapshotJson,
  resolveGuideViewerAssets,
  type GuideSnapshot,
  type GuideSnapshotGenerator,
  type GuideSnapshotSource,
} from "@plannotator/shared/guide-format";
import { GUIDE_VIEWER_MANIFEST } from "@plannotator/shared/guide-viewer-manifest";
import { buildSavedGuideSnapshot, findSavedGuideById, listAllSavedGuides } from "@plannotator/shared/guide-store";
import { parseRemoteUrl } from "@plannotator/shared/repo";
import { validateGuideOutput } from "./guide-review";

export interface GuideCliResult {
  code: 0 | 1 | 2;
  stdout?: string;
  stderr?: string;
}

export const GUIDE_CLI_USAGE = [
  "Usage:",
  "  plannotator guide list",
  "  plannotator guide export --id <savedGuideId> [--out <file.html> | --out -]",
  "  plannotator guide export --guide <guide.json> --patch <diff.patch | -> [--out <file.html> | --out -]",
  "  plannotator guide export --snapshot <snapshot.json> [--out <file.html> | --out -]",
  "",
  "Export a Guided Review as one portable HTML file (the viewer loads from guides.show).",
  "",
  "Options:",
  "  --id <id>          A guide Plannotator saved (see `plannotator guide list`)",
  "  --guide <file>     A guide you wrote: { title, intent, sections[{ title, overview, diffs[{ file, summary }] }],",
  "                     unplacedFiles?, review?{ gitRef, base }, source?, generator? }. Validated against --patch;",
  "                     every file in the guide must appear in the patch. Provenance (repo, branch, head) is read",
  "                     from git in the current directory unless `source` says otherwise.",
  "  --patch <file>     The unified diff the guide describes (`git diff <base>...HEAD > guide.patch`); `-` reads stdin",
  "  --snapshot <file>  A complete portable guide snapshot document (JSON) to wrap as HTML",
  "  --out <file>       Where to write the HTML (default: ./guided-review-<slug>.html); `-` writes to stdout",
  "  --viewer-url <u>   Viewer base URL override (default https://guides.show/v1/; also PLANNOTATOR_GUIDE_VIEWER_URL)",
  "",
  "Exit codes: 0 exported · 1 not found / not exportable / invalid guide or snapshot · 2 usage",
].join("\n");

function takeOption(args: string[], name: string): { value?: string; rest: string[] } | { error: string } {
  const i = args.indexOf(name);
  if (i < 0) return { rest: args };
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) return { error: `${name} requires a value` };
  return { value, rest: [...args.slice(0, i), ...args.slice(i + 2)] };
}

export function runGuideList(): GuideCliResult {
  const guides = listAllSavedGuides();
  if (guides.length === 0) return { code: 0, stdout: "No saved guides.\n" };
  const rows = guides.map(({ repoKey, id, envelope }) => ({
    id,
    when: new Date(envelope.savedAt).toISOString().replace("T", " ").slice(0, 16),
    exportable: envelope.review ? "yes" : "no ",
    label: envelope.label,
    title: envelope.title,
    repo: repoKey,
  }));
  const idW = Math.max(2, ...rows.map((r) => r.id.length));
  const labelW = Math.min(24, Math.max(5, ...rows.map((r) => r.label.length)));
  const lines = [
    `${"ID".padEnd(idW)}  ${"SAVED".padEnd(16)}  EXPORT  ${"LABEL".padEnd(labelW)}  TITLE`,
    ...rows.map((r) => `${r.id.padEnd(idW)}  ${r.when.padEnd(16)}  ${r.exportable}     ${r.label.slice(0, labelW).padEnd(labelW)}  ${r.title}`),
    "",
    "EXPORT=no: the guide predates portable exports (its diff was not retained).",
  ];
  return { code: 0, stdout: lines.join("\n") + "\n" };
}


function git(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort provenance for an authored guide: repo from origin (or the directory name), branch, head. */
export function inferGuideSource(cwd: string): GuideSnapshotSource {
  const remote = git(["remote", "get-url", "origin"], cwd);
  const repo = (remote && parseRemoteUrl(remote)) || basename(cwd);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const headSha = git(["rev-parse", "HEAD"], cwd);
  return {
    kind: "local",
    repo,
    ...(branch && branch !== "HEAD" && { branch }),
    ...(headSha && { headSha }),
  };
}

interface AuthoredGuideOptions {
  readonly cwd: string;
  readonly stdin?: string;
  /** Injected for deterministic tests. */
  readonly now?: string;
  readonly source?: GuideSnapshotSource;
}

/**
 * Turn an authored guide (`--guide`) plus its patch (`--patch`) into a
 * snapshot. Strict where the in-app validator is lenient: a file the guide
 * names that is not in the patch is an error naming the file and the files
 * that ARE in the patch, so the author can fix the guide instead of silently
 * losing a chapter. Files the guide leaves out land in "Everything else".
 */
export function buildAuthoredGuideSnapshot(
  guideJson: string,
  rawPatch: string,
  opts: AuthoredGuideOptions,
): { ok: true; snapshot: GuideSnapshot } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(guideJson);
  } catch (e) {
    return { ok: false, error: `Guide file is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Guide file must be a JSON object." };
  const g = raw as Record<string, unknown>;

  const patchFiles = listGuidePatchFiles(rawPatch).map((f) => f.path);
  if (patchFiles.length === 0) return { ok: false, error: "The patch contains no file diffs. Expected unified diff output, e.g. `git diff <base>...HEAD`." };

  const problems: string[] = [];
  if (typeof g.title !== "string" || g.title.trim() === "") problems.push("`title` must be a non-empty string.");
  if (typeof g.intent !== "string" || g.intent.trim() === "") problems.push("`intent` must be a non-empty string.");
  if (!Array.isArray(g.sections) || g.sections.length === 0) {
    problems.push("`sections` must be a non-empty array.");
  } else {
    const patchSet = new Set(patchFiles);
    const seen = new Map<string, number>();
    const unknown = new Set<string>();
    g.sections.forEach((section, i) => {
      if (!section || typeof section !== "object") { problems.push(`sections[${i}] must be an object.`); return; }
      const sec = section as Record<string, unknown>;
      if (typeof sec.title !== "string" || sec.title.trim() === "") problems.push(`sections[${i}].title must be a non-empty string.`);
      if (typeof sec.overview !== "string" || sec.overview.trim() === "") problems.push(`sections[${i}].overview must be a non-empty string.`);
      if (sec.diffs !== undefined && !Array.isArray(sec.diffs)) { problems.push(`sections[${i}].diffs must be an array of { file, summary }.`); return; }
      for (const [j, ref] of ((sec.diffs as unknown[] | undefined) ?? []).entries()) {
        const r = (ref && typeof ref === "object" ? ref : {}) as Record<string, unknown>;
        if (typeof r.file !== "string" || r.file === "") { problems.push(`sections[${i}].diffs[${j}].file must be a path from the patch.`); continue; }
        if (typeof r.summary !== "string") problems.push(`sections[${i}].diffs[${j}].summary must be a string.`);
        if (!patchSet.has(r.file)) unknown.add(r.file);
        const first = seen.get(r.file);
        if (first !== undefined) problems.push(`${r.file} is placed twice (sections[${first}] and sections[${i}]); a file belongs to one section.`);
        else seen.set(r.file, i);
      }
    });
    if (unknown.size > 0) {
      problems.push(
        `These files are not in the patch: ${[...unknown].join(", ")}.\nFiles in the patch:\n  ${patchFiles.join("\n  ")}`,
      );
    }
    if (g.unplacedFiles !== undefined) {
      if (!Array.isArray(g.unplacedFiles) || g.unplacedFiles.some((f) => typeof f !== "string")) problems.push("`unplacedFiles` must be an array of paths.");
      else {
        const bad = (g.unplacedFiles as string[]).filter((f) => !patchSet.has(f));
        if (bad.length > 0) problems.push(`unplacedFiles not in the patch: ${bad.join(", ")}.`);
      }
    }
  }
  if (problems.length > 0) return { ok: false, error: `Guide is not valid:\n- ${problems.join("\n- ")}` };

  const validated = validateGuideOutput(
    { title: g.title, intent: g.intent, sections: g.sections, unplacedFiles: g.unplacedFiles },
    patchFiles,
  );
  if ("error" in validated) return { ok: false, error: `Guide is not valid: ${validated.error}` };

  const review = (g.review && typeof g.review === "object" ? g.review : {}) as Record<string, unknown>;
  const gitRef = typeof review.gitRef === "string" && review.gitRef.trim() ? review.gitRef.trim() : "HEAD";
  const base = typeof review.base === "string" && review.base.trim() ? review.base.trim() : undefined;
  const source = { ...(opts.source ?? inferGuideSource(opts.cwd)), ...((g.source as Partial<GuideSnapshotSource> | undefined) ?? {}) } as GuideSnapshotSource;
  const generator: GuideSnapshotGenerator = {
    generatedAt: opts.now ?? new Date().toISOString(),
    ...((g.generator as GuideSnapshotGenerator | undefined) ?? {}),
  };

  const snapshot = buildGuideSnapshot({
    guide: validated.guide,
    reviewed: [],
    review: { rawPatch, gitRef, ...(base && { base }), source },
    generator,
    exportedAt: opts.now,
  });
  // The strict format parser is the authority on user-supplied `source` /
  // `generator` / `review` shapes — round-trip so a bad field fails here, not
  // in someone's browser.
  const parsed = parseGuideSnapshot(JSON.parse(JSON.stringify(snapshot)));
  if (!parsed.ok) return { ok: false, error: `Guide is not valid (${parsed.error.path}): ${parsed.error.message}` };
  return { ok: true, snapshot: parsed.value };
}

export function runGuideExport(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), io: { stdin?: () => string; now?: string } = {}): GuideCliResult {
  const idOpt = takeOption(argv, "--id");
  if ("error" in idOpt) return { code: 2, stderr: `${idOpt.error}\n\n${GUIDE_CLI_USAGE}\n` };
  const snapOpt = takeOption(idOpt.rest, "--snapshot");
  if ("error" in snapOpt) return { code: 2, stderr: `${snapOpt.error}\n\n${GUIDE_CLI_USAGE}\n` };
  const guideOpt = takeOption(snapOpt.rest, "--guide");
  if ("error" in guideOpt) return { code: 2, stderr: `${guideOpt.error}\n\n${GUIDE_CLI_USAGE}\n` };
  const patchOpt = takeOption(guideOpt.rest, "--patch");
  if ("error" in patchOpt) return { code: 2, stderr: `${patchOpt.error}\n\n${GUIDE_CLI_USAGE}\n` };
  const outOpt = takeOption(patchOpt.rest, "--out");
  if ("error" in outOpt) return { code: 2, stderr: `${outOpt.error}\n\n${GUIDE_CLI_USAGE}\n` };
  const viewerOpt = takeOption(outOpt.rest, "--viewer-url");
  if ("error" in viewerOpt) return { code: 2, stderr: `${viewerOpt.error}\n\n${GUIDE_CLI_USAGE}\n` };
  if (viewerOpt.rest.length > 0) return { code: 2, stderr: `Unknown argument: ${viewerOpt.rest[0]}\n\n${GUIDE_CLI_USAGE}\n` };
  if ((idOpt.value ? 1 : 0) + (snapOpt.value ? 1 : 0) + (guideOpt.value ? 1 : 0) !== 1) {
    return { code: 2, stderr: `Provide exactly one of --id, --guide (with --patch), or --snapshot.\n\n${GUIDE_CLI_USAGE}\n` };
  }
  if ((guideOpt.value === undefined) !== (patchOpt.value === undefined)) {
    return { code: 2, stderr: `--guide and --patch go together.\n\n${GUIDE_CLI_USAGE}\n` };
  }

  let snapshot: GuideSnapshot;
  if (idOpt.value) {
    const found = findSavedGuideById(idOpt.value);
    if (!found) return { code: 1, stderr: `No saved guide with id ${idOpt.value}. Run \`plannotator guide list\`.\n` };
    const built = buildSavedGuideSnapshot(found.repoKey, found.envelope);
    if (!built) return { code: 1, stderr: `Guide ${idOpt.value} cannot be exported: its diff was not retained (it predates portable exports).\n` };
    snapshot = built;
  } else if (guideOpt.value) {
    const guideFile = resolve(cwd, guideOpt.value);
    if (!existsSync(guideFile)) return { code: 1, stderr: `Guide file not found: ${guideFile}\n` };
    let rawPatch: string;
    if (patchOpt.value === "-") {
      rawPatch = io.stdin ? io.stdin() : readFileSync(0, "utf-8");
    } else {
      const patchFile = resolve(cwd, patchOpt.value!);
      if (!existsSync(patchFile)) return { code: 1, stderr: `Patch file not found: ${patchFile}\n` };
      rawPatch = readFileSync(patchFile, "utf-8");
    }
    const built = buildAuthoredGuideSnapshot(readFileSync(guideFile, "utf-8"), rawPatch, { cwd, now: io.now });
    if (!built.ok) return { code: 1, stderr: `${built.error}\n` };
    snapshot = built.snapshot;
  } else {
    const file = resolve(cwd, snapOpt.value!);
    if (!existsSync(file)) return { code: 1, stderr: `Snapshot file not found: ${file}\n` };
    const parsed = parseGuideSnapshotJson(readFileSync(file, "utf-8"));
    if (!parsed.ok) return { code: 1, stderr: `Invalid guide snapshot (${parsed.error.path}): ${parsed.error.message}\n` };
    snapshot = parsed.value;
  }

  const viewer = resolveGuideViewerAssets(GUIDE_VIEWER_MANIFEST, { baseUrl: viewerOpt.value ?? env.PLANNOTATOR_GUIDE_VIEWER_URL });
  const html = createGuideHtml(snapshot, { viewer });
  if (outOpt.value === "-") return { code: 0, stdout: html };
  const outPath = resolve(cwd, outOpt.value ?? guideExportFilename(snapshot.guide.title));
  try {
    writeFileSync(outPath, html, "utf-8");
  } catch (e) {
    return { code: 1, stderr: `Could not write ${outPath}: ${e instanceof Error ? e.message : String(e)}\n` };
  }
  return { code: 0, stdout: `${outPath}\n`, stderr: `Exported ${snapshot.guide.title} (${(Buffer.byteLength(html, "utf8") / 1024).toFixed(0)} KB)\n` };
}

export function runGuideCli(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), io: { stdin?: () => string; now?: string } = {}): GuideCliResult {
  const [sub, ...rest] = argv;
  if (sub === "list") {
    if (rest.length > 0) return { code: 2, stderr: `Unknown argument: ${rest[0]}\n\n${GUIDE_CLI_USAGE}\n` };
    return runGuideList();
  }
  if (sub === "export") return runGuideExport(rest, env, cwd, io);
  return { code: 2, stderr: `${GUIDE_CLI_USAGE}\n` };
}
