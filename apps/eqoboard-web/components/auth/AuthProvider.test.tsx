import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { AuthUiSnapshot } from "@/lib/contracts/auth";
import { AuthProvider, handleSignedOutMessage, useAuth } from "./AuthProvider";

const snapshot: AuthUiSnapshot = {
  status: "authenticated",
  authenticated: true,
  displayName: "Reader",
  permissions: ["market:read"],
  storagePartition: "native-v1-opaque",
};

function escapeHtmlText(value: string): string {
  const entities: Readonly<Record<string, string>> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#x27;",
  };
  return value.replace(/[&<>"']/gu, (character) => entities[character] ?? character);
}

describe("AuthProvider safe projection", () => {
  it("exposes only the immutable UI snapshot", () => {
    function SnapshotReader() {
      const auth = useAuth();
      return <output>{JSON.stringify(auth)}</output>;
    }
    const html = renderToString(
      <AuthProvider snapshot={snapshot}>
        <SnapshotReader />
      </AuthProvider>,
    );
    expect(html).toContain(escapeHtmlText(JSON.stringify(snapshot)));
    expect(html).not.toMatch(/issuer|subject|role|token|secret/i);
  });

  it("rejects use outside the provider", () => {
    function SnapshotReader() {
      const auth = useAuth();
      return <output>{JSON.stringify(auth)}</output>;
    }
    expect(() => renderToString(<SnapshotReader />)).toThrow(/AuthProvider/u);
  });
});

describe("AuthCacheBoundary partitioned logout", () => {
  it("ignores another user's partition and invalidates only the matching partition", () => {
    const invalidations: string[] = [];
    const invalidate = () => {
      invalidations.push("query-cache-cleared");
      invalidations.push("document-reloaded");
    };

    expect(
      handleSignedOutMessage(
        { type: "signed-out", storagePartition: "native-research-v1-other-user" },
        "native-research-v1-current-user",
        invalidate,
      ),
    ).toBe(false);
    expect(invalidations).toEqual([]);

    expect(
      handleSignedOutMessage(
        { type: "signed-out", storagePartition: "native-research-v1-current-user" },
        "native-research-v1-current-user",
        invalidate,
      ),
    ).toBe(true);
    expect(invalidations).toEqual(["query-cache-cleared", "document-reloaded"]);
  });

  it("does not treat an anonymous or malformed event as a signed-out identity", () => {
    let invalidated = false;
    const invalidate = () => {
      invalidated = true;
    };
    expect(
      handleSignedOutMessage({ type: "signed-out", storagePartition: null }, null, invalidate),
    ).toBe(false);
    expect(
      handleSignedOutMessage({ type: "signed-out" }, "native-terminal-v1-user", invalidate),
    ).toBe(false);
    expect(invalidated).toBe(false);
  });
});
