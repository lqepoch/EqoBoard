/** Server-to-server credential for the private OpenTerminal research API. */
export function getResearchServiceKey(): string | null {
  return process.env.EQO_RESEARCH_API_KEY?.trim() || null;
}
