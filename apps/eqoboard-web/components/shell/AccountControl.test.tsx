import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import type { AuthUiSnapshot } from "@/lib/contracts/auth";

const queryMocks = vi.hoisted(() => ({ clear: vi.fn() }));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ clear: queryMocks.clear }),
}));
vi.mock("next-auth/react", () => ({
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

import { AuthProvider } from "@/components/auth/AuthProvider";
import { AccountControl } from "./AccountControl";

const localSnapshot: AuthUiSnapshot = {
  status: "authenticated",
  authenticated: true,
  displayName: "Local workstation",
  identityType: "local-workstation",
  permissions: ["market:read", "workspace:read", "workspace:write"],
  storagePartition: "native-terminal-v1-local",
  runtimeMode: "terminal",
  researchOrigin: null,
};

describe("AccountControl local workstation state", () => {
  it("shows loopback-local identity without offering OIDC sign-in or sign-out", () => {
    const markup = renderToString(
      <AuthProvider snapshot={localSnapshot}>
        <AccountControl />
      </AuthProvider>,
    );

    expect(markup).toContain("Local workstation");
    expect(markup).toContain("Loopback-only local access");
    expect(markup).not.toContain("Sign in");
    expect(markup).not.toContain("Sign out");
  });
});
