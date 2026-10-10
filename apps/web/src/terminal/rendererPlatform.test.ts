import assert from "node:assert/strict";
import test from "node:test";
import { isMacWebKit } from "./rendererPlatform";

test("uses the macOS WebKit renderer path for WKWebView and Safari", () => {
  assert.equal(
    isMacWebKit(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/620.1 Safari/620.1",
      "MacIntel",
    ),
    true,
  );
});

test("does not mistake Chromium on macOS for WKWebView", () => {
  assert.equal(
    isMacWebKit(
      "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
      "MacIntel",
    ),
    false,
  );
});

test("does not apply the macOS workaround to WebKitGTK", () => {
  assert.equal(
    isMacWebKit("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1 Safari/605.1", "Linux x86_64"),
    false,
  );
});
