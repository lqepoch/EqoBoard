import assert from "node:assert/strict";
import test from "node:test";
import { runWithClientAbort } from "./client-abort.mjs";

test("does not start downstream work when the client disconnects during authorization", async () => {
  const request = new AbortController();
  let resolveAuthorization;
  const pendingAuthorization = new Promise((resolve) => {
    resolveAuthorization = resolve;
  });
  let markAuthorizationStarted;
  const authorizationStarted = new Promise((resolve) => {
    markAuthorizationStarted = resolve;
  });
  let markAuthorizationSettled;
  const authorizationSettled = new Promise((resolve) => {
    markAuthorizationSettled = resolve;
  });
  let downstreamCalls = 0;

  const responsePromise = runWithClientAbort(
    request.signal,
    () => {
      markAuthorizationStarted();
      return pendingAuthorization.then((value) => {
        markAuthorizationSettled();
        return value;
      });
    },
    async () => {
      downstreamCalls += 1;
      return new Response("unexpected downstream call");
    },
    () => new Response(null, { status: 499 }),
  );

  await authorizationStarted;
  request.abort(new Error("client disconnected"));
  const response = await responsePromise;
  assert.equal(response.status, 499);
  assert.equal(downstreamCalls, 0);

  // Resolve the authorization promise after the race to prove its completion
  // cannot revive the request or start downstream work.
  resolveAuthorization({ ok: true });
  await authorizationSettled;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(downstreamCalls, 0);
});

test("does not authorize an already disconnected request", async () => {
  const request = new AbortController();
  request.abort();
  let authorizationCalls = 0;
  let downstreamCalls = 0;

  const response = await runWithClientAbort(
    request.signal,
    async () => {
      authorizationCalls += 1;
      return { ok: true };
    },
    async () => {
      downstreamCalls += 1;
      return new Response("unexpected downstream call");
    },
    () => new Response(null, { status: 499 }),
  );

  assert.equal(response.status, 499);
  assert.equal(authorizationCalls, 0);
  assert.equal(downstreamCalls, 0);
});
