"use client";

import { signIn } from "next-auth/react";

export default function SignInButton() {
  return <button
    className="auth-sign-in"
    type="button"
    onClick={() => void signIn("eqo-oidc", { callbackUrl: "/" })}
  >
    Continue with your organization identity provider
  </button>;
}
