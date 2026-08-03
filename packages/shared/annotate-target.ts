/**
 * Tolerant annotate target selection (#1182).
 *
 * Slash-command hosts forward raw user arguments to `plannotator annotate`
 * verbatim. On Claude Code the skill runs the CLI through a bash-substitution
 * prefix that executes before the model sees anything, so trailing natural
 * language ("/plannotator-annotate the aim doc") lands in the argument slot
 * and used to die with `File not found: the`.
 *
 * This module implements the shared three-tier fallback that every host hooks
 * into at its existing "nothing found" terminal (the first resolution pass is
 * always the host's unchanged pipeline):
 *
 *   1. Fast path: probe each whitespace-delimited token; if exactly one names
 *      an existing file, URL, or folder, proceed with it directly.
 *   2. Ambiguity: two or more tokens resolve; error naming every candidate,
 *      never guess.
 *   3. Handoff: nothing resolves; emit a message that echoes the words tried
 *      and (for CLI surfaces whose output lands in an agent's context) asks
 *      the agent to interpret the request and re-run with a concrete target.
 *
 * Selection and message building are pure; the token probe touches the
 * filesystem via the same primitives the host pipelines use, so a token that
 * probes true resolves on the re-run.
 */

import { existsSync, statSync } from "node:fs";
import { resolveAtReference, stripAtPrefix } from "./at-reference";
import { resolveMarkdownFile, resolveUserPath } from "./resolve-file";

export interface AnnotateTokenCandidate {
  /** The whitespace-delimited token the user typed. */
  token: string;
  /**
   * What the token resolved to: an absolute path for folders, HTML files and
   * document matches, the token itself for URLs and ambiguous document names.
   * Feeding this back into the host pipeline on a single match keeps hosts
   * without fuzzy resolution (Pi) consistent with the probe's answer.
   */
  value: string;
}

export type AnnotateTokenSelection =
  | { kind: "single"; candidate: AnnotateTokenCandidate }
  | { kind: "multiple"; candidates: AnnotateTokenCandidate[] }
  | { kind: "none"; words: string[] };

export type AnnotateTokenProbe = (token: string) => string | null;

/**
 * Would `plannotator annotate <token>` reach a specific verdict on this
 * token: open it, or fail with a target-specific error ("Ambiguous
 * filename", "File type not supported", "File too large", empty folder)?
 *
 * Mirrors the CLI resolution branch order: URL, folder, HTML file, then
 * document resolution (strip-first with the literal-`@` fallback for
 * scoped-package-style names), then bare existence (existing-but-unsupported
 * targets belong to the pipeline so its specific errors keep surfacing
 * verbatim). Returns the value to feed the pipeline, or null. An ambiguous
 * document name returns the stripped token so that a sole-candidate run
 * surfaces the existing "Ambiguous filename" error instead of guessing.
 *
 * Cheap for natural-language words: without an annotatable extension the
 * document resolver returns before walking the project, and the remaining
 * checks are single stat calls.
 */
export function probeAnnotateToken(
  token: string,
  projectRoot: string,
): string | null {
  if (!token) return null;

  if (/^https?:\/\//i.test(token)) return token;

  const folder = resolveAtReference(token, (candidate) => {
    try {
      return statSync(resolveUserPath(candidate, projectRoot)).isDirectory();
    } catch {
      return false;
    }
  });
  if (folder !== null) return resolveUserPath(folder, projectRoot);

  const html = resolveAtReference(token, (candidate) => {
    const abs = resolveUserPath(candidate, projectRoot);
    return /\.html?$/i.test(abs) && existsSync(abs);
  });
  if (html !== null) return resolveUserPath(html, projectRoot);

  const stripped = stripAtPrefix(token);
  let doc = resolveMarkdownFile(stripped, projectRoot);
  if (doc.kind === "not_found" && stripped !== token) {
    doc = resolveMarkdownFile(token, projectRoot);
  }
  if (doc.kind === "found") return doc.path;
  if (doc.kind === "ambiguous") return stripped;

  const literal = resolveAtReference(token, (candidate) =>
    existsSync(resolveUserPath(candidate, projectRoot)),
  );
  if (literal !== null) return resolveUserPath(literal, projectRoot);

  return null;
}

/**
 * Does the whole input name something that the annotate pipeline would reach
 * a specific verdict on? Used by hosts that run the token fallback as a
 * pre-pass: when this is true the unchanged pipeline runs and produces
 * exactly today's behavior.
 */
export function annotateInputNamesExistingTarget(
  input: string,
  projectRoot: string,
): boolean {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return false;
  return probeAnnotateToken(trimmed, projectRoot) !== null;
}

/**
 * Tier 1/2/3 selection over the whitespace-delimited tokens of the raw
 * argument string. Tokens starting with `-` are treated as flags, never as
 * target candidates; duplicate tokens are probed once.
 */
export function selectAnnotateTokenTarget(
  rawInput: string,
  probe: AnnotateTokenProbe,
): AnnotateTokenSelection {
  const tokens = (rawInput ?? "").trim().split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  const words: string[] = [];
  const candidates: AnnotateTokenCandidate[] = [];

  for (const token of tokens) {
    if (token.startsWith("-")) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    words.push(token);
    const value = probe(token);
    if (value !== null) candidates.push({ token, value });
  }

  if (candidates.length === 1) {
    return { kind: "single", candidate: candidates[0] };
  }
  if (candidates.length > 1) {
    return { kind: "multiple", candidates };
  }
  return { kind: "none", words };
}

export const ANNOTATE_USAGE_TARGET =
  "<file.md | file.txt | file.html | https://... | folder/>";

/**
 * Tier-2 error: several tokens each name an existing target. Never guess;
 * name every candidate so the caller can re-run with exactly one.
 */
export function buildAmbiguousAnnotateArgsMessage(
  candidates: AnnotateTokenCandidate[],
): string {
  return [
    `Ambiguous annotate arguments: ${candidates.length} of them each resolve to an existing target.`,
    ...candidates.map((candidate) => `  ${candidate.token} -> ${candidate.value}`),
    `Re-run with exactly one target: plannotator annotate ${ANNOTATE_USAGE_TARGET}`,
  ].join("\n");
}

/**
 * Tier-3 message: nothing in the arguments names an existing target. Echoes
 * the words tried and, when `agentHandoff` is set (CLI surfaces whose output
 * lands in an agent's context), asks the reading agent to interpret the
 * request and re-run with a concrete target, preserving the given flags.
 */
export function buildUnresolvedAnnotateArgsMessage(options: {
  words: string[];
  flags?: string[];
  agentHandoff?: boolean;
}): string {
  const { words, flags = [], agentHandoff = false } = options;
  const flagSuffix = flags.length > 0 ? ` ${flags.join(" ")}` : "";
  const lines = [
    "Could not resolve the arguments below to a file, URL, or folder; nothing in them matches an existing path:",
    "",
    `  ${words.join(" ")}`,
    "",
    `The annotate command needs a concrete target: plannotator annotate ${ANNOTATE_USAGE_TARGET}${flagSuffix}`,
  ];
  if (agentHandoff) {
    lines.push(
      "",
      "If you are an agent reading this: the arguments look like a natural-language description of what to annotate. Work out from the conversation which file, URL, or folder the user means, then run the command yourself with that concrete target:",
      "",
      `  plannotator annotate <path-or-url>${flagSuffix}`,
    );
  }
  return lines.join("\n");
}
