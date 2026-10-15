"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ShellIcon } from "./ShellIcon";

type PrimaryNavProps = {
  onNavigate?: () => void;
  placement?: "desktop" | "mobile";
};

export function PrimaryNav({ onNavigate, placement = "desktop" }: PrimaryNavProps) {
  const pathname = usePathname();
  const workspaceActive = pathname === "/";

  return (
    <nav
      aria-label="Primary navigation"
      className="eq-primary-nav"
      data-testid={placement === "mobile" ? "mobile-primary-navigation" : "primary-navigation"}
    >
      <div className="eq-primary-nav__label">Workspace</div>
      <Link
        aria-current={workspaceActive ? "page" : undefined}
        className="eq-primary-nav__link"
        href="/"
        onClick={onNavigate}
      >
        <span aria-hidden="true" className="eq-nav-icon"><ShellIcon name="workspace" size={17} /></span>
        <span className="eq-primary-nav__link-text">Workspace</span>
      </Link>
    </nav>
  );
}
