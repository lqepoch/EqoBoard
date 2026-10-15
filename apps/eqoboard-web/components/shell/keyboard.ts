export type ShortcutTarget = {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
  parentElement?: ShortcutTarget | null;
};

type ShortcutEventTarget = EventTarget | ShortcutTarget;

export type CommandPaletteKeyEvent = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "defaultPrevented" | "repeat" | "target"
>;

const TEXT_ENTRY_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function isTextEntryTarget(target: ShortcutEventTarget | null): boolean {
  let current = target as unknown as ShortcutTarget | null;
  while (current) {
    const tagName = current.tagName?.toUpperCase();
    const role = current.getAttribute?.("role");
    const contentEditable = current.getAttribute?.("contenteditable");

    if (
      (tagName && TEXT_ENTRY_TAGS.has(tagName)) ||
      current.isContentEditable ||
      contentEditable === "" ||
      contentEditable === "true" ||
      contentEditable === "plaintext-only" ||
      role === "textbox" ||
      role === "searchbox"
    ) {
      return true;
    }

    current = current.parentElement ?? null;
  }

  return false;
}

export function isInsideDialog(
  target: ShortcutEventTarget | null,
  allowedDialogId?: string,
): boolean {
  let current = target as unknown as ShortcutTarget | null;
  while (current) {
    const tagName = current.tagName?.toUpperCase();
    const role = current.getAttribute?.("role");
    const isDialog = tagName === "DIALOG" || role === "dialog" || role === "alertdialog";
    if (isDialog && current.getAttribute?.("id") !== allowedDialogId) return true;
    current = current.parentElement ?? null;
  }
  return false;
}

export function shouldOpenCommandPalette(
  event: CommandPaletteKeyEvent,
  allowedDialogId?: string,
): boolean {
  return (
    !event.defaultPrevented &&
    !event.isComposing &&
    !event.repeat &&
    !event.altKey &&
    !event.shiftKey &&
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === "k" &&
    !isTextEntryTarget(event.target) &&
    !isInsideDialog(event.target, allowedDialogId)
  );
}
