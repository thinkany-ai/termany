import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
// @ts-expect-error plain ESM script without type declarations
import { decodePng } from "../../../scripts/halloween-sprites.mjs";

// The Halloween theme in the demo build: the share pose, pixel exactness,
// the sidebar layouts that used to hide the pumpkin, and motion rules.

const PALETTE = new Set(
  readFileSync(new URL("../src/themes/halloween/art/palette.gpl", import.meta.url), "utf8")
    .split("\n")
    .map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+\S+/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => (Number(m[1]) << 16) | (Number(m[2]) << 8) | Number(m[3])),
);
const STILL = "flame=mid pupils=c lids=open bulbs=orange-lit,purple-lit,green-lit";

async function openScene(page: Page, query: string) {
  await page.goto(`/?theme=halloween${query}`);
  const canvas = page.locator(".halloween-scene");
  await expect(canvas).toHaveAttribute("data-pose", /flame=/);
  return canvas;
}

const pose = (page: Page) => page.locator(".halloween-scene").getAttribute("data-pose");

test("?theme=halloween selects the theme", async ({ page }) => {
  await openScene(page, "");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "halloween");
});

test("the share pose at 2.5 s matches its snapshot", async ({ page }) => {
  await openScene(page, "&showcase=2500");
  await expect(page.locator(".theme-scene")).toHaveScreenshot("scene-2500.png");
});

test("every art pixel is a whole block of one palette color", async ({ page }, info) => {
  const canvas = await openScene(page, "&showcase=2500");
  const dpr = (info.project.use.deviceScaleFactor as number) ?? 1;
  const k = 4 * dpr;
  const shot = decodePng(await canvas.screenshot({ scale: "device" }));
  let blocks = 0;
  for (let by = 0; by < 64; by++) {
    // The last art column sits under the sidebar's 1 px right border.
    for (let bx = 0; bx < 59; bx++) {
      const at = (x: number, y: number) => {
        const o = ((by * k + y) * shot.width + bx * k + x) * 4;
        return (shot.rgba[o] << 16) | (shot.rgba[o + 1] << 8) | shot.rgba[o + 2];
      };
      const first = at(0, 0);
      expect(PALETTE.has(first), `block ${bx},${by} is #${first.toString(16)}`).toBe(true);
      for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) {
        if (at(x, y) !== first) throw new Error(`block ${bx},${by} is not one color at ${dpr}x`);
      }
      blocks++;
    }
  }
  expect(blocks).toBe(64 * 59);
});

test("a short window keeps the whole pumpkin; the page tree scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 480 });
  await openScene(page, "&showcase=2500");
  const scene = await page.locator(".theme-scene").boundingBox();
  expect(scene!.height).toBeGreaterThanOrEqual(192);
  await expect(page.locator(".theme-scene")).toHaveScreenshot("scene-short-window.png");
});

test("a long page list keeps the whole pumpkin; the page tree scrolls", async ({ page }) => {
  await openScene(page, "&showcase=2500&pages=60");
  const scene = await page.locator(".theme-scene").boundingBox();
  expect(scene!.height).toBeGreaterThanOrEqual(192);
  const tree = page.locator(".sidebar > .tree");
  expect(await tree.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect(page.locator(".theme-scene")).toHaveScreenshot("scene-many-pages.png");
});

test("reduced motion holds the still pose", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openScene(page, "");
  expect(await pose(page)).toBe(STILL);
  await page.waitForTimeout(2000);
  expect(await pose(page)).toBe(STILL);
});

test("without reduced motion the scene animates", async ({ page }) => {
  await openScene(page, "");
  const seen = new Set<string | null>();
  for (let i = 0; i < 12; i++) {
    seen.add(await pose(page));
    await page.waitForTimeout(250);
  }
  expect(seen.size).toBeGreaterThan(1);
});

test("an agent finishing in an unfocused pane raises the alert", async ({ page }) => {
  await openScene(page, "");
  const panes = page.locator(".pane-slot[data-pane-id]");
  await panes.nth(1).locator(".xterm").click();
  await page.keyboard.type("explain the failing build");
  await page.keyboard.press("Enter");
  await panes.nth(0).locator(".xterm").click();
  await expect(page.locator(".halloween-scene")).toHaveAttribute("data-pose", /flame=flare/, { timeout: 10_000 });
  await panes.nth(1).locator(".xterm").click();
  await expect(page.locator(".halloween-scene")).not.toHaveAttribute("data-pose", /flame=flare/, { timeout: 5_000 });
});
