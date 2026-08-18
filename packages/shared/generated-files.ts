/**
 * linguist-generated detection for code review (#1317).
 *
 * GitHub collapses diffs for files marked `linguist-generated` (or
 * `linguist-generated=true`) in `.gitattributes`. The review UI mirrors that:
 * the server resolves the attribute for the changed paths and ships the
 * generated set as a presentation-layer sidecar on the diff payload — the
 * diff data itself is never filtered.
 *
 * Resolution deliberately goes through git's own attribute machinery
 * (`git check-attr`) instead of a hand-rolled `.gitattributes` parser, so
 * stacked and negated rules (`-linguist-generated`, `linguist-generated=false`,
 * per-directory files, `$GIT_DIR/info/attributes`) behave exactly as git
 * resolves them. One `--stdin -z` invocation covers every path — never a
 * per-file subprocess.
 *
 * Best-effort by design: any failure (git missing, not a work tree, non-zero
 * exit, unparsable output) returns the empty set, which renders every file
 * expanded — the pre-#1317 behavior. Attributes are read from the working
 * tree at the review cwd, git's default resolution.
 *
 * Runtime-agnostic like review-core (Pi consumes a build-time copy via
 * vendor.sh).
 */

import type { ReviewGitRuntime } from "./review-core";

export const GENERATED_ATTRIBUTE = "linguist-generated";

/**
 * `git check-attr -z` emits NUL-separated triples: path, attribute name,
 * value. A bare `linguist-generated` reports `set`, `=true` reports `true`;
 * both mean generated. `unset` (negated with `-`), `false`, and
 * `unspecified` all mean not generated — matching linguist's own boolean
 * reading of the attribute.
 */
export function parseCheckAttrGenerated(stdout: string): string[] {
  const tokens = stdout.split("\0");
  const generated: string[] = [];
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    const [path, attribute, value] = [tokens[i], tokens[i + 1], tokens[i + 2]];
    if (attribute !== GENERATED_ATTRIBUTE) continue;
    if (value === "set" || value === "true") generated.push(path);
  }
  return generated;
}

/**
 * Resolve which of `paths` are marked generated, in one `git check-attr`
 * subprocess. Paths must be repo-relative (the forward-slash paths a parsed
 * unified diff yields). Returns the generated subset in input order
 * (deduplicated); empty on any failure.
 */
export async function detectGeneratedFiles(
  runtime: ReviewGitRuntime,
  cwd: string | undefined,
  paths: string[],
): Promise<string[]> {
  const unique = [...new Set(paths.filter((p) => p.length > 0))];
  if (unique.length === 0) return [];
  try {
    const result = await runtime.runGit(
      ["check-attr", "--stdin", "-z", GENERATED_ATTRIBUTE],
      {
        cwd,
        // NUL-terminated input pairs with -z output; paths with spaces,
        // quotes, or newlines round-trip without any quoting layer.
        stdin: unique.join("\0") + "\0",
        interaction: "forbid",
      },
    );
    if (result.exitCode !== 0 || result.truncated) return [];
    const generated = new Set(parseCheckAttrGenerated(result.stdout));
    // Report in input order so the sidecar is deterministic for a given diff.
    return unique.filter((p) => generated.has(p));
  } catch {
    return [];
  }
}
