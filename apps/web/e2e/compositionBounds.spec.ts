import { expect, test, type Locator } from "@playwright/test";

declare global {
  interface Window {
    imeWrites: string[];
  }
}

async function expectBounded(terminal: Locator) {
  await expect(terminal.locator(".composition-view")).toHaveClass(/active/);
  await expect.poll(() => terminal.evaluate((element) => {
    const screen = element.querySelector(".xterm-screen")!.getBoundingClientRect();
    const view = element.querySelector(".composition-view")!.getBoundingClientRect();
    const input = element.querySelector("textarea")!.getBoundingClientRect();
    return Math.max(view.right, input.right) - screen.right;
  })).toBeLessThanOrEqual(1);
  expect(await terminal.evaluate((element) => {
    for (let parent: HTMLElement | null = element as HTMLElement; parent; parent = parent.parentElement) {
      if (parent.scrollLeft !== 0) return false;
    }
    return true;
  })).toBe(true);
}

test("IME preedit stays inside an app pane and commits once after resize", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Native IME composition is driven through Chromium CDP");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?theme=default-dark");
  const terminal = page.locator(".xterm").first();
  await expect(terminal.locator(".xterm-screen")).toBeVisible();
  await terminal.locator(".xterm-screen").click({ position: { x: 25, y: 40 } });
  await expect(terminal.locator("textarea")).toBeFocused();

  // Observe the real frontend -> backend boundary without replacing xterm's
  // input handling. The demo uses the same manager/addons as the desktop app.
  await page.evaluate(async () => {
    const modulePath = "/src/demo.ts";
    const { DemoBackend } = await import(modulePath);
    const original = DemoBackend.prototype.write;
    window.imeWrites = [];
    DemoBackend.prototype.write = function (data: string) {
      window.imeWrites.push(data);
      return original.call(this, data);
    };
  });
  await page.keyboard.type("a".repeat(40));
  await expect.poll(() => page.evaluate(() => window.imeWrites.join(""))).toBe("a".repeat(40));
  await page.evaluate(() => { window.imeWrites = []; });

  const cdp = await page.context().newCDPSession(page);
  const text = "ni'hao'zhong'wen'shu'ru'fa".repeat(10);
  await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
  await expectBounded(terminal);

  const oldWidth = await terminal.locator(".xterm-screen").evaluate((element) => element.clientWidth);
  await page.setViewportSize({ width: 1024, height: 640 });
  await expect.poll(() => terminal.locator(".xterm-screen").evaluate((element) => element.clientWidth)).toBeLessThan(oldWidth);
  await expectBounded(terminal);
  await page.evaluate(async () => {
    const modulePath = "/src/terminal/manager.ts";
    const { applyFontSize } = await import(modulePath);
    applyFontSize(18);
  });
  await expect(terminal.locator(".composition-view")).toHaveCSS("font-size", "18px");
  await expectBounded(terminal);
  expect(await page.evaluate(() => window.imeWrites)).toEqual([]);

  await cdp.send("Input.insertText", { text: "你好" });
  await expect.poll(() => page.evaluate(() => window.imeWrites)).toEqual(["你好"]);
  await expect(terminal.locator(".composition-view")).not.toHaveClass(/active/);
  await cdp.send("Input.imeSetComposition", { text: "quxiao", selectionStart: 6, selectionEnd: 6 });
  await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
  await expect(terminal.locator(".composition-view")).not.toHaveClass(/active/);
  await page.keyboard.type("abc");
  await expect.poll(() => page.evaluate(() => window.imeWrites.join(""))).toBe("你好abc");
  expect(errors).toEqual([]);
});
