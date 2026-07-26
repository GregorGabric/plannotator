import { describe, expect, test } from 'bun:test';
import { createVimHudCommand, getVimHudPhase } from './vimHud';

describe('Vim HUD command projection', () => {
  test('normalizes multi-key and named keys for the video keycaps', () => {
    expect(createVimHudCommand(1, 'documentStart', 'g', 'block')).toMatchObject({
      key: 'gg',
      description: 'Start of document',
    });
    expect(createVimHudCommand(2, 'cancel', 'Escape', 'visual')).toMatchObject({
      key: 'esc',
      description: 'Cancel current Vim state',
    });
    expect(createVimHudCommand(3, 'annotationMenu', ' ', 'visual')).toMatchObject({
      key: 'space',
      description: 'Open annotation actions',
    });
  });

  test('distinguishes structural, line, word, visual, and action phases', () => {
    expect(getVimHudPhase('block', 'moveDown')).toBe('BLOCK');
    expect(getVimHudPhase('inline', 'moveDown')).toBe('INLINE');
    expect(getVimHudPhase('text', 'moveDown')).toBe('LINE');
    expect(getVimHudPhase('text', 'wordForward')).toBe('WORD');
    expect(getVimHudPhase('text', 'refine')).toBe('TEXT');
    expect(getVimHudPhase('visual', 'wordEnd')).toBe('VISUAL');
    expect(getVimHudPhase('action', 'comment')).toBe('ACTION');
  });
});
