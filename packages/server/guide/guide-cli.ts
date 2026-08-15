/**
 * `plannotator guide <list|export>` — portable Guided Review exports from the
 * command line (decision record D9): the same pure export function the UI
 * uses, callable without a running review server. Two sources:
 *
 *   --id <savedGuideId>      a guide Plannotator saved (any repo shelf)
 *   --snapshot <file.json>   a snapshot document authored elsewhere (agent
 *                            skills wrap their own guide + `git diff` this way)
 *
 * Kept free of process.exit / console so it is unit-testable; the CLI entry
 * prints `stdout`/`stderr` and exits with `code`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createGuideHtml,
  guideExportFilename,
  parseGuideSnapshotJson,
  resolveGuideViewerAssets,
  type GuideSnapshot,
} from "@plannotator/shared/guide-format";
import { GUIDE_VIEWER_MANIFEST } from "@plannotator/shared/guide-viewer-manifest";
import { buildSavedGuideSnapshot, findSavedGuideById, listAllSavedGuides } from "@plannotator/shared/guide-store";

export interface GuideCliResult {
  code: 0 | 1 | 2;
  stdout?: string;
  stderr?: string;
}

export const GUIDE_CLI_USAGE = [
  "Usage:",
  "  plannotator guide list",
  "  plannotator guide export --id <savedGuideId> [--out <file.html> | --out -]",
  "  plannotator guide export --snapshot <snapshot.json> [--out <file.html> | --out -]",
  "",
  "Export a Guided Review as one portable HTML file (the viewer loads from guide.show).",
  "",
  "Options:",
  "  --id <id>          A guide Plannotator saved (see `plannotator guide list`)",
  "  --snapshot <file>  A portable guide snapshot document (JSON) to wrap as HTML",
  "  --out <file>       Where to write the HTML (default: ./guided-review-<slug>.html); `-` writes to stdout",
  "  --viewer-url <u>   Viewer base URL override (default https://guide.show/v1/; also PLANNOTATOR_GUIDE_VIEWER_URL)",
  "",
  "Exit codes: 0 exported · 1 not found / not exportable / invalid snapshot · 2 usage",
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

export function runGuideExport(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): GuideCliResult {
  const idOpt = takeOption(argv, "--id");
  if ("error" in idOpt) return { code: 2, stderr: `${idOpt.error}\n\n${GUIDE_CLI_USAGE}\n` };
  const snapOpt = takeOption(idOpt.rest, "--snapshot");
  if ("error" in snapOpt) return { code: 2, stderr: `${snapOpt.error}\n\n${GUIDE_CLI_USAGE}\n` };
  const outOpt = takeOption(snapOpt.rest, "--out");
  if ("error" in outOpt) return { code: 2, stderr: `${outOpt.error}\n\n${GUIDE_CLI_USAGE}\n` };
  const viewerOpt = takeOption(outOpt.rest, "--viewer-url");
  if ("error" in viewerOpt) return { code: 2, stderr: `${viewerOpt.error}\n\n${GUIDE_CLI_USAGE}\n` };
  if (viewerOpt.rest.length > 0) return { code: 2, stderr: `Unknown argument: ${viewerOpt.rest[0]}\n\n${GUIDE_CLI_USAGE}\n` };
  if ((idOpt.value ? 1 : 0) + (snapOpt.value ? 1 : 0) !== 1) {
    return { code: 2, stderr: `Provide exactly one of --id or --snapshot.\n\n${GUIDE_CLI_USAGE}\n` };
  }

  let snapshot: GuideSnapshot;
  if (idOpt.value) {
    const found = findSavedGuideById(idOpt.value);
    if (!found) return { code: 1, stderr: `No saved guide with id ${idOpt.value}. Run \`plannotator guide list\`.\n` };
    const built = buildSavedGuideSnapshot(found.repoKey, found.envelope);
    if (!built) return { code: 1, stderr: `Guide ${idOpt.value} cannot be exported: its diff was not retained (it predates portable exports).\n` };
    snapshot = built;
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

export function runGuideCli(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): GuideCliResult {
  const [sub, ...rest] = argv;
  if (sub === "list") {
    if (rest.length > 0) return { code: 2, stderr: `Unknown argument: ${rest[0]}\n\n${GUIDE_CLI_USAGE}\n` };
    return runGuideList();
  }
  if (sub === "export") return runGuideExport(rest, env, cwd);
  return { code: 2, stderr: `${GUIDE_CLI_USAGE}\n` };
}
