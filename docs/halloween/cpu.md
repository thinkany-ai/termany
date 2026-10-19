# Halloween theme: idle CPU in the packaged macOS app

Measured on 2026-10-19 on the developer's Mac (Apple silicon, macOS 15),
Termany 0.2.7 built from this branch.

## Budget (set before measuring)

- **CPU-1** WHILE the app is idle with the Halloween theme, the total CPU of
  all of its processes MUST stay within 0.5 percentage points of one core
  above the same build with the default theme. This is the mean over 60 s.
- **CPU-2** WHERE reduced motion is on, the difference MUST stay within 0.2
  percentage points.

"Idle" means one 1280×832 window and two shell panes, with no agent running
and nobody typing.

## Method

- **Isolation.** Each variant is a release `.app`
  (`tauri build --bundles app --no-sign`) with its own bundle identifier, its
  own `HOME` under the scratch directory, and its server on port 5184. So it
  never touches the user's installed Termany or that app's server on 5174.
  The temporary port and default-theme patches were reverted after each
  build.
- **What is counted.** The CPU time of the app process, its children (the
  Node server and the shells), and the three WebKit processes it started
  (WebContent, GPU, Networking). The value is the delta of `ps -o time=`
  over 60 s, divided by the wall time.
- **Window visibility.** It was read from the on-screen window list before
  and after each run. macOS stops rendering a fully covered WebView, so a
  run with the window covered says nothing about animation cost.

## Results

| Variant | Window | Scene state | CPU, % of one core |
|---|---|---|---|
| Default theme (baseline) | partly visible | — | 0.17 |
| Default theme (baseline) | fully covered | — | 0.13 |
| Halloween, first build (480×512 canvas) | visible | animating | 8.44 |
| Halloween, art-resolution canvas (60×64, CSS 4×) | partly visible | animating | 3.23 |
| Halloween, art-resolution canvas | fully covered | not drawing | 0.13 |
| Halloween with rest, diagnostic build | partly visible | animating 25–50 s, resting after | 5.18 |
| Halloween with rest, diagnostic build | fully covered | resting, 0 ticks in 60 s | 0.02 |

### What the numbers say

- **Animation cost.** While the scene animates (about 5 frame changes per
  second), it costs about 3% of a core above baseline, even with the
  art-resolution canvas. That is roughly 0.6% per change per second. Most of
  it is WebKit's layer commit and the window compositor (WebContent, GPU and
  the app's own process), not JavaScript. **While animating, CPU-1 is not
  met.**
- **Rest.** The scene therefore rests: it holds the still pose when the
  window is not focused or after 30 s without input
  (`apps/web/src/themes/halloween/scene.tsx`, `REST_AFTER_MS`).
- **Resting does no work.** The diagnostic build shows that a resting scene
  stops ticking entirely. Its tick count did not change over the 60 s run.
  So, I infer, a resting scene costs the same as the baseline.

## Not measured

- **Visible and resting.** A run with the window visible and the scene
  resting. The user's own windows covered the test window in every
  attempt, and this session had no permission to bring it forward. This is
  the number CPU-1 is really about.
- **CPU-2 (reduced motion).** Turning on Reduce Motion is a system setting,
  so it was not changed. In code, reduced motion takes the same path as
  rest.
- **Many panes, or agents working.** Neither was measured.

To fill these in, run the variants with the test window in front. The
scripts used are described above. They need a Mac where the test window can
stay uncovered for 90 s.
