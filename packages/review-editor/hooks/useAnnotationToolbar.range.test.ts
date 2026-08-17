import { describe, expect, test } from 'bun:test';
import { extendTouchLineRange } from './useAnnotationToolbar';

describe('touch line-range extension', () => {
  test('normalizes forward and reverse endpoints on one diff side', () => {
    expect(extendTouchLineRange(
      { start: 12, end: 12, side: 'additions' },
      { start: 18, end: 18, side: 'additions' },
    )).toEqual({ start: 12, end: 18, side: 'additions' });

    expect(extendTouchLineRange(
      { start: 12, end: 12, side: 'additions' },
      { start: 7, end: 7, side: 'additions' },
    )).toEqual({ start: 7, end: 12, side: 'additions' });
  });

  test('fails closed across diff sides or an already cross-side range', () => {
    expect(extendTouchLineRange(
      { start: 12, end: 12, side: 'additions' },
      { start: 9, end: 9, side: 'deletions' },
    )).toBeNull();

    expect(extendTouchLineRange(
      { start: 12, end: 14, side: 'additions', endSide: 'deletions' },
      { start: 18, end: 18, side: 'additions' },
    )).toBeNull();
  });
});
