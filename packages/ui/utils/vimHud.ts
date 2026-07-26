import {
  describeVimSelectionAction,
  type VimSelectionActionId,
  type VimSelectionHudContext,
} from '../shortcuts/plan-review/vimSelection.shortcuts';

/** Semantic label displayed in the Vim key HUD. */
export type VimHudPhase =
  | 'BLOCK'
  | 'INLINE'
  | 'LINE'
  | 'WORD'
  | 'TEXT'
  | 'VISUAL'
  | 'ACTION';

/** One successfully handled Vim command rendered by the key HUD. */
export interface VimHudCommand {
  readonly sequence: number;
  readonly actionId: VimSelectionActionId;
  readonly key: string;
  readonly description: string;
}

function normalizeVimHudKey(
  actionId: VimSelectionActionId,
  rawKey: string,
): string {
  if (actionId === 'documentStart') return 'gg';
  if (rawKey === 'Escape') return 'esc';
  if (rawKey === 'Enter') return 'enter';
  if (rawKey === ' ' || rawKey === 'Space' || rawKey === 'Spacebar') return 'space';
  return rawKey;
}

/**
 * Build immutable HUD feedback from a command that the Vim controller handled.
 */
export function createVimHudCommand(
  sequence: number,
  actionId: VimSelectionActionId,
  rawKey: string,
  context: VimSelectionHudContext,
): VimHudCommand {
  return {
    sequence,
    actionId,
    key: normalizeVimHudKey(actionId, rawKey),
    description: describeVimSelectionAction(actionId, context),
  };
}

/**
 * Project live Vim navigation state and the latest motion into the video HUD's
 * semantic phase vocabulary.
 */
export function getVimHudPhase(
  state: VimSelectionHudContext,
  actionId?: VimSelectionActionId,
): VimHudPhase {
  switch (state) {
    case 'action':
      return 'ACTION';
    case 'visual':
    case 'visual-block':
      return 'VISUAL';
    case 'inline':
      return 'INLINE';
    case 'block':
    case 'inactive':
      return 'BLOCK';
    case 'text':
      switch (actionId) {
        case 'moveDown':
        case 'moveUp':
        case 'lineStart':
        case 'lineEnd':
          return 'LINE';
        case 'wordForward':
        case 'wordBackward':
        case 'wordEnd':
          return 'WORD';
        case 'previousTextBlock':
        case 'nextTextBlock':
          return 'BLOCK';
        case 'documentStart':
        case 'documentEnd':
        case 'moveOut':
        case 'refine':
        case 'visual':
        case 'visualBlock':
        case 'swapSelectionEnds':
        case 'activeAnnotation':
        case 'annotationMenu':
        case 'comment':
        case 'redline':
        case 'markup':
        case 'label':
        case 'copy':
        case 'cancel':
        case 'help':
        case undefined:
          return 'TEXT';
      }
  }
}
