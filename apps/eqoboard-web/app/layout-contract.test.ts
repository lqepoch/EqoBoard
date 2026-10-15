import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");

describe("root layout request rendering contract", () => {
  it("keeps per-request authentication projection on a dynamic App Router response", () => {
    expect(source).toContain('export const dynamic = "force-dynamic";');
    expect(source).toContain("const auth = await getAuthUiSnapshot();");
    expect(source).toContain("<Providers auth={auth}>{children}</Providers>");
  });
});
