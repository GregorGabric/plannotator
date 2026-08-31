import { useReducer, useRef } from 'react';
import {
  createContextualUndoHistory,
  type ContextualUndoHistory,
  type HistoryDirection,
} from '../utils/undoHistory';

/** Imperative bounded history API used by surface-specific command adapters. */
export interface UndoHistoryApi<TAction> {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  record: (action: TAction) => void;
  undo: () => boolean;
  redo: () => boolean;
  clear: () => void;
  clearAll: () => void;
}

interface UndoHistoryOptions<TAction> {
  context: string;
  apply: (action: TAction, direction: HistoryDirection) => void;
  capacity?: number;
}

/**
 * Keep independent bounded stacks per surface context while replaying actions
 * through the latest adapter callbacks.
 */
export function useUndoHistory<TAction>({
  context,
  apply,
  capacity = 50,
}: UndoHistoryOptions<TAction>): UndoHistoryApi<TAction> {
  const optionsRef = useRef({ context, apply });
  optionsRef.current = { context, apply };
  const historyRef = useRef<ContextualUndoHistory<TAction> | null>(null);
  historyRef.current ??= createContextualUndoHistory<TAction>(capacity);
  const [, render] = useReducer((revision: number) => revision + 1, 0);
  const apiRef = useRef<UndoHistoryApi<TAction> | null>(null);

  if (!apiRef.current) {
    apiRef.current = {
      get canUndo() {
        return (historyRef.current?.read(optionsRef.current.context).past.length ?? 0) > 0;
      },
      get canRedo() {
        return (historyRef.current?.read(optionsRef.current.context).future.length ?? 0) > 0;
      },
      record(action) {
        const current = optionsRef.current;
        historyRef.current?.record(current.context, action);
        render();
      },
      undo() {
        const current = optionsRef.current;
        const action = historyRef.current?.takeUndo(current.context) ?? null;
        if (action === null) return false;
        current.apply(action, 'undo');
        render();
        return true;
      },
      redo() {
        const current = optionsRef.current;
        const action = historyRef.current?.takeRedo(current.context) ?? null;
        if (action === null) return false;
        current.apply(action, 'redo');
        render();
        return true;
      },
      clear() {
        const key = optionsRef.current.context;
        const state = historyRef.current?.read(key);
        if (!state) return;
        if (state.past.length === 0 && state.future.length === 0) return;
        historyRef.current?.clear(key);
        render();
      },
      clearAll() {
        historyRef.current?.clearAll();
        render();
      },
    };
  }

  return apiRef.current;
}
