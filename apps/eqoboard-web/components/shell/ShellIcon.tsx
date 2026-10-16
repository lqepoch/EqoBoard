import type { ReactNode } from "react";

export type ShellIconName =
  | "menu"
  | "search"
  | "close"
  | "chevron-down"
  | "workspace"
  | "command"
  | "sun"
  | "moon"
  | "system";

type ShellIconProps = Readonly<{
  name: ShellIconName;
  size?: number;
}>;

const ICON_PATHS: Record<ShellIconName, ReactNode> = {
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.8" />
      <path d="m16 16 4 4" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  workspace: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <rect x="14" y="14" width="6" height="6" rx="1" />
    </>
  ),
  command: (
    <>
      <path d="M5 12h13" />
      <path d="m12 6 6 6-6 6" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
    </>
  ),
  moon: <path d="M20.4 15.1A8.6 8.6 0 0 1 8.9 3.6 8.7 8.7 0 1 0 20.4 15.1Z" />,
  system: (
    <>
      <rect x="3.5" y="4" width="17" height="13" rx="1.5" />
      <path d="M8 21h8m-4-4v4" />
    </>
  ),
};

export function ShellIcon({ name, size = 16 }: ShellIconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      focusable="false"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
      width={size}
    >
      {ICON_PATHS[name]}
    </svg>
  );
}
