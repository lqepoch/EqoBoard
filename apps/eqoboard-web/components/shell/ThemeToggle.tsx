"use client";

import type { ThemePreference } from "./theme";
import { ShellIcon } from "./ShellIcon";

const THEME_LABELS: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

type ThemeToggleProps = {
  preference: ThemePreference;
  onCycle: () => void;
};

export function ThemeToggle({ preference, onCycle }: ThemeToggleProps) {
  return (
    <button
      aria-label={`Appearance: ${THEME_LABELS[preference]}. Activate to cycle.`}
      className="eq-icon-button"
      data-testid="theme-toggle"
      onClick={onCycle}
      title={`Appearance: ${THEME_LABELS[preference]}`}
      type="button"
    >
      <span className="eq-theme-icon">
        <ShellIcon name={preference === "light" ? "sun" : preference === "dark" ? "moon" : "system"} size={17} />
      </span>
    </button>
  );
}
