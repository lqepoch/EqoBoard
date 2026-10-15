/** The same canonical workspace symbol boundary used for persisted market context. */
export function isWidgetSymbol(value: unknown): value is string {
  return typeof value === "string" && value === value.toUpperCase() &&
    /^(?=.*[A-Z0-9])[A-Z0-9.\-^=&]{1,24}$/u.test(value);
}
