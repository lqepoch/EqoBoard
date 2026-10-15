"use client";

import { createContext, useCallback, useContext, useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { signIn as nextAuthSignIn, signOut as nextAuthSignOut } from "next-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import type { AuthUiSnapshot } from "@/lib/contracts/auth";

type AuthContextValue = Readonly<{
  snapshot: AuthUiSnapshot;
}>;

export type AuthActions = Readonly<{
  signIn(): Promise<void>;
  signOut(): Promise<void>;
}>;

const AuthContext = createContext<AuthContextValue | null>(null);
const AUTH_CHANNEL = "eqoboard-auth-v1";

export function AuthProvider({ snapshot, children }: Readonly<{
  snapshot: AuthUiSnapshot;
  children: ReactNode;
}>) {
  const value = useMemo(() => ({ snapshot }), [snapshot]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthUiSnapshot {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value.snapshot;
}

export function useAuthActions(): AuthActions {
  const queryClient = useQueryClient();
  const signIn = useCallback(async () => {
    await nextAuthSignIn("eqo-oidc", { callbackUrl: "/" });
  }, []);
  const signOut = useCallback(async () => {
    queryClient.clear();
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(AUTH_CHANNEL);
      channel.postMessage({ type: "signed-out" });
      channel.close();
    }
    await nextAuthSignOut({ callbackUrl: "/" });
  }, [queryClient]);
  return useMemo(() => ({ signIn, signOut }), [signIn, signOut]);
}

export function AuthCacheBoundary({ children }: Readonly<{ children: ReactNode }>) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(AUTH_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data && typeof event.data === "object" &&
          (event.data as { type?: unknown }).type === "signed-out") {
        queryClient.clear();
        window.location.replace("/");
      }
    };
    return () => channel.close();
  }, [queryClient]);
  return children;
}
