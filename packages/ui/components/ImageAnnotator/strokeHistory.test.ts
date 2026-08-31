import { describe, expect, it } from 'bun:test';
import { DEFAULT_STATE, type AnnotatorState, type Stroke } from './types';
import { clearStrokeHistory, recordStroke, redoStroke, undoStroke } from './strokeHistory';

const stroke = (id: string): Stroke => ({
  id,
  tool: 'pen',
  points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  color: '#fff',
  size: 3,
});

describe('image stroke history', () => {
  it('undoes, redoes, and invalidates redo after a new stroke', () => {
    const withTwo = recordStroke(recordStroke(DEFAULT_STATE, stroke('a')), stroke('b'));
    const undone = undoStroke(withTwo);
    expect(undone.strokes.map(({ id }) => id)).toEqual(['a']);
    expect(undone.futureStrokes.map(({ id }) => id)).toEqual(['b']);
    expect(redoStroke(undone).strokes.map(({ id }) => id)).toEqual(['a', 'b']);
    expect(recordStroke(undone, stroke('c')).futureStrokes).toEqual([]);
  });

  it('clear invalidates both visible and redo strokes', () => {
    const withTwo = recordStroke(recordStroke(DEFAULT_STATE, stroke('a')), stroke('b'));
    const undone = undoStroke(withTwo);
    const cleared = clearStrokeHistory(undone);
    expect(cleared.strokes).toEqual([]);
    expect(cleared.futureStrokes).toEqual([]);
    expect(redoStroke(cleared)).toBe(cleared);
  });

  it('keeps older host state without futureStrokes compatible', () => {
    const legacyState: AnnotatorState = {
      strokes: [stroke('a')],
      currentStroke: null,
      tool: 'pen',
      color: '#fff',
      strokeSize: 3,
    };
    const undone = undoStroke(legacyState);
    expect(undone.strokes).toEqual([]);
    expect(undone.futureStrokes?.map(({ id }) => id)).toEqual(['a']);
    expect(redoStroke(undone).strokes.map(({ id }) => id)).toEqual(['a']);
  });
});
