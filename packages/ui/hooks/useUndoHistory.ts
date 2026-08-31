import { useRef } from 'react';
import {
  createUndoHistoryState,
  recordUndoAction,
  takeRedoAction,
  takeUndoAction,
  type HistoryDirection,
  type UndoHistoryState,
} from '../utils/undoHistory';

/** Imperative bounded history API used by surface-specific command adapters. */
export interface UndoHistoryApi<TAction> {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  record: (action: TAction) => void;
  undo: () => boolean;
  redo: () => boolean;
  clear: () => void;
}

interface UndoHistoryOptions<TAction> {
  context: string;
  apply: (action: TAction, direction: HistoryDirection) => void;
  capacity?: number;
}

/**
 * Keep one bounded stack for the active surface context while replaying
 * actions through the latest adapter callback. A context change starts a fresh
 * baseline immediately; history is intentionally not cached across navigation.
 */
export function useUndoHistory<TAction>({
  context,
  apply,
  capacity = 50,
}: UndoHistoryOptions<TAction>): UndoHistoryApi<TAction> {
  const optionsRef = useRef({ apply, capacity });
  optionsRef.current = { apply, capacity };
  const contextRef = useRef(context);
  const historyRef = useRef<UndoHistoryState<TAction>>(createUndoHistoryState<TAction>());
  if (contextRef.current !== context) {
    contextRef.current = context;
    historyRef.current = createUndoHistoryState<TAction>();
  }
  const apiRef = useRef<UndoHistoryApi<TAction> | null>(null);

  if (!apiRef.current) {
    apiRef.current = {
      get canUndo() {
        return historyRef.current.past.length > 0;
      },
      get canRedo() {
        return historyRef.current.future.length > 0;
      },
      record(action) {
        historyRef.current = recordUndoAction(historyRef.current, action, optionsRef.current.capacity);
      },
      undo() {
        const current = optionsRef.current;
        const step = takeUndoAction(historyRef.current);
        if (step.action === null) return false;
        historyRef.current = step.state;
        current.apply(step.action, 'undo');
        return true;
      },
      redo() {
        const current = optionsRef.current;
        const step = takeRedoAction(historyRef.current, optionsRef.current.capacity);
        if (step.action === null) return false;
        historyRef.current = step.state;
        current.apply(step.action, 'redo');
        return true;
      },
      clear() {
        historyRef.current = createUndoHistoryState<TAction>();
      },
    };
  }

  return apiRef.current;
}
