/**
 * Native slash commands for OpenCode 2.
 *
 * OpenCode's V2 plugin API gained command execution in anomalyco/opencode
 * PR #44765 (issue #2185): `ctx.command.transform(draft => draft.add({ name,
 * description, execute }))`, where `execute` fully owns the invocation and
 * nothing reaches the model unless it says so. That shape currently ships only
 * on the `beta` and `dev` dist-tags of `@opencode-ai/plugin`; `next` and
 * `latest` still carry the older context. So the capability is duck-typed at
 * runtime, never imported: on a host without it this module registers nothing
 * and the markdown command stubs stay the (model-mediated) fallback.
 *
 * Execution reuses the exact V1 machinery — `handleCliCommand` — over a
 * translation client, so the two hosts cannot drift.
 */

import { handleCliCommand, type OpenCodeBridgeAgent, type OpenCodeBridgeContext } from "./cli-bridge";
import {
  createV2BridgeClient,
  supportsNativeCommands,
  type V2CommandDraft,
  type V2CommandInvocation,
  type V2ContextLike,
} from "./v2-client";

export const NATIVE_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  {
    name: "plannotator-review",
    description:
      "Open interactive code review for current changes or a PR URL; pass --git or --gitbutler to force that provider",
  },
  {
    name: "plannotator-annotate",
    description: "Open interactive annotation UI for a file, folder, or URL",
  },
  {
    name: "plannotator-last",
    description: "Annotate the last assistant message",
  },
];

export interface CliCommandRequest {
  command: string;
  client: unknown;
  sessionId?: string;
  rawArgs: string;
  cwd?: string;
  bridge?: OpenCodeBridgeContext;
}

export interface NativeCommandDeps {
  ctx: V2ContextLike;
  getAgents: () => Promise<OpenCodeBridgeAgent[]>;
  getBridgeContext: () => Promise<OpenCodeBridgeContext>;
  /**
   * Injection seam for tests only; production always uses `handleCliCommand`.
   * Bun's `mock.module` is process-global and cannot be unset, so a module mock
   * of `cli-bridge` here would leak into every other suite.
   */
  runCommand?: (request: CliCommandRequest) => Promise<void>;
}

/** Resolve the invocation's working directory, session location first. */
async function resolveDirectory(ctx: V2ContextLike, sessionID: string): Promise<string> {
  try {
    const session = await ctx.session?.get?.({ sessionID });
    const directory = session?.location?.directory;
    if (typeof directory === "string" && directory) return directory;
  } catch {
    // Fall through to the plugin location, then the process cwd.
  }
  return ctx.location?.directory || process.cwd();
}

export async function runNativeCommand(
  command: string,
  invocation: V2CommandInvocation,
  deps: NativeCommandDeps,
): Promise<void> {
  const sessionID = invocation.sessionID;
  // The raw argument tail, exactly as OpenCode 1 forwards it. The CLI's own
  // tolerant argument resolution takes it from here — nothing is parsed or
  // rewritten on the way through.
  const rawArgs = typeof invocation.prompt?.text === "string" ? invocation.prompt.text : "";
  const client = createV2BridgeClient({
    ctx: deps.ctx,
    getAgents: deps.getAgents,
    delivery: invocation.delivery,
  });

  const run = deps.runCommand ?? ((request: CliCommandRequest) => handleCliCommand(request as never));
  await run({
    command,
    client,
    sessionId: sessionID,
    rawArgs,
    cwd: await resolveDirectory(deps.ctx, sessionID),
    bridge: await deps.getBridgeContext(),
  });
}

/**
 * Register the three Plannotator commands when the host supports it.
 *
 * Returns whether anything was registered, so callers (and tests) can pin the
 * "old host, zero new behavior" half of the contract.
 */
export async function registerNativeCommands(deps: NativeCommandDeps): Promise<boolean> {
  const transform = deps.ctx.command?.transform;
  if (!supportsNativeCommands(deps.ctx) || typeof transform !== "function") return false;

  await transform((draft: V2CommandDraft) => {
    for (const command of NATIVE_COMMANDS) {
      draft.add({
        name: command.name,
        description: command.description,
        execute: async (invocation) => {
          try {
            await runNativeCommand(command.name, invocation, deps);
          } catch (error) {
            // handleCliCommand already logs and swallows everything except a
            // prompt-delivery failure. Report that one and stop: rethrowing
            // would surface an OpenCode command execution error for feedback
            // the reviewer has already given.
            console.error(
              `[Plannotator] /${command.name} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
      });
    }
  });

  return true;
}
