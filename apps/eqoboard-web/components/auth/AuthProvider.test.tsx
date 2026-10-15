import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { AuthUiSnapshot } from "@/lib/contracts/auth";
import { AuthProvider, useAuth } from "./AuthProvider";

const snapshot: AuthUiSnapshot = {
  status: "authenticated",
  authenticated: true,
  displayName: "Reader",
  permissions: ["market:read"],
  storagePartition: "native-v1-opaque",
};

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
    expect(html).toContain(JSON.stringify(snapshot));
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
