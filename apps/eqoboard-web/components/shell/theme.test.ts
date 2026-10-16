import { describe, expect, it } from "vitest";
import {
  applyThemePreference,
  nextThemePreference,
  parseThemePreference,
  readThemePreference,
  THEME_STORAGE_KEY,
  writeThemePreference,
} from "./theme";

describe("theme preference", () => {
  it("accepts only the supported persisted values", () => {
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("system")).toBe("system");
    expect(parseThemePreference("auto")).toBe("system");
    expect(parseThemePreference(null)).toBe("system");
  });

  it("cycles predictably through system, light, and dark", () => {
    expect(nextThemePreference("system")).toBe("light");
    expect(nextThemePreference("light")).toBe("dark");
    expect(nextThemePreference("dark")).toBe("system");
  });

  it("uses one versioned key and applies the preference to the root", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    writeThemePreference(storage, "dark");
    expect(values.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(readThemePreference(storage)).toBe("dark");

    const root = { dataset: {} as Record<string, string> };
    applyThemePreference(root, "dark");
    expect(root.dataset.theme).toBe("dark");
  });

  it("falls back safely when storage is blocked", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readThemePreference(storage)).toBe("system");
    expect(() => writeThemePreference(storage, "light")).not.toThrow();
  });
});
