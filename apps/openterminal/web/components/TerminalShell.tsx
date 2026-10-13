"use client";

import dynamic from "next/dynamic";
import MarketStreamProvider from "./MarketStreamProvider";
import SignOutButton from "./SignOutButton";

const Terminal = dynamic(() => import("./Terminal"), { ssr: false });

export default function TerminalShell({
  userName,
  researchOrigin,
  localAccess = false,
}: {
  userName: string;
  researchOrigin: string | null;
  localAccess?: boolean;
}) {
  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#0b0e14]">
      {!localAccess && (
        <div className="h-6 bg-[#0a0e14] border-b border-[#1e293b] px-3 flex items-center justify-between text-[10px] font-mono text-slate-400 shrink-0 select-none">
          <span>{userName}</span>
          <SignOutButton />
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        <MarketStreamProvider>
          <Terminal researchOrigin={researchOrigin} />
        </MarketStreamProvider>
      </div>
    </div>
  );
}
