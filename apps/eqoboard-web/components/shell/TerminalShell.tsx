"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";
import { AccountControl } from "./AccountControl";
import { CommandPalette, type ShellCommand } from "./CommandPalette";
import { MarketStatusPill } from "./MarketStatusPill";
import { PrimaryNav } from "./PrimaryNav";
import { ShellIcon } from "./ShellIcon";
import { ThemeToggle } from "./ThemeToggle";
import { shouldOpenCommandPalette } from "./keyboard";
import { useThemePreference } from "./useThemePreference";

type TerminalShellProps = {
  children: ReactNode;
};

export function TerminalShell({ children }: TerminalShellProps) {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const mobileNavRef = useRef<HTMLDialogElement>(null);
  const mobileNavTriggerRef = useRef<HTMLButtonElement>(null);
  const { preference, cyclePreference } = useThemePreference();

  const commands = useMemo<readonly ShellCommand[]>(
    () => [
      {
        id: "workspace",
        label: "Open workspace",
        keywords: ["terminal", "dashboard"],
        run: () => router.push("/"),
      },
      {
        id: "appearance",
        label: "Cycle appearance",
        keywords: ["theme", "light", "dark", "system"],
        run: cyclePreference,
      },
    ],
    [cyclePreference, router],
  );

  const closeMobileNavigation = useCallback(() => {
    setMobileNavOpen(false);
    const dialog = mobileNavRef.current;
    if (dialog?.open) dialog.close();
  }, []);

  useEffect(() => {
    const dialog = mobileNavRef.current;
    if (!dialog) return;

    if (mobileNavOpen && !dialog.open) {
      dialog.showModal();
    } else if (!mobileNavOpen && dialog.open) {
      dialog.close();
    }
  }, [mobileNavOpen]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!shouldOpenCommandPalette(event, "mobile-navigation-dialog")) return;
      event.preventDefault();
      if (mobileNavRef.current?.open) {
        mobileNavRef.current.close();
        setMobileNavOpen(false);
      }
      setPaletteOpen(true);
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  const isWorkspacePage = pathname === "/";

  return (
    <div className="eq-app-shell" data-testid="app-shell">
      <a className="eq-skip-link" href="#main-content">
        Skip to workspace
      </a>
      <header className="eq-app-header">
        <div className="eq-header-brand">
          <button
            aria-controls="mobile-navigation-dialog"
            aria-expanded={mobileNavOpen}
            aria-label="Open navigation"
            aria-haspopup="dialog"
            className="eq-nav-toggle eq-mobile-nav-toggle"
            data-testid="mobile-nav-toggle"
            onClick={() => setMobileNavOpen(true)}
            ref={mobileNavTriggerRef}
            type="button"
          >
            <ShellIcon name="menu" size={17} />
          </button>
          <Link aria-label="EqoBoard home" className="eq-brand" href="/">
            <span aria-hidden="true" className="eq-brand-mark">
              EQ
            </span>
            <span>EqoBoard</span>
          </Link>
        </div>
        <button
          aria-controls="eq-command-palette-dialog"
          aria-expanded={paletteOpen}
          aria-haspopup="dialog"
          aria-keyshortcuts="Control+K Meta+K"
          aria-label="Open command palette"
          className="eq-command-trigger"
          data-testid="command-palette-trigger"
          onClick={() => setPaletteOpen(true)}
          type="button"
        >
          <span aria-hidden="true" className="eq-command-trigger__search">
            <ShellIcon name="search" size={16} />
          </span>
          <span className="eq-command-trigger__label">Search commands or symbols</span>
          <span aria-hidden="true" className="eq-shortcut">
            Ctrl K / ⌘ K
          </span>
        </button>
        <div className="eq-header-actions">
          <MarketStatusPill />
          <ThemeToggle onCycle={cyclePreference} preference={preference} />
          <AccountControl />
        </div>
      </header>

      <aside className="eq-app-sidebar">
        <PrimaryNav />
      </aside>

      <div className="eq-app-main">
        <AuthBanner authenticated={auth.authenticated} status={auth.status} />
        <main className="eq-main-content" id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>

      <dialog
        aria-labelledby="mobile-navigation-title"
        className="eq-mobile-nav-dialog"
        data-testid="mobile-nav-dialog"
        id="mobile-navigation-dialog"
        onClose={() => {
          setMobileNavOpen(false);
          mobileNavTriggerRef.current?.focus();
        }}
        ref={mobileNavRef}
      >
        <div className="eq-mobile-nav-dialog__header">
          <h2 id="mobile-navigation-title">Navigation</h2>
          <button
            aria-label="Close navigation"
            className="eq-dialog-close"
            onClick={closeMobileNavigation}
            type="button"
          >
            <ShellIcon name="close" size={16} />
          </button>
        </div>
        <PrimaryNav onNavigate={closeMobileNavigation} placement="mobile" />
      </dialog>

      <CommandPalette commands={commands} onOpenChange={setPaletteOpen} open={paletteOpen} />
      <span className="eq-visually-hidden" aria-live="polite">
        {isWorkspacePage ? "Workspace selected" : "Page selected"}
      </span>
    </div>
  );
}

type AuthBannerProps = {
  status: ReturnType<typeof useAuth>["status"];
  authenticated: boolean;
};

function AuthBanner({ status, authenticated }: AuthBannerProps) {
  if (authenticated) return null;

  const details = {
    "identity-unavailable": {
      message: "Sign-in is temporarily unavailable. Protected resources remain closed.",
      role: "alert" as const,
    },
    "policy-rejected": {
      message: "This account is not permitted to access EqoBoard.",
      role: "alert" as const,
    },
    "sign-in-required": {
      message: "Sign in to open your workspace and protected resources.",
      role: "status" as const,
    },
    authenticated: {
      message: "Session access is unavailable. Protected resources remain closed.",
      role: "alert" as const,
    },
  }[status];

  return (
    <section className="eq-auth-banner" data-state={status}>
      <div className="eq-auth-banner__message" role={details.role}>
        <span aria-hidden="true" className="eq-auth-banner__marker">
          ●
        </span>
        <span>{details.message}</span>
      </div>
    </section>
  );
}
