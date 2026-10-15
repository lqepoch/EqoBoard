import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeRequest, readBoundedJson } from "@/lib/server/bff-security";
import { consumePrincipalRateLimit } from "@/lib/server/rate-limit";
import { requireRuntimeMode } from "@/lib/server/runtime-mode";
import { readProviderJson } from "@/lib/server/research/transport";
import { POST } from "./route";

vi.mock("@/lib/server/bff-security", () => ({ authorizeRequest: vi.fn(), readBoundedJson: vi.fn() }));
vi.mock("@/lib/server/rate-limit", () => ({ consumePrincipalRateLimit: vi.fn() }));
vi.mock("@/lib/server/runtime-mode", () => ({ requireRuntimeMode: vi.fn() }));
vi.mock("@/lib/server/research/transport", () => ({ readProviderJson: vi.fn() }));

const principal = Object.freeze({
  identityIssuer: "https://identity.example",
  subject: "test-user",
  permissions: ["research:ai"],
  sessionExpiresAt: Date.now() + 60_000,
});

function request(): Request {
  return new Request("https://terminal.example/api/research/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://terminal.example" },
    body: JSON.stringify({ messages: [{ role: "user", content: "Summarize these notes." }] }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireRuntimeMode).mockReturnValue(null);
  vi.mocked(authorizeRequest).mockResolvedValue({ ok: true, principal } as never);
  vi.mocked(consumePrincipalRateLimit).mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  vi.mocked(readBoundedJson).mockResolvedValue({
    ok: true,
    value: { messages: [{ role: "user", content: "Summarize these notes." }] },
    text: "{}",
  });
});

describe("terminal-only native AI research action", () => {
  it("hides the action in Research mode before identity, body, or provider work", async () => {
    vi.mocked(requireRuntimeMode).mockReturnValue(new Response(JSON.stringify({ error: "not_found" }), { status: 404 }) as never);
    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(requireRuntimeMode).toHaveBeenCalledWith("terminal", expect.any(Request));
    expect(authorizeRequest).not.toHaveBeenCalled();
    expect(readBoundedJson).not.toHaveBeenCalled();
    expect(readProviderJson).not.toHaveBeenCalled();
  });

  it("uses only the authorized bounded same-origin action and preserves provider labeling", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-only-key");
    vi.mocked(readProviderJson).mockResolvedValue({
      content: [{ type: "text", text: "Unverified summary." }],
      stop_reason: "end_turn",
    } as never);
    try {
      const response = await POST(request());
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ text: "Unverified summary.", provider: "Anthropic" });
      expect(authorizeRequest).toHaveBeenCalledWith(expect.any(Request), "research:ai");
      expect(readBoundedJson).toHaveBeenCalledWith(expect.any(Request), 16 * 1024);
      expect(readProviderJson).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
