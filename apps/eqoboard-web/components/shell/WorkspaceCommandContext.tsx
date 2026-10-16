"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export type ActiveSymbolSelector = (symbol: string) => void;

export type WorkspaceCommandRegistration = Readonly<{
  registerActiveSymbolSelector(selectSymbol: ActiveSymbolSelector): () => void;
}>;

export type WorkspaceCommandActions = Readonly<{
  selectSymbol(symbol: string): boolean;
}>;

type RegisteredSelector = Readonly<{
  token: symbol;
  selectSymbol: ActiveSymbolSelector;
}>;

/** A single active-workspace callback with token-checked disposal across workspace switches. */
export function createWorkspaceCommandRegistry() {
  let active: RegisteredSelector | null = null;

  return Object.freeze({
    registerActiveSymbolSelector(selectSymbol: ActiveSymbolSelector): () => void {
      const token = Symbol("active-workspace-symbol-selector");
      active = Object.freeze({ token, selectSymbol });
      let disposed = false;

      return () => {
        if (disposed) return;
        disposed = true;
        if (active?.token === token) active = null;
      };
    },
    selectSymbol(symbol: string): boolean {
      const current = active;
      if (!current) return false;
      current.selectSymbol(symbol);
      return true;
    },
  });
}

const RegistrationContext = createContext<WorkspaceCommandRegistration | null>(null);
const ActionsContext = createContext<WorkspaceCommandActions | null>(null);

export function WorkspaceCommandProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [registry] = useState(createWorkspaceCommandRegistry);
  const registerActiveSymbolSelector = useCallback(
    (selectSymbol: ActiveSymbolSelector) => registry.registerActiveSymbolSelector(selectSymbol),
    [registry],
  );
  const selectSymbol = useCallback((symbol: string) => registry.selectSymbol(symbol), [registry]);
  const registration = useMemo(
    () => Object.freeze({ registerActiveSymbolSelector }),
    [registerActiveSymbolSelector],
  );
  const actions = useMemo(() => Object.freeze({ selectSymbol }), [selectSymbol]);

  return (
    <RegistrationContext.Provider value={registration}>
      <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>
    </RegistrationContext.Provider>
  );
}

export function useWorkspaceCommandRegistration(): WorkspaceCommandRegistration {
  const value = useContext(RegistrationContext);
  if (!value) {
    throw new Error("WorkspaceCommandProvider is required to register workspace commands.");
  }
  return value;
}

export function useWorkspaceCommandActions(): WorkspaceCommandActions {
  const value = useContext(ActionsContext);
  if (!value) throw new Error("WorkspaceCommandProvider is required to invoke workspace commands.");
  return value;
}
