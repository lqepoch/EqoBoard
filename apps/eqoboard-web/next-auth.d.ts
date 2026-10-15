import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface User {
    eqoRoles?: string[];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    nativeSubject?: string;
    nativeIssuer?: string;
    nativeRoles?: string[];
    nativeDisplayName?: string | null;
    nativeExpiresAt?: number;
    nativeProviderExpiresAt?: number | null;
  }
}
