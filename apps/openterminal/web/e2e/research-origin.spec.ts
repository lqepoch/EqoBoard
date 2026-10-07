import { test, expect } from "@playwright/test";
import { validatePublicResearchOrigin } from "../lib/research-origin";

test("validates the optional OpenBB origin against the native terminal origin", () => {
  expect(validatePublicResearchOrigin("https://research.example.test", "https://terminal.example.test"))
    .toBe("https://research.example.test");
  expect(validatePublicResearchOrigin("http://localhost:8088", "http://127.0.0.1:3000"))
    .toBe("http://localhost:8088");
  expect(validatePublicResearchOrigin("http://127.0.0.1:8088", "https://terminal.example.test"))
    .toBe("http://127.0.0.1:8088");

  const invalidOrigins = [
    undefined,
    "not a URL",
    "http://research.example.test",
    "https://user:secret@research.example.test",
    "https://research.example.test/workspace",
    "https://research.example.test/",
    "https://research.example.test?mode=workspace",
    "https://research.example.test#workspace",
    "https://terminal.example.test.:8443",
  ];

  for (const origin of invalidOrigins) {
    expect(validatePublicResearchOrigin(origin, "https://terminal.example.test"), String(origin)).toBeNull();
  }

  expect(validatePublicResearchOrigin("https://research.example.test", null)).toBeNull();
});
