import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NATIVE_COMMANDS, registerNativeCommands, type CliCommandRequest } from "./native-commands";
import { normalizeAgentList, toBridgeMessages } from "./v2-client";
import { switchV2SessionAgent } from "./agent-switch";

function makeDeps(overrides: Record<string, unknown> = {}) {
  const runCommand = mock(async (_request: CliCommandRequest) => {});
  const added: Array<{ name: string; description?: string; execute: Function }> = [];
  const transform = mock(async (apply: (draft: { add: (d: any) => void }) => void) => {
    apply({ add: (definition) => added.push(definition) });
    return { dispose: async () => {} };
  });

  const ctx: any = {
    command: { transform },
    session: {
      get: async () => ({ location: { directory: "/project" } }),
    },
    location: { directory: "/fallback" },
    ...overrides,
  };

  return {
    ctx,
    added,
    transform,
    runCommand,
    deps: {
      ctx,
      getAgents: async () => [],
      getBridgeContext: async () => ({ sharingEnabled: true }),
      runCommand,
    },
  };
}

describe("OpenCode 2 native command registration", () => {
  test("registers nothing when the host has no command.transform", async () => {
    // The whole feature-detection contract: on `next` / `latest` hosts the V2
    // plugin API predates PR #44765 and must stay untouched.
    const { deps } = makeDeps({ command: undefined });
    expect(await registerNativeCommands(deps)).toBe(false);
  });

  test("registers exactly the three Plannotator commands when the API exists", async () => {
    const { deps, added } = makeDeps();
    expect(await registerNativeCommands(deps)).toBe(true);
    // Command names are the user-visible slash commands and are deliberately
    // frozen: they must match the OpenCode 1 stubs so both hosts agree.
    expect(added.map((command) => command.name)).toEqual([
      "plannotator-review",
      "plannotator-annotate",
      "plannotator-last",
    ]);
    for (const command of added) expect(command.execute).toBeInstanceOf(Function);
  });

  test("each execute runs the CLI path with the raw argument tail", async () => {
    const { deps, added, runCommand } = makeDeps();
    await registerNativeCommands(deps);

    const annotate = added.find((command) => command.name === "plannotator-annotate")!;
    await annotate.execute({
      sessionID: "session-9",
      prompt: { text: "notes.md --gate --json" },
      delivery: "queue",
    });

    expect(runCommand).toHaveBeenCalledTimes(1);
    const request = runCommand.mock.calls[0]![0]!;
    expect(request.command).toBe("plannotator-annotate");
    expect(request.sessionId).toBe("session-9");
    // Raw pass-through: flags must reach the CLI's own argument resolution
    // unparsed, exactly as OpenCode 1 forwards `input.arguments`.
    expect(request.rawArgs).toBe("notes.md --gate --json");
    expect(request.cwd).toBe("/project");
  });

  test("an argument-less invocation still runs with an empty tail", async () => {
    const { deps, added, runCommand } = makeDeps();
    await registerNativeCommands(deps);

    const review = added.find((command) => command.name === "plannotator-review")!;
    await review.execute({ sessionID: "session-1" });

    expect(runCommand.mock.calls[0]![0]!.rawArgs).toBe("");
  });

  test("falls back to the plugin location when the session has no directory", async () => {
    const { deps, added, runCommand } = makeDeps({
      session: { get: async () => { throw new Error("no session"); } },
    });
    await registerNativeCommands(deps);
    await added[0]!.execute({ sessionID: "session-1", prompt: { text: "" } });

    expect(runCommand.mock.calls[0]![0]!.cwd).toBe("/fallback");
  });

  test("a failing command is reported, not rethrown into OpenCode", async () => {
    const failing = mock(async () => { throw new Error("boom"); });
    const { deps, added } = makeDeps();
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args[0]); };
    try {
      await registerNativeCommands({ ...deps, runCommand: failing });
      await added[0]!.execute({ sessionID: "session-1", prompt: { text: "" } });
    } finally {
      console.error = originalError;
    }
    expect(errors.some((line) => String(line).includes("boom"))).toBe(true);
  });
});

describe("V2 agent list shapes", () => {
  // The new promise plugin domain answers with a bare array while the HTTP
  // client types it as a `{ data }` envelope. Reading `.data` blindly threw and
  // silently emptied the agent list, disabling subagent gating on new hosts.
  test("reads both the bare array and the { data } envelope", () => {
    const entries = [{ id: "plan", mode: "primary", hidden: false }];
    expect(normalizeAgentList(entries)).toEqual([
      { name: "plan", description: undefined, mode: "primary", hidden: false },
    ]);
    expect(normalizeAgentList({ location: {}, data: entries })).toEqual(normalizeAgentList(entries));
  });

  test("unusable responses degrade to an empty list instead of throwing", () => {
    expect(normalizeAgentList(undefined)).toEqual([]);
    expect(normalizeAgentList({ data: "nope" })).toEqual([]);
    expect(normalizeAgentList([{ mode: "primary" }])).toEqual([]);
  });
});

describe("V2 agent switching", () => {
  test("switches the session agent when the host exposes switchAgent", async () => {
    const switchAgent = mock(async (_input: { sessionID: string; agent: string }) => {});
    const result = await switchV2SessionAgent({
      ctx: { session: { switchAgent } },
      sessionID: "session-1",
      requestedAgent: "build",
      getAgents: async () => [{ name: "build" }],
      warn: () => {},
    });

    expect(switchAgent).toHaveBeenCalledWith({ sessionID: "session-1", agent: "build" });
    expect(result).toBe("build");
  });

  test("warns and leaves the agent alone when the host has no switchAgent", async () => {
    const warnings: string[] = [];
    const result = await switchV2SessionAgent({
      ctx: { session: {} },
      sessionID: "session-1",
      requestedAgent: "build",
      getAgents: async () => [{ name: "build" }],
      warn: (message) => warnings.push(message),
    });

    expect(result).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  test("a failing switch does not fail the approval", async () => {
    const warnings: string[] = [];
    const result = await switchV2SessionAgent({
      ctx: { session: { switchAgent: async () => { throw new Error("busy"); } } },
      sessionID: "session-1",
      requestedAgent: "build",
      getAgents: async () => [{ name: "build" }],
      warn: (message) => warnings.push(message),
    });

    expect(result).toBeUndefined();
    expect(warnings.some((line) => line.includes("busy"))).toBe(true);
  });

  test("an unavailable or disabled agent never reaches switchAgent", async () => {
    const switchAgent = mock(async () => {});
    expect(await switchV2SessionAgent({
      ctx: { session: { switchAgent } },
      sessionID: "session-1",
      requestedAgent: "ghost",
      getAgents: async () => [{ name: "build" }],
      warn: () => {},
    })).toBeUndefined();
    expect(await switchV2SessionAgent({
      ctx: { session: { switchAgent } },
      sessionID: "session-1",
      requestedAgent: "disabled",
      getAgents: async () => [{ name: "build" }],
      warn: () => {},
    })).toBeUndefined();
    expect(switchAgent).not.toHaveBeenCalled();
  });
});

describe("V2 session context translation", () => {
  // `/plannotator-last` reads assistant text out of the session. V2 messages
  // are flat (`{ id, type, content }`) where V1 nested them under info/parts;
  // getRecentAssistantMessages reads the V1 shape.
  test("maps flat V2 messages into the nested shape the bridge reads", () => {
    const mapped = toBridgeMessages([
      { id: "m1", type: "assistant", time: { created: 5 }, content: [{ type: "text", text: "hi" }] },
    ]) as Array<{ info: { id: string; role: string; time: { created: number } }; parts: unknown[] }>;

    expect(mapped[0]!.info).toEqual({ id: "m1", role: "assistant", time: { created: 5 } });
    expect(mapped[0]!.parts).toEqual([{ type: "text", text: "hi" }]);
  });

  test("a non-array context yields no messages", () => {
    expect(toBridgeMessages(undefined)).toEqual([]);
  });
});

describe("shared command stubs", () => {
  // OpenCode 1 evaluates a command template's shell interpolation BEFORE the V1
  // plugin's command.execute.before hook can clear the parts, so a `!` backtick
  // in these shared stubs would launch a second Plannotator session on every
  // OC1 invocation. Permanently pinned.
  const stubDir = path.join(import.meta.dir, "commands");

  for (const command of NATIVE_COMMANDS) {
    test(`${command.name}.md carries no shell interpolation`, () => {
      const body = readFileSync(path.join(stubDir, `${command.name}.md`), "utf-8");
      expect(body).not.toContain("!`");
      // The model-mediated fallback needs the argument tail to reach the CLI.
      expect(body).toContain("$ARGUMENTS");
    });
  }
});
