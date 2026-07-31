/**
 * Plannotator uninstall lifecycle.
 *
 * The uninstaller removes only product-owned paths and recognizable managed
 * entries from shared host configuration. The default mode keeps local review
 * data. Purge removes the known Plannotator data inventory while preserving
 * unknown top-level entries rather than guessing that custom files are ours.
 */
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
} from "node:path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";

const CORE_SKILLS = [
  "plannotator-review",
  "plannotator-annotate",
  "plannotator-last",
] as const;

const LEGACY_COMMAND_NAMES = [
  ...CORE_SKILLS,
  "plannotator-archive",
] as const;

const KIRO_SKILLS = [
  "plannotator-review",
  "plannotator-annotate",
  "plannotator-setup-goal",
  "plannotator-visual-explainer",
  "plannotator-archive",
] as const;

const STALE_CODEX_SKILLS = [
  ...CORE_SKILLS,
  "plannotator-compound",
  "plannotator-setup-goal",
  "plannotator-archive",
] as const;

const STALE_SHARED_SKILLS = [
  "plannotator-archive",
] as const;

const PURGE_OWNED_TOP_LEVEL = [
  "plans",
  "history",
  "drafts",
  "hooks",
  "compound",
  "sessions",
  "guides",
  "failed-comments",
  "semantic-diff",
  "vendor",
  "migrations",
  "config.json",
  "install-prefs",
  "review-skills.json",
  "vscode-ipc.json",
  "codex-review-debug.log",
  "codex-review-schema.json",
  "tour-schema.json",
  "guide-schema.json",
] as const;

const WINDOWS_PATH_SCRIPT = [
  "$p=[Environment]::GetEnvironmentVariable('Path','User')",
  "if($null -eq $p){exit 3}",
  "$t=$env:PLANNOTATOR_UNINSTALL_PATH.Trim().TrimEnd('\\')",
  "$kept=@($p -split ';' | Where-Object { $_ -and $_.Trim().TrimEnd('\\') -ine $t })",
  "$n=$kept -join ';'",
  "if($n -eq $p){exit 3}",
  "[Environment]::SetEnvironmentVariable('Path',$n,'User')",
].join("; ");

const WINDOWS_SELF_DELETE_SCRIPT = [
  "$target=$env:PLANNOTATOR_UNINSTALL_TARGET",
  "for($i=0;$i -lt 40;$i++){",
  "  Start-Sleep -Milliseconds 250",
  "  Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue",
  "  if(-not (Test-Path -LiteralPath $target)){break}",
  "}",
  "$parent=$env:PLANNOTATOR_UNINSTALL_PARENT",
  "Remove-Item -LiteralPath $parent -Force -ErrorAction SilentlyContinue",
].join(" ");

type JsonRecord = Record<string, unknown>;

/** Result returned by a host CLI command invoked during uninstall. */
export interface UninstallCommandResult {
  readonly exitCode: number;
  readonly timedOut: boolean;
}

/**
 * Platform and process capabilities used by the uninstall application service.
 *
 * Tests provide this boundary explicitly so no test can discover or mutate the
 * developer's real home directory, PATH, plugins, or agent installations.
 */
export interface UninstallEnvironment {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly tempDir: string;
  readonly dataDir: string;
  readonly execPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly which: (command: string) => string | null;
  readonly runCommand: (
    command: string,
    args: readonly string[],
    env?: Readonly<Record<string, string>>,
  ) => Promise<UninstallCommandResult>;
  readonly scheduleWindowsSelfDelete: (
    target: string,
    parent: string,
  ) => Promise<boolean>;
}

/** Requested uninstall behavior after CLI confirmation has completed. */
export interface UninstallRequest {
  readonly purge: boolean;
  readonly dryRun: boolean;
}

/** Caller-visible record of completed, planned, preserved, and failed work. */
export interface UninstallResult {
  readonly ok: boolean;
  readonly dataDir: string;
  readonly removed: readonly string[];
  readonly planned: readonly string[];
  readonly preserved: readonly string[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

type MutableUninstallResult = {
  dataDir: string;
  removed: string[];
  planned: string[];
  preserved: string[];
  warnings: string[];
  errors: string[];
};

type HookCleanupSpec = {
  readonly event: string;
  readonly matcher?: string;
  readonly suffix: "" | "improve-context";
};

/**
 * Build the real process boundary used by `plannotator uninstall`.
 *
 * No filesystem mutation occurs until `runPlannotatorUninstall` is called.
 */
export function createDefaultUninstallEnvironment(): UninstallEnvironment {
  const homeDir = homedir();
  const env = process.env;

  return {
    platform: process.platform,
    homeDir,
    tempDir: tmpdir(),
    dataDir: getPlannotatorDataDir(),
    execPath: process.execPath,
    env,
    which: (command) => Bun.which(command),
    runCommand: defaultRunCommand,
    scheduleWindowsSelfDelete: defaultScheduleWindowsSelfDelete,
  };
}

/**
 * Explain the irreversible purge boundary in user-facing language.
 */
export function formatPurgeWarning(dataDir: string): string {
  return [
    `Purge will permanently delete Plannotator data in ${dataDir}.`,
    "This data is local-only. It is not stored on a Plannotator server and cannot be recovered after purge.",
  ].join("\n");
}

/**
 * Remove Plannotator's conventional installation and recognizable host
 * integrations. Expected filesystem and host-CLI failures are collected in
 * the returned value so one stale integration cannot prevent other cleanup.
 */
export async function runPlannotatorUninstall(
  request: UninstallRequest,
  environment = createDefaultUninstallEnvironment(),
): Promise<UninstallResult> {
  const state: MutableUninstallResult = {
    dataDir: resolve(environment.dataDir),
    removed: [],
    planned: [],
    preserved: [],
    warnings: [],
    errors: [],
  };

  const dataDirSafetyIssue =
    getDataDirSafetyIssue(
      state.dataDir,
      resolve(environment.homeDir),
      resolve(environment.tempDir),
      environment.platform,
    ) ?? inspectDataDir(state.dataDir);

  if (request.purge && dataDirSafetyIssue) {
    return {
      ...state,
      ok: false,
      errors: [
        `Refusing to purge ${state.dataDir}: ${dataDirSafetyIssue}.`,
      ],
    };
  }

  const paths = resolveOwnedPaths(environment);

  await removeHostPlugins(request, environment, paths, state);
  removeHostConfigEntries(request, environment, paths, state);
  removeInstalledFiles(request, environment, paths, state);
  if (dataDirSafetyIssue) {
    state.warnings.push(
      `Preserved managed runtime paths under ${state.dataDir}: ${dataDirSafetyIssue}.`,
    );
  } else {
    removeInstallerData(request, state);
  }

  if (request.purge) {
    purgeLocalData(request, state);
  }

  await removeWindowsPathEntry(request, environment, paths, state);
  await removeBinaries(request, environment, paths, state);

  return {
    ...state,
    ok: state.errors.length === 0,
  };
}

/**
 * Format an uninstall result for terminal output without exposing host command
 * stdout/stderr or unrelated configuration contents.
 */
export function formatUninstallResult(result: UninstallResult): string {
  const lines: string[] = [];

  if (result.removed.length > 0) {
    lines.push("Removed:");
    for (const item of result.removed) lines.push(`  - ${item}`);
  }
  if (result.planned.length > 0) {
    lines.push("Would remove:");
    for (const item of result.planned) lines.push(`  - ${item}`);
  }
  if (result.preserved.length > 0) {
    lines.push("Preserved:");
    for (const item of result.preserved) lines.push(`  - ${item}`);
  }
  if (result.warnings.length > 0) {
    lines.push("Warnings:");
    for (const item of result.warnings) lines.push(`  - ${item}`);
  }
  if (result.errors.length > 0) {
    lines.push("Errors:");
    for (const item of result.errors) lines.push(`  - ${item}`);
  }

  return lines.join("\n");
}

function resolveOwnedPaths(environment: UninstallEnvironment) {
  const { homeDir, env } = environment;
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(homeDir, ".claude");
  const codexDir = env.CODEX_HOME || join(homeDir, ".codex");
  const factoryDir = env.FACTORY_CONFIG_DIR || join(homeDir, ".factory");
  const copilotDir = env.COPILOT_HOME || join(homeDir, ".copilot");
  const xdgConfigDir = env.XDG_CONFIG_HOME || join(homeDir, ".config");
  const xdgCacheDir = env.XDG_CACHE_HOME || join(homeDir, ".cache");
  const configDirs = uniquePaths([
    xdgConfigDir,
    join(homeDir, ".config"),
  ]);
  const localAppData = env.LOCALAPPDATA || join(homeDir, "AppData", "Local");
  const unixInstallDir = join(homeDir, ".local", "bin");
  const windowsInstallDir = join(localAppData, "plannotator");

  const binaryPaths = uniquePaths([
    join(unixInstallDir, "plannotator"),
    join(unixInstallDir, "plannotator.exe"),
    join(windowsInstallDir, "plannotator"),
    join(windowsInstallDir, "plannotator.exe"),
  ]);

  return {
    claudeDir,
    codexDir,
    factoryDir,
    copilotDir,
    configDirs,
    xdgCacheDir,
    windowsInstallDir,
    binaryPaths,
  };
}

async function removeHostPlugins(
  request: UninstallRequest,
  environment: UninstallEnvironment,
  paths: ReturnType<typeof resolveOwnedPaths>,
  state: MutableUninstallResult,
): Promise<void> {
  const actions = [
    {
      label: "Claude Code plugin plannotator@plannotator",
      command: "claude",
      args: [
        "plugin",
        "uninstall",
        "plannotator@plannotator",
        "--scope",
        "user",
        ...(request.purge ? [] : ["--keep-data"]),
        "--yes",
      ],
      installed:
        hasEnabledPlugin(
          join(paths.claudeDir, "settings.json"),
          "plannotator@plannotator",
        ),
    },
    {
      label: "GitHub Copilot CLI plugin plannotator-copilot@plannotator",
      command: "copilot",
      args: ["plugins", "remove", "plannotator-copilot@plannotator", "--plugin"],
      installed:
        hasEnabledPlugin(
          join(paths.copilotDir, "settings.json"),
          "plannotator-copilot@plannotator",
        ) ||
        hasDirectoryWithPrefix(
          join(paths.copilotDir, "installed-plugins", "plannotator"),
          "plannotator-copilot",
        ),
    },
    {
      label: "Droid plugin plannotator@plannotator",
      command: "droid",
      args: [
        "plugin",
        "uninstall",
        "plannotator@plannotator",
        "--scope",
        "user",
      ],
      installed: hasEnabledPlugin(
        join(paths.factoryDir, "settings.json"),
        "plannotator@plannotator",
      ),
    },
    {
      label: "Pi extension npm:@plannotator/pi-extension",
      command: "pi",
      args: ["remove", "npm:@plannotator/pi-extension"],
      installed: hasPiPackage(
        join(
          environment.env.PI_CODING_AGENT_DIR || join(environment.homeDir, ".pi", "agent"),
          "settings.json",
        ),
      ),
    },
    {
      label: "VS Code extension backnotprop.plannotator-webview",
      command: "code",
      args: ["--uninstall-extension", "backnotprop.plannotator-webview"],
      installed: hasDirectoryWithPrefix(
        join(environment.homeDir, ".vscode", "extensions"),
        "backnotprop.plannotator-webview-",
      ),
    },
  ] as const;

  for (const action of actions) {
    if (!action.installed) continue;
    if (request.dryRun) {
      state.planned.push(action.label);
      continue;
    }

    const executable = environment.which(action.command);
    if (!executable) {
      state.errors.push(
        `${action.label} was detected but ${action.command} is unavailable; it was not removed. Use the host's plugin manager manually.`,
      );
      continue;
    }

    const result = await environment.runCommand(executable, action.args);
    if (result.exitCode === 0) {
      state.removed.push(action.label);
    } else {
      state.errors.push(
        `${action.label} was not removed automatically (${result.timedOut ? "command timed out" : `exit ${result.exitCode}`}); use the host's plugin manager manually.`,
      );
    }
  }
}

function removeHostConfigEntries(
  request: UninstallRequest,
  environment: UninstallEnvironment,
  paths: ReturnType<typeof resolveOwnedPaths>,
  state: MutableUninstallResult,
): void {
  cleanupHooksJson(
    join(paths.claudeDir, "settings.json"),
    [
      { event: "PermissionRequest", matcher: "ExitPlanMode", suffix: "" },
      { event: "PreToolUse", matcher: "EnterPlanMode", suffix: "improve-context" },
    ],
    paths.binaryPaths,
    environment.platform,
    false,
    "managed Claude Code hooks",
    request,
    state,
  );

  cleanupHooksJson(
    join(paths.codexDir, "hooks.json"),
    [{ event: "Stop", suffix: "" }],
    paths.binaryPaths,
    environment.platform,
    true,
    "managed Codex Stop hook",
    request,
    state,
  );
  cleanupCodexConfig(
    join(paths.codexDir, "config.toml"),
    request,
    state,
  );

  cleanupGeminiSettings(
    join(environment.homeDir, ".gemini", "settings.json"),
    paths.binaryPaths,
    environment.platform,
    request,
    state,
  );

  for (const configDir of paths.configDirs) {
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      cleanupOpenCodeConfig(
        join(configDir, "opencode", name),
        request,
        state,
      );
    }
  }
}

function removeInstalledFiles(
  request: UninstallRequest,
  environment: UninstallEnvironment,
  paths: ReturnType<typeof resolveOwnedPaths>,
  state: MutableUninstallResult,
): void {
  for (const skill of CORE_SKILLS) {
    removePath(
      join(paths.claudeDir, "skills", skill),
      request,
      state,
    );
    removePath(
      join(environment.homeDir, ".agents", "skills", skill),
      request,
      state,
    );
  }

  for (const skill of STALE_SHARED_SKILLS) {
    removePath(join(paths.claudeDir, "skills", skill), request, state);
    removePath(
      join(environment.homeDir, ".agents", "skills", skill),
      request,
      state,
    );
  }

  for (const staleLayout of ["core", "extra"]) {
    removePath(
      join(paths.claudeDir, "skills", staleLayout),
      request,
      state,
    );
  }

  for (const skill of STALE_CODEX_SKILLS) {
    removePath(join(paths.codexDir, "skills", skill), request, state);
  }

  for (const skill of KIRO_SKILLS) {
    removePath(
      join(environment.homeDir, ".kiro", "skills", skill),
      request,
      state,
    );
  }

  for (const command of LEGACY_COMMAND_NAMES) {
    removePath(
      join(paths.claudeDir, "commands", `${command}.md`),
      request,
      state,
    );
    for (const configDir of paths.configDirs) {
      removePath(
        join(configDir, "opencode", "commands", `${command}.md`),
        request,
        state,
      );
    }
  }

  for (const command of [
    "plannotator-review",
    "plannotator-annotate",
    "plannotator-last",
  ]) {
    removePath(
      join(environment.homeDir, ".gemini", "commands", `${command}.toml`),
      request,
      state,
    );
  }

  removePath(
    join(environment.homeDir, ".gemini", "policies", "plannotator.toml"),
    request,
    state,
  );

  cleanupRecognizableKiroAgent(
    join(environment.homeDir, ".kiro", "agents", "plannotator.json"),
    request,
    state,
  );
  for (const configDir of paths.configDirs) {
    cleanupRecognizableAmpPlugin(
      join(configDir, "amp", "plugins", "plannotator.ts"),
      request,
      state,
    );
  }

  for (const cachePath of [
    join(paths.xdgCacheDir, "opencode", "node_modules", "@plannotator"),
    join(paths.xdgCacheDir, "opencode", "packages", "@plannotator"),
    join(environment.homeDir, ".cache", "opencode", "node_modules", "@plannotator"),
    join(environment.homeDir, ".cache", "opencode", "packages", "@plannotator"),
    join(environment.homeDir, ".bun", "install", "cache", "@plannotator"),
  ]) {
    removePath(cachePath, request, state);
  }
}

function removeInstallerData(
  request: UninstallRequest,
  state: MutableUninstallResult,
): void {
  // The sidecars are installed components. install-prefs and migrations are
  // retained as local state in the default mode: the migration ledger is what
  // prevents a later reinstall from mistaking separately installed extras for
  // obsolete installer copies. Purge removes those files through its inventory.
  for (const path of [
    join(state.dataDir, "vendor", "sem"),
    join(state.dataDir, "vendor", "agent-terminal"),
  ]) {
    removePath(path, request, state);
  }
}

function purgeLocalData(
  request: UninstallRequest,
  state: MutableUninstallResult,
): void {
  if (!pathExists(state.dataDir)) return;

  for (const name of PURGE_OWNED_TOP_LEVEL) {
    removePath(join(state.dataDir, name), request, state);
  }

  let remaining: string[];
  try {
    remaining = readdirSync(state.dataDir);
  } catch (error) {
    if (existsSync(state.dataDir)) {
      state.errors.push(
        `Could not inspect ${state.dataDir} after purge: ${formatError(error)}`,
      );
    }
    return;
  }

  if (request.dryRun) {
    const recognized = new Set<string>(PURGE_OWNED_TOP_LEVEL);
    const customEntries = remaining.filter((name) => !recognized.has(name));
    if (customEntries.length === 0) {
      state.planned.push(state.dataDir);
      return;
    }
    for (const name of customEntries) {
      state.preserved.push(
        `${join(state.dataDir, name)} (unrecognized custom entry)`,
      );
    }
    return;
  }

  if (remaining.length === 0) {
    removePath(state.dataDir, request, state);
    return;
  }

  const recognized = new Set<string>(PURGE_OWNED_TOP_LEVEL);
  for (const name of remaining) {
    const remainingPath = join(state.dataDir, name);
    if (recognized.has(name)) {
      state.errors.push(
        `Known Plannotator data entry remains after purge: ${remainingPath}.`,
      );
    } else {
      state.preserved.push(
        `${remainingPath} (unrecognized custom entry)`,
      );
    }
  }
}

async function removeWindowsPathEntry(
  request: UninstallRequest,
  environment: UninstallEnvironment,
  paths: ReturnType<typeof resolveOwnedPaths>,
  state: MutableUninstallResult,
): Promise<void> {
  if (environment.platform !== "win32") return;

  const label = `Windows user PATH entry ${paths.windowsInstallDir}`;
  if (request.dryRun) {
    state.planned.push(label);
    return;
  }

  const powershell =
    environment.which("powershell.exe") ||
    environment.which("pwsh.exe");
  if (!powershell) {
    state.warnings.push(
      `Could not inspect the Windows user PATH; remove ${paths.windowsInstallDir} from PATH manually if present.`,
    );
    return;
  }

  const result = await environment.runCommand(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PATH_SCRIPT],
    { PLANNOTATOR_UNINSTALL_PATH: paths.windowsInstallDir },
  );
  if (result.exitCode === 0) {
    state.removed.push(label);
  } else if (result.exitCode !== 3) {
    state.warnings.push(
      `Could not remove ${paths.windowsInstallDir} from the Windows user PATH.`,
    );
  }
}

async function removeBinaries(
  request: UninstallRequest,
  environment: UninstallEnvironment,
  paths: ReturnType<typeof resolveOwnedPaths>,
  state: MutableUninstallResult,
): Promise<void> {
  for (const binaryPath of paths.binaryPaths) {
    if (!pathExists(binaryPath)) continue;

    if (request.dryRun) {
      state.planned.push(binaryPath);
      continue;
    }

    const isCurrentWindowsBinary =
      environment.platform === "win32" &&
      samePath(binaryPath, environment.execPath, "win32");

    if (isCurrentWindowsBinary) {
      const scheduled = await environment.scheduleWindowsSelfDelete(
        binaryPath,
        dirname(binaryPath),
      );
      if (scheduled) {
        state.removed.push(`${binaryPath} (scheduled after exit)`);
      } else {
        state.errors.push(
          `Could not schedule removal of the running executable ${binaryPath}.`,
        );
      }
      continue;
    }

    removePath(binaryPath, request, state);
  }
}

function cleanupHooksJson(
  filePath: string,
  specs: readonly HookCleanupSpec[],
  binaryPaths: readonly string[],
  platform: NodeJS.Platform,
  removeWhenEmpty: boolean,
  label: string,
  request: UninstallRequest,
  state: MutableUninstallResult,
): void {
  const parsed = readJsonRecord(filePath, state);
  if (!parsed) return;

  const hooks = asRecord(parsed.hooks);
  if (!hooks) return;

  let changed = false;
  for (const spec of specs) {
    const entries = hooks[spec.event];
    if (!Array.isArray(entries)) continue;

    const nextEntries: unknown[] = [];
    let eventChanged = false;
    for (const value of entries) {
      const entry = asRecord(value);
      if (
        !entry ||
        (spec.matcher !== undefined && entry.matcher !== spec.matcher)
      ) {
        nextEntries.push(value);
        continue;
      }

      const hookEntries = entry.hooks;
      if (!Array.isArray(hookEntries)) {
        nextEntries.push(value);
        continue;
      }

      const nextHooks = hookEntries.filter(
        (hook) => !isManagedHook(hook, binaryPaths, spec.suffix, platform),
      );
      if (nextHooks.length === hookEntries.length) {
        nextEntries.push(value);
        continue;
      }

      changed = true;
      eventChanged = true;
      if (nextHooks.length === 0 && hasOnlyKeys(entry, ["matcher", "hooks"])) {
        continue;
      }
      nextEntries.push({ ...entry, hooks: nextHooks });
    }

    if (!eventChanged) continue;
    if (nextEntries.length === 0) delete hooks[spec.event];
    else hooks[spec.event] = nextEntries;
  }

  if (!changed) return;
  if (Object.keys(hooks).length === 0) delete parsed.hooks;
  else parsed.hooks = hooks;

  if (request.dryRun) {
    state.planned.push(`${label} in ${filePath}`);
    return;
  }

  if (removeWhenEmpty && Object.keys(parsed).length === 0) {
    removePath(filePath, request, state);
    return;
  }

  writeJson(filePath, parsed, label, state);
}

function cleanupCodexConfig(
  filePath: string,
  request: UninstallRequest,
  state: MutableUninstallResult,
): void {
  if (!existsSync(filePath)) return;
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    state.warnings.push(`Could not inspect ${filePath}: ${formatError(error)}`);
    return;
  }

  const meaningfulLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const isInstallerTemplate =
    meaningfulLines.length === 2 &&
    meaningfulLines[0] === "[features]" &&
    /^hooks\s*=\s*true$/.test(meaningfulLines[1]);

  if (!isInstallerTemplate) return;
  removePath(filePath, request, state);
}

function cleanupGeminiSettings(
  filePath: string,
  binaryPaths: readonly string[],
  platform: NodeJS.Platform,
  request: UninstallRequest,
  state: MutableUninstallResult,
): void {
  const parsed = readJsonRecord(filePath, state);
  if (!parsed) return;
  const wasInstallerTemplate = isGeminiInstallerTemplate(
    parsed,
    binaryPaths,
    platform,
  );

  const hooks = asRecord(parsed.hooks);
  const beforeTool = hooks?.BeforeTool;
  if (!hooks || !Array.isArray(beforeTool)) return;

  let changed = false;
  const nextEntries: unknown[] = [];
  for (const value of beforeTool) {
    const entry = asRecord(value);
    if (
      !entry ||
      entry.matcher !== "exit_plan_mode" ||
      !Array.isArray(entry.hooks)
    ) {
      nextEntries.push(value);
      continue;
    }

    const nextHooks = entry.hooks.filter(
      (hook) => !isManagedHook(hook, binaryPaths, "", platform),
    );
    if (nextHooks.length === entry.hooks.length) {
      nextEntries.push(value);
      continue;
    }

    changed = true;
    if (nextHooks.length === 0 && hasOnlyKeys(entry, ["matcher", "hooks"])) {
      continue;
    }
    nextEntries.push({ ...entry, hooks: nextHooks });
  }

  if (!changed) return;
  if (request.dryRun) {
    state.planned.push(`managed Gemini hook in ${filePath}`);
    return;
  }

  if (wasInstallerTemplate) {
    removePath(filePath, request, state);
    return;
  }

  if (nextEntries.length === 0) delete hooks.BeforeTool;
  else hooks.BeforeTool = nextEntries;
  if (Object.keys(hooks).length === 0) delete parsed.hooks;
  else parsed.hooks = hooks;
  writeJson(filePath, parsed, "managed Gemini hook", state);
}

function cleanupOpenCodeConfig(
  filePath: string,
  request: UninstallRequest,
  state: MutableUninstallResult,
): void {
  const parsed = readJsonRecord(filePath, state);
  if (!parsed || !Array.isArray(parsed.plugin)) return;

  const next = parsed.plugin.filter(
    (entry) => !isPlannotatorOpenCodePlugin(entry),
  );
  if (next.length === parsed.plugin.length) return;

  if (request.dryRun) {
    state.planned.push(`@plannotator/opencode entry in ${filePath}`);
    return;
  }

  parsed.plugin = next;
  writeJson(filePath, parsed, "@plannotator/opencode entry", state);
}

function cleanupRecognizableKiroAgent(
  filePath: string,
  request: UninstallRequest,
  state: MutableUninstallResult,
): void {
  const parsed = readJsonRecord(filePath, state);
  if (!parsed) return;

  const prompt = typeof parsed.prompt === "string" ? parsed.prompt : "";
  const description =
    typeof parsed.description === "string" ? parsed.description : "";
  const recognizable =
    parsed.name === "plannotator" &&
    description.includes("Kiro custom agent wiring for Plannotator") &&
    prompt.includes("Each skill runs a `plannotator` shell command");

  if (recognizable) {
    removePath(filePath, request, state);
  } else {
    state.preserved.push(`${filePath} (custom or unrecognized Kiro agent)`);
  }
}

function cleanupRecognizableAmpPlugin(
  filePath: string,
  request: UninstallRequest,
  state: MutableUninstallResult,
): void {
  if (!existsSync(filePath)) return;
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    state.warnings.push(`Could not inspect ${filePath}: ${formatError(error)}`);
    return;
  }

  const recognizable =
    content.includes('const CATEGORY = "Plannotator"') &&
    content.includes("export default function plannotatorAmpPlugin") &&
    content.includes("PLANNOTATOR_ORIGIN");

  if (recognizable) {
    removePath(filePath, request, state);
  } else {
    state.preserved.push(`${filePath} (custom or unrecognized Amp plugin)`);
  }
}

function readJsonRecord(
  filePath: string,
  state: MutableUninstallResult,
): JsonRecord | null {
  if (!existsSync(filePath)) return null;
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    state.warnings.push(`Could not inspect ${filePath}: ${formatError(error)}`);
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(content);
    const record = asRecord(parsed);
    if (!record) {
      state.warnings.push(`Preserved ${filePath}: expected a JSON object.`);
      return null;
    }
    return record;
  } catch {
    state.warnings.push(
      `Preserved ${filePath}: it is not strict JSON, so managed entries could not be removed safely.`,
    );
    return null;
  }
}

function writeJson(
  filePath: string,
  value: JsonRecord,
  label: string,
  state: MutableUninstallResult,
): void {
  try {
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    state.removed.push(`${label} in ${filePath}`);
  } catch (error) {
    state.errors.push(`Could not update ${filePath}: ${formatError(error)}`);
  }
}

function removePath(
  path: string,
  request: UninstallRequest,
  state: MutableUninstallResult,
): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (isMissingPathError(error)) return;
    state.errors.push(`Could not inspect ${path}: ${formatError(error)}`);
    return;
  }

  if (request.dryRun) {
    state.planned.push(path);
    return;
  }

  try {
    rmSync(path, {
      recursive: stat.isDirectory() && !stat.isSymbolicLink(),
      force: true,
    });
    state.removed.push(path);
  } catch (error) {
    state.errors.push(`Could not remove ${path}: ${formatError(error)}`);
  }
}

function isManagedHook(
  value: unknown,
  binaryPaths: readonly string[],
  suffix: "" | "improve-context",
  platform: NodeJS.Platform,
): boolean {
  const hook = asRecord(value);
  if (!hook || hook.type !== "command" || typeof hook.command !== "string") {
    return false;
  }

  const command = hook.command.trim();
  const expectedBare = suffix ? `plannotator ${suffix}` : "plannotator";
  if (command === expectedBare) return true;

  for (const binaryPath of binaryPaths) {
    const candidates = suffix
      ? [`${binaryPath} ${suffix}`, `"${binaryPath}" ${suffix}`]
      : [binaryPath, `"${binaryPath}"`];
    if (candidates.some((candidate) => sameCommand(command, candidate, platform))) {
      return true;
    }
  }
  return false;
}

function isGeminiInstallerTemplate(
  value: JsonRecord,
  binaryPaths: readonly string[],
  platform: NodeJS.Platform,
): boolean {
  const hooks = asRecord(value.hooks);
  const experimental = asRecord(value.experimental);
  if (!hooks || !experimental || experimental.plan !== true) return false;
  if (!hasOnlyKeys(value, ["hooks", "experimental"])) return false;
  if (!hasOnlyKeys(experimental, ["plan"])) return false;

  const beforeTool = hooks.BeforeTool;
  if (
    !hasOnlyKeys(hooks, ["BeforeTool"]) ||
    !Array.isArray(beforeTool) ||
    beforeTool.length !== 1
  ) {
    return false;
  }

  const entry = asRecord(beforeTool[0]);
  if (
    !entry ||
    entry.matcher !== "exit_plan_mode" ||
    !hasOnlyKeys(entry, ["matcher", "hooks"]) ||
    !Array.isArray(entry.hooks) ||
    entry.hooks.length !== 1
  ) {
    return false;
  }

  const hook = asRecord(entry.hooks[0]);
  return (
    hook !== null &&
    hasOnlyKeys(hook, ["type", "command", "timeout"]) &&
    isManagedHook(hook, binaryPaths, "", platform)
  );
}

function isPlannotatorOpenCodePlugin(value: unknown): boolean {
  const spec =
    typeof value === "string"
      ? value
      : Array.isArray(value) && typeof value[0] === "string"
        ? value[0]
        : null;
  return spec !== null && /^@plannotator\/opencode(?:@|$)/.test(spec);
}

function hasEnabledPlugin(filePath: string, pluginId: string): boolean {
  const parsed = tryReadJsonRecord(filePath);
  const enabled = parsed ? asRecord(parsed.enabledPlugins) : null;
  return enabled?.[pluginId] === true;
}

function hasPiPackage(filePath: string): boolean {
  const parsed = tryReadJsonRecord(filePath);
  const packages = parsed?.packages;
  if (!Array.isArray(packages)) return false;

  return packages.some((entry) => {
    const record = asRecord(entry);
    const source =
      typeof entry === "string"
        ? entry
        : typeof record?.source === "string"
          ? record.source
          : null;
    return (
      typeof source === "string" &&
      /^npm:@plannotator\/pi-extension(?:@|$)/.test(source)
    );
  });
}

function tryReadJsonRecord(filePath: string): JsonRecord | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function hasDirectoryWithPrefix(directory: string, prefix: string): boolean {
  try {
    return readdirSync(directory).some((entry) => entry.startsWith(prefix));
  } catch {
    return false;
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function hasOnlyKeys(
  value: JsonRecord,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function sameCommand(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  const normalizedLeft = left.replace(/\\/g, "/");
  const normalizedRight = right.replace(/\\/g, "/");
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function samePath(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  const normalizedLeft = normalize(resolve(left));
  const normalizedRight = normalize(resolve(right));
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => normalize(resolve(path))))];
}

function getDataDirSafetyIssue(
  dataDir: string,
  homeDir: string,
  tempDir: string,
  platform: NodeJS.Platform,
): string | null {
  if (!isAbsolute(dataDir)) {
    return "the data directory is not absolute";
  }
  const root = parse(dataDir).root;
  if (samePath(dataDir, root, platform)) {
    return "the data directory is a filesystem root";
  }
  if (samePath(dataDir, homeDir, platform)) {
    return "the data directory is the home directory; choose a dedicated PLANNOTATOR_DATA_DIR";
  }
  if (isAncestorOrSame(dataDir, homeDir, platform)) {
    return `the data directory contains the home directory ${homeDir}`;
  }
  if (samePath(dataDir, tempDir, platform)) {
    return "the data directory is the shared temporary directory";
  }
  return null;
}

function inspectDataDir(dataDir: string): string | null {
  try {
    const stat = lstatSync(dataDir);
    if (stat.isSymbolicLink()) {
      return "the data directory is a symlink; set PLANNOTATOR_DATA_DIR to its resolved target and retry";
    }
    if (!stat.isDirectory()) {
      return "the data path is not a directory";
    }
  } catch (error) {
    if (isMissingPathError(error)) return null;
    return `the data directory could not be inspected (${formatError(error)})`;
  }
  return null;
}

function isAncestorOrSame(
  parent: string,
  child: string,
  platform: NodeJS.Platform,
): boolean {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  const rel = platform === "win32"
    ? relative(resolvedParent.toLowerCase(), resolvedChild.toLowerCase())
    : relative(resolvedParent, resolvedChild);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function defaultRunCommand(
  command: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
): Promise<UninstallCommandResult> {
  let proc: Bun.Subprocess<"ignore", "ignore", "ignore">;
  try {
    proc = Bun.spawn([command, ...args], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, ...env },
    });
  } catch {
    return { exitCode: 1, timedOut: false };
  }

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<number>((resolveTimeout) => {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      resolveTimeout(124);
    }, 15_000);
  });
  const exitCode = await Promise.race([proc.exited, timeout]);
  if (timer) clearTimeout(timer);
  return { exitCode, timedOut };
}

async function defaultScheduleWindowsSelfDelete(
  target: string,
  parent: string,
): Promise<boolean> {
  const powershell = Bun.which("powershell.exe") || Bun.which("pwsh.exe");
  if (!powershell) return false;

  try {
    const proc = Bun.spawn(
      [
        powershell,
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        WINDOWS_SELF_DELETE_SCRIPT,
      ],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
        env: {
          ...process.env,
          PLANNOTATOR_UNINSTALL_TARGET: target,
          PLANNOTATOR_UNINSTALL_PARENT: parent,
        },
      },
    );
    proc.unref();
    return true;
  } catch {
    return false;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return !isMissingPathError(error);
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
