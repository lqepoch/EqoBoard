import { describe, expect, it } from "vitest";
import { isInsideDialog, isTextEntryTarget, shouldOpenCommandPalette } from "./keyboard";

function keyEvent(overrides: Record<string, unknown> = {}) {
  return {
    key: "k",
    metaKey: false,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    defaultPrevented: false,
    repeat: false,
    target: null,
    ...overrides,
  } as Parameters<typeof shouldOpenCommandPalette>[0];
}

describe("command palette shortcut", () => {
  it("opens for Control or Command plus K", () => {
    expect(shouldOpenCommandPalette(keyEvent())).toBe(true);
    expect(shouldOpenCommandPalette(keyEvent({ metaKey: true, ctrlKey: false }))).toBe(true);
  });

  it("does not steal typing, modified chords, composition, or handled events", () => {
    expect(shouldOpenCommandPalette(keyEvent({ target: { tagName: "INPUT" } }))).toBe(false);
    expect(shouldOpenCommandPalette(keyEvent({ target: { getAttribute: (name: string) => name === "contenteditable" ? "true" : null } }))).toBe(false);
    expect(shouldOpenCommandPalette(keyEvent({ altKey: true }))).toBe(false);
    expect(shouldOpenCommandPalette(keyEvent({ shiftKey: true }))).toBe(false);
    expect(shouldOpenCommandPalette(keyEvent({ isComposing: true }))).toBe(false);
    expect(shouldOpenCommandPalette(keyEvent({ defaultPrevented: true }))).toBe(false);
    expect(shouldOpenCommandPalette(keyEvent({ repeat: true }))).toBe(false);
    expect(shouldOpenCommandPalette(keyEvent({ key: "p" }))).toBe(false);
  });

  it("recognizes inherited editable regions", () => {
    const target = {
      tagName: "SPAN",
      parentElement: {
        getAttribute: (name: string) => name === "role" ? "textbox" : null,
      },
    };
    expect(isTextEntryTarget(target)).toBe(true);
  });

  it("ignores other dialogs while allowing the shell mobile navigation dialog", () => {
    const nested = {
      tagName: "BUTTON",
      parentElement: {
        tagName: "DIALOG",
        getAttribute: (name: string) => name === "id" ? "widget-dialog" : null,
      },
    };
    const mobileNavigation = {
      tagName: "A",
      parentElement: {
        tagName: "DIALOG",
        getAttribute: (name: string) => name === "id" ? "mobile-navigation-dialog" : null,
      },
    };

    expect(isInsideDialog(nested)).toBe(true);
    expect(shouldOpenCommandPalette(keyEvent({ target: nested }))).toBe(false);
    expect(isInsideDialog(mobileNavigation, "mobile-navigation-dialog")).toBe(false);
    expect(shouldOpenCommandPalette(keyEvent({ target: mobileNavigation }), "mobile-navigation-dialog")).toBe(true);
  });
});
