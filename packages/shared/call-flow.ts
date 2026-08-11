/**
 * Isolated CallDiff execution and exact Git snapshot materialization.
 *
 * CallDiff is a Node-native, synchronous Tree-sitter library. Plannotator runs
 * it in a short-lived Node 22 worker and never imports it into Bun or Pi.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { getPlannotatorDataDir } from "./data-dir";
import { indexCallFlowImpacts, parseCallDiffWorkerResult } from "./call-flow-types";
import type {
  CallFlowAdvert,
  CallFlowResponse,
  ParsedCallDiffWorkerResult,
} from "./call-flow-types";
import { parseCommitDiffType, parseWorktreeDiffType } from "./review-core";

export const CALLDIFF_VERSION = "0.4.1";
export const CALLDIFF_COMMIT = "a3194d20ca91ef6a314273d634e9b9c0db1c2707";
export const CALLDIFF_SOURCE_SPEC = `https://github.com/tanishqkancharla/calldiff/archive/${CALLDIFF_COMMIT}.tar.gz`;
export const CALLDIFF_SOURCE_INTEGRITY = "sha512-5y6tjre5UE00qPrVFPurnk9RBdk8WlRok+0w41lxLt1MyPLOlNUEaAT2/j/nz2xWlhDm3DfDYvW/5KBD2b9TLg==";
export const CALLDIFF_TREE_SITTER_VERSION = "0.25.1";

/** Exact grammar set validated against CallDiff 0.4.1. */
export const CALLDIFF_GRAMMAR_SPECS = [
  "tree-sitter-javascript@0.25.0",
  "tree-sitter-typescript@0.23.2",
  "tree-sitter-python@0.25.0",
  "tree-sitter-go@0.25.0",
  "tree-sitter-rust@0.24.0",
  "tree-sitter-java@0.23.5",
  "tree-sitter-ruby@0.23.1",
  "tree-sitter-c@0.24.1",
  "tree-sitter-cpp@0.23.4",
  "tree-sitter-c-sharp@0.23.1",
  "tree-sitter-php@0.24.2",
  "tree-sitter-kotlin@0.3.8",
  "tree-sitter-swift@0.7.1",
  "tree-sitter-scala@0.24.0",
  "@tree-sitter-grammars/tree-sitter-lua@0.2.0",
  "tree-sitter-elixir@0.3.5",
  "tree-sitter-bash@0.25.1",
  "tree-sitter-haskell@0.23.1",
  "@tree-sitter-grammars/tree-sitter-zig@1.1.2",
  "tree-sitter-solidity@1.2.13",
  "tree-sitter-ocaml@0.24.2",
] as const;

function packageNameFromSpec(spec: string): string {
  if (spec.startsWith("@")) {
    const separator = spec.indexOf("@", 1);
    return separator === -1 ? spec : spec.slice(0, separator);
  }
  return spec.slice(0, spec.lastIndexOf("@"));
}

const REQUIRED_GRAMMAR_PACKAGES = CALLDIFF_GRAMMAR_SPECS.map(packageNameFromSpec);

const WORKER_TIMEOUT_MS = 45_000;
const GIT_TIMEOUT_MS = 20_000;
const MAX_PROCESS_OUTPUT_BYTES = 12 * 1024 * 1024;

export interface CallFlowAnalysisInput {
  snapshotId: string;
  cwd: string;
  diffType: string;
  base: string;
  rawPatch: string;
  vcsType?: string;
  /** Exact hosted-PR object pair, used only with a checkout that contains both. */
  prCommitPair?: { from: string; to: string };
}

export type CallFlowRuntime = {
  nodePath: string;
  packageEntry: string;
  runtimeDir: string;
  version: string;
};

export type CallFlowRuntimeResolution =
  | { ok: true; runtime: CallFlowRuntime }
  | { ok: false; reason: string; message: string };

export type CallFlowRuntimeInstallResult =
  | { ok: true; status: "installed" | "already-installed" | "skipped"; runtimeDir: string; message: string }
  | { ok: false; status: "failed"; runtimeDir: string; message: string };

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  aborted: boolean;
}

interface SnapshotPlan {
  cwd: string;
  from: string;
  to: string;
  cleanup: () => void;
}

const WORKER_SOURCE = String.raw`
import { pathToFileURL } from "node:url";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const diagnostics = [];
const originalError = console.error;
console.error = (...values) => {
  diagnostics.push({ level: "warning", message: values.map(String).join(" ") });
};
try {
  const moduleUrl = pathToFileURL(request.packageEntry).href;
  const mod = await import(moduleUrl);
  if (typeof mod.runDiff !== "function") throw new Error("CallDiff does not export runDiff().");
  const result = mod.runDiff({
    cwd: request.cwd,
    from: request.from,
    to: request.to,
    maxDepth: request.maxDepth,
    color: false,
    locs: true,
  });
  process.stdout.write(JSON.stringify({ protocol: 1, ok: true, version: request.version, result, diagnostics }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify({ protocol: 1, ok: false, message, diagnostics }));
  process.exitCode = 1;
} finally {
  console.error = originalError;
}
`;

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

export function getCallFlowManagedRuntimeDir(dataDir = getPlannotatorDataDir()): string {
  return join(dataDir, "vendor", "call-flow", `calldiff-${CALLDIFF_VERSION}`);
}

function readPackageVersion(packageRoot: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function resolvePackageEntry(packageRoot: string): string | null {
  const entry = join(packageRoot, "dist", "index.js");
  return existsSync(entry) ? entry : null;
}

function readRuntimeLock(runtimeDir: string): {
  sourceIntegrity: string | null;
  rootDependencies: Record<string, string>;
} | null {
  try {
    const lock = JSON.parse(readFileSync(join(runtimeDir, "package-lock.json"), "utf8")) as {
      packages?: Record<string, { integrity?: unknown; dependencies?: unknown }>;
    };
    const integrity = lock.packages?.["node_modules/calldiff"]?.integrity;
    const dependencies = lock.packages?.[""]?.dependencies;
    return {
      sourceIntegrity: typeof integrity === "string" ? integrity : null,
      rootDependencies: dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)
        ? dependencies as Record<string, string>
        : {},
    };
  } catch {
    return null;
  }
}

function hasPinnedRuntimeDependencies(rootDependencies: Record<string, string>): boolean {
  if (rootDependencies.calldiff !== CALLDIFF_SOURCE_SPEC) return false;
  if (rootDependencies["tree-sitter"] !== CALLDIFF_TREE_SITTER_VERSION) return false;
  return CALLDIFF_GRAMMAR_SPECS.every((spec) => {
    const packageName = packageNameFromSpec(spec);
    return rootDependencies[packageName] === spec.slice(packageName.length + 1);
  });
}

async function checkNode22(nodePath: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await runCommand(nodePath, ["--version"], { timeoutMs: 3_000 });
  const match = /^v(\d+)/.exec(result.stdout.trim());
  if (result.exitCode !== 0 || !match) return { ok: false, message: "Node.js could not be started." };
  if (Number(match[1]) < 22) return { ok: false, message: `Node.js 22 or newer is required (found ${result.stdout.trim()}).` };
  return { ok: true };
}

function findExecutable(name: string): string | null {
  const pathValue = process.env.PATH;
  if (!pathValue) return null;
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const directory of pathValue.split(process.platform === "win32" ? ";" : ":")) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function missingGrammarPackages(runtimeDir: string): string[] {
  return REQUIRED_GRAMMAR_PACKAGES.filter((name) => !existsSync(join(runtimeDir, "node_modules", ...name.split("/"))));
}

/** Resolve a complete, offline-safe CallDiff runtime without executing analysis. */
export async function resolveCallFlowRuntime(): Promise<CallFlowRuntimeResolution> {
  const nodePath = findExecutable("node");
  if (!nodePath) return { ok: false, reason: "node-unavailable", message: "Call flow requires Node.js 22 or newer." };
  const nodeCheck = await checkNode22(nodePath);
  if (!nodeCheck.ok) return { ok: false, reason: "node-version", message: nodeCheck.message };

  const override = process.env.PLANNOTATOR_CALLDIFF_PATH?.trim();
  const runtimeDir = override ? resolve(override) : getCallFlowManagedRuntimeDir();
  const packageRoot = override ? runtimeDir : join(runtimeDir, "node_modules", "calldiff");
  const version = readPackageVersion(packageRoot);
  const packageEntry = resolvePackageEntry(packageRoot);
  if (!version || !packageEntry) {
    return {
      ok: false,
      reason: "runtime-unavailable",
      message: override
        ? `PLANNOTATOR_CALLDIFF_PATH does not contain a built CallDiff package: ${runtimeDir}`
        : "Call flow runtime is not installed. Run plannotator install-runtime call-flow or reinstall Plannotator.",
    };
  }
  if (version !== CALLDIFF_VERSION) {
    return { ok: false, reason: "version-mismatch", message: `CallDiff ${version} is installed; Plannotator requires ${CALLDIFF_VERSION}.` };
  }
  if (!override) {
    const revisionPath = join(runtimeDir, ".calldiff-revision");
    const installedRevision = existsSync(revisionPath) ? readFileSync(revisionPath, "utf8").trim() : "";
    if (installedRevision !== CALLDIFF_COMMIT) {
      return { ok: false, reason: "revision-mismatch", message: "The CallDiff runtime is stale. Re-run plannotator install-runtime call-flow." };
    }
    const runtimeLock = readRuntimeLock(runtimeDir);
    if (runtimeLock?.sourceIntegrity !== CALLDIFF_SOURCE_INTEGRITY) {
      return { ok: false, reason: "integrity-mismatch", message: "The CallDiff runtime failed its pinned source-integrity check. Re-run plannotator install-runtime call-flow." };
    }
    if (!hasPinnedRuntimeDependencies(runtimeLock.rootDependencies)) {
      return { ok: false, reason: "runtime-lock-mismatch", message: "The CallDiff runtime dependency lock is stale. Re-run plannotator install-runtime call-flow." };
    }
  }
  const missing = missingGrammarPackages(runtimeDir);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: "grammars-incomplete",
      message: `Call flow runtime is missing ${missing.length} pinned grammar package${missing.length === 1 ? "" : "s"}. Re-run plannotator install-runtime call-flow.`,
    };
  }
  return { ok: true, runtime: { nodePath, packageEntry, runtimeDir, version } };
}

function writeRuntimePackageJson(runtimeDir: string): void {
  const dependencies: Record<string, string> = {
    calldiff: CALLDIFF_SOURCE_SPEC,
    // CallDiff declares ranges for its parser and TypeScript grammar. Pin both
    // at the host boundary so a reinstall cannot silently change the ABI.
    "tree-sitter": CALLDIFF_TREE_SITTER_VERSION,
    // CallDiff's pinned source archive intentionally has no built dist/.
    // Keep the compiler exact and build once at install time.
    typescript: "5.9.2",
    "@types/node": "24.2.0",
  };
  for (const spec of CALLDIFF_GRAMMAR_SPECS) {
    const packageName = packageNameFromSpec(spec);
    dependencies[packageName] = spec.slice(packageName.length + 1);
  }
  writeFileSync(join(runtimeDir, "package.json"), JSON.stringify({
    name: "plannotator-call-flow-runtime",
    private: true,
    description: "Managed offline runtime for Plannotator call-flow analysis",
    dependencies,
    overrides: { "tree-sitter-typescript": { "tree-sitter": "$tree-sitter" } },
  }, null, 2) + "\n", "utf8");
}

export async function installCallFlowRuntime(): Promise<CallFlowRuntimeInstallResult> {
  const runtimeDir = getCallFlowManagedRuntimeDir();
  if (isTruthy(process.env.PLANNOTATOR_SKIP_CALLDIFF_INSTALL)) {
    return { ok: true, status: "skipped", runtimeDir, message: "Skipping call-flow runtime install (PLANNOTATOR_SKIP_CALLDIFF_INSTALL is set)." };
  }
  const nodePath = findExecutable("node");
  const npmPath = findExecutable("npm");
  if (!nodePath || !npmPath) {
    return { ok: false, status: "failed", runtimeDir, message: "Call-flow runtime requires Node.js 22+ and npm." };
  }
  const nodeCheck = await checkNode22(nodePath);
  if (!nodeCheck.ok) return { ok: false, status: "failed", runtimeDir, message: nodeCheck.message };
  mkdirSync(runtimeDir, { recursive: true });
  writeRuntimePackageJson(runtimeDir);

  const existing = await resolveCallFlowRuntime();
  if (existing.ok && existing.runtime.runtimeDir === runtimeDir) {
    return { ok: true, status: "already-installed", runtimeDir, message: `Call-flow runtime already installed at ${runtimeDir}.` };
  }

  const install = await runCommand(npmPath, [
    "install", "--omit=dev", "--no-audit", "--no-fund", "--legacy-peer-deps",
  ], { cwd: runtimeDir, timeoutMs: 240_000, maxOutputBytes: 4 * 1024 * 1024 });
  if (install.exitCode !== 0) {
    const detail = install.stderr.trim() || install.stdout.trim() || "npm install failed";
    return { ok: false, status: "failed", runtimeDir, message: detail.slice(0, 2_000) };
  }
  const packageRoot = join(runtimeDir, "node_modules", "calldiff");
  const tscPath = process.platform === "win32"
    ? join(runtimeDir, "node_modules", ".bin", "tsc.cmd")
    : join(runtimeDir, "node_modules", ".bin", "tsc");
  const build = await runCommand(tscPath, ["-p", "tsconfig.json"], {
    cwd: packageRoot,
    timeoutMs: 120_000,
    maxOutputBytes: 4 * 1024 * 1024,
  });
  if (build.exitCode !== 0) {
    const detail = build.stderr.trim() || build.stdout.trim() || "CallDiff TypeScript build failed";
    return { ok: false, status: "failed", runtimeDir, message: detail.slice(0, 2_000) };
  }
  writeFileSync(join(runtimeDir, ".calldiff-revision"), `${CALLDIFF_COMMIT}\n`, "utf8");
  const resolved = await resolveCallFlowRuntime();
  if (!resolved.ok) return { ok: false, status: "failed", runtimeDir, message: resolved.message };
  return { ok: true, status: "installed", runtimeDir, message: `Installed CallDiff ${CALLDIFF_VERSION} and pinned grammars at ${runtimeDir}.` };
}

async function runCommand(
  executable: string,
  args: readonly string[],
  options: { cwd?: string; input?: string; timeoutMs?: number; maxOutputBytes?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<CommandResult> {
  const maxOutputBytes = options.maxOutputBytes ?? MAX_PROCESS_OUTPUT_BYTES;
  return await new Promise((resolvePromise) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let outputLimitExceeded = false;
    let aborted = false;
    const kill = (): void => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* process already exited */ }
      }
    };
    const append = (current: string, currentBytes: number, chunk: Buffer): { value: string; bytes: number } => {
      if (stdoutBytes + stderrBytes + chunk.length > maxOutputBytes) {
        outputLimitExceeded = true;
        kill();
        return { value: current, bytes: currentBytes };
      }
      return { value: current + chunk.toString("utf8"), bytes: currentBytes + chunk.length };
    };
    child.stdout.on("data", (chunk: Buffer) => {
      const next = append(stdout, stdoutBytes, chunk);
      stdout = next.value;
      stdoutBytes = next.bytes;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const next = append(stderr, stderrBytes, chunk);
      stderr = next.value;
      stderrBytes = next.bytes;
    });
    child.on("error", (error) => {
      const next = append(stderr, stderrBytes, Buffer.from(error.message));
      stderr = next.value;
      stderrBytes = next.bytes;
    });
    // A killed process or failed spawn can reject stdin while the child error
    // is already being handled above. Do not let that secondary EPIPE escape.
    child.stdin.on("error", () => {});
    const abort = (): void => {
      aborted = true;
      kill();
    };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs) : null;
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolvePromise({
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
        timedOut,
        outputLimitExceeded,
        aborted,
      });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

async function git(cwd: string, args: readonly string[], input?: string): Promise<string> {
  const result = await runCommand("git", args, { cwd, input, timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: 8 * 1024 * 1024 });
  if (result.exitCode !== 0) {
    throw new Error((result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed`).slice(0, 2_000));
  }
  return result.stdout.trim();
}

async function resolveCommit(cwd: string, ref: string): Promise<string> {
  return git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
}

async function firstParent(cwd: string, ref: string): Promise<string> {
  try {
    return await resolveCommit(cwd, `${ref}^`);
  } catch {
    throw new Error("Call flow is unavailable for a root commit because CallDiff requires two commit snapshots.");
  }
}

async function commitIndex(cwd: string, parent: string, message: string): Promise<string> {
  const tree = await git(cwd, ["write-tree"]);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Plannotator",
    GIT_AUTHOR_EMAIL: "call-flow@plannotator.invalid",
    GIT_COMMITTER_NAME: "Plannotator",
    GIT_COMMITTER_EMAIL: "call-flow@plannotator.invalid",
  };
  const result = await runCommand("git", ["commit-tree", tree, "-p", parent, "-m", message], {
    cwd,
    env,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "git commit-tree failed");
  return result.stdout.trim();
}

async function applyPatchToIndex(cwd: string, patch: string): Promise<void> {
  if (!patch.trim()) return;
  const normalizedPatch = patch.endsWith("\n") ? patch : `${patch}\n`;
  await git(cwd, ["apply", "--cached", "--binary", "--recount", "--whitespace=nowarn", "-"], normalizedPatch);
}

async function createSyntheticPlan(
  sourceCwd: string,
  baseCommit: string,
  patches: readonly string[],
): Promise<SnapshotPlan> {
  const tempRoot = await mkdtemp(join(tmpdir(), "plannotator-call-flow-"));
  const cloneCwd = join(tempRoot, "repo");
  const cleanup = () => rmSync(tempRoot, { recursive: true, force: true });
  try {
    await git(sourceCwd, ["clone", "--shared", "--no-checkout", "--quiet", "--", sourceCwd, cloneCwd]);
    await git(cloneCwd, ["read-tree", baseCommit]);
    let parent = baseCommit;
    const commits: string[] = [];
    for (let index = 0; index < patches.length; index += 1) {
      await applyPatchToIndex(cloneCwd, patches[index]);
      parent = await commitIndex(cloneCwd, parent, `Plannotator call-flow snapshot ${index + 1}`);
      commits.push(parent);
    }
    return {
      cwd: cloneCwd,
      from: commits.length > 1 ? commits[commits.length - 2] : baseCommit,
      to: commits[commits.length - 1] ?? baseCommit,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Map the visible review mode to the exact two immutable commits CallDiff needs. */
export async function createCallFlowSnapshotPlan(input: CallFlowAnalysisInput): Promise<SnapshotPlan> {
  if (input.vcsType && input.vcsType !== "git") {
    throw new Error(`Call flow does not yet support ${input.vcsType} reviews.`);
  }
  if (input.prCommitPair) {
    return {
      cwd: input.cwd,
      from: await resolveCommit(input.cwd, input.prCommitPair.from),
      to: await resolveCommit(input.cwd, input.prCommitPair.to),
      cleanup: () => {},
    };
  }

  const worktree = parseWorktreeDiffType(input.diffType);
  const cwd = worktree?.path ?? input.cwd;
  const diffType = worktree?.subType ?? input.diffType;
  const commit = parseCommitDiffType(diffType);
  if (commit) {
    const to = await resolveCommit(cwd, commit.sha);
    return { cwd, from: await firstParent(cwd, to), to, cleanup: () => {} };
  }

  if (diffType === "last-commit") {
    const to = await resolveCommit(cwd, "HEAD");
    return { cwd, from: await firstParent(cwd, to), to, cleanup: () => {} };
  }
  if (diffType === "branch") {
    return { cwd, from: await resolveCommit(cwd, input.base), to: await resolveCommit(cwd, "HEAD"), cleanup: () => {} };
  }
  if (diffType === "merge-base") {
    const from = await git(cwd, ["merge-base", "--", input.base, "HEAD"]);
    return { cwd, from, to: await resolveCommit(cwd, "HEAD"), cleanup: () => {} };
  }
  if (diffType === "all") {
    throw new Error("Call flow is unavailable for the All Files snapshot because it has no commit baseline.");
  }
  if (diffType === "since-base") {
    const mergeBase = await git(cwd, ["merge-base", "--", input.base, "HEAD"]);
    return createSyntheticPlan(cwd, mergeBase, [input.rawPatch]);
  }
  if (diffType === "uncommitted" || diffType === "staged") {
    return createSyntheticPlan(cwd, await resolveCommit(cwd, "HEAD"), [input.rawPatch]);
  }
  if (diffType === "unstaged") {
    const stagedPatch = await git(cwd, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff"]);
    return createSyntheticPlan(cwd, await resolveCommit(cwd, "HEAD"), [stagedPatch, input.rawPatch]);
  }
  throw new Error(`Call flow does not yet support the ${diffType} review mode.`);
}

async function executeWorker(runtime: CallFlowRuntime, plan: SnapshotPlan, signal: AbortSignal): Promise<ParsedCallDiffWorkerResult> {
  const request = JSON.stringify({
    packageEntry: runtime.packageEntry,
    version: runtime.version,
    cwd: plan.cwd,
    from: plan.from,
    to: plan.to,
    maxDepth: 10,
  });
  const result = await runCommand(runtime.nodePath, [
    "--max-old-space-size=512",
    "--input-type=module",
    "--eval",
    WORKER_SOURCE,
  ], {
    cwd: runtime.runtimeDir,
    input: request,
    timeoutMs: WORKER_TIMEOUT_MS,
    signal,
    env: {
      ...process.env,
      CALLDIFF_GRAMMAR_CACHE: runtime.runtimeDir,
      npm_config_offline: "true",
      NPM_CONFIG_OFFLINE: "true",
    },
  });
  if (result.aborted) throw new Error("Call-flow analysis was superseded by a newer review snapshot.");
  if (result.timedOut) throw new Error("CallDiff exceeded the 45 second analysis limit.");
  if (result.outputLimitExceeded) throw new Error("CallDiff result exceeded Plannotator's 12 MB output limit.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error((result.stderr.trim() || "CallDiff worker returned invalid JSON.").slice(0, 2_000));
  }
  return parseCallDiffWorkerResult(parsed);
}

/** Session-local cache + single execution slot for a review server. */
export class CallFlowService {
  private readonly cache = new Map<string, Extract<CallFlowResponse, { status: "ok" }>>();
  private readonly failureCache = new Map<string, { expiresAt: number; response: CallFlowResponse }>();
  private readonly inFlight = new Map<string, Promise<CallFlowResponse>>();
  private readonly controllers = new Map<string, AbortController>();
  private queue: Promise<void> = Promise.resolve();

  private analysisKey(input: CallFlowAnalysisInput): string {
    const pair = input.prCommitPair ? `${input.prCommitPair.from}:${input.prCommitPair.to}` : "";
    return [input.snapshotId, input.cwd, input.diffType, input.base, pair].join("\0");
  }

  async getAdvert(enabled: boolean, input?: Pick<CallFlowAnalysisInput, "vcsType" | "diffType">): Promise<CallFlowAdvert> {
    if (!enabled) return { enabled: false, available: false, state: "disabled", provider: "calldiff" };
    if (input?.vcsType && input.vcsType !== "git") {
      return { enabled: true, available: false, state: "unsupported", provider: "calldiff", reason: "vcs-unsupported", message: `Call flow does not yet support ${input.vcsType} reviews.` };
    }
    const effective = parseWorktreeDiffType(input?.diffType ?? "")?.subType ?? input?.diffType;
    if (effective === "all" || effective?.startsWith("jj-") || effective?.startsWith("gitbutler:") || effective?.startsWith("p4-")) {
      return { enabled: true, available: false, state: "unsupported", provider: "calldiff", reason: "view-unsupported", message: "Call flow is not available for this review view." };
    }
    const resolved = await resolveCallFlowRuntime();
    if (!resolved.ok) return { enabled: true, available: false, state: "unavailable", provider: "calldiff", reason: resolved.reason, message: resolved.message };
    return { enabled: true, available: true, state: "available", provider: "calldiff", version: resolved.runtime.version };
  }

  analyze(input: CallFlowAnalysisInput): Promise<CallFlowResponse> {
    const key = this.analysisKey(input);
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);
    const failed = this.failureCache.get(key);
    if (failed && failed.expiresAt > Date.now()) return Promise.resolve(failed.response);
    if (failed) this.failureCache.delete(key);
    const running = this.inFlight.get(key);
    const runningController = this.controllers.get(key);
    if (running && !runningController?.signal.aborted) return running;
    for (const [analysisKey, controller] of this.controllers) {
      if (analysisKey !== key) controller.abort();
    }
    const controller = new AbortController();
    this.controllers.set(key, controller);
    const work = this.withSlot(() => this.analyzeUncached(input, controller.signal));
    this.inFlight.set(key, work);
    void work.then(
      (response) => {
        if (response.status === "error") {
          this.failureCache.set(key, { expiresAt: Date.now() + 30_000, response });
        }
        this.finish(key, controller);
      },
      () => this.finish(key, controller),
    );
    return work;
  }

  cancelAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
  }

  private finish(key: string, controller: AbortController): void {
    if (this.controllers.get(key) !== controller) return;
    this.controllers.delete(key);
    this.inFlight.delete(key);
  }

  private async withSlot<T>(operation: () => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const previous = this.queue;
    this.queue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private async analyzeUncached(input: CallFlowAnalysisInput, signal: AbortSignal): Promise<CallFlowResponse> {
    if (signal.aborted) {
      return { status: "stale", reason: "snapshot-superseded", message: "Call-flow analysis was superseded by a newer review snapshot." };
    }
    const runtime = await resolveCallFlowRuntime();
    if (!runtime.ok) return { status: "unavailable", reason: runtime.reason, message: runtime.message };
    let plan: SnapshotPlan | undefined;
    try {
      plan = await createCallFlowSnapshotPlan(input);
      if (signal.aborted) {
        return { status: "stale", reason: "snapshot-superseded", message: "Call-flow analysis was superseded by a newer review snapshot." };
      }
      const parsed = await executeWorker(runtime.runtime, plan, signal);
      const indexed = indexCallFlowImpacts(parsed.trees);
      const response: Extract<CallFlowResponse, { status: "ok" }> = {
        status: "ok",
        snapshotId: input.snapshotId,
        provider: "calldiff",
        version: parsed.version,
        from: parsed.from,
        to: parsed.to,
        ...(parsed.message && { message: parsed.message }),
        raw: parsed.raw,
        trees: parsed.trees,
        fileImpacts: indexed.fileImpacts,
        summary: { ...indexed.summary, warnings: parsed.diagnostics.filter((diagnostic) => diagnostic.level === "warning").length },
        diagnostics: parsed.diagnostics,
      };
      this.cache.set(this.analysisKey(input), response);
      while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value!);
      return response;
    } catch (error) {
      if (signal.aborted) {
        return { status: "stale", reason: "snapshot-superseded", message: "Call-flow analysis was superseded by a newer review snapshot." };
      }
      return { status: "error", reason: "analysis-failed", message: error instanceof Error ? error.message : String(error) };
    } finally {
      plan?.cleanup();
    }
  }
}
