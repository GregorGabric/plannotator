/**
 * Duck-typed adapters over the OpenCode 2 plugin context.
 *
 * The V2 plugin API is still pre-release: the published `next` and `latest`
 * dist-tags of `@opencode-ai/plugin` carry an older context shape than the
 * `beta` / `dev` nightlies. Nothing here may import the plugin package at
 * runtime or assume a domain exists: every capability is probed before use so
 * the adapter degrades to today's behavior on an older host.
 */

import type { OpenCodeBridgeAgent } from "./cli-bridge";

/** The subset of the V2 session domain this plugin touches. */
export interface V2SessionDomain {
  get?: (input: { sessionID: string }) => Promise<{ location?: { directory?: string } }>;
  prompt?: (input: { sessionID: string; text: string; delivery?: unknown }) => Promise<unknown>;
  switchAgent?: (input: { sessionID: string; agent: string }) => Promise<unknown>;
  context?: (input: { sessionID: string }) => Promise<unknown>;
}

/**
 * The subset of the V2 command domain this plugin touches.
 *
 * `transform` exists on every V2 host and says nothing about capability: the
 * pre-#44765 draft is `{ list, get, update, remove }`. Only the draft handed to
 * the callback can answer that, which is why nothing here treats the presence
 * of `transform` as support.
 */
export interface V2CommandDomain {
  transform?: (apply: (draft: V2CommandDraft) => void) => Promise<unknown> | unknown;
  list?: (input?: unknown) => Promise<unknown>;
  reload?: () => Promise<unknown>;
}

export interface V2ContextLike {
  agent?: { list?: (input?: unknown) => Promise<unknown> };
  session?: V2SessionDomain;
  command?: V2CommandDomain;
  location?: { directory?: string };
}

export interface V2CommandInvocation {
  sessionID: string;
  prompt?: { text?: string };
  /**
   * The admission mode OpenCode chose for the invocation. Carried for
   * completeness and deliberately NOT reused when feedback comes back: see
   * `FEEDBACK_DELIVERY`.
   */
  delivery?: unknown;
}

export interface V2CommandDefinition {
  name: string;
  description?: string;
  execute: (input: V2CommandInvocation) => Promise<void>;
}

/**
 * Post-#44765 draft. `add` is optional in the type because an older host hands
 * the callback a draft without it; every call site must probe before using it.
 */
export interface V2CommandDraft {
  add?: (definition: V2CommandDefinition) => void;
}

export interface V2CommandListEntry {
  name: string;
  description?: string;
}

/** The V1-shaped client `cli-bridge` consumes. */
export interface V2BridgeClient {
  app: {
    log: (entry: { level: "info" | "error"; message: string }) => void;
    agents: () => Promise<{ data: OpenCodeBridgeAgent[] }>;
  };
  // Widened to `unknown` on purpose: these are handed to `cli-bridge`, whose
  // client interface declares the same operations with `unknown` parameters.
  session: {
    messages: (input: unknown) => Promise<{ data: unknown[] }>;
    prompt: (input: unknown) => Promise<unknown>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

/**
 * Unwrap a list response that may or may not be enveloped.
 *
 * The generated client types every `list` as `{ location, data }`, and that is
 * what the documented success shape is. Reading `.data` unconditionally throws
 * on anything else and the throw lands in a caller's catch, where it degrades
 * silently rather than loudly, so both shapes are accepted here instead.
 */
function readEntries(response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  if (isRecord(response) && Array.isArray(response.data)) return response.data;
  return [];
}

/** Read `ctx.command.list()` into name/description pairs, envelope or not. */
export function readListPayload(response: unknown): V2CommandListEntry[] {
  const entries: V2CommandListEntry[] = [];
  for (const entry of readEntries(response)) {
    if (!isRecord(entry) || typeof entry.name !== "string") continue;
    entries.push({
      name: entry.name,
      description: typeof entry.description === "string" ? entry.description : undefined,
    });
  }
  return entries;
}

/** Read an agent list, envelope or bare array, without ever throwing. */
export function normalizeAgentList(response: unknown): OpenCodeBridgeAgent[] {
  const entries = readEntries(response);

  const agents: OpenCodeBridgeAgent[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const name = typeof entry.id === "string"
      ? entry.id
      : typeof entry.name === "string" ? entry.name : undefined;
    if (!name) continue;
    agents.push({
      name,
      description: typeof entry.description === "string" ? entry.description : undefined,
      mode: typeof entry.mode === "string" ? entry.mode : undefined,
      hidden: entry.hidden === true,
    });
  }
  return agents;
}

/** True when this host's session domain can switch the active agent. */
export function supportsSwitchAgent(ctx: V2ContextLike): boolean {
  return typeof ctx.session?.switchAgent === "function";
}

// There is deliberately no `supportsNativeCommands(ctx)`. `ctx.command.transform`
// exists on hosts whose draft predates PR #44765 and has no `add`, so any probe
// from the context alone reports a false positive; the draft itself is the only
// witness. See `native-commands.ts`.

/**
 * Translate `ctx.session.context()` output into the message shape
 * `getRecentAssistantMessages` reads. V2 messages are flat
 * (`{ id, type, time, content }`); V1 nested them under `info` / `parts`.
 */
export function toBridgeMessages(context: unknown): unknown[] {
  if (!Array.isArray(context)) return [];
  return context.filter(isRecord).map((message) => ({
    info: {
      id: typeof message.id === "string" ? message.id : undefined,
      role: typeof message.type === "string" ? message.type : undefined,
      time: isRecord(message.time) ? { created: message.time.created } : undefined,
    },
    parts: Array.isArray(message.content) ? message.content : [],
  }));
}

function joinTextParts(parts: unknown[]): string {
  return parts
    .filter((part): part is { type: string; text: string } =>
      isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** Read the session id out of the V1-shaped `{ path: { id } }` request. */
function readSessionId(request: unknown): string | undefined {
  if (!isRecord(request) || !isRecord(request.path)) return undefined;
  return typeof request.path.id === "string" ? request.path.id : undefined;
}

/**
 * How Plannotator feedback is admitted to the session.
 *
 * A command invocation carries its own delivery, but that value was chosen when
 * the user pressed enter, and a review comes back minutes later: replaying a
 * "steer" then would land the feedback in the middle of whatever turn is
 * running now. "queue" is the safe choice for a late arrival. Upstream's own
 * default is "steer" (`packages/core/src/session/prompt.ts`), so this is set
 * explicitly rather than omitted.
 */
const FEEDBACK_DELIVERY = "queue";

/**
 * Build the V1-shaped client `handleCliCommand` and `resolveValidatedTargetAgent`
 * expect, backed by the V2 context. Delivering feedback goes through
 * `ctx.session.prompt`, the direct path, rather than a synthetic-event
 * injection, which is unreliable on some V2 nightlies (upstream #44788).
 *
 * There is deliberately no `tui` domain: the V2 server-plugin context exposes
 * none, and every toast call site in `cli-bridge` is best-effort.
 */
export function createV2BridgeClient(input: {
  ctx: V2ContextLike;
  getAgents: () => Promise<OpenCodeBridgeAgent[]>;
  /** Best-effort warning sink; defaults to stderr. */
  warn?: (message: string) => void;
}): V2BridgeClient {
  const warn = input.warn ?? ((message: string) => console.error(message));
  const loggedUrls = new Set<string>();
  return {
    app: {
      agents: async () => ({ data: await input.getAgents() }),
      log: ({ message }) => {
        const url = /https?:\/\/\S+/.exec(message)?.[0];
        if (url && loggedUrls.has(url)) return;
        if (url) loggedUrls.add(url);
        console.error(message);
      },
    },
    session: {
      messages: async (request) => {
        const sessionID = readSessionId(request);
        if (!sessionID) return { data: [] };
        const context = await input.ctx.session?.context?.({ sessionID });
        return { data: toBridgeMessages(context) };
      },
      prompt: async (request) => {
        const sessionID = readSessionId(request);
        if (!sessionID) throw new Error("Plannotator feedback has no OpenCode session to deliver to.");
        const body = isRecord(request) && isRecord(request.body) ? request.body : {};
        const agent = typeof body.agent === "string" ? body.agent : undefined;
        if (agent && typeof input.ctx.session?.switchAgent === "function") {
          // A failed switch must never cost the reviewer their feedback: the
          // same guarantee `switchV2SessionAgent` gives the approval path.
          try {
            await input.ctx.session.switchAgent({ sessionID, agent });
          } catch (error) {
            warn(`[Plannotator] Could not switch the OpenCode session to "${agent}": ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const prompt = input.ctx.session?.prompt;
        if (typeof prompt !== "function") {
          throw new Error("OpenCode 2 host exposes no session.prompt; cannot deliver Plannotator feedback.");
        }
        return await prompt({
          sessionID,
          text: joinTextParts(Array.isArray(body.parts) ? body.parts : []),
          delivery: FEEDBACK_DELIVERY,
        });
      },
    },
  };
}
