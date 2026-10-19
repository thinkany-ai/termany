import { expect, test, type Page } from "@playwright/test";

// Snapshots of the Halloween scene in the demo build, at dpr 1 and 2 (see
// playwright.config.ts). The scene is pixel art with no text, so a change of
// one pixel, a blurred upscale or a pumpkin pushed out of view all fail.

async function openShare(page: Page, query = "") {
  await page.goto(`/?theme=halloween&showcase=2500${query}`);
  await expect(page.locator(".halloween-scene")).toHaveAttribute("data-pose", /flame=flare/);
  return page.locator(".theme-scene");
}

test("share pose", async ({ page }) => {
  await expect(await openShare(page)).toHaveScreenshot("scene-2500.png");
});

test("short window keeps the whole pumpkin", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 480 });
  await expect(await openShare(page)).toHaveScreenshot("scene-short-window.png");
});

test("long page list keeps the whole pumpkin", async ({ page }) => {
  await expect(await openShare(page, "&pages=60")).toHaveScreenshot("scene-many-pages.png");
});
