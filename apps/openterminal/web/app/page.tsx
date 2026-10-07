import { getServerSession } from "next-auth";
import { authOptions, isAuthRuntimeConfigured, isCurrentOidcIssuer } from "@/auth";
import { scopesForRoles } from "@/lib/permissions";
import TerminalShell from "../components/TerminalShell";
import SignOutButton from "../components/SignOutButton";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!isAuthRuntimeConfigured()) {
    return <AuthMessage title="Sign-in is not configured">
      Configure the OIDC issuer, client, session secret, gateway signing keys, and public HTTPS origin before using the terminal.
    </AuthMessage>;
  }

  let session;
  try {
    session = await getServerSession(authOptions);
  } catch {
    return <AuthMessage title="Identity service unavailable">
      The terminal cannot verify your session. Check the server identity configuration and try again.
    </AuthMessage>;
  }

  if (!session?.user?.id) {
    return <AuthMessage title="Sign in to EqoBoard">
      <a className="auth-sign-in" href="/api/auth/signin/eqo-oidc">Continue with your organization identity provider</a>
    </AuthMessage>;
  }

  if (!session.user.issuer || !isCurrentOidcIssuer(session.user.issuer)) {
    return <AuthMessage title="Identity configuration changed">
      This session belongs to a previous identity provider configuration. Sign out and authenticate again.
      <SignOutButton />
    </AuthMessage>;
  }

  if (scopesForRoles(session.user.roles).length === 0) {
    return <AuthMessage title="This account has no EqoBoard permissions">
      Ask your identity administrator to assign an approved EqoBoard role, then sign in again.
      <SignOutButton />
    </AuthMessage>;
  }

  return <TerminalShell userName={session.user.name ?? session.user.id} />;
}

function AuthMessage({ title, children }: { title: string; children: React.ReactNode }) {
  return <main className="auth-message">
    <section className="auth-message-card" role="status">
      <h1>{title}</h1>
      <div>{children}</div>
    </section>
  </main>;
}
