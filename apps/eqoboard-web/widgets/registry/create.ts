import {
  parseWidgetConfigData,
  parseWidgetInstanceV1,
  parseWidgetManifestV1,
} from "../sdk/manifest";
import { isWidgetActionId } from "../sdk/actions";
import type { WidgetInstanceV1, WidgetShortcut } from "../sdk/contracts";
import type {
  AnyWidgetRegistration,
  BuiltinProvenance,
  WidgetConfigParseResult,
  WidgetInstanceResolution,
  WidgetRegistry,
} from "./types";

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export type WidgetRegistryDefinitionErrorCode =
  | "invalid-manifest"
  | "invalid-provenance"
  | "invalid-capabilities"
  | "invalid-registration"
  | "duplicate-manifest-id"
  | "duplicate-config-schema"
  | "duplicate-renderer-id"
  | "duplicate-shortcut"
  | "invalid-default-config";

export class WidgetRegistryDefinitionError extends Error {
  readonly code: WidgetRegistryDefinitionErrorCode;

  constructor(code: WidgetRegistryDefinitionErrorCode) {
    super(code);
    this.name = "WidgetRegistryDefinitionError";
    this.code = code;
  }
}

function boundedText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !hasControlCharacters(value)
  );
}

function safeRelativePath(value: string): boolean {
  return (
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value.split("/").every((segment) => segment !== ".." && segment !== ".")
  );
}

function safeSourcePaths(value: string): boolean {
  return value.split(";").every((sourcePath) => {
    const path = sourcePath.trim();
    return boundedText(path, 320) && safeRelativePath(path);
  });
}

function readCapabilityIds(
  value: unknown,
  validId: (value: string) => boolean,
): readonly string[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(value as object);
    const lengthDescriptor = descriptors.length;
    if (
      !lengthDescriptor ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value > 96 ||
      ownKeys.length !== lengthDescriptor.value + 1
    )
      return null;
    const length = lengthDescriptor.value;
    const result: string[] = [];
    for (const key of ownKeys) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= length)
        return null;
      const descriptor = descriptors[key];
      if (
        !descriptor?.enumerable ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "string" ||
        !validId(descriptor.value)
      )
        return null;
      result.push(descriptor.value);
    }
    if (result.length !== length || new Set(result).size !== result.length) return null;
    return Object.freeze(result);
  } catch {
    return null;
  }
}

function validProvenance(value: BuiltinProvenance, expectedProvenanceId: string): boolean {
  if (
    !boundedText(value.provenanceId, 120) ||
    value.provenanceId !== expectedProvenanceId ||
    (value.origin !== "first-party" && value.origin !== "adapted-upstream") ||
    !boundedText(value.sourceRepository, 200) ||
    !boundedText(value.sourcePath, 320) ||
    !safeSourcePaths(value.sourcePath) ||
    !boundedText(value.auditReference, 240)
  )
    return false;
  if (value.sourceCommit !== null && !/^[0-9a-f]{40}$/iu.test(value.sourceCommit)) return false;
  if (value.license !== null && !boundedText(value.license, 120)) return false;
  if (
    value.noticePath !== null &&
    (!boundedText(value.noticePath, 320) || !safeRelativePath(value.noticePath))
  )
    return false;
  if (
    value.origin === "adapted-upstream" &&
    (value.sourceCommit === null || value.license === null || value.noticePath === null)
  )
    return false;
  if (value.origin === "first-party" && value.sourceCommit !== null) return false;
  return true;
}

function registryDefinitionError(error: unknown): WidgetRegistryDefinitionError {
  if (error instanceof WidgetRegistryDefinitionError) return error;
  return new WidgetRegistryDefinitionError("invalid-registration");
}

function parseRegisteredConfig(
  registration: AnyWidgetRegistration,
  value: unknown,
): WidgetConfigParseResult {
  const bounded = parseWidgetConfigData(value);
  if (!bounded.ok) return { ok: false, code: "config-invalid" };
  try {
    const result = registration.parseConfig(bounded.value);
    if (result && result.ok === true) {
      const canonical = parseWidgetConfigData(result.value);
      if (!canonical.ok) return { ok: false, code: "config-invalid" };
      return { ok: true, value: canonical.value };
    }
    const field = result && result.ok === false ? result.field : undefined;
    return { ok: false, code: "config-invalid", ...(field ? { field } : {}) };
  } catch {
    return { ok: false, code: "config-invalid" };
  }
}

/**
 * Builds a registry from statically imported compiled entries. This does not load
 * modules, resolve paths, or trust manifest-supplied executable content.
 */
export function createWidgetRegistry(entries: readonly AnyWidgetRegistration[]): WidgetRegistry {
  const byManifestId = new Map<string, AnyWidgetRegistration>();
  const byConfigSchema = new Map<string, AnyWidgetRegistration>();
  const byShortcut = new Map<WidgetShortcut, AnyWidgetRegistration>();
  const rendererIds = new Set<string>();
  const normalized: AnyWidgetRegistration[] = [];

  for (const entry of entries) {
    try {
      if (
        !entry ||
        typeof entry !== "object" ||
        entry.Component === undefined ||
        entry.Component === null ||
        typeof entry.parseConfig !== "function" ||
        typeof entry.createDefaultConfig !== "function"
      ) {
        throw new WidgetRegistryDefinitionError("invalid-registration");
      }
      const allowedReadOperations = readCapabilityIds(entry.allowedReadOperations, (value) =>
        /^[A-Za-z][A-Za-z0-9.-]{0,95}$/u.test(value),
      );
      const allowedActions = readCapabilityIds(entry.allowedActions, (value) =>
        isWidgetActionId(value),
      );
      if (allowedReadOperations === null || allowedActions === null) {
        throw new WidgetRegistryDefinitionError("invalid-capabilities");
      }
      const parsed = parseWidgetManifestV1(entry.manifest);
      if (!parsed.ok) throw new WidgetRegistryDefinitionError("invalid-manifest");
      const manifest = parsed.value;
      if (!validProvenance(entry.provenance, manifest.provenanceId)) {
        throw new WidgetRegistryDefinitionError("invalid-provenance");
      }
      if (byManifestId.has(manifest.id))
        throw new WidgetRegistryDefinitionError("duplicate-manifest-id");
      if (byConfigSchema.has(manifest.configSchemaId))
        throw new WidgetRegistryDefinitionError("duplicate-config-schema");
      if (rendererIds.has(manifest.rendererId))
        throw new WidgetRegistryDefinitionError("duplicate-renderer-id");
      if (manifest.shortcut && byShortcut.has(manifest.shortcut)) {
        throw new WidgetRegistryDefinitionError("duplicate-shortcut");
      }
      const defaultConfig = entry.createDefaultConfig();
      const defaultResult = parseRegisteredConfig(entry, defaultConfig);
      if (!defaultResult.ok) {
        throw new WidgetRegistryDefinitionError("invalid-default-config");
      }
      const provenance = Object.freeze({ ...entry.provenance });
      const registration = Object.freeze({
        ...entry,
        manifest,
        allowedReadOperations,
        allowedActions,
        provenance,
      }) as AnyWidgetRegistration;
      byManifestId.set(manifest.id, registration);
      byConfigSchema.set(manifest.configSchemaId, registration);
      if (manifest.shortcut) byShortcut.set(manifest.shortcut, registration);
      rendererIds.add(manifest.rendererId);
      normalized.push(registration);
    } catch (error) {
      throw registryDefinitionError(error);
    }
  }

  const list = Object.freeze([...normalized]);
  return Object.freeze({
    get(manifestId: string) {
      return byManifestId.get(manifestId);
    },
    list() {
      return list;
    },
    getByShortcut(shortcut: WidgetShortcut) {
      return byShortcut.get(shortcut);
    },
    parseConfig(configSchemaId: string, value: unknown): WidgetConfigParseResult {
      const registration = byConfigSchema.get(configSchemaId);
      if (!registration) return { ok: false, code: "unsupported-config-schema" };
      return parseRegisteredConfig(registration, value);
    },
    resolveInstance(instance: WidgetInstanceV1): WidgetInstanceResolution {
      const parsedInstance = parseWidgetInstanceV1(instance);
      if (!parsedInstance.ok) return { status: "invalid-instance" };
      const value = parsedInstance.value;
      const registration = byManifestId.get(value.manifestId);
      if (!registration) return { status: "unsupported-manifest" };
      if (registration.manifest.version !== value.manifestVersion) {
        return { status: "unsupported-manifest-version" };
      }
      if (registration.manifest.configSchemaId !== value.configSchemaId) {
        return { status: "unsupported-config-schema" };
      }
      if (value.symbolBinding && registration.manifest.symbolBinding !== "active-or-fixed") {
        return { status: "unsupported-symbol-binding" };
      }
      const result = parseRegisteredConfig(registration, value.config);
      if (!result.ok) return { status: "config-invalid" };
      return {
        status: "ready",
        registration,
        config: result.value,
        ...(registration.manifest.symbolBinding === "active-or-fixed"
          ? { effectiveSymbolBinding: value.symbolBinding ?? { mode: "active" as const } }
          : {}),
      };
    },
  });
}
