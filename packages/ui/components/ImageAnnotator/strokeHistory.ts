import type { AnnotatorState, Stroke } from './types';

/** Commit a completed stroke and invalidate the abandoned redo branch. */
export function recordStroke(state: AnnotatorState, stroke: Stroke): AnnotatorState {
  return {
    ...state,
    strokes: [...state.strokes, stroke],
    futureStrokes: [],
    currentStroke: null,
  };
}

/** Move the latest visible stroke to the redo stack. */
export function undoStroke(state: AnnotatorState): AnnotatorState {
  const stroke = state.strokes.at(-1);
  if (!stroke) return state;
  return {
    ...state,
    strokes: state.strokes.slice(0, -1),
    futureStrokes: [...state.futureStrokes, stroke],
    currentStroke: null,
  };
}

/** Restore the latest stroke removed by undo. */
export function redoStroke(state: AnnotatorState): AnnotatorState {
  const stroke = state.futureStrokes.at(-1);
  if (!stroke) return state;
  return {
    ...state,
    strokes: [...state.strokes, stroke],
    futureStrokes: state.futureStrokes.slice(0, -1),
    currentStroke: null,
  };
}

/** Clear the canvas and invalidate both stroke branches. */
export function clearStrokeHistory(state: AnnotatorState): AnnotatorState {
  if (state.strokes.length === 0 && state.futureStrokes.length === 0 && state.currentStroke === null) return state;
  return {
    ...state,
    strokes: [],
    futureStrokes: [],
    currentStroke: null,
  };
}
