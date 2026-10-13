"use client";

import dynamic from "next/dynamic";

const ModernTerminal = dynamic(() => import("./terminal/ModernTerminal"), {
  ssr: false,
});

export default function Terminal({
  researchOrigin,
}: {
  researchOrigin: string | null;
}) {
  return <ModernTerminal researchOrigin={researchOrigin} />;
}
