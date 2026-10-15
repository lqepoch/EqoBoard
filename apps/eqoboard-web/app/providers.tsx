"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AuthUiSnapshot } from "@/lib/contracts/auth";
import { AuthCacheBoundary, AuthProvider } from "@/components/auth/AuthProvider";
import { MarketDataHost } from "@/features/data/MarketDataHost";
import { WorkspaceCommandProvider } from "@/components/shell/WorkspaceCommandContext";

type ProvidersProps = Readonly<{
  auth: AuthUiSnapshot;
  children: ReactNode;
}>;

export function Providers({ auth, children }: ProvidersProps) {
  const permissionBoundary = auth.permissions.slice().sort().join(",");
  const cacheBoundary = `${auth.status}:${auth.storagePartition ?? "anonymous"}:${permissionBoundary}`;

  return (
    <AuthScopedProviders auth={auth} key={cacheBoundary}>
      {children}
    </AuthScopedProviders>
  );
}

type AuthScopedProvidersProps = Readonly<{
  auth: AuthUiSnapshot;
  children: ReactNode;
}>;

function AuthScopedProviders({ auth, children }: AuthScopedProvidersProps) {
  const [queryClient] = useState(() => new QueryClient());

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <AuthCacheBoundary>
        <AuthProvider snapshot={auth}>
          <WorkspaceCommandProvider>
            <MarketDataHost auth={auth}>{children}</MarketDataHost>
          </WorkspaceCommandProvider>
        </AuthProvider>
      </AuthCacheBoundary>
    </QueryClientProvider>
  );
}
