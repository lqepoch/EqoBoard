/** EqoBoard permission vocabulary; adapted from its existing BFF permission contract.
 * These values retain service compatibility and never enable execution.
 */
export const PERMISSIONS = [
  "market:read",
  "market:stream",
  "market:subscribe",
  "research:read",
  "research:ai",
  "research:private-read",
  "engine:offline-read",
  "workspace:read",
  "workspace:write",
  "orders:preview",
  "paper:submit",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type AuthUiStatus =
  | "identity-unavailable"
  | "policy-rejected"
  | "sign-in-required"
  | "authenticated";

/** Visibility and private-cache partition only; never accepted as server authority. */
export type AuthUiSnapshot = Readonly<{
  status: AuthUiStatus;
  authenticated: boolean;
  displayName: string | null;
  permissions: readonly Permission[];
  /** Server-derived opaque non-secret namespace, null without a verified session. */
  storagePartition: string | null;
  /** Non-authoritative UI routing metadata; the server still enforces runtime isolation. */
  runtimeMode?: "terminal" | "research";
  /** Server-validated distinct-host research origin; never a browser-selected proxy target. */
  researchOrigin?: string | null;
}>;

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}
