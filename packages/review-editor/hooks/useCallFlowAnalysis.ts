import { useEffect, useState } from 'react';
import type { CallFlowResponse } from '@plannotator/shared/call-flow-types';

export type CallFlowAnalysisState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; data: Extract<CallFlowResponse, { status: 'ok' }> }
  | { status: 'error'; error: Exclude<CallFlowResponse, { status: 'ok' }> | Error };

/** Run once per visible review snapshot; all Dock/Lens consumers share this state. */
export function useCallFlowAnalysis(
  snapshotId: string | undefined,
  available: boolean,
): CallFlowAnalysisState {
  const [state, setState] = useState<CallFlowAnalysisState>({ status: 'idle' });

  useEffect(() => {
    if (!available || !snapshotId) {
      setState({ status: 'idle' });
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading' });
    fetch(`/api/call-flow?snapshot=${encodeURIComponent(snapshotId)}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as CallFlowResponse;
        return payload;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setState(payload.status === 'ok'
          ? { status: 'ready', data: payload }
          : { status: 'error', error: payload });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setState({ status: 'error', error: error instanceof Error ? error : new Error(String(error)) });
      });
    return () => controller.abort();
  }, [available, snapshotId]);

  return state;
}
