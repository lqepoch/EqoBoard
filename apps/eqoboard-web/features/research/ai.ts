export type ResearchAiMessage = Readonly<{
  role: "user" | "assistant";
  content: string;
}>;

export type ResearchAiRequest = Readonly<{ messages: readonly ResearchAiMessage[] }>;
export type ResearchAiResponse = Readonly<{
  schemaVersion: 1;
  text: string;
  generatedAt: string;
  provider: "Anthropic";
}>;
export type ResearchAiActionInput = ResearchAiRequest;
export type ResearchAiActionOutput = ResearchAiResponse;

export type ResearchAiRequestResult =
  | Readonly<{ ok: true; value: ResearchAiRequest }>
  | Readonly<{ ok: false; code: "invalid-shape" | "invalid-message" | "too-large" }>;

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key) && key !== "__proto__" && key !== "prototype" && key !== "constructor") &&
    keys.every((key) => Object.hasOwn(value, key));
}

export function parseResearchAiRequest(input: unknown): ResearchAiRequestResult {
  const root = record(input);
  if (!root || !exactKeys(root, ["messages"]) || !Array.isArray(root.messages)) {
    return { ok: false, code: "invalid-shape" };
  }
  if (root.messages.length < 1 || root.messages.length > 12) return { ok: false, code: "too-large" };
  const messages: ResearchAiMessage[] = [];
  let totalCharacters = 0;
  for (const [index, raw] of root.messages.entries()) {
    const message = record(raw);
    if (!message || !exactKeys(message, ["role", "content"]) ||
        (message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string" ||
        message.content.trim() === "" || message.content.length > 4_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(message.content)) {
      return { ok: false, code: "invalid-message" };
    }
    if (index === 0 && message.role !== "user") return { ok: false, code: "invalid-message" };
    if (index > 0 && message.role === messages[index - 1]?.role) return { ok: false, code: "invalid-message" };
    totalCharacters += message.content.length;
    if (totalCharacters > 16_000) return { ok: false, code: "too-large" };
    messages.push(Object.freeze({ role: message.role, content: message.content }));
  }
  if (messages.at(-1)?.role !== "user") return { ok: false, code: "invalid-message" };
  return { ok: true, value: Object.freeze({ messages: Object.freeze(messages) }) };
}

export function parseResearchAiResponse(value: unknown): ResearchAiResponse | null {
  const root = record(value);
  if (!root || root.schemaVersion !== 1 || root.provider !== "Anthropic" || typeof root.text !== "string" || root.text.trim() === "" ||
      root.text.length > 24_000 || typeof root.generatedAt !== "string" || !Number.isFinite(new Date(root.generatedAt).getTime())) return null;
  return Object.freeze({ schemaVersion: 1, provider: "Anthropic", text: root.text, generatedAt: new Date(root.generatedAt).toISOString() });
}
