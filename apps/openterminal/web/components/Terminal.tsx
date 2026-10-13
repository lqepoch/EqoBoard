"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import TopBar from "./TopBar";
import Sidebar from "./Sidebar";
import Workspace from "./Workspace";
import CommandPalette from "./CommandPalette";
import { useTerminal } from "../store/terminal";

const ModernTerminal = dynamic(() => import("./terminal/ModernTerminal"), {
  ssr: false,
});

export default function Terminal({
  researchOrigin,
  localAccess = false,
}: {
  researchOrigin: string | null;
  localAccess?: boolean;
}) {
  const setCommandOpen = useTerminal((s) => s.setCommandOpen);
  const addWidget = useTerminal((s) => s.addWidget);

  const [viewMode, setViewModeState] = useState<"pro" | "workspace">(() => {
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search).get("view");
      if (p === "workspace") return "workspace";
      if (p === "pro") return "pro";
      const saved = localStorage.getItem("eqo_view_mode");
      if (saved === "workspace" || saved === "pro") return saved;
      if (["localhost", "127.0.0.1"].includes(window.location.hostname)) {
        return "pro";
      }
    }
    return localAccess ? "pro" : "workspace";
  });

  const setViewMode = (mode: "pro" | "workspace") => {
    setViewModeState(mode);
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem("eqo_view_mode", mode);
      } catch {}
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandOpen(true);
        return;
      }
      if (e.altKey) {
        const map: Record<string, () => void> = {
          "1": () => addWidget("chart"),
          "2": () => addWidget("quote"),
          "3": () => addWidget("news"),
          "4": () => addWidget("screener"),
          "5": () => addWidget("heatmap"),
          "6": () => addWidget("crypto"),
          "7": () => addWidget("options"),
          "8": () => addWidget("portfolio"),
          "9": () => addWidget("ai"),
        };
        const fn = map[e.key];
        if (fn) {
          e.preventDefault();
          fn();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setCommandOpen, addWidget]);

  if (viewMode === "pro") {
    return (
      <div className="flex flex-col h-full w-full overflow-hidden">
        <ModernTerminal
          researchOrigin={researchOrigin}
          onSwitchToWorkspace={() => setViewMode("workspace")}
        />
        <CommandPalette researchOrigin={researchOrigin} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen">
      <TopBar onSwitchToPro={() => setViewMode("pro")} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar researchOrigin={researchOrigin} />
        <main className="flex-1 overflow-auto">
          <Workspace />
        </main>
      </div>
      <CommandPalette researchOrigin={researchOrigin} />
    </div>
  );
}
