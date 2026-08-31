/**
 * Duck-typed adapters over the OpenCode 2 plugin context.
 *
 * The V2 plugin API is still pre-release: the published `next` and `latest`
 * dist-tags of `@opencode-ai/plugin` carry an older context shape than the
 * `beta` / `dev` nightlies. Nothing here may import the plugin package at
 * runtime or assume a domain exists — every capability is probed before use so
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

export interface V2ContextLike {
  agent?: { list?: (input?: unknown) => Promise<unknown> };
  session?: V2SessionDomain;
  command?: { transform?: (apply: (draft: V2CommandDraft) => void) => Promise<unknown> | unknown };
  location?: { directory?: string };
}

export interface V2CommandInvocation {
  sessionID: string;
  prompt?: { text?: string };
  delivery?: unknown;
}

export interface V2CommandDefinition {
  name: string;
  description?: string;
  execute: (input: V2CommandInvocation) => Promise<void>;
}

export interface V2CommandDraft {
  add: (definition: V2CommandDefinition) => void;
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
 * Read an agent list from either response shape.
 *
 * `ctx.agent.list()` is typed as the HTTP client's `{ location, data }`
 * envelope, but the in-process plugin domain on newer hosts answers with a
 * bare array. Reading `response.data` unconditionally threw into the caller's
 * catch there and silently degraded the agent list to empty, which disables
 * agent-switch validation and subagent detection.
 */
export function normalizeAgentList(response: unknown): OpenCodeBridgeAgent[] {
  const entries = Array.isArray(response)
    ? response
    : isRecord(response) && Array.isArray(response.data)
      ? response.data
      : [];

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

/** True when this host's plugin API can register native slash commands. */
export function supportsNativeCommands(ctx: V2ContextLike): boolean {
  return typeof ctx.command?.transform === "function";
}

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
 * Build the V1-shaped client `handleCliCommand` and `resolveValidatedTargetAgent`
 * expect, backed by the V2 context. Delivering feedback goes through
 * `ctx.session.prompt` — the direct path — rather than a synthetic-event
 * injection, which is unreliable on some V2 nightlies.
 *
 * There is deliberately no `tui` domain: the V2 server-plugin context exposes
 * none, and every toast call site in `cli-bridge` is best-effort.
 */
export function createV2BridgeClient(input: {
  ctx: V2ContextLike;
  getAgents: () => Promise<OpenCodeBridgeAgent[]>;
  delivery?: unknown;
}): V2BridgeClient {
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
          await input.ctx.session.switchAgent({ sessionID, agent });
        }
        const prompt = input.ctx.session?.prompt;
        if (typeof prompt !== "function") {
          throw new Error("OpenCode 2 host exposes no session.prompt; cannot deliver Plannotator feedback.");
        }
        return await prompt({
          sessionID,
          text: joinTextParts(Array.isArray(body.parts) ? body.parts : []),
          ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
        });
      },
    },
  };
}
