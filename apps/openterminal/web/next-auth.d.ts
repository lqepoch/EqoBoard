import "next-auth";
import "next-auth/jwt";
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    eqoRoles?: string[];
  }

  interface Session {
    sessionExpiresAt: number;
    user: {
      id: string;
      roles: string[];
      issuer: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    eqoRoles?: string[];
    eqoIssuer?: string;
  }
}
