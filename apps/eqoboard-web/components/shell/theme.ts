export const THEME_STORAGE_KEY = "eqoboard.theme.v1";

export type ThemePreference = "system" | "light" | "dark";

const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

/** The terminal is designed dark-first; "system" remains an explicit opt-in. */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = "dark";

export function parseThemePreference(value: unknown): ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference)
    ? (value as ThemePreference)
    : DEFAULT_THEME_PREFERENCE;
}

export function nextThemePreference(current: ThemePreference): ThemePreference {
  const index = THEME_PREFERENCES.indexOf(current);
  return THEME_PREFERENCES[(index + 1) % THEME_PREFERENCES.length] ?? "system";
}

export function readThemePreference(storage: Pick<Storage, "getItem"> | null): ThemePreference {
  try {
    return storage
      ? parseThemePreference(storage.getItem(THEME_STORAGE_KEY))
      : DEFAULT_THEME_PREFERENCE;
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

export function writeThemePreference(
  storage: Pick<Storage, "setItem"> | null,
  preference: ThemePreference,
): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Theme changes still apply in memory when browser storage is unavailable.
  }
}

export function applyThemePreference(
  root: Pick<HTMLElement, "dataset">,
  preference: ThemePreference,
): void {
  root.dataset.theme = preference;
}
