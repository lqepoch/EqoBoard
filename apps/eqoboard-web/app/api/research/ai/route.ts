import { NextResponse } from "next/server";

import { parseResearchAiRequest, type ResearchAiResponse } from "@/features/research/ai";
import { authorizeRequest, readBoundedJson } from "@/lib/server/bff-security";
import { consumePrincipalRateLimit } from "@/lib/server/rate-limit";
import { requireRuntimeMode } from "@/lib/server/runtime-mode";
import { readProviderJson } from "@/lib/server/research/transport";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_REQUEST_BYTES = 16 * 1024;
const SYSTEM_PROMPT = "You are the EqoBoard research assistant. Respond concisely and professionally in the language the user writes in. Do not claim access to market data unless the user provides it in the prompt. You are not a licensed financial adviser; do not give personalized investment advice or tell the user what to buy or sell. Identify uncertainty and distinguish analysis from verified provider observations.";

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function POST(request: Request): Promise<NextResponse> {
  const modeError = requireRuntimeMode("terminal", request);
  if (modeError) return modeError;
  const authorization = await authorizeRequest(request, "research:ai");
  if (!authorization.ok) return authorization.response;
  const limited = await consumePrincipalRateLimit(authorization.principal, {
    bucket: "native-research:ai",
    maxRequests: 10,
    windowMs: 60_000,
  });
  if (!limited.allowed) {
    return NextResponse.json({ error: "research_ai_rate_limited" }, {
      status: 429,
      headers: { "Cache-Control": "no-store", "Retry-After": String(limited.retryAfterSeconds) },
    });
  }
  const body = await readBoundedJson(request, MAX_REQUEST_BYTES);
  if (!body.ok) return body.response;
  const parsed = parseResearchAiRequest(body.value);
  if (!parsed.ok) return errorResponse("invalid_research_ai_request", 400);

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return errorResponse("research_ai_unconfigured", 503);
  const modelValue = process.env.ANTHROPIC_MODEL?.trim() || "claude-opus-4-8";
  if (!/^[a-zA-Z0-9._-]{1,96}$/u.test(modelValue)) return errorResponse("research_ai_unconfigured", 503);

  try {
    const result = await readProviderJson<unknown>(new URL("https://api.anthropic.com/v1/messages"), {
      method: "POST",
      timeoutMs: 15_000,
      maxBytes: 64 * 1024,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: modelValue,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: parsed.value.messages,
      }),
    });
    if (!isRecord(result) || !Array.isArray(result.content)) return errorResponse("research_ai_response_invalid", 502);
    const text = result.content.flatMap((block): string[] => {
      if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return [];
      return [block.text];
    }).join("").slice(0, 24_000);
    if (text.trim() === "") return errorResponse("research_ai_response_invalid", 502);
    const output: ResearchAiResponse = Object.freeze({
      schemaVersion: 1,
      text: result.stop_reason === "refusal" ? "The AI provider declined this request." : text,
      generatedAt: new Date().toISOString(),
      provider: "Anthropic",
    });
    return NextResponse.json(output, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return errorResponse("research_ai_unavailable", 502);
  }
}
