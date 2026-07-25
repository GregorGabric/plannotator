import { afterEach, describe, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';
import { SETTINGS } from './settings';

afterEach(() => {
  resetStorageBackend();
});

describe('Vim mode setting', () => {
  test('is opt-in and defaults to disabled when no preference exists', () => {
    const values = new Map<string, string>();
    setStorageBackend({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    });

    expect(SETTINGS.vimModeEnabled.defaultValue).toBe(false);
    expect(SETTINGS.vimModeEnabled.fromCookie()).toBeUndefined();
  });

  test('round-trips only explicit boolean values', () => {
    const values = new Map<string, string>();
    setStorageBackend({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    });

    SETTINGS.vimModeEnabled.toCookie(true);
    expect(values.get('plannotator-vim-mode-enabled')).toBe('true');
    expect(SETTINGS.vimModeEnabled.fromCookie()).toBe(true);

    SETTINGS.vimModeEnabled.toCookie(false);
    expect(values.get('plannotator-vim-mode-enabled')).toBe('false');
    expect(SETTINGS.vimModeEnabled.fromCookie()).toBe(false);

    values.set('plannotator-vim-mode-enabled', 'unexpected');
    expect(SETTINGS.vimModeEnabled.fromCookie()).toBeUndefined();
  });
});
