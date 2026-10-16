"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyThemePreference,
  DEFAULT_THEME_PREFERENCE,
  nextThemePreference,
  readThemePreference,
  writeThemePreference,
  type ThemePreference,
} from "./theme";

function getLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function useThemePreference() {
  const [preference, setPreference] = useState<ThemePreference>(DEFAULT_THEME_PREFERENCE);
  const preferenceRef = useRef<ThemePreference>(DEFAULT_THEME_PREFERENCE);

  useEffect(() => {
    const initial = readThemePreference(getLocalStorage());
    preferenceRef.current = initial;
    setPreference(initial);
    applyThemePreference(document.documentElement, initial);
  }, []);

  const cyclePreference = useCallback(() => {
    const current = preferenceRef.current;
    const next = nextThemePreference(current);
    preferenceRef.current = next;
    setPreference(next);
    applyThemePreference(document.documentElement, next);
    writeThemePreference(getLocalStorage(), next);
  }, []);

  return { preference, cyclePreference };
}
