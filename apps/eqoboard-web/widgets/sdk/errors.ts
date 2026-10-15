import { isPermission } from "../../lib/contracts/auth";
import { WidgetDataReadError } from "./data";
import type { WidgetRuntimeError } from "./contracts";

const SAFE_CODES = new Set<WidgetRuntimeError["code"]>([
  "manifest-invalid",
  "unsupported-version",
  "config-invalid",
  "permission-missing",
  "rate-limited",
  "data-unavailable",
  "request-failed",
  "render-failed",
  "cancelled",
]);

function ownDataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.enumerable && "value" in descriptor ? descriptor.value : undefined;
}

/** Maps arbitrary thrown values to a small UI-safe error union without raw messages. */
export function toWidgetRuntimeError(value: unknown): WidgetRuntimeError {
  try {
    if (value instanceof WidgetDataReadError) {
      const code = ownDataValue(value, "code");
      if (
        code === "cancelled" ||
        code === "suspended" ||
        code === "disposed" ||
        code === "hidden"
      ) {
        return { code: "cancelled", retryable: false };
      }
      if (code === "rate-limited") {
        const retryAfterMs = ownDataValue(value, "retryAfterMs");
        return {
          code: "rate-limited",
          retryable: true,
          ...(Number.isSafeInteger(retryAfterMs) && (retryAfterMs as number) > 0
            ? { retryAfterMs: Math.min(retryAfterMs as number, 60_000) }
            : {}),
        };
      }
      return { code: "request-failed", retryable: true };
    }
  } catch {
    return { code: "request-failed", retryable: true };
  }
  if (value !== null && typeof value === "object") {
    try {
      const code = ownDataValue(value, "code");
      const permission = ownDataValue(value, "permission");
      if (code === "permission-missing" && isPermission(permission)) {
        return { code: "permission-missing", permission, retryable: false };
      }
      if (typeof code === "string" && SAFE_CODES.has(code as WidgetRuntimeError["code"])) {
        switch (code) {
          case "manifest-invalid":
          case "unsupported-version":
          case "config-invalid":
          case "render-failed":
            return { code, retryable: false };
          case "data-unavailable":
          case "request-failed": {
            const retryable = ownDataValue(value, "retryable");
            return {
              code,
              retryable: typeof retryable === "boolean" ? retryable : true,
            };
          }
          case "cancelled":
            return { code: "cancelled", retryable: false };
          case "rate-limited": {
            const retryAfterMs = ownDataValue(value, "retryAfterMs");
            return {
              code: "rate-limited",
              retryable: true,
              ...(Number.isSafeInteger(retryAfterMs) && (retryAfterMs as number) > 0
                ? { retryAfterMs: Math.min(retryAfterMs as number, 60_000) }
                : {}),
            };
          }
          default:
            break;
        }
      }
    } catch {
      // Proxy/getter exceptions are treated as an unknown safe failure.
    }
  }
  return { code: "request-failed", retryable: true };
}

/** Stable user-facing labels; never display response bodies or exception text. */
export function widgetErrorMessage(error: WidgetRuntimeError): string {
  switch (error.code) {
    case "permission-missing":
      return "You do not have permission to view this widget.";
    case "rate-limited":
      return "This widget is refreshing too often. Try again shortly.";
    case "data-unavailable":
      return "Data is currently unavailable.";
    case "cancelled":
      return "This widget is paused.";
    case "config-invalid":
      return "This widget configuration is not supported.";
    case "manifest-invalid":
    case "unsupported-version":
      return "This widget version is not supported.";
    case "render-failed":
    case "request-failed":
      return "This widget could not be loaded.";
  }
}
