"use client";

import { useState } from "react";
import { useAuth, useAuthActions } from "@/components/auth/AuthProvider";
import { ShellIcon } from "./ShellIcon";

export function AccountControl() {
  const auth = useAuth();
  const { signIn, signOut } = useAuthActions();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function runAction(action: () => Promise<void>) {
    setPending(true);
    setFailure(null);
    try {
      await action();
    } catch {
      setFailure("The request could not be completed. Please try again.");
    } finally {
      setPending(false);
    }
  }

  if (!auth.authenticated && auth.status === "sign-in-required") {
    return (
      <div className="eq-account-control">
        <button
          className="eq-account-button"
          data-testid="sign-in-button"
          disabled={pending}
          onClick={() => void runAction(signIn)}
          type="button"
        >
          {pending ? "Opening sign-in…" : "Sign in"}
        </button>
        {failure ? (
          <span className="eq-account-control__error" role="alert">
            {failure}
          </span>
        ) : null}
      </div>
    );
  }

  if (!auth.authenticated) {
    return (
      <span className="eq-header-access-state" data-testid="account-access-state">
        Access unavailable
      </span>
    );
  }

  const isLocalWorkstation = auth.identityType === "local-workstation";
  const displayName =
    auth.displayName?.trim() || (isLocalWorkstation ? "Local workstation" : "Signed in");

  return (
    <div className="eq-account-control">
      <details className="eq-account-menu" data-testid="account-menu">
        <summary aria-label={`Account menu for ${displayName}`} className="eq-account-button">
          <span aria-hidden="true" className="eq-account-indicator" />
          <span className="eq-account-button__label">{displayName}</span>
          <span aria-hidden="true" className="eq-account-chevron">
            <ShellIcon name="chevron-down" size={14} />
          </span>
        </summary>
        <div className="eq-account-menu__panel">
          <div className="eq-account-menu__identity">{displayName}</div>
          <div className="eq-account-menu__status" data-testid="local-workstation-status">
            {isLocalWorkstation ? "Loopback-only local access" : "Authenticated session"}
          </div>
          {isLocalWorkstation ? null : (
            <button
              className="eq-account-menu__action"
              disabled={pending}
              onClick={() => void runAction(signOut)}
              type="button"
            >
              {pending ? "Signing out…" : "Sign out"}
            </button>
          )}
          {failure ? (
            <div className="eq-account-menu__error" role="alert">
              {failure}
            </div>
          ) : null}
        </div>
      </details>
    </div>
  );
}
