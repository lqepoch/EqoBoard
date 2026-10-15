import "server-only";

import { isPermission, type Permission } from "../contracts/auth";

/** This role map intentionally mirrors the existing verified OIDC policy. */
const ROLE_PERMISSIONS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  "eqoboard-market-reader": [
    "market:read",
    "market:stream",
    "market:subscribe",
    "research:read",
    "workspace:read",
  ],
  "eqoboard-workspace-editor": ["workspace:write"],
  "eqoboard-private-research-reader": ["research:private-read", "workspace:read"],
  "eqoboard-engine-offline-reader": ["engine:offline-read"],
  "eqoboard-order-reviewer": ["orders:preview"],
  "eqoboard-paper-operator": ["paper:submit"],
});

export function allowlistedRoles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((role): role is string =>
    typeof role === "string" && Object.hasOwn(ROLE_PERMISSIONS, role),
  ))];
}

export function permissionsForRoles(roles: readonly string[]): Permission[] {
  const permissions = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) permissions.add(permission);
  }
  return [...permissions].filter(isPermission).sort();
}

export function isAllowlistedRole(value: unknown): value is string {
  return typeof value === "string" && Object.hasOwn(ROLE_PERMISSIONS, value);
}
