import { getServerSession } from "next-auth";
import { notFound } from "next/navigation";
import SignInButton from "@/components/SignInButton";
import SignOutButton from "@/components/SignOutButton";
import YfinanceResearchChartPage from "@/components/research/YfinanceResearchChartPage";
import {
  authOptions,
  isCurrentOidcIssuer,
  isResearchAuthRuntimeConfigured,
} from "@/auth";
import { scopesForRoles } from "@/lib/permissions";

export const dynamic = "force-dynamic";

const SYMBOL = /^[A-Z0-9][A-Z0-9.-]{0,31}$/;

export default async function YfinanceResearchPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  if (!SYMBOL.test(symbol)) notFound();
  if (process.env.EQO_BFF_MODE !== "research") notFound();
  if (!isResearchAuthRuntimeConfigured()) {
    return <AccessMessage title="Yahoo research is unavailable">
      The isolated research identity runtime is not configured for this hostname.
    </AccessMessage>;
  }

  let session;
  try {
    session = await getServerSession(authOptions);
  } catch {
    return <AccessMessage title="Identity service unavailable">
      The research page could not verify the current organization session.
    </AccessMessage>;
  }
  if (!session?.user?.id) {
    return <AccessMessage title="Sign in to Yahoo research">
      <SignInButton callbackUrl={`/research/yfinance/${encodeURIComponent(symbol)}`} />
    </AccessMessage>;
  }
  if (!session.user.issuer || !isCurrentOidcIssuer(session.user.issuer)) {
    return <AccessMessage title="Identity configuration changed">
      This session belongs to a previous identity provider configuration. Sign out and authenticate again.
      <SignOutButton />
    </AccessMessage>;
  }
  if (!scopesForRoles(session.user.roles).includes("research:read")) {
    return <AccessMessage title="Research read permission required">
      This Yahoo history view requires the approved market-reader role on the isolated research hostname.
      <SignOutButton />
    </AccessMessage>;
  }

  return <YfinanceResearchChartPage symbol={symbol} />;
}

function AccessMessage({ title, children }: { title: string; children: React.ReactNode }) {
  return <main className="min-h-screen bg-[#080b11] text-slate-100 flex items-center justify-center p-4">
    <section className="max-w-xl border border-[#243149] bg-[#0b0e16] p-5" role="status">
      <h1 className="text-base font-semibold">{title}</h1>
      <div className="mt-3 text-sm text-slate-400">{children}</div>
    </section>
  </main>;
}
