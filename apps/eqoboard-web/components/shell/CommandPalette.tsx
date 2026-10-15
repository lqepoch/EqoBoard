"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { useWidgetDataClient } from "@/features/data/MarketDataHost";
import { parseSymbolSearchEnvelope } from "@/features/research/data";
import type {
  ResearchEnvelopeByOperation,
  ResearchSymbolSearchResult,
} from "@/features/research/data";
import { WidgetDataReadError } from "@/widgets/sdk/data";
import { ShellIcon } from "./ShellIcon";
import { useWorkspaceCommandActions } from "./WorkspaceCommandContext";
import {
  getSymbolSearchAvailability,
  getSymbolSearchQueryIssue,
  nextPaletteOptionIndex,
  normalizeSymbolSearchQuery,
  scheduleSymbolSearch,
  symbolSearchErrorMessage,
} from "./symbol-search";

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

type SymbolSearchEnvelope = ResearchEnvelopeByOperation["research.symbolSearch"];

type SymbolSearchState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "restricted"; reason: ReturnType<typeof getSymbolSearchAvailability> }>
  | Readonly<{ status: "debouncing" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready"; envelope: SymbolSearchEnvelope }>
  | Readonly<{ status: "error"; message: string }>;

type PaletteOption =
  | Readonly<{ kind: "command"; key: string; command: ShellCommand; label: string }>
  | Readonly<{ kind: "symbol"; key: string; result: ResearchSymbolSearchResult; label: string }>;

const IDLE_SEARCH: SymbolSearchState = { status: "idle" };

export function CommandPalette({ open, commands, onOpenChange }: CommandPaletteProps) {
  const auth = useAuth();
  const dataClient = useWidgetDataClient();
  const workspaceCommands = useWorkspaceCommandActions();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectionMessage, setSelectionMessage] = useState<string | null>(null);
  const [symbolSearch, setSymbolSearch] = useState<SymbolSearchState>(IDLE_SEARCH);

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

  const normalizedQuery = normalizeSymbolSearchQuery(query);
  const queryIssue = getSymbolSearchQueryIssue(query);
  const showSymbolSearchSection = Boolean(normalizedQuery || queryIssue);
  const symbolSearchAvailability = getSymbolSearchAvailability(auth);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      setQuery("");
      setActiveIndex(0);
      setSelectionMessage(null);
      dialog.showModal();
      inputRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
    if (!open) {
      setQuery("");
      setSelectionMessage(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !normalizedQuery) {
      setSymbolSearch(IDLE_SEARCH);
      return;
    }

    if (symbolSearchAvailability !== "ready") {
      setSymbolSearch({ status: "restricted", reason: symbolSearchAvailability });
      return;
    }

    setSymbolSearch({ status: "debouncing" });
    return scheduleSymbolSearch(
      normalizedQuery,
      async (searchQuery, signal) => {
        const payload = await dataClient.read(
          "research.symbolSearch",
          { query: searchQuery },
          { signal },
        );
        const envelope = parseSymbolSearchEnvelope(payload);
        if (!envelope) throw new WidgetDataReadError("request-failed");
        return envelope;
      },
      {
        onStart: () => setSymbolSearch({ status: "loading" }),
        onResult: (envelope) => setSymbolSearch({ status: "ready", envelope }),
        onError: (error) => {
          const message = symbolSearchErrorMessage(error);
          setSymbolSearch(message ? { status: "error", message } : IDLE_SEARCH);
        },
      },
    );
  }, [dataClient, normalizedQuery, open, symbolSearchAvailability]);

  const options = useMemo<readonly PaletteOption[]>(() => {
    const commandOptions: PaletteOption[] = filteredCommands.map((command) => ({
      kind: "command",
      key: `command-${command.id}`,
      command,
      label: command.label,
    }));
    const symbolOptions: PaletteOption[] = symbolSearch.status === "ready"
      ? symbolSearch.envelope.data.map((result) => ({
        kind: "symbol",
        key: `symbol-${result.symbol}`,
        result,
        label: `Select ${result.symbol}, ${result.name}, ${result.exchange}, ${result.type}`,
      }))
      : [];
    return [...commandOptions, ...symbolOptions];
  }, [filteredCommands, symbolSearch]);

  function runCommand(command: ShellCommand) {
    onOpenChange(false);
    command.run();
  }

  function handleQueryChange(value: string) {
    setQuery(value);
    setActiveIndex(0);
    setSelectionMessage(null);
  }

  function selectSymbol(result: ResearchSymbolSearchResult) {
    try {
      if (!workspaceCommands.selectSymbol(result.symbol)) {
        setSelectionMessage("The active workspace is not ready to change its symbol.");
        return;
      }
      onOpenChange(false);
    } catch {
      setSelectionMessage("The active workspace could not change its symbol. Try again.");
    }
  }

  function activateOption(option: PaletteOption | undefined) {
    if (!option) return;
    if (option.kind === "command") runCommand(option.command);
    else selectSymbol(option.result);
  }

  function focusOption(index: number) {
    if (index < 0 || index >= options.length) return;
    setActiveIndex(index);
    optionRefs.current[index]?.focus();
  }

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;

    if (event.key === "ArrowDown" && options.length > 0) {
      event.preventDefault();
      focusOption(0);
    } else if (event.key === "ArrowUp" && options.length > 0) {
      event.preventDefault();
      focusOption(options.length - 1);
    } else if (event.key === "Enter" && options.length > 0) {
      event.preventDefault();
      activateOption(options[activeIndex] ?? options[0]);
    }
  }

  function handleOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowDown" && options.length > 0) {
      event.preventDefault();
      focusOption(nextPaletteOptionIndex(index, options.length, "next"));
    } else if (event.key === "ArrowUp" && options.length > 0) {
      event.preventDefault();
      focusOption(nextPaletteOptionIndex(index, options.length, "previous"));
    }
  }

  const activeOption = options[activeIndex];
  const searchRestriction = symbolSearch.status === "restricted"
    ? getRestrictionMessage(symbolSearch.reason)
    : null;
  const liveAnnouncement = activeOption
    ? `${activeOption.label}, ${activeIndex + 1} of ${options.length}`
    : symbolSearch.status === "debouncing" || symbolSearch.status === "loading"
      ? "Searching TradingView symbol metadata"
      : symbolSearch.status === "restricted"
        ? getRestrictionMessage(symbolSearch.reason)
        : symbolSearch.status === "error"
          ? symbolSearch.message
          : options.length === 0 ? "No matching commands or symbols" : "";

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
          <span aria-hidden="true" className="eq-command-search-icon">
            <ShellIcon name="search" size={17} />
          </span>
          <input
            aria-label="Search commands and symbols"
            autoComplete="off"
            autoFocus
            className="eq-command-dialog__input"
            data-testid="command-palette-search"
            onChange={(event) => handleQueryChange(event.currentTarget.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="Search commands or symbols"
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
          <section aria-labelledby="eq-command-palette-commands-title">
            <h3
              className="eq-command-dialog__group-title"
              id="eq-command-palette-commands-title"
            >
              Commands
            </h3>
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
                      <span aria-hidden="true" className="eq-command-result-icon">
                        <ShellIcon name="command" size={16} />
                      </span>
                      <span className="eq-command-dialog__item-label">{command.label}</span>
                      {command.shortcut ? (
                        <span className="eq-shortcut">{command.shortcut}</span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="eq-command-dialog__empty">No matching commands</div>
            )}
          </section>

          {showSymbolSearchSection ? (
            <section
              aria-labelledby="eq-command-palette-symbols-title"
              data-testid="command-symbol-results"
            >
              <h3
                className="eq-command-dialog__group-title"
                id="eq-command-palette-symbols-title"
              >
                Symbols
              </h3>
              {queryIssue ? (
                <div
                  className="eq-command-dialog__notice"
                  data-testid="command-symbol-search-state"
                  role="status"
                >
                  {queryIssue === "too-long"
                    ? "Symbol search is limited to 64 characters."
                    : "Symbol search does not accept control characters."}
                </div>
              ) : symbolSearch.status === "restricted" ? (
                <div
                  className="eq-command-dialog__notice"
                  data-testid="command-symbol-search-state"
                  role="status"
                >
                  {searchRestriction}
                </div>
              ) : symbolSearch.status === "debouncing" || symbolSearch.status === "loading" ? (
                <div
                  className="eq-command-dialog__notice"
                  data-testid="command-symbol-search-state"
                  role="status"
                >
                  Searching TradingView symbol metadata…
                </div>
              ) : symbolSearch.status === "error" ? (
                <div
                  className="eq-command-dialog__notice"
                  data-testid="command-symbol-search-state"
                  role="alert"
                >
                  {symbolSearch.message}
                </div>
              ) : symbolSearch.status === "ready" ? (
                <>
                  <SymbolSearchAttribution envelope={symbolSearch.envelope} />
                  {symbolSearch.envelope.data.length > 0 ? (
                    <ul aria-label="Symbol metadata results" className="eq-command-dialog__list">
                      {symbolSearch.envelope.data.map((result, index) => {
                        const optionIndex = filteredCommands.length + index;
                        return (
                          <li className="eq-command-dialog__option" key={result.symbol}>
                            <button
                              aria-label={
                                `Select ${result.symbol}, ${result.name}, ` +
                                `${result.exchange}, ${result.type}`
                              }
                              className="eq-command-dialog__item eq-command-dialog__symbol-item"
                              data-active={optionIndex === activeIndex}
                              data-testid={`command-symbol-result-${result.symbol}`}
                              id={`eq-symbol-option-${encodeURIComponent(result.symbol)}`}
                              onClick={() => selectSymbol(result)}
                              onFocus={() => setActiveIndex(optionIndex)}
                              onKeyDown={(event) => handleOptionKeyDown(event, optionIndex)}
                              onMouseEnter={() => setActiveIndex(optionIndex)}
                              ref={(element) => { optionRefs.current[optionIndex] = element; }}
                              type="button"
                            >
                              <span aria-hidden="true" className="eq-command-result-icon">
                                <ShellIcon name="workspace" size={16} />
                              </span>
                              <span className="eq-command-dialog__item-label">
                                <span className="eq-command-dialog__symbol-name">
                                  {result.symbol} <span>{result.name}</span>
                                </span>
                                <span className="eq-command-dialog__symbol-meta">
                                  {result.exchange} · {result.type}
                                  {result.providerSymbol === result.symbol
                                    ? ""
                                    : ` · TradingView ${result.providerSymbol}`}
                                </span>
                              </span>
                              <span className="eq-command-dialog__select-hint">Select</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <div
                      className="eq-command-dialog__empty"
                      data-testid="command-symbol-search-state"
                      role="status"
                    >
                      No symbol matches for “{normalizedQuery}”.
                    </div>
                  )}
                  {symbolSearch.envelope.status === "partial" ||
                  symbolSearch.envelope.completeness.truncated ? (
                    <p className="eq-command-dialog__warning">
                      Some metadata results may be incomplete.
                    </p>
                  ) : null}
                  {symbolSearch.envelope.warning ? (
                    <p className="eq-command-dialog__warning">
                      {symbolSearch.envelope.warning}
                    </p>
                  ) : null}
                </>
              ) : (
                <div
                  className="eq-command-dialog__notice"
                  data-testid="command-symbol-search-state"
                  role="status"
                >
                  Type a symbol or company name to search.
                </div>
              )}
            </section>
          ) : null}
        </div>
        {selectionMessage ? (
          <div className="eq-command-dialog__warning" role="status">
            {selectionMessage}
          </div>
        ) : null}
        <span aria-live="polite" className="eq-visually-hidden">{liveAnnouncement}</span>
        <div className="eq-command-dialog__footer" id="eq-command-palette-help">
          <span>↑ ↓ Move</span><span>Enter Select</span><span>Esc Close</span>
        </div>
      </div>
    </dialog>
  );
}

function SymbolSearchAttribution({ envelope }: { envelope: SymbolSearchEnvelope }) {
  return (
    <div className="eq-command-dialog__attribution" data-testid="command-symbol-source">
      <span>
        Source: <a
          href={envelope.source.providerUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          {envelope.source.provider}
        </a>
      </span>
      <span>Reference metadata only · not live market data or SIP quotes</span>
    </div>
  );
}

function getRestrictionMessage(reason: ReturnType<typeof getSymbolSearchAvailability>): string {
  switch (reason) {
    case "identity-unavailable": return "Sign-in is unavailable; symbol search is closed.";
    case "policy-rejected": return "This account cannot search symbols.";
    case "sign-in-required": return "Sign in with research access to search.";
    case "terminal-runtime-required": return "Use the terminal session to search symbols.";
    case "research-permission-required": return "Research access is required to search symbols.";
    case "ready": return "Type a symbol or company name to search.";
  }
}
