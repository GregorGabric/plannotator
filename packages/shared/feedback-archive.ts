/**
 * Feedback Archive — durable local storage of every submitted review.
 *
 * Plannotator's decision paths hand the user's feedback to the invoking agent
 * and then forget it: code review persisted nothing at all, plan decisions
 * only landed in `plans/` while the client-side planSave setting was on (and
 * overwrote the previous decision for the same slug), and the annotate
 * surfaces only kept the #678 record for single local files. This module is
 * the one place all of those write a durable, analyzable record of what the
 * user actually submitted.
 *
 * Layout (per project, mirroring the `history/` project convention):
 *
 *   {DATA_DIR}/feedback/{project}/index.jsonl      append-only, authoritative
 *   {DATA_DIR}/feedback/{project}/records/…​.md      human-readable sidecar
 *
 * The JSONL line is self-contained: an analyzer never has to open a sidecar.
 * The sidecar exists because everything else in the data dir is markdown and
 * users grep it; it is written only for records that carry content (a bare
 * approval or a dismissal is a decision-only line).
 *
 * Contract, shared with `persistAnnotateSubmission` (#678):
 *  - This module NEVER throws. Any failure is logged once and reported as
 *    `null`, so a full disk can never turn a reviewer's submit into a 500.
 *  - Callers append BEFORE deleting the reviewer's draft: a failed archive
 *    write leaves the draft behind as the recovery copy.
 *  - The data directory is resolved PER CALL (not captured at module load
 *    like storage.ts does), so a test can redirect PLANNOTATOR_DATA_DIR
 *    inside the test body — Bun runs every test file in one process, and a
 *    module-load capture cannot be redirected without import-order games.
 *
 * Runtime-agnostic: node:fs / node:path only, so Pi vendors it unmodified.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { getPlannotatorDataDir } from "./data-dir";
import { extractDirName, extractRepoName, sanitizeTag } from "./project";

/** Schema version carried on every line. Bump only on a breaking shape change. */
export const FEEDBACK_RECORD_VERSION = 1;

/** Tool that authored the record. See the interop note in the design doc: a
 *  client tool MAY emit this same line shape under its own `clients/` namespace
 *  and the records merge cleanly (sort by `ts`, filter by `client`). */
export const FEEDBACK_RECORD_CLIENT = "plannotator";

export type FeedbackSurface =
  | "plan"
  | "review"
  | "annotate"
  | "annotate-url"
  | "annotate-app"
  | "annotate-last"
  | "annotate-folder";

export type FeedbackDecision =
  | "approved"
  | "approved-with-notes"
  | "denied"
  | "feedback"
  | "lgtm"
  | "dismissed";

/** Identity of the reviewed changeset. Deliberately NOT the patch bytes: the
 *  refs plus the snapshot id are enough to regenerate the diff from the repo,
 *  and guide history already showed what uncapped patch copies cost on disk. */
export interface FeedbackReviewTarget {
  vcsType?: string;
  diffType?: string;
  base?: string;
  gitRef?: string;
  snapshotId?: string;
  cwd?: string;
  pr?: { provider: string; repo: string; number: number };
  changedFiles?: number;
  patchBytes?: number;
}

export interface FeedbackTarget {
  /** Plan history slug (plan surface). */
  slug?: string;
  /** Plan history version this decision was made on. */
  planVersion?: number;
  /** Absolute path of `history/{project}/{slug}/NNN.md` — join the record to
   *  the exact plan text without duplicating it into the archive. */
  planVersionFile?: string;
  /** Annotated file (single-file and folder annotate sessions). */
  filePath?: string;
  /** Annotated URL (URL sessions) or the live app's target URL. */
  url?: string;
  review?: FeedbackReviewTarget;
}

/** One submitted annotation, shallow-normalized. Unknown shapes never throw:
 *  anything unrecognized is simply absent from the record. */
export interface FeedbackAnnotationRecord {
  id?: string;
  type?: string;
  text?: string;
  originalText?: string;
  file?: string;
  lineStart?: number;
  lineEnd?: number;
  side?: string;
  blockId?: string;
  diffContext?: string;
  severity?: string;
  inReplyTo?: string;
  /** External tool identifier ("eslint", "browser-agent", a review job).
   *  Absent means the human wrote it — that is the "my own comments" filter. */
  source?: string;
  author?: string;
  images?: number;
}

export interface FeedbackRecord {
  v: number;
  ts: string;
  client: string;
  project: string;
  origin?: string;
  surface: FeedbackSurface;
  decision: FeedbackDecision;
  target?: FeedbackTarget;
  feedback?: string;
  annotations?: FeedbackAnnotationRecord[];
  counts: { annotations: number; external: number; images: number };
  /** Sidecar path relative to the project directory. Absent on decision-only lines. */
  recordFile?: string;
}

export interface FeedbackArchiveInput {
  /** Project namespace, same convention as `history/{project}`. */
  project: string;
  origin?: string;
  surface: FeedbackSurface;
  decision: FeedbackDecision;
  target?: FeedbackTarget;
  /** Exported human-readable feedback (byte-identical to what the agent got). */
  feedback?: unknown;
  /** Raw annotations array from the submit body. */
  annotations?: unknown;
  /** Injected by tests to force the failure branch. */
  now?: Date;
}

/**
 * Derive the archive's project segment.
 *
 * `history/` keys by whatever `detectProjectName()` returned (already
 * sanitizeTag'd) or the literal `_unknown`, and the archive matches it so both
 * stores bucket the same session identically. Every other value is
 * sanitizeTag'd, which is also what keeps a caller-derived name (the review
 * server reads it off the repo path) from ever escaping the archive directory.
 */
export function normalizeFeedbackProject(project: string | null | undefined): string {
  if (!project) return "_unknown";
  if (project === "_unknown") return project;
  return sanitizeTag(project) ?? "_unknown";
}

/**
 * Best-effort project name for a server that has a working directory but no
 * detected project (the review server). Mirrors `detectProjectName`'s fallback
 * chain without shelling out to git: the review cwd is already the repo root
 * for every local VCS provider.
 */
export function deriveFeedbackProject(cwd: string | undefined): string {
  if (!cwd) return "_unknown";
  return extractDirName(cwd) ?? extractRepoName(cwd) ?? "_unknown";
}

function feedbackProjectDir(project: string): string {
  return join(getPlannotatorDataDir(), "feedback", normalizeFeedbackProject(project));
}

/** Filesystem-safe ISO stamp, same convention as `saveAnnotateSubmission`. */
function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Shallow-normalize one submitted annotation.
 *
 * Markdown annotations (plan/annotate) and code annotations (review) are
 * different shapes; both are read leniently and the union of their known
 * fields is recorded. Provenance (`source`, `author`) is always preserved:
 * external, WebMCP, and agent-sourced annotations belong in the record —
 * the submitted feedback text already embeds them — but must stay
 * distinguishable from what the human wrote.
 */
function normalizeAnnotation(raw: unknown): FeedbackAnnotationRecord {
  if (typeof raw !== "object" || raw === null) return {};
  const a = raw as Record<string, unknown>;
  const record: FeedbackAnnotationRecord = {};
  const id = asString(a.id);
  if (id) record.id = id;
  const type = asString(a.type);
  if (type) record.type = type;
  const text = asString(a.text);
  if (text) record.text = text;
  const originalText = asString(a.originalText) ?? asString(a.selectedText) ?? asString(a.tokenText);
  if (originalText) record.originalText = originalText;
  const file = asString(a.filePath) ?? asString(a.file);
  if (file) record.file = file;
  const lineStart = asNumber(a.lineStart);
  if (lineStart !== undefined) record.lineStart = lineStart;
  const lineEnd = asNumber(a.lineEnd);
  if (lineEnd !== undefined) record.lineEnd = lineEnd;
  const side = asString(a.side);
  if (side) record.side = side;
  const blockId = asString(a.blockId);
  if (blockId) record.blockId = blockId;
  const diffContext = asString(a.diffContext);
  if (diffContext) record.diffContext = diffContext;
  const severity = asString(a.severity);
  if (severity) record.severity = severity;
  const inReplyTo = asString(a.inReplyTo);
  if (inReplyTo) record.inReplyTo = inReplyTo;
  const source = asString(a.source);
  if (source) record.source = source;
  const author = asString(a.author);
  if (author) record.author = author;
  if (Array.isArray(a.images) && a.images.length > 0) record.images = a.images.length;
  return record;
}

const SURFACE_TITLES: Record<FeedbackSurface, string> = {
  plan: "Plan review feedback",
  review: "Code review feedback",
  annotate: "Annotate feedback",
  "annotate-url": "Annotate feedback (URL)",
  "annotate-app": "Annotate feedback (live app)",
  "annotate-last": "Annotate feedback (agent message)",
  "annotate-folder": "Annotate feedback (folder)",
};

/**
 * Render the human-readable sidecar: a short metadata header plus the exact
 * feedback text the agent received.
 */
export function renderFeedbackRecordMarkdown(record: FeedbackRecord): string {
  const lines: string[] = [`# ${SURFACE_TITLES[record.surface] ?? "Feedback"}`, ""];
  lines.push(`- Submitted: ${record.ts}`);
  lines.push(`- Surface: ${record.surface}`);
  lines.push(`- Decision: ${record.decision}`);
  lines.push(`- Project: ${record.project}`);
  if (record.origin) lines.push(`- Origin: ${record.origin}`);
  const target = record.target;
  if (target?.filePath) lines.push(`- File: ${target.filePath}`);
  if (target?.url) lines.push(`- URL: ${target.url}`);
  if (target?.slug) {
    lines.push(
      `- Plan: ${target.slug}${target.planVersion ? ` (version ${target.planVersion})` : ""}`,
    );
  }
  if (target?.planVersionFile) lines.push(`- Plan version file: ${target.planVersionFile}`);
  const review = target?.review;
  if (review) {
    const bits = [review.diffType, review.base ? `base ${review.base}` : null, review.gitRef ? `ref ${review.gitRef}` : null]
      .filter(Boolean)
      .join(", ");
    if (bits) lines.push(`- Diff: ${bits}`);
    if (review.cwd) lines.push(`- Repository: ${review.cwd}`);
    if (review.pr) lines.push(`- Pull request: ${review.pr.provider} ${review.pr.repo}#${review.pr.number}`);
  }
  lines.push(
    `- Annotations: ${record.counts.annotations}${record.counts.external > 0 ? ` (${record.counts.external} external)` : ""}`,
  );
  lines.push("", "---", "");
  lines.push(record.feedback && record.feedback.trim() ? record.feedback : "_No feedback text submitted._");
  lines.push("");
  return lines.join("\n");
}

/**
 * Append one submitted-feedback record to the archive.
 *
 * Returns the path of the index file that was appended to, or `null` when
 * nothing durable was written (the caller then keeps the reviewer's draft).
 * Never throws.
 *
 * The sidecar is written before the index line even though the index is the
 * authoritative store: it is created with the exclusive `wx` flag (retrying
 * with a collision counter), so a record file can never be overwritten and an
 * index line can never name a file that does not exist. An orphan sidecar
 * after a failed append is harmless; a dangling reference would not be.
 */
export function appendFeedbackRecord(input: FeedbackArchiveInput): string | null {
  try {
    const now = input.now ?? new Date();
    const project = normalizeFeedbackProject(input.project);
    const feedback = typeof input.feedback === "string" ? input.feedback : "";
    const rawAnnotations = Array.isArray(input.annotations) ? input.annotations : [];
    const annotations = rawAnnotations.map(normalizeAnnotation);
    const counts = {
      annotations: annotations.length,
      external: annotations.filter((a) => a.source !== undefined).length,
      images: annotations.reduce((sum, a) => sum + (a.images ?? 0), 0),
    };
    const hasContent = feedback.trim().length > 0 || annotations.length > 0;

    const record: FeedbackRecord = {
      v: FEEDBACK_RECORD_VERSION,
      ts: now.toISOString(),
      client: FEEDBACK_RECORD_CLIENT,
      project,
      ...(input.origin ? { origin: input.origin } : {}),
      surface: input.surface,
      decision: input.decision,
      ...(input.target ? { target: input.target } : {}),
      ...(feedback ? { feedback } : {}),
      ...(annotations.length > 0 ? { annotations } : {}),
      counts,
    };

    const projectDir = feedbackProjectDir(project);
    mkdirSync(projectDir, { recursive: true });

    if (hasContent) {
      const recordsDir = join(projectDir, "records");
      mkdirSync(recordsDir, { recursive: true });
      const base = `${stamp(now)}-${input.surface}-${input.decision}`;
      let name = `${base}.md`;
      const body = renderFeedbackRecordMarkdown(record);
      for (let n = 2; ; n++) {
        try {
          writeFileSync(join(recordsDir, name), body, { encoding: "utf-8", flag: "wx" });
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== "EEXIST" || n > 100) throw err;
          name = `${base}-${n}.md`;
        }
      }
      record.recordFile = `records/${name}`;
      // The sidecar body names the record's own metadata, not its filename, so
      // no rewrite is needed once the final name is known.
    }

    const indexPath = join(projectDir, "index.jsonl");
    // JSON.stringify can never emit a raw newline, so one record is always one
    // line: a torn append degrades to a single unparsable line, never a
    // corrupted store, and readers skip it.
    appendFileSync(indexPath, `${JSON.stringify(record)}\n`, "utf-8");
    return indexPath;
  } catch (error) {
    console.error(
      `[plannotator] warning: could not archive submitted feedback (${error instanceof Error ? error.message : String(error)}); keeping the annotation draft as the recovery copy`,
    );
    return null;
  }
}

/**
 * Read a project's archive, skipping unparsable lines.
 *
 * The read path in v1 is "the files on disk" (jq/grep); this helper exists so
 * the servers' own tests and any future in-process reader agree on the
 * torn-line tolerance the append contract promises. Never throws.
 */
export function parseFeedbackIndex(contents: string): FeedbackRecord[] {
  const records: FeedbackRecord[] = [];
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as FeedbackRecord;
      if (parsed && typeof parsed === "object" && typeof parsed.v === "number") records.push(parsed);
    } catch {
      // Torn last line from a concurrent append — skip it, keep the rest.
    }
  }
  return records;
}

/** Absolute path of a project's archive index (for callers that report it). */
export function feedbackIndexPath(project: string): string {
  return join(feedbackProjectDir(project), "index.jsonl");
}
