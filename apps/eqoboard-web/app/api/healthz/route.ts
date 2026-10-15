import { noStoreJson } from "@/lib/server/bff-security";

export const dynamic = "force-dynamic";

export function GET() {
  return noStoreJson({ status: "ok" });
}
