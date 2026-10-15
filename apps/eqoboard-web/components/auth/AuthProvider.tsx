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

export function handleSignedOutMessage(
  value: unknown,
  storagePartition: string | null,
  onSignedOut: () => void,
): boolean {
  if (
    storagePartition === null ||
    value === null ||
    typeof value !== "object" ||
    (value as { type?: unknown }).type !== "signed-out" ||
    (value as { storagePartition?: unknown }).storagePartition !== storagePartition
  ) {
    return false;
  }

  onSignedOut();
  return true;
}

export function AuthProvider({
  snapshot,
  children,
}: Readonly<{
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
  const auth = useAuth();
  const signIn = useCallback(async () => {
    await nextAuthSignIn("eqo-oidc", { callbackUrl: "/" });
  }, []);
  const signOut = useCallback(async () => {
    await nextAuthSignOut({ callbackUrl: "/", redirect: false });
    queryClient.clear();
    if (auth.storagePartition !== null && typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(AUTH_CHANNEL);
      channel.postMessage({ type: "signed-out", storagePartition: auth.storagePartition });
      channel.close();
    }
    window.location.replace("/");
  }, [auth.storagePartition, queryClient]);
  return useMemo(() => ({ signIn, signOut }), [signIn, signOut]);
}

export function AuthCacheBoundary({
  children,
  storagePartition,
}: Readonly<{ children: ReactNode; storagePartition: string | null }>) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (storagePartition === null || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(AUTH_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      handleSignedOutMessage(event.data, storagePartition, () => {
        queryClient.clear();
        window.location.replace("/");
      });
    };
    return () => channel.close();
  }, [queryClient, storagePartition]);
  return children;
}
