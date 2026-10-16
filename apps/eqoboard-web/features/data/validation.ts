/** Shared fail-closed guards for JSON-like values crossing the browser boundary. */
export function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Rejects symbols, accessors, and non-enumerable properties on parsed records. */
export function hasOnlyEnumerableDataProperties(value: object): boolean {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = descriptors[key];
      return descriptor?.enumerable === true && "value" in descriptor;
    });
  } catch {
    return false;
  }
}
