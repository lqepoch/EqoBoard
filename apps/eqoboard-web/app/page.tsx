"use client";

import type { Permission } from "@/lib/contracts/auth";
import type { ReactNode } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { builtinWidgetRegistry } from "@/widgets/registry/builtin";
import { WorkspaceRoot } from "@/workspace/WorkspaceRoot";
import { AccessState } from "@/components/shell/AccessState";
import { TerminalShell } from "@/components/shell/TerminalShell";
import { LegacyWorkspaceImportPanel } from "@/components/workspace/LegacyWorkspaceImportPanel";

// UI projection only; every workspace API enforces its own authorization.
function canReadWorkspace(permissions: readonly Permission[]): boolean {
  return permissions.includes("workspace:read");
}

export default function HomePage() {
  const auth = useAuth();
  const isAuthenticated = auth.authenticated && auth.status === "authenticated";

  let content: ReactNode;
  if (!isAuthenticated) {
    const accessCopy = {
      "identity-unavailable": {
        title: "Sign-in is temporarily unavailable",
        detail: "We could not verify access right now. Protected workspace data remains closed.",
        state: "unavailable" as const,
      },
      "policy-rejected": {
        title: "Access is restricted",
        detail: "This account is not allowed to open this workspace.",
        state: "restricted" as const,
      },
      "sign-in-required": {
        title: "Sign in to open your workspace",
        detail: "Your workspace and protected market resources require an authenticated session.",
        state: "restricted" as const,
      },
      authenticated: {
        title: "Access is unavailable",
        detail: "A verified session is required before workspace data can be loaded.",
        state: "restricted" as const,
      },
    }[auth.status];

    content = <AccessState {...accessCopy} />;
  } else if (!canReadWorkspace(auth.permissions)) {
    content = <AccessState
      detail="Your account does not have permission to open this workspace. Ask an administrator to update access."
      title="Workspace access is not assigned"
    />;
  } else {
    content = <WorkspaceRoot auth={auth} registry={builtinWidgetRegistry} />;
  }

  if (auth.status === "sign-in-required") {
    content = (
      <>
        {content}
        <div className="eq-access-followup">
          <LegacyWorkspaceImportPanel canImport={false} registry={builtinWidgetRegistry} />
        </div>
      </>
    );
  }

  return <TerminalShell>{content}</TerminalShell>;
}
