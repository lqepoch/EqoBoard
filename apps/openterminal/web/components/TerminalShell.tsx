"use client";

import dynamic from "next/dynamic";
import MarketStreamProvider from "./MarketStreamProvider";
import SignOutButton from "./SignOutButton";

const Terminal = dynamic(() => import("./Terminal"), { ssr: false });

export default function TerminalShell({
  userName,
  researchOrigin,
}: {
  userName: string;
  researchOrigin: string | null;
}) {
  return <>
    <div className="terminal-session-controls">
      <span>{userName}</span>
      <SignOutButton />
    </div>
    <MarketStreamProvider><Terminal researchOrigin={researchOrigin} /></MarketStreamProvider>
  </>;
}
