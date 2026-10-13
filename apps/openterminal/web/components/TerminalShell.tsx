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
  return <>
    <div className="terminal-session-controls">
      <span>{userName}</span>
      {!localAccess && <SignOutButton />}
    </div>
    <MarketStreamProvider><Terminal researchOrigin={researchOrigin} /></MarketStreamProvider>
  </>;
}
