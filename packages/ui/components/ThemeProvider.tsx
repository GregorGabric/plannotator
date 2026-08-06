import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { configStore } from '../config/configStore';
import { readThemePairCookies, writeThemePairCookies } from '../config/settings';
import { useConfigValue } from '../config/useConfig';
import { storage } from '../utils/storage';
import {
  BUILT_IN_THEMES,
  getUnsupportedMode,
  resolvePairTheme,
  resolveThemeMode,
  seedThemePair,
  setDefaultThemePair,
  themeSupportsHalf,
  type ThemeHalf,
  type ThemeInfo,
  type ThemePair,
} from '../utils/themeRegistry';
import type { Mode } from './themeModes';

// Kept here because published consumers already import Mode from ThemeProvider.
export type { Mode } from './themeModes';

type ThemeProviderState = {
  // Mode (dark/light/system) — backward-compatible with old "theme" API
  theme: Mode;
  setTheme: (mode: Mode) => void;
  mode: Mode;
  setMode: (mode: Mode) => void;
  preferredMode: 'dark' | 'light';
  resolvedMode: 'dark' | 'light';
  // Color theme (the palette the current mode renders — pair[preferredMode])
  colorTheme: string;
  setColorTheme: (theme: string) => void;
  // The pair itself: one palette per half, assignable independently
  lightTheme: string;
  darkTheme: string;
  setHalfTheme: (half: ThemeHalf, theme: string) => void;
  availableThemes: ThemeInfo[];
};

const ThemeProviderContext = createContext<ThemeProviderState>({
  theme: 'dark',
  setTheme: () => null,
  mode: 'dark',
  setMode: () => null,
  preferredMode: 'dark',
  resolvedMode: 'dark',
  colorTheme: 'plannotator',
  setColorTheme: () => null,
  lightTheme: 'plannotator',
  darkTheme: 'plannotator',
  setHalfTheme: () => null,
  availableThemes: BUILT_IN_THEMES,
});

/** Sync theme classes on <html> without stripping non-theme classes (e.g. transitions-ready). */
function applyThemeClasses(themeId: string, resolvedMode: 'dark' | 'light'): void {
  const el = document.documentElement;
  const themeClass = `theme-${themeId}`;
  const wantLight = resolvedMode === 'light';

  if (el.classList.contains(themeClass) && el.classList.contains('light') === wantLight) return;

  for (const cls of Array.from(el.classList)) {
    if (cls.startsWith('theme-')) el.classList.remove(cls);
  }
  el.classList.remove('light');

  el.classList.add(themeClass);
  if (wantLight) el.classList.add('light');
}

/** Read system preference synchronously */
function getSystemIsLight(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches;
}

interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Mode;
  defaultColorTheme?: string;
  storageKey?: string;
  colorThemeStorageKey?: string;
}

export function ThemeProvider({
  children,
  defaultTheme = 'dark',
  defaultColorTheme = 'plannotator',
  storageKey = 'plannotator-theme',
  colorThemeStorageKey = 'plannotator-color-theme',
}: ThemeProviderProps) {
  // The props are the fallback for someone with no persisted preference. The
  // config store is a singleton that may already have resolved its own default,
  // so ask storage directly instead of trusting the resolved value; the seed is
  // handed to the store below, once mounting is done.
  const [propsSeed] = useState<ThemePair | null>(() => {
    const fallback = seedThemePair(defaultColorTheme, defaultTheme);
    setDefaultThemePair(fallback);
    return readThemePairCookies() === undefined ? fallback : null;
  });
  const pendingSeed = useRef(propsSeed);

  const storePair = useConfigValue('themePair');
  const pair = pendingSeed.current ?? storePair;
  const mode = pair.mode;

  useEffect(() => {
    if (!pendingSeed.current) return;
    configStore.set('themePair', pendingSeed.current);
    pendingSeed.current = null;
  }, []);

  const [systemIsLight, setSystemIsLight] = useState(getSystemIsLight);

  // Keep the OS-resolved preference separate from the half it selects.
  const preferredMode: 'dark' | 'light' =
    mode === 'system' ? (systemIsLight ? 'light' : 'dark') : mode;
  const colorTheme = resolvePairTheme(pair, preferredMode);
  const resolvedMode = resolveThemeMode(colorTheme, preferredMode);

  // [P3 fix] Apply theme class synchronously during initialization to prevent
  // flash of unstyled content. CSS tokens live under .theme-* selectors, so
  // without this the first frame has no valid --background/--foreground.
  if (typeof window !== 'undefined') {
    applyThemeClasses(colorTheme, resolvedMode);
  }

  // Keep class in sync after state changes
  useEffect(() => {
    applyThemeClasses(colorTheme, resolvedMode);
  }, [resolvedMode, colorTheme]);

  // Enable color transitions after mount settles — prevents the global *
  // transition rule from firing during initial load.
  useEffect(() => {
    requestAnimationFrame(() => {
      document.documentElement.classList.add('transitions-ready');
    });
  }, []);

  // [P2 fix] Listen for system theme changes AND re-read current value when
  // entering system mode (OS may have changed while pinned to explicit mode)
  useEffect(() => {
    if (mode !== 'system') return;

    // Sync immediately — OS preference may have changed since we last checked
    setSystemIsLight(getSystemIsLight());

    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    const handleChange = () => setSystemIsLight(mediaQuery.matches);

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [mode]);

  const setMode = useCallback((newMode: Mode) => {
    configStore.set('themePair', { ...configStore.get('themePair'), mode: newMode });
  }, []);

  /** Assign one palette to one half of the pair. */
  const setHalfTheme = useCallback((half: ThemeHalf, newTheme: string) => {
    if (!themeSupportsHalf(newTheme, half)) return;
    configStore.set('themePair', { ...configStore.get('themePair'), [half]: newTheme });
  }, []);

  /**
   * Legacy single-palette API. A palette that renders both modes takes over the
   * whole pair; a mode-restricted one takes the half it supports and pins the
   * mode there, so a caller that picks Dracula still sees Dracula.
   */
  const setColorTheme = useCallback((newTheme: string) => {
    const current = configStore.get('themePair');
    const unsupported = getUnsupportedMode(newTheme);
    if (!unsupported) {
      configStore.set('themePair', { ...current, light: newTheme, dark: newTheme });
      return;
    }
    const half: ThemeHalf = unsupported === 'light' ? 'dark' : 'light';
    configStore.set('themePair', { ...current, [half]: newTheme, mode: half });
  }, []);

  // Mirror the resolved choice onto the keys older releases read, so a
  // downgrade lands on the user's palette instead of an unstyled first frame.
  // The pair itself is written first: a pair migrated from the legacy
  // single-palette key is derived, and the mirror below overwrites the key it
  // was derived from.
  useEffect(() => {
    writeThemePairCookies(pair);
    if (storage.getItem(colorThemeStorageKey) !== colorTheme) {
      storage.setItem(colorThemeStorageKey, colorTheme);
    }
    if (storage.getItem(storageKey) !== mode) storage.setItem(storageKey, mode);
  }, [pair, colorTheme, colorThemeStorageKey, mode, storageKey]);

  const value = useMemo<ThemeProviderState>(() => ({
    theme: mode,
    setTheme: setMode,
    mode,
    setMode,
    preferredMode,
    resolvedMode,
    colorTheme,
    setColorTheme,
    lightTheme: pair.light,
    darkTheme: pair.dark,
    setHalfTheme,
    availableThemes: BUILT_IN_THEMES,
  }), [mode, preferredMode, resolvedMode, colorTheme, pair.light, pair.dark, setMode, setColorTheme, setHalfTheme]);

  return (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};
