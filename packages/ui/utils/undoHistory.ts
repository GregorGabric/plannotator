/** Direction in which a recorded history action is replayed. */
export type HistoryDirection = 'undo' | 'redo';

/** Immutable state for one bounded undo/redo context. */
export interface UndoHistoryState<TAction> {
  readonly past: readonly TAction[];
  readonly future: readonly TAction[];
}

/** Result of taking one action from a history stack. */
export interface UndoHistoryStep<TAction> {
  readonly state: UndoHistoryState<TAction>;
  readonly action: TAction | null;
}

/** Pure per-context bounded history store. */
export interface ContextualUndoHistory<TAction> {
  read: (context: string) => UndoHistoryState<TAction>;
  record: (context: string, action: TAction) => void;
  takeUndo: (context: string) => TAction | null;
  takeRedo: (context: string) => TAction | null;
  clear: (context: string) => void;
  clearAll: () => void;
}

/** Create an empty undo/redo state. */
export function createUndoHistoryState<TAction>(): UndoHistoryState<TAction> {
  return { past: [], future: [] };
}

/** Record an already-applied action and invalidate the redo branch. */
export function recordUndoAction<TAction>(
  state: UndoHistoryState<TAction>,
  action: TAction,
  capacity: number,
): UndoHistoryState<TAction> {
  const boundedCapacity = Math.max(1, Math.floor(capacity));
  return {
    past: [...state.past, action].slice(-boundedCapacity),
    future: [],
  };
}

/** Take the newest undo action, if one exists. */
export function takeUndoAction<TAction>(state: UndoHistoryState<TAction>): UndoHistoryStep<TAction> {
  const action = state.past.at(-1) ?? null;
  if (action === null) return { state, action: null };
  return {
    action,
    state: {
      past: state.past.slice(0, -1),
      future: [...state.future, action],
    },
  };
}

/** Take the newest redo action, if one exists. */
export function takeRedoAction<TAction>(
  state: UndoHistoryState<TAction>,
  capacity: number,
): UndoHistoryStep<TAction> {
  const action = state.future.at(-1) ?? null;
  if (action === null) return { state, action: null };
  const boundedCapacity = Math.max(1, Math.floor(capacity));
  return {
    action,
    state: {
      past: [...state.past, action].slice(-boundedCapacity),
      future: state.future.slice(0, -1),
    },
  };
}

/** Create isolated bounded stacks for independently navigable surfaces. */
export function createContextualUndoHistory<TAction>(capacity = 50): ContextualUndoHistory<TAction> {
  const states = new Map<string, UndoHistoryState<TAction>>();
  const read = (context: string): UndoHistoryState<TAction> =>
    states.get(context) ?? createUndoHistoryState<TAction>();
  return {
    read,
    record(context, action) {
      states.set(context, recordUndoAction(read(context), action, capacity));
    },
    takeUndo(context) {
      const step = takeUndoAction(read(context));
      if (step.action !== null) states.set(context, step.state);
      return step.action;
    },
    takeRedo(context) {
      const step = takeRedoAction(read(context), capacity);
      if (step.action !== null) states.set(context, step.state);
      return step.action;
    },
    clear(context) {
      states.delete(context);
    },
    clearAll() {
      states.clear();
    },
  };
}

/** One reversible mutation to an ID-addressed collection. */
export type CollectionMutation<TItem> =
  | { readonly kind: 'add'; readonly item: TItem; readonly index: number }
  | { readonly kind: 'edit'; readonly before: TItem; readonly after: TItem }
  | { readonly kind: 'delete'; readonly item: TItem; readonly index: number };

function insertAt<TItem>(items: readonly TItem[], item: TItem, index: number): TItem[] {
  const insertionIndex = Math.max(0, Math.min(index, items.length));
  return [...items.slice(0, insertionIndex), item, ...items.slice(insertionIndex)];
}

/** Apply or invert one collection mutation while preserving the recorded item index. */
export function applyCollectionMutation<TItem>(
  items: readonly TItem[],
  mutation: CollectionMutation<TItem>,
  direction: HistoryDirection,
  getId: (item: TItem) => string,
): TItem[] {
  switch (mutation.kind) {
    case 'add':
      return direction === 'undo'
        ? items.filter((item) => getId(item) !== getId(mutation.item))
        : insertAt(items, mutation.item, mutation.index);
    case 'delete':
      return direction === 'undo'
        ? insertAt(items, mutation.item, mutation.index)
        : items.filter((item) => getId(item) !== getId(mutation.item));
    case 'edit': {
      const replacement = direction === 'undo' ? mutation.before : mutation.after;
      return items.map((item) => getId(item) === getId(replacement) ? replacement : item);
    }
  }
}

/** Apply a compound collection action in the order required for exact inversion. */
export function applyCollectionMutations<TItem>(
  items: readonly TItem[],
  mutations: readonly CollectionMutation<TItem>[],
  direction: HistoryDirection,
  getId: (item: TItem) => string,
): TItem[] {
  const ordered = direction === 'undo' ? [...mutations].reverse() : mutations;
  return ordered.reduce<TItem[]>(
    (current, mutation) => applyCollectionMutation(current, mutation, direction, getId),
    [...items],
  );
}

const NATIVE_HISTORY_SELECTOR = [
  'input',
  'textarea',
  '[contenteditable]:not([contenteditable="false"])',
  '.cm-editor',
  '[role="textbox"]',
].join(',');

const ACTIVE_HISTORY_OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[data-popover-layer]',
  '[data-comment-popover="true"]',
  '.cm-editor.cm-focused',
].join(',');

/**
 * Return whether the event belongs to native text history or another active
 * tool. `composedPath()` is required for editors mounted inside shadow DOM.
 */
export function isNativeHistoryOwner(event: KeyboardEvent): boolean {
  const first = event.composedPath()[0];
  if (!(first instanceof Element)) return false;
  return first.matches(NATIVE_HISTORY_SELECTOR)
    || first.closest(NATIVE_HISTORY_SELECTOR) !== null;
}

/** Return whether a dialog, composer, or source editor currently owns history. */
export function hasActiveHistoryOverlay(root: ParentNode): boolean {
  return root.querySelector(ACTIVE_HISTORY_OVERLAY_SELECTOR) !== null;
}

/** External or agent-authored annotations never enter human undo history. */
export function isHumanHistoryMutation(item: { readonly source?: string }): boolean {
  return !item.source;
}
