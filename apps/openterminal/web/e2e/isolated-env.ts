const FORBIDDEN_HOST_CREDENTIALS = [
  "ALPACA_KEY",
  "ALPACA_SECRET",
  "EQO_GATEWAY_JWT_SECRET",
  "EQO_RESEARCH_JWT_SECRET",
  "MDP_TERMINAL_JWT_SECRET",
  "MDP_RESEARCH_JWT_SECRET",
  "QUANT_TERMINAL_JWT_SECRET",
  "QUANT_RESEARCH_JWT_SECRET",
  "ENGINE_TERMINAL_JWT_SECRET",
  "ENGINE_RESEARCH_JWT_SECRET",
  "EQO_QUANT_RESEARCH_URL",
  "EQO_ENGINE_URL",
  "EQO_RESEARCH_API_KEY",
  "EQO_OIDC_CLIENT_SECRET",
  "NEXTAUTH_SECRET",
  "EQO_ADAPTER_ALPACA_TOKEN",
  "EQO_ADAPTER_IBKR_TOKEN",
  "EQO_ADAPTER_SCHWAB_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "GITHUB_TOKEN",
] as const;

/** Refuse to start host-side E2E/mock processes in an operator credential shell. */
export function assertHostE2eEnvironmentIsIsolated(): void {
  const present = FORBIDDEN_HOST_CREDENTIALS.filter((name) => Boolean(process.env[name]));
  if (present.length > 0) {
    throw new Error(`E2E host environment contains forbidden credentials: ${present.join(", ")}`);
  }
}
