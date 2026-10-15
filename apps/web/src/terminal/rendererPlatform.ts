/**
 * macOS Tauri renders through WKWebView, which identifies as pure AppleWebKit.
 * The renderer and IME workarounds must not run in Chromium or WebKitGTK, so
 * keep this check independent of globals and unit-test the platform split.
 */
export function isMacWebKit(
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  const pureWebKit = userAgent.includes("AppleWebKit") && !/Chrome|Chromium|Edg\//.test(userAgent);
  const mac = /Mac|iPhone|iPad/.test(platform) || userAgent.includes("Macintosh");
  return pureWebKit && mac;
}
