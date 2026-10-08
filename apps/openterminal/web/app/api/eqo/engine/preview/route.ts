import { type NextRequest } from "next/server";
import { engineMethodNotAllowed, proxyEngineRead } from "@/lib/engine-preview";

export function GET(request: NextRequest) {
  return proxyEngineRead(request, "preview");
}

export function HEAD() {
  return engineMethodNotAllowed();
}

export function POST() {
  return engineMethodNotAllowed();
}

export function PUT() {
  return engineMethodNotAllowed();
}

export function PATCH() {
  return engineMethodNotAllowed();
}

export function DELETE() {
  return engineMethodNotAllowed();
}

export function OPTIONS() {
  return engineMethodNotAllowed();
}
