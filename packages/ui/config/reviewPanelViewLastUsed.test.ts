import { afterEach, describe, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';
import { SETTINGS } from './settings';
import { configStore } from './configStore';
import { setReviewPanelView } from './reviewView';

function installMemoryBackend(): Map<string, string> {
  const values = new Map<string, string>();
  setStorageBackend({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  });
  return values;
}

afterEach(() => {
  resetStorageBackend();
});

describe('reviewPanelViewLastUsed setting', () => {
  test('never persists commits: a commits (or junk) cookie reads as unset', () => {
    const values = installMemoryBackend();

    values.set('plannotator-review-panel-view-last-used', 'commits');
    expect(SETTINGS.reviewPanelViewLastUsed.fromCookie()).toBeUndefined();

    values.set('plannotator-review-panel-view-last-used', 'unexpected');
    expect(SETTINGS.reviewPanelViewLastUsed.fromCookie()).toBeUndefined();
  });

  test('round-trips sections/tree; the null default writes no cookie', () => {
    const values = installMemoryBackend();

    // ensureLoaded seeds unrecorded defaults through toCookie — null must
    // not materialize a cookie that a later fromCookie would misread.
    SETTINGS.reviewPanelViewLastUsed.toCookie(null);
    expect(values.has('plannotator-review-panel-view-last-used')).toBe(false);
    expect(SETTINGS.reviewPanelViewLastUsed.fromCookie()).toBeUndefined();

    SETTINGS.reviewPanelViewLastUsed.toCookie('tree');
    expect(SETTINGS.reviewPanelViewLastUsed.fromCookie()).toBe('tree');
    SETTINGS.reviewPanelViewLastUsed.toCookie('sections');
    expect(SETTINGS.reviewPanelViewLastUsed.fromCookie()).toBe('sections');
  });

  test('setReviewPanelView syncs last-used so an explicit Settings choice is not shadowed', () => {
    const values = installMemoryBackend();
    const priorView = configStore.get('reviewPanelView');
    const priorLastUsed = configStore.get('reviewPanelViewLastUsed');
    try {
      // 'tree' exercises the sync without touching the server-synced
      // defaultDiffType half of the coupled pair.
      setReviewPanelView('tree');
      expect(configStore.get('reviewPanelViewLastUsed')).toBe('tree');
      expect(values.get('plannotator-review-panel-view-last-used')).toBe('tree');
    } finally {
      // Restore the singleton's in-memory values (cookie writes land in the
      // discarded memory backend; both settings are cookie-only).
      configStore.set('reviewPanelView', priorView);
      configStore.set('reviewPanelViewLastUsed', priorLastUsed);
    }
  });
});
