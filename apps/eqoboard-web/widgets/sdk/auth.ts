import { isPermission, type AuthUiSnapshot } from "../../lib/contracts/auth";
import type { WidgetAuthorizationView } from "./contracts";

/**
 * Reduces the server-authored UI snapshot to the only fields widgets may observe.
 * This is a visibility hint, never authorization for a data request.
 */
export function projectWidgetAuthorization(snapshot: AuthUiSnapshot): WidgetAuthorizationView {
  const permissions = snapshot.authenticated
    ? snapshot.permissions.filter(isPermission)
    : [];
  return Object.freeze({
    authenticated: snapshot.authenticated,
    permissions: Object.freeze(permissions),
  });
}

