export type FatalSignal = "SIGINT" | "SIGTERM";

export interface StoppableServer {
  stop: () => void | Promise<void>;
}

export interface ServerShutdownCoordinator {
  trackServerStart: <T extends StoppableServer>(
    serverStart: Promise<T>,
  ) => Promise<T>;
  handleSignal: (signal: FatalSignal) => Promise<void>;
}

export interface ServerShutdownCoordinatorOptions {
  exit: (code: number) => void;
  onStopError?: (error: unknown) => void;
}

function exitCodeForSignal(signal: FatalSignal): number {
  return signal === "SIGINT" ? 130 : 143;
}

/**
 * Coordinates process signals with the one server owned by the hook CLI.
 *
 * The first signal waits for the active server's idempotent stop routine so
 * external presenters are dismissed before process exit. A second signal is
 * deliberately treated as a force-exit escape hatch when cleanup is stuck.
 */
export function createServerShutdownCoordinator({
  exit,
  onStopError = () => {},
}: ServerShutdownCoordinatorOptions): ServerShutdownCoordinator {
  let activeServer: Promise<StoppableServer> | undefined;
  let shutdownStarted = false;
  let forceExited = false;

  return {
    trackServerStart<T extends StoppableServer>(
      serverStart: Promise<T>,
    ): Promise<T> {
      // Track the pending start, rather than only its result. A presenter can
      // open from onReady before the start promise resolves, so a signal in
      // that window must wait for the server object and then stop it.
      activeServer = serverStart;
      return serverStart;
    },

    async handleSignal(signal: FatalSignal): Promise<void> {
      const exitCode = exitCodeForSignal(signal);

      if (shutdownStarted) {
        forceExited = true;
        exit(exitCode);
        return;
      }

      shutdownStarted = true;
      const server = activeServer;

      try {
        const startedServer = await server;
        await startedServer?.stop();
      } catch (error) {
        onStopError(error);
      } finally {
        // With a real process, the force-exit call above never returns. The
        // guard also keeps injected test exits from producing a second exit.
        if (!forceExited) {
          exit(exitCode);
        }
      }
    },
  };
}
