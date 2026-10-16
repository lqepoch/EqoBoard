import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getAuthUiSnapshot } from "@/lib/server/auth";
import { Providers } from "./providers";
import "@/styles/globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "EqoBoard",
  description: "A secure, source-aware market research workspace.",
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const auth = await getAuthUiSnapshot();

  return (
    <html data-theme="dark" lang="en">
      <body>
        <Providers auth={auth}>{children}</Providers>
      </body>
    </html>
  );
}
