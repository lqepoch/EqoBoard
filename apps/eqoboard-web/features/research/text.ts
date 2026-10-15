export function hasControlCharacters(
  value: string,
  options: Readonly<{ allowTextWhitespace?: boolean }> = {},
): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x7f) return true;
    if (code < 0x20) {
      const allowedTextWhitespace =
        options.allowTextWhitespace && (code === 0x09 || code === 0x0a || code === 0x0d);
      if (!allowedTextWhitespace) return true;
    }
  }
  return false;
}
