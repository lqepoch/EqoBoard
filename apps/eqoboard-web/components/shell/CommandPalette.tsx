"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ShellIcon } from "./ShellIcon";

export type ShellCommand = Readonly<{
  id: string;
  label: string;
  keywords?: readonly string[];
  shortcut?: string;
  run: () => void;
}>;

type CommandPaletteProps = {
  open: boolean;
  commands: readonly ShellCommand[];
  onOpenChange: (open: boolean) => void;
};

export function CommandPalette({ open, commands, onOpenChange }: CommandPaletteProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const filteredCommands = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return commands;
    return commands.filter((command) =>
      [command.label, ...(command.keywords ?? [])]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [commands, query]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      setQuery("");
      setActiveIndex(0);
      dialog.showModal();
      inputRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  function runCommand(command: ShellCommand) {
    onOpenChange(false);
    command.run();
  }

  function focusOption(index: number) {
    setActiveIndex(index);
    optionRefs.current[index]?.focus();
  }

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;

    if (event.key === "ArrowDown" && filteredCommands.length > 0) {
      event.preventDefault();
      focusOption(0);
    } else if (event.key === "ArrowUp" && filteredCommands.length > 0) {
      event.preventDefault();
      focusOption(filteredCommands.length - 1);
    } else if (event.key === "Enter" && filteredCommands[activeIndex]) {
      event.preventDefault();
      runCommand(filteredCommands[activeIndex]);
    }
  }

  function handleOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowDown" && filteredCommands.length > 0) {
      event.preventDefault();
      focusOption((index + 1) % filteredCommands.length);
    } else if (event.key === "ArrowUp" && filteredCommands.length > 0) {
      event.preventDefault();
      focusOption((index - 1 + filteredCommands.length) % filteredCommands.length);
    }
  }

  return (
    <dialog
      aria-labelledby="eq-command-palette-title"
      className="eq-command-dialog"
      data-testid="command-palette"
      id="eq-command-palette-dialog"
      onClose={() => onOpenChange(false)}
      ref={dialogRef}
    >
      <div className="eq-command-dialog__form">
        <div className="eq-command-dialog__search-row">
          <span aria-hidden="true" className="eq-command-search-icon"><ShellIcon name="search" size={17} /></span>
          <input
            aria-label="Search commands"
            autoComplete="off"
            autoFocus
            className="eq-command-dialog__input"
            data-testid="command-palette-search"
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="Search commands"
            ref={inputRef}
            type="search"
            value={query}
            aria-controls="eq-command-palette-list"
            aria-describedby="eq-command-palette-help"
          />
          <button
            aria-label="Close command palette"
            className="eq-dialog-close"
            onClick={() => onOpenChange(false)}
            type="button"
          >
            <ShellIcon name="close" size={16} />
          </button>
        </div>
        <h2 className="eq-visually-hidden" id="eq-command-palette-title">Command palette</h2>
        <div className="eq-command-dialog__results" id="eq-command-palette-list">
          {filteredCommands.length ? (
            <ul aria-label="Available commands" className="eq-command-dialog__list">
              {filteredCommands.map((command, index) => (
                <li className="eq-command-dialog__option" key={command.id}>
                  <button
                    className="eq-command-dialog__item"
                    data-active={index === activeIndex}
                    id={`eq-command-option-${command.id}`}
                    onClick={() => runCommand(command)}
                    onFocus={() => setActiveIndex(index)}
                    onKeyDown={(event) => handleOptionKeyDown(event, index)}
                    onMouseEnter={() => setActiveIndex(index)}
                    ref={(element) => { optionRefs.current[index] = element; }}
                    type="button"
                  >
                    <span aria-hidden="true" className="eq-command-result-icon"><ShellIcon name="command" size={16} /></span>
                    <span className="eq-command-dialog__item-label">{command.label}</span>
                    {command.shortcut ? <span className="eq-shortcut">{command.shortcut}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="eq-command-dialog__empty">No matching commands</div>
          )}
        </div>
        <span aria-live="polite" className="eq-visually-hidden">
          {filteredCommands[activeIndex]
            ? `${filteredCommands[activeIndex].label}, ${activeIndex + 1} of ${filteredCommands.length}`
            : "No matching commands"}
        </span>
        <div className="eq-command-dialog__footer" id="eq-command-palette-help">
          <span>↑ ↓ Move</span><span>Enter Run</span><span>Esc Close</span>
        </div>
      </div>
    </dialog>
  );
}
