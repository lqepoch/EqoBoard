import type { Page, Response } from "@playwright/test";

export type CapturedResponse = {
  path: string;
  pathname: string;
  url: string;
  status: number;
  body?: unknown;
  bodyReady: Promise<void>;
};

export type ResponseCapture = ReturnType<typeof captureJsonResponses>;

export function captureJsonResponses(
  page: Page,
  origin: string,
  include: (response: Response, path: string) => boolean,
) {
  const responses: CapturedResponse[] = [];
  const pending: Promise<void>[] = [];

  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin !== origin || !include(response, url.pathname)) return;

    const captured: CapturedResponse = {
      path: `${url.pathname}${url.search}`,
      pathname: url.pathname,
      url: response.url(),
      status: response.status(),
      bodyReady: Promise.resolve(),
    };
    responses.push(captured);
    captured.bodyReady = (async () => {
      try {
        captured.body = await response.json();
      } catch {
        captured.body = undefined;
      }
    })();
    pending.push(captured.bodyReady);
  });

  const latest = (predicate: (response: CapturedResponse) => boolean, since = 0) =>
    [...responses].slice(since).reverse().find(predicate);

  return {
    responses,
    mark: () => responses.length,
    since: (index: number) => responses.slice(index),
    latest,
    async latestSettled(predicate: (response: CapturedResponse) => boolean, since = 0) {
      const current = latest(predicate, since);
      if (!current) return undefined;
      await current.bodyReady;
      // If a newer response arrived while the body was being read, the caller
      // must retry against that response rather than silently use stale data.
      return latest(predicate, since) === current ? current : undefined;
    },
    async settle() {
      let cursor = 0;
      while (cursor < pending.length) {
        const batch = pending.slice(cursor);
        cursor = pending.length;
        await Promise.all(batch);
      }
    },
  };
}
