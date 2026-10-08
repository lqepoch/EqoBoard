export const ACTION_SCOPES = [
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

export type ActionScope = (typeof ACTION_SCOPES)[number];

const ROLE_SCOPES: Readonly<Record<string, readonly ActionScope[]>> = {
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
};

export function allowlistedRoles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((role): role is string =>
    typeof role === "string" && Object.hasOwn(ROLE_SCOPES, role),
  ))];
}

export function scopesForRoles(roles: readonly string[]): ActionScope[] {
  const scopes = new Set<ActionScope>();
  for (const role of roles) {
    for (const scope of ROLE_SCOPES[role] ?? []) scopes.add(scope);
  }
  return [...scopes];
}

export function isActionScope(value: unknown): value is ActionScope {
  return typeof value === "string" && (ACTION_SCOPES as readonly string[]).includes(value);
}
