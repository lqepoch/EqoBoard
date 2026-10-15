import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  readMdpFixtureCounters,
  researchWebOrigin,
  resetMdpFixtureCounters,
  signInAt,
  terminalWebOrigin,
} from "./helpers/research-test-support";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("@api standalone production image optimizer returns the disabled response", async ({
  request,
}) => {
  const imageOptimizerUrl = new URL("/_next/image", terminalWebOrigin());
  imageOptimizerUrl.search = new URLSearchParams({
    url: "https://acceptance-image-optimizer.invalid/probe.png",
    w: "64",
    q: "75",
  }).toString();

  const response = await request.get(imageOptimizerUrl.toString());

  // The production standalone image leaves the optimizer route unhandled. The
  // reserved .invalid host ensures an enabled optimizer cannot fetch an image.
  expect(response.status()).toBe(404);
  expect(response.headers()["content-type"]).toMatch(/^text\/html(?:;|$)/iu);
  expect(await response.text()).toContain("404: This page could not be found.");
});

test("@component Canvas chart export downloads a nonempty PNG with a valid signature", async ({
  browser,
  request,
}) => {
  const researchOrigin = researchWebOrigin();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await signInAt(page, researchOrigin, "reader", "/");
    await resetMdpFixtureCounters(request);

    const observationResponse = page.waitForResponse((response) => {
      return new URL(response.url()).pathname === "/api/research/yfinance/daily";
    });
    await page.goto(new URL("/research/yfinance/SPY", researchOrigin).toString(), {
      waitUntil: "domcontentloaded",
    });
    expect((await observationResponse).status()).toBe(200);

    const chart = page.getByTestId("yahoo-research-chart");
    await expect(chart).toHaveAttribute("data-history-status", "ready");
    await expect(chart.getByTestId("native-chart-provenance")).toContainText(
      "Synthetic acceptance fixture · bounded-synthetic-e2e",
    );
    const canvasDimensions = await chart.locator("canvas").evaluateAll((canvases) =>
      canvases.map((canvas) => ({
        width: (canvas as HTMLCanvasElement).width,
        height: (canvas as HTMLCanvasElement).height,
      })),
    );
    expect(canvasDimensions.some(({ width, height }) => width > 0 && height > 0)).toBe(true);

    const pngExport = chart.getByTestId("native-chart-export-loaded-png");
    await expect(pngExport).toBeEnabled();
    const downloadReady = page.waitForEvent("download");
    await pngExport.click();
    const download = await downloadReady;
    expect(download.suggestedFilename()).toMatch(/^SPY-loaded-chart-.+\.png$/u);
    expect(await download.failure()).toBeNull();

    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    if (!downloadPath) throw new Error("The browser did not retain the PNG download.");

    const png = await readFile(downloadPath);
    expect(png.byteLength).toBeGreaterThan(PNG_SIGNATURE.byteLength);
    expect(png.subarray(0, PNG_SIGNATURE.byteLength)).toEqual(PNG_SIGNATURE);
    const fixtureCounters = await readMdpFixtureCounters(request);
    expect(fixtureCounters.calls["/v1/research/yfinance/daily"]).toBe(1);
    expect(fixtureCounters.acceptedDelegations).toBe(1);
    expect(fixtureCounters.rejectedDelegations).toBe(0);
    expect(fixtureCounters.fixture).toBe("native-e2e synthetic fixture; not provider data");
  } finally {
    await context.close();
  }
});
